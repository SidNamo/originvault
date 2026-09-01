import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import {
  access,
  link,
  mkdir,
  open,
  rm,
  stat,
  truncate,
  unlink,
  utimes,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { requireAuth, type SessionUser } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { logForRequest, logger } from './logger.js';
import { assertStorageAvailable, StorageQuotaError } from './quota.js';
import { extractMetadata, isHiddenResource, originalCreatedAtFromMetadata, resolveInside, safeRelativeDirectory, safeSegment, userFilesRoot } from './storage.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SESSION_ROUTE = '/api/upload-sessions';
const SESSION_COLUMNS = `
  id,
  file_id AS "fileId",
  user_id AS "userId",
  client_fingerprint AS "clientFingerprint",
  identity_hash AS "identityHash",
  destination_folder_id AS "destinationFolderId",
  destination_folder_path AS "destinationFolderPath",
  final_folder_id AS "finalFolderId",
  relative_directory AS "relativeDirectory",
  original_name AS "originalName",
  mime_type AS "mimeType",
  size_bytes::text AS "sizeBytes",
  offset_bytes::text AS "offsetBytes",
  client_last_modified AS "clientLastModified",
  temp_relative_path AS "tempRelativePath",
  status,
  stored_name AS "storedName",
  final_relative_path AS "finalRelativePath",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`;

type Queryable = Pick<PoolClient, 'query'>;

interface UploadSessionRow {
  id: string;
  fileId: string;
  userId: string;
  clientFingerprint: string;
  identityHash: string;
  destinationFolderId: string | null;
  destinationFolderPath: string;
  finalFolderId: string | null;
  relativeDirectory: string;
  originalName: string;
  mimeType: string;
  sizeBytes: string;
  offsetBytes: string;
  clientLastModified: Date | null;
  tempRelativePath: string;
  status: 'active' | 'finalizing';
  storedName: string | null;
  finalRelativePath: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NormalizedUploadInput {
  fingerprint: string;
  originalName: string;
  sizeBytes: bigint;
  mimeType: string;
  lastModified: Date | null;
  folderId: string | null;
  relativeDirectory: string;
}

interface CompletedFile {
  id: string;
  name: string;
  sizeBytes: string;
  sha256: string;
}

interface UploadCollisionEntry {
  key: string;
  originalName: string;
  folderId: string | null;
  relativeDirectory: string;
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

class OffsetMismatchError extends HttpError {
  constructor(readonly expectedOffset: bigint) {
    super(409, 'Upload offset does not match the server offset', {
      'Upload-Offset': expectedOffset.toString(),
    });
  }
}

function maxUploadBytes(): bigint {
  if (!Number.isSafeInteger(config.maxUploadBytes) || config.maxUploadBytes < 0) {
    throw new Error('MAX_UPLOAD_BYTES must be a non-negative safe integer');
  }
  return BigInt(config.maxUploadBytes);
}

function parseNonNegativeInteger(value: unknown, fieldName: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new HttpError(400, `${fieldName} must be a non-negative integer`);
    return BigInt(value);
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new HttpError(400, `${fieldName} must be a non-negative integer`);
  }
  return BigInt(value);
}

export function parseUploadOffset(value: string | undefined): bigint {
  if (value === undefined || !/^\d+$/.test(value)) {
    throw new HttpError(400, 'Upload-Offset must be a non-negative integer');
  }
  return BigInt(value);
}

function normalizeLastModified(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  let date: Date;
  if (typeof value === 'number') date = new Date(value);
  else if (typeof value === 'string' && /^\d+$/.test(value)) date = new Date(Number(value));
  else if (typeof value === 'string') date = new Date(value);
  else throw new HttpError(400, 'lastModified must be an ISO date or Unix time in milliseconds');
  if (!Number.isFinite(date.getTime())) throw new HttpError(400, 'lastModified is invalid');
  return date;
}

export function normalizeUploadInput(body: unknown, configuredMaximum = maxUploadBytes()): NormalizedUploadInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'A JSON request body is required');
  const input = body as Record<string, unknown>;
  const fingerprint = typeof input.fingerprint === 'string' ? input.fingerprint.trim() : '';
  if (!fingerprint || fingerprint.length > 512 || /[\u0000-\u001f]/.test(fingerprint)) {
    throw new HttpError(400, 'fingerprint must be 1-512 printable characters');
  }
  const rawName = typeof input.originalName === 'string' ? input.originalName : '';
  if (!rawName || rawName.length > 1024) throw new HttpError(400, 'originalName is required');
  const originalName = safeSegment(rawName);
  const sizeBytes = parseNonNegativeInteger(input.sizeBytes, 'sizeBytes');
  if (sizeBytes > configuredMaximum) throw new HttpError(413, 'File is too large');
  const rawMimeType = input.mimeType === undefined || input.mimeType === null
    ? 'application/octet-stream'
    : String(input.mimeType).trim();
  if (!rawMimeType || rawMimeType.length > 255 || /[\r\n\u0000]/.test(rawMimeType)) {
    throw new HttpError(400, 'mimeType is invalid');
  }
  const folderId = input.folderId === undefined || input.folderId === null || input.folderId === ''
    ? null
    : String(input.folderId);
  if (folderId && !UUID_PATTERN.test(folderId)) throw new HttpError(400, 'folderId is invalid');
  const rawDirectory = input.relativeDirectory === undefined || input.relativeDirectory === null
    ? ''
    : String(input.relativeDirectory);
  if (rawDirectory.length > 4096) throw new HttpError(400, 'relativeDirectory is too long');
  return {
    fingerprint,
    originalName,
    sizeBytes,
    mimeType: rawMimeType,
    lastModified: normalizeLastModified(input.lastModified),
    folderId,
    relativeDirectory: safeRelativeDirectory(rawDirectory),
  };
}

function parseUploadCollisionEntries(value: unknown): UploadCollisionEntry[] {
  if (!Array.isArray(value) || !value.length || value.length > 1_000) {
    throw new HttpError(400, 'entries must contain 1 to 1000 upload candidates');
  }
  const entries = value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new HttpError(400, 'Each upload candidate must be an object');
    }
    const raw = entry as Record<string, unknown>;
    const key = typeof raw.key === 'string' ? raw.key : '';
    const rawName = typeof raw.originalName === 'string' ? raw.originalName : '';
    const folderId = raw.folderId === undefined || raw.folderId === null || raw.folderId === ''
      ? null
      : String(raw.folderId);
    const rawDirectory = raw.relativeDirectory === undefined || raw.relativeDirectory === null
      ? ''
      : String(raw.relativeDirectory);
    if (!key || key.length > 128 || /[\u0000-\u001f]/.test(key)) throw new HttpError(400, 'Upload candidate key is invalid');
    if (folderId && !UUID_PATTERN.test(folderId)) throw new HttpError(400, 'Upload candidate folderId is invalid');
    try {
      return {
        key,
        originalName: safeSegment(rawName),
        folderId,
        relativeDirectory: safeRelativeDirectory(rawDirectory),
      };
    } catch {
      throw new HttpError(400, 'Upload candidate path is invalid');
    }
  });
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
    throw new HttpError(400, 'Upload candidate keys must be unique');
  }
  return entries;
}

async function uploadCollisions(user: SessionUser, entries: UploadCollisionEntry[]) {
  const folderIds = [...new Set(entries.flatMap((entry) => entry.folderId ? [entry.folderId] : []))];
  const folders = folderIds.length
    ? await db.query<{ id: string; relativePath: string }>(`
      SELECT id,relative_path AS "relativePath" FROM folders
      WHERE user_id=$1 AND trashed_at IS NULL AND id=ANY($2::uuid[])
    `, [user.id, folderIds])
    : { rows: [] as Array<{ id: string; relativePath: string }> };
  if (folders.rows.length !== folderIds.length) throw new HttpError(404, 'Destination folder not found');
  const folderPaths = new Map(folders.rows.map((folder) => [folder.id, folder.relativePath]));
  const candidates = entries.map((entry) => ({
    ...entry,
    relativePath: path.posix.join(entry.folderId ? folderPaths.get(entry.folderId)! : '', entry.relativeDirectory, entry.originalName),
  }));
  const existing = await db.query<{ id: string; type: 'file' | 'folder'; relativePath: string }>(`
    SELECT id,'file'::text AS type,relative_path AS "relativePath"
    FROM files WHERE user_id=$1 AND trashed_at IS NULL AND relative_path=ANY($2::text[])
    UNION ALL
    SELECT id,'folder'::text AS type,relative_path AS "relativePath"
    FROM folders WHERE user_id=$1 AND trashed_at IS NULL AND relative_path=ANY($2::text[])
  `, [user.id, candidates.map((candidate) => candidate.relativePath)]);
  const existingByPath = new Map(existing.rows.map((item) => [item.relativePath, item]));
  return candidates.flatMap((candidate) => {
    const item = existingByPath.get(candidate.relativePath);
    return item ? [{ key: candidate.key, existing: { type: item.type, id: item.id }, name: candidate.originalName }] : [];
  });
}

export function uploadIdentityHash(userId: string, input: NormalizedUploadInput): string {
  const canonical = JSON.stringify({
    userId,
    fingerprint: input.fingerprint,
    originalName: input.originalName,
    sizeBytes: input.sizeBytes.toString(),
    mimeType: input.mimeType,
    lastModified: input.lastModified?.toISOString() ?? null,
    folderId: input.folderId,
    relativeDirectory: input.relativeDirectory,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

function sessionUserDirectory(storageKey: string): string {
  const safeStorageKey = safeSegment(storageKey);
  if (safeStorageKey !== storageKey) throw new Error('Authenticated storage key is not storage-safe');
  return resolveInside(config.dataRoot, path.join('.upload-sessions', safeStorageKey));
}

function expectedTempRelativePath(storageKey: string, sessionId: string): string {
  return path.join('.upload-sessions', safeSegment(storageKey), `${sessionId}.part`);
}

function sessionPartPath(user: SessionUser, session: Pick<UploadSessionRow, 'id' | 'tempRelativePath'>): string {
  const expected = expectedTempRelativePath(user.storageKey, session.id);
  if (path.normalize(session.tempRelativePath) !== path.normalize(expected)) {
    logger.fatal({
      event: 'upload_session_temp_path_invalid',
      userId: user.id,
      sessionId: session.id,
      storedTempRelativePath: session.tempRelativePath,
      expectedTempRelativePath: expected,
    }, 'Upload session temp path did not match its isolated server-derived path');
    throw new HttpError(500, 'Upload session storage path is invalid');
  }
  return resolveInside(sessionUserDirectory(user.storageKey), `${session.id}.part`);
}

function chunkDirectory(user: SessionUser, sessionId: string): string {
  return resolveInside(sessionUserDirectory(user.storageKey), `${sessionId}.chunks`);
}

async function ensurePartFile(user: SessionUser, session: UploadSessionRow): Promise<string> {
  const directory = sessionUserDirectory(user.storageKey);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const partPath = sessionPartPath(user, session);
  const handle = await open(partPath, 'a', 0o600);
  await handle.close();
  return partPath;
}

async function loadSession(queryable: Queryable, userId: string, sessionId: string, forUpdate = false): Promise<UploadSessionRow | null> {
  const result = await queryable.query<UploadSessionRow>(`
    SELECT ${SESSION_COLUMNS}
    FROM upload_sessions
    WHERE id=$1 AND user_id=$2
    ${forUpdate ? 'FOR UPDATE' : ''}
  `, [sessionId, userId]);
  return result.rows[0] ?? null;
}

async function reconcilePartWithDatabase(user: SessionUser, session: UploadSessionRow): Promise<string> {
  const databaseOffset = BigInt(session.offsetBytes);
  let partPath: string;
  try {
    partPath = await ensurePartFile(user, session);
  } catch (error: any) {
    if (error?.code === 'ENOENT' && databaseOffset > 0n) {
      logger.error({ event: 'upload_session_part_missing', userId: user.id, sessionId: session.id, databaseOffset: databaseOffset.toString() }, 'Resumable upload part file is missing');
      throw new HttpError(409, 'Server upload data is missing; cancel this session and upload again');
    }
    throw error;
  }
  const partStat = await stat(partPath);
  const physicalOffset = BigInt(partStat.size);
  if (physicalOffset > databaseOffset) {
    await truncate(partPath, Number(databaseOffset));
    logger.warn({
      event: 'upload_session_uncommitted_bytes_truncated',
      userId: user.id,
      sessionId: session.id,
      physicalOffset: physicalOffset.toString(),
      databaseOffset: databaseOffset.toString(),
    }, 'Uncommitted bytes left by an interrupted worker were truncated to the durable database offset');
  } else if (physicalOffset < databaseOffset) {
    logger.error({
      event: 'upload_session_part_shorter_than_database',
      userId: user.id,
      sessionId: session.id,
      physicalOffset: physicalOffset.toString(),
      databaseOffset: databaseOffset.toString(),
    }, 'Upload part file is shorter than its durable database offset');
    throw new HttpError(409, 'Server upload data is incomplete; cancel this session and upload again');
  }
  return partPath;
}

function setUploadHeaders(res: Response, session: Pick<UploadSessionRow, 'id' | 'offsetBytes' | 'sizeBytes'>): void {
  res.setHeader('Location', `${SESSION_ROUTE}/${session.id}`);
  res.setHeader('Upload-Offset', session.offsetBytes);
  res.setHeader('Upload-Length', session.sizeBytes);
  res.setHeader('Upload-Accept', 'application/offset+octet-stream');
  res.setHeader('Cache-Control', 'no-store');
}

function sessionResponse(session: UploadSessionRow) {
  return {
    id: session.id,
    uploadUrl: `${SESSION_ROUTE}/${session.id}`,
    offset: Number(session.offsetBytes),
    sizeBytes: Number(session.sizeBytes),
    complete: false,
  };
}

async function sessionState(user: SessionUser, sessionId: string): Promise<UploadSessionRow> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const session = await loadSession(client, user.id, sessionId, true);
    if (!session) throw new HttpError(404, 'Upload session not found');
    await reconcilePartWithDatabase(user, session);
    await client.query('UPDATE upload_sessions SET updated_at=now() WHERE id=$1 AND user_id=$2', [session.id, user.id]);
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function stageChunk(req: Request, user: SessionUser, sessionId: string, maximumBytes: bigint): Promise<{ path: string; size: bigint }> {
  const contentLength = req.header('content-length');
  if (contentLength !== undefined) {
    const declared = parseNonNegativeInteger(contentLength, 'Content-Length');
    if (declared > maximumBytes) throw new HttpError(413, 'Chunk exceeds the remaining upload size');
  }
  const directory = chunkDirectory(user, sessionId);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stagedPath = resolveInside(directory, `${randomUUID()}.chunk`);
  const handle = await open(stagedPath, 'wx', 0o600);
  let size = 0n;
  try {
    for await (const value of req) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const nextSize = size + BigInt(chunk.length);
      if (nextSize > maximumBytes) throw new HttpError(413, 'Chunk exceeds the remaining upload size');
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written, Number(size) + written);
        written += result.bytesWritten;
      }
      size = nextSize;
    }
    if (req.aborted) throw new HttpError(400, 'Chunk upload was aborted');
    await handle.sync();
    return { path: stagedPath, size };
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(stagedPath).catch(() => undefined);
    throw error;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function appendStagedChunk(
  user: SessionUser,
  sessionId: string,
  requestedOffset: bigint,
  stagedPath: string,
  stagedSize: bigint,
): Promise<{ session: UploadSessionRow; complete: boolean }> {
  const client = await db.connect();
  let partPath: string | undefined;
  let appendStarted = false;
  let committed = false;
  try {
    await client.query('BEGIN');
    const session = await loadSession(client, user.id, sessionId, true);
    if (!session) throw new HttpError(404, 'Upload session not found');
    partPath = await reconcilePartWithDatabase(user, session);
    const durableOffset = BigInt(session.offsetBytes);
    const totalSize = BigInt(session.sizeBytes);
    if (requestedOffset !== durableOffset) throw new OffsetMismatchError(durableOffset);
    if (session.status === 'finalizing' && durableOffset === totalSize) {
      if (stagedSize !== 0n) throw new HttpError(409, 'Upload is already finalizing');
      await client.query('COMMIT');
      return { session, complete: true };
    }
    if (stagedSize === 0n && durableOffset < totalSize) throw new HttpError(400, 'Chunk body is empty');
    if (stagedSize > totalSize - durableOffset) throw new HttpError(413, 'Chunk exceeds the remaining upload size');

    if (stagedSize > 0n) {
      appendStarted = true;
      const writeStream = createWriteStream(partPath, { flags: 'a', mode: 0o600 });
      await pipeline(createReadStream(stagedPath), writeStream);
      const handle = await open(partPath, 'r');
      try { await handle.sync(); } finally { await handle.close(); }
    }

    const newOffset = durableOffset + stagedSize;
    const updated = await client.query<UploadSessionRow>(`
      UPDATE upload_sessions
      SET offset_bytes=$3, updated_at=now()
      WHERE id=$1 AND user_id=$2
      RETURNING ${SESSION_COLUMNS}
    `, [sessionId, user.id, newOffset.toString()]);
    await client.query('COMMIT');
    committed = true;
    logger.debug({
      event: 'resumable_chunk_committed',
      userId: user.id,
      sessionId,
      previousOffset: durableOffset.toString(),
      chunkBytes: stagedSize.toString(),
      newOffset: newOffset.toString(),
      sizeBytes: totalSize.toString(),
    }, 'Resumable upload chunk was durably committed');
    return { session: updated.rows[0]!, complete: newOffset === totalSize };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (appendStarted && !committed && partPath) {
      await truncate(partPath, Number(requestedOffset)).catch((truncateError) => {
        logger.fatal({ event: 'resumable_chunk_rollback_truncate_failed', userId: user.id, sessionId, requestedOffset: requestedOffset.toString(), err: truncateError }, 'Could not roll back partially appended upload bytes');
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function ensureFolderPath(
  client: PoolClient,
  user: SessionUser,
  baseFolderId: string | null,
  originalBasePath: string,
  requestedDirectory: string,
): Promise<{ folderId: string | null; relativePath: string }> {
  let parentId = baseFolderId;
  let parentPath = '';
  if (parentId) {
    const base = await client.query<{ relative_path: string }>('SELECT relative_path FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [parentId, user.id]);
    if (!base.rowCount) throw new HttpError(409, 'Destination folder no longer exists');
    parentPath = base.rows[0]!.relative_path;
  } else if (originalBasePath) {
    throw new HttpError(409, 'Destination folder was deleted while the upload was in progress');
  }

  for (const segment of safeRelativeDirectory(requestedDirectory).split('/').filter(Boolean)) {
    const relativePath = path.join(parentPath, segment);
    let existing = await client.query<{ id: string; relative_path: string }>(
      'SELECT id,relative_path FROM folders WHERE user_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 AND trashed_at IS NULL',
      [user.id, parentId, segment],
    );
    if (!existing.rowCount) {
      await mkdir(resolveInside(userFilesRoot(user.storageKey), relativePath), { recursive: true });
      try {
        existing = await client.query<{ id: string; relative_path: string }>(
          'INSERT INTO folders(user_id,parent_id,name,relative_path,is_hidden) VALUES($1,$2,$3,$4,$5) RETURNING id,relative_path',
          [user.id, parentId, segment, relativePath, isHiddenResource(segment)],
        );
        logger.info({ event: 'folder_created_during_resumable_upload', userId: user.id, sessionDestination: relativePath, folderId: existing.rows[0]!.id }, 'Folder was created for a resumable upload destination');
      } catch (error: any) {
        if (error?.code !== '23505') throw error;
        existing = await client.query<{ id: string; relative_path: string }>(
          'SELECT id,relative_path FROM folders WHERE user_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 AND trashed_at IS NULL',
          [user.id, parentId, segment],
        );
      }
    }
    parentId = existing.rows[0]!.id;
    parentPath = existing.rows[0]!.relative_path;
  }
  await mkdir(resolveInside(userFilesRoot(user.storageKey), parentPath), { recursive: true });
  return { folderId: parentId, relativePath: parentPath };
}

function candidateName(requested: string, index: number): string {
  const parsed = path.parse(safeSegment(requested));
  return index === 0 ? `${parsed.name}${parsed.ext}` : `${parsed.name} (${index})${parsed.ext}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function chooseAvailableDestination(
  client: PoolClient,
  user: SessionUser,
  sessionId: string,
  directoryPath: string,
  originalName: string,
): Promise<{ storedName: string; relativePath: string }> {
  const root = userFilesRoot(user.storageKey);
  for (let index = 0; index < 100_000; index += 1) {
    const storedName = candidateName(originalName, index);
    const relativePath = path.join(directoryPath, storedName);
    const reserved = await client.query('SELECT 1 FROM upload_sessions WHERE user_id=$1 AND final_relative_path=$2 AND id<>$3', [user.id, relativePath, sessionId]);
    if (reserved.rowCount) continue;
    const indexed = await client.query('SELECT 1 FROM files WHERE user_id=$1 AND relative_path=$2 AND trashed_at IS NULL', [user.id, relativePath]);
    if (indexed.rowCount) continue;
    if (await pathExists(resolveInside(root, relativePath))) continue;
    return { storedName, relativePath };
  }
  throw new HttpError(409, 'Could not allocate an available destination file name');
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function sameFile(firstPath: string, secondPath: string): Promise<boolean> {
  try {
    const [first, second] = await Promise.all([stat(firstPath), stat(secondPath)]);
    return first.dev === second.dev && first.ino === second.ino;
  } catch {
    return false;
  }
}

async function alreadyCompletedFile(queryable: Queryable, userId: string, fileId: string): Promise<CompletedFile | null> {
  const result = await queryable.query<CompletedFile>(`
    SELECT id,stored_name AS name,size_bytes::text AS "sizeBytes",sha256
    FROM files WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL
  `, [fileId, userId]);
  return result.rows[0] ?? null;
}

async function prepareFinalization(client: PoolClient, user: SessionUser, sessionId: string, knownFileId: string): Promise<UploadSessionRow | CompletedFile> {
  try {
    await client.query('BEGIN');
    const session = await loadSession(client, user.id, sessionId, true);
    if (!session) {
      await client.query('ROLLBACK');
      const completed = await alreadyCompletedFile(client, user.id, knownFileId);
      if (completed) return completed;
      throw new HttpError(404, 'Upload session not found');
    }
    await reconcilePartWithDatabase(user, session);
    if (BigInt(session.offsetBytes) !== BigInt(session.sizeBytes)) throw new HttpError(409, 'Upload is not complete');
    if (!session.finalRelativePath || !session.storedName) {
      const destination = await ensureFolderPath(
        client,
        user,
        session.destinationFolderId,
        session.destinationFolderPath,
        session.relativeDirectory,
      );
      const selected = await chooseAvailableDestination(client, user, session.id, destination.relativePath, session.originalName);
      const updated = await client.query<UploadSessionRow>(`
        UPDATE upload_sessions
        SET status='finalizing', final_folder_id=$3, stored_name=$4, final_relative_path=$5, updated_at=now()
        WHERE id=$1 AND user_id=$2
        RETURNING ${SESSION_COLUMNS}
      `, [session.id, user.id, destination.folderId, selected.storedName, selected.relativePath]);
      await client.query('COMMIT');
      return updated.rows[0]!;
    }
    if (session.status !== 'finalizing') {
      const updated = await client.query<UploadSessionRow>(`
        UPDATE upload_sessions SET status='finalizing',updated_at=now()
        WHERE id=$1 AND user_id=$2 RETURNING ${SESSION_COLUMNS}
      `, [session.id, user.id]);
      await client.query('COMMIT');
      return updated.rows[0]!;
    }
    await client.query('COMMIT');
    return session;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function resetCollidingDestination(queryable: Queryable, user: SessionUser, sessionId: string, relativePath: string): Promise<void> {
  await queryable.query(`
    UPDATE upload_sessions
    SET status='active',final_folder_id=NULL,stored_name=NULL,final_relative_path=NULL,updated_at=now()
    WHERE id=$1 AND user_id=$2 AND final_relative_path=$3
  `, [sessionId, user.id, relativePath]);
}

async function commitCompletedFile(
  client: PoolClient,
  user: SessionUser,
  session: UploadSessionRow,
  sha256: string,
  metadata: Record<string, unknown>,
): Promise<CompletedFile> {
  try {
    await client.query('BEGIN');
    const current = await loadSession(client, user.id, session.id, true);
    if (!current) {
      await client.query('ROLLBACK');
      const completed = await alreadyCompletedFile(client, user.id, session.fileId);
      if (completed) return completed;
      throw new HttpError(404, 'Upload session was cancelled during finalization');
    }
    if (current.finalRelativePath !== session.finalRelativePath || current.storedName !== session.storedName) {
      throw new HttpError(409, 'Upload destination changed during finalization');
    }
    await client.query(`
      INSERT INTO files(id,user_id,folder_id,original_name,stored_name,relative_path,mime_type,size_bytes,sha256,upload_identity_hash,client_last_modified,extracted_metadata,is_hidden,original_created_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT(id) DO NOTHING
    `, [
      session.fileId,
      user.id,
      session.finalFolderId,
      session.storedName,
      session.storedName,
      session.finalRelativePath,
      session.mimeType,
      session.sizeBytes,
      sha256,
      session.identityHash,
      session.clientLastModified,
      metadata,
      isHiddenResource(session.storedName ?? session.originalName, metadata),
      originalCreatedAtFromMetadata(metadata) ?? null,
    ]);
    await client.query('DELETE FROM upload_sessions WHERE id=$1 AND user_id=$2', [session.id, user.id]);
    await client.query('COMMIT');
    return { id: session.fileId, name: session.originalName, sizeBytes: session.sizeBytes, sha256 };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function finalizeSession(user: SessionUser, sessionId: string, knownFileId: string): Promise<CompletedFile> {
  const client = await db.connect();
  const lockKey = `originvault:${user.id}`;
  let lockHeld = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    lockHeld = true;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const prepared = await prepareFinalization(client, user, sessionId, knownFileId);
      if (!('tempRelativePath' in prepared)) return prepared;
      const session = prepared;
      const partPath = sessionPartPath(user, session);
      const finalPath = resolveInside(userFilesRoot(user.storageKey), session.finalRelativePath!);
      await mkdir(path.dirname(finalPath), { recursive: true });
      try {
        await link(partPath, finalPath);
        logger.debug({ event: 'resumable_upload_original_linked', userId: user.id, sessionId, relativePath: session.finalRelativePath }, 'Completed part was atomically linked into the human-readable destination');
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
        if (!(await sameFile(partPath, finalPath))) {
          logger.warn({ event: 'resumable_upload_destination_collision', userId: user.id, sessionId, relativePath: session.finalRelativePath, attempt }, 'Reserved destination was occupied externally; selecting another name');
          await resetCollidingDestination(client, user, sessionId, session.finalRelativePath!);
          continue;
        }
        logger.debug({ event: 'resumable_upload_existing_link_recovered', userId: user.id, sessionId, relativePath: session.finalRelativePath }, 'Recovered a final file link created before an interrupted finalization');
      }

      if (session.clientLastModified && Number.isFinite(new Date(session.clientLastModified).getTime())) {
        await utimes(finalPath, new Date(), new Date(session.clientLastModified));
      }
      const finalStat = await stat(finalPath);
      if (BigInt(finalStat.size) !== BigInt(session.sizeBytes)) {
        logger.fatal({ event: 'resumable_upload_final_size_mismatch', userId: user.id, sessionId, expectedBytes: session.sizeBytes, actualBytes: finalStat.size }, 'Finalized file size did not match the declared original size');
        throw new HttpError(500, 'Final file size verification failed');
      }
      const sha256 = await hashFile(finalPath);
      const metadata = await extractMetadata(finalPath);
      const completed = await commitCompletedFile(client, user, session, sha256, metadata);
      await unlink(partPath).catch((error) => logger.warn({ event: 'completed_upload_part_cleanup_failed', userId: user.id, sessionId, err: error }, 'Completed upload part file could not be removed'));
      await rm(chunkDirectory(user, sessionId), { recursive: true, force: true }).catch((error) => logger.warn({ event: 'completed_upload_chunk_directory_cleanup_failed', userId: user.id, sessionId, err: error }, 'Completed upload staging directory could not be removed'));
      logger.info({
        event: 'resumable_upload_completed',
        userId: user.id,
        username: user.username,
        sessionId,
        fileId: completed.id,
        originalName: completed.name,
        relativePath: session.finalRelativePath,
        sizeBytes: completed.sizeBytes,
        sha256,
        metadataFieldCount: Object.keys(metadata).length,
      }, 'Resumable upload was stored byte-for-byte and indexed');
      return completed;
    }
    throw new HttpError(409, 'Destination changed too many times; retry finalization');
  } finally {
    let lockReleaseError: Error | undefined;
    if (lockHeld) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', [lockKey]);
        if (!unlocked.rows[0]?.unlocked) throw new Error('User mutation lock was not held by this connection');
      } catch (error) {
        lockReleaseError = error instanceof Error ? error : new Error('User mutation lock release failed');
        logger.error({ event: 'resumable_upload_lock_release_failed', userId: user.id, sessionId, err: lockReleaseError }, 'Resumable upload mutation lock connection was discarded');
      }
    }
    client.release(lockReleaseError);
  }
}

async function createOrResumeSession(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const input = normalizeUploadInput(req.body);
  const identityHash = uploadIdentityHash(user.id, input);
  const client = await db.connect();
  let session: UploadSessionRow | null = null;
  let completedExisting: CompletedFile | null = null;
  let inserted = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${user.id}`]);
    const completed = await client.query<CompletedFile>(`
      SELECT id,stored_name AS name,size_bytes::text AS "sizeBytes",sha256
      FROM files WHERE user_id=$1 AND upload_identity_hash=$2 AND trashed_at IS NULL
    `, [user.id, identityHash]);
    if (completed.rowCount) {
      completedExisting = completed.rows[0]!;
      await client.query('COMMIT');
    } else {
      const existing = await client.query<UploadSessionRow>(`
        SELECT ${SESSION_COLUMNS} FROM upload_sessions WHERE user_id=$1 AND identity_hash=$2 FOR UPDATE
      `, [user.id, identityHash]);
      if (existing.rowCount) {
        session = existing.rows[0]!;
        await reconcilePartWithDatabase(user, session);
        await client.query('UPDATE upload_sessions SET updated_at=now() WHERE id=$1', [session.id]);
      } else {
        await assertStorageAvailable(user.id, input.sizeBytes, client);
        let destinationFolderPath = '';
        if (input.folderId) {
          const folder = await client.query<{ relative_path: string }>('SELECT relative_path FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [input.folderId, user.id]);
          if (!folder.rowCount) throw new HttpError(404, 'Destination folder not found');
          destinationFolderPath = folder.rows[0]!.relative_path;
        }
        const id = randomUUID();
        const fileId = randomUUID();
        const tempRelativePath = expectedTempRelativePath(user.storageKey, id);
        const created = await client.query<UploadSessionRow>(`
          INSERT INTO upload_sessions(
            id,file_id,user_id,client_fingerprint,identity_hash,destination_folder_id,destination_folder_path,
            relative_directory,original_name,mime_type,size_bytes,client_last_modified,temp_relative_path
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          RETURNING ${SESSION_COLUMNS}
        `, [
          id,
          fileId,
          user.id,
          input.fingerprint,
          identityHash,
          input.folderId,
          destinationFolderPath,
          input.relativeDirectory,
          input.originalName,
          input.mimeType,
          input.sizeBytes.toString(),
          input.lastModified,
          tempRelativePath,
        ]);
        session = created.rows[0]!;
        await ensurePartFile(user, session);
        inserted = true;
      }
      await client.query('COMMIT');
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }

  if (completedExisting) {
    logForRequest(req).debug({ event: 'completed_resumable_upload_recovered', fileId: completedExisting.id, fingerprintHashPrefix: identityHash.slice(0, 12) }, 'Previously completed upload was recovered by its stable identity');
    res.status(200).json({ complete: true, file: completedExisting });
    return;
  }
  if (!session) throw new Error('Upload session creation returned no session');

  logForRequest(req)[inserted ? 'info' : 'debug']({
    event: inserted ? 'resumable_upload_session_created' : 'resumable_upload_session_resumed',
    sessionId: session.id,
    originalName: session.originalName,
    sizeBytes: session.sizeBytes,
    offsetBytes: session.offsetBytes,
    destinationFolderId: session.destinationFolderId,
    relativeDirectory: session.relativeDirectory,
    fingerprintHashPrefix: identityHash.slice(0, 12),
  }, inserted ? 'Resumable upload session created' : 'Existing resumable upload session resumed');

  if (BigInt(session.offsetBytes) === BigInt(session.sizeBytes)) {
    const file = await finalizeSession(user, session.id, session.fileId);
    res.status(inserted ? 201 : 200).json({ complete: true, file });
    return;
  }
  setUploadHeaders(res, session);
  res.status(inserted ? 201 : 200).json(sessionResponse(session));
}

async function getSession(req: Request, res: Response, headOnly: boolean): Promise<void> {
  const sessionId = String(req.params.id ?? '');
  if (!UUID_PATTERN.test(sessionId)) throw new HttpError(400, 'Upload session id is invalid');
  const session = await sessionState(req.user!, sessionId);
  setUploadHeaders(res, session);
  logForRequest(req).trace({ event: 'resumable_upload_session_state_read', sessionId, offsetBytes: session.offsetBytes, sizeBytes: session.sizeBytes, status: session.status }, 'Resumable upload session state was read');
  if (headOnly) {
    res.status(204).end();
    return;
  }
  res.json(sessionResponse(session));
}

async function patchSession(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const sessionId = String(req.params.id ?? '');
  if (!UUID_PATTERN.test(sessionId)) throw new HttpError(400, 'Upload session id is invalid');
  const contentType = (req.header('content-type') ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (contentType !== 'application/offset+octet-stream' && contentType !== 'application/octet-stream') {
    throw new HttpError(415, 'PATCH chunks require application/offset+octet-stream');
  }
  const requestedOffset = parseUploadOffset(req.header('upload-offset'));
  const initial = await loadSession(db, user.id, sessionId);
  if (!initial) throw new HttpError(404, 'Upload session not found');
  const initialOffset = BigInt(initial.offsetBytes);
  if (requestedOffset !== initialOffset) throw new OffsetMismatchError(initialOffset);
  const remaining = BigInt(initial.sizeBytes) - initialOffset;
  logForRequest(req).trace({ event: 'resumable_chunk_staging_started', sessionId, requestedOffset: requestedOffset.toString(), remainingBytes: remaining.toString(), contentLength: req.header('content-length') }, 'Incoming resumable chunk staging started');
  const staged = await stageChunk(req, user, sessionId, remaining);
  try {
    logForRequest(req).debug({ event: 'resumable_chunk_staged', sessionId, requestedOffset: requestedOffset.toString(), chunkBytes: staged.size.toString() }, 'Incoming resumable chunk was staged and synced');
    const appended = await appendStagedChunk(user, sessionId, requestedOffset, staged.path, staged.size);
    if (appended.complete) {
      const file = await finalizeSession(user, sessionId, appended.session.fileId);
      res.status(201).json({ complete: true, file });
      return;
    }
    setUploadHeaders(res, appended.session);
    res.status(204).end();
  } finally {
    await unlink(staged.path).catch(() => undefined);
  }
}

async function cancelSession(req: Request, res: Response): Promise<void> {
  const user = req.user!;
  const sessionId = String(req.params.id ?? '');
  if (!UUID_PATTERN.test(sessionId)) throw new HttpError(400, 'Upload session id is invalid');
  const client = await db.connect();
  const lockKey = `originvault:${user.id}`;
  let session: UploadSessionRow | null = null;
  let lockHeld = false;
  let transactionStarted = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    lockHeld = true;
    await client.query('BEGIN');
    transactionStarted = true;
    session = await loadSession(client, user.id, sessionId, true);
    if (!session) throw new HttpError(404, 'Upload session not found');
    await client.query('DELETE FROM upload_sessions WHERE id=$1 AND user_id=$2', [sessionId, user.id]);
    await client.query('COMMIT');
    transactionStarted = false;
    const partPath = sessionPartPath(user, session);
    if (session.finalRelativePath) {
      const finalPath = resolveInside(userFilesRoot(user.storageKey), session.finalRelativePath);
      if (await sameFile(partPath, finalPath)) await unlink(finalPath).catch(() => undefined);
    }
    await unlink(partPath).catch(() => undefined);
    await rm(chunkDirectory(user, sessionId), { recursive: true, force: true }).catch(() => undefined);
    logForRequest(req).warn({ event: 'resumable_upload_session_cancelled', sessionId, originalName: session.originalName, offsetBytes: session.offsetBytes, sizeBytes: session.sizeBytes }, 'Resumable upload session and temporary bytes were cancelled');
    res.status(204).end();
  } catch (error) {
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    let lockReleaseError: Error | undefined;
    if (lockHeld) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', [lockKey]);
        if (!unlocked.rows[0]?.unlocked) throw new Error('User mutation lock was not held by this connection');
      } catch (error) {
        lockReleaseError = error instanceof Error ? error : new Error('User mutation lock release failed');
        logger.error({ event: 'resumable_cancel_lock_release_failed', userId: user.id, sessionId, err: lockReleaseError }, 'Resumable upload cancellation lock connection was discarded');
      }
    }
    client.release(lockReleaseError);
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
function asyncHandler(handler: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

export function createResumableUploadRouter(): Router {
  const router = Router();
  router.post(`${SESSION_ROUTE}/collisions`, express.json({ limit: '64kb' }), requireAuth, asyncHandler(async (req, res) => {
    res.json({ conflicts: await uploadCollisions(req.user!, parseUploadCollisionEntries(req.body?.entries)) });
  }));
  router.post(SESSION_ROUTE, express.json({ limit: '64kb' }), requireAuth, asyncHandler(async (req, res) => createOrResumeSession(req, res)));
  router.head(`${SESSION_ROUTE}/:id`, requireAuth, asyncHandler(async (req, res) => getSession(req, res, true)));
  router.get(`${SESSION_ROUTE}/:id`, requireAuth, asyncHandler(async (req, res) => getSession(req, res, false)));
  router.patch(`${SESSION_ROUTE}/:id`, requireAuth, asyncHandler(async (req, res) => patchSession(req, res)));
  router.delete(`${SESSION_ROUTE}/:id`, requireAuth, asyncHandler(async (req, res) => cancelSession(req, res)));
  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const known = error instanceof HttpError || error instanceof StorageQuotaError;
    const statusCode = known ? error.statusCode : 500;
    if (error instanceof HttpError) {
      for (const [name, value] of Object.entries(error.headers)) res.setHeader(name, value);
    }
    const fields = {
      event: 'resumable_upload_request_failed',
      sessionId: req.params.id,
      method: req.method,
      path: req.path,
      statusCode,
      err: error,
    };
    if (statusCode >= 500) logForRequest(req).error(fields, 'Resumable upload request failed');
    else logForRequest(req).warn(fields, 'Resumable upload request was rejected');
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Resumable upload failed' });
  });
  return router;
}

export const resumableUploadRouter = createResumableUploadRouter();
