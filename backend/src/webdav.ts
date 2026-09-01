import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, open, rename, rm, stat, utimes } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { requireAuth } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { logForRequest } from './logger.js';
import {
  DAV_MUTATION_STAGING,
  fileSha256,
  mutationBackupPath,
  mutationEditPath,
  mutationStagingRoot,
  removeMutationJournal,
  writeMutationJournal,
} from './mutationJournal.js';
import { assertStorageAvailable, getStorageUsage, StorageQuotaError, type StorageUsage } from './quota.js';
import { extractMetadata, isHiddenResource, originalCreatedAtFromMetadata, resolveInside, safeSegment, userFilesRoot } from './storage.js';
import { pruneEmptyActiveFolders, removeEmptyActiveFolderPaths } from './folderCleanup.js';
import { moveSelectionsToTrash } from './trash.js';

class DavError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

interface DavIdentity {
  tokenId: string;
  userId: string;
  username: string;
  storageKey: string;
  trashEnabled: boolean;
  folderId: string | null;
  scopePath: string;
  scopeName: string;
  access: 'read' | 'readwrite';
}

interface DavResource {
  type: 'file' | 'folder';
  id: string | null;
  folderId: string | null;
  parentId?: string | null;
  name: string;
  relativePath: string;
  mimeType?: string;
  sizeBytes?: string;
  sha256?: string;
  createdAt: Date | string;
  modifiedAt: Date | string;
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
type Queryable = Pool | PoolClient;
const asyncHandler = (handler: AsyncHandler) => (req: Request, res: Response, next: NextFunction): void => { handler(req, res, next).catch(next); };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TOKEN_PATTERN = /^ovd_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([A-Za-z0-9_-]{32,})$/i;
const WEBDAV_MTIME_HEADERS = ['x-oc-mtime', 'x-upload-mtime', 'x-file-mtime', 'x-last-modified', 'last-modified'] as const;
const MIME_TYPE_PATTERN = /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/;

export function parseWebdavMtime(value: string | undefined): Date | null {
  const normalized = value?.trim();
  if (!normalized) return null;
  let milliseconds: number;
  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) return null;
    milliseconds = Math.abs(numeric) < 100_000_000_000 ? numeric * 1000 : numeric;
  } else milliseconds = Date.parse(normalized);
  if (!Number.isFinite(milliseconds) || Math.abs(milliseconds) > 8_640_000_000_000_000) return null;
  const parsed = new Date(milliseconds);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function requestClientModifiedTime(req: Request): { value: Date; headerName: string } | null {
  for (const headerName of WEBDAV_MTIME_HEADERS) {
    const rawValue = req.header(headerName);
    if (rawValue === undefined) continue;
    const value = parseWebdavMtime(rawValue);
    if (value) return { value, headerName };
    logForRequest(req).warn({ event: 'webdav_mtime_header_invalid', headerName }, 'Invalid WebDAV client modification time was ignored');
  }
  return null;
}

function normalizedMimeType(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const mimeType = value.split(';', 1)[0]!.trim().toLowerCase();
  return mimeType && mimeType.length <= 255 && MIME_TYPE_PATTERN.test(mimeType) ? mimeType : null;
}

export function webdavContentType(requested: string | undefined, metadata: Record<string, unknown>): string {
  const requestedMimeType = normalizedMimeType(requested);
  const extractedMimeType = normalizedMimeType(metadata['File:MIMEType']);
  if (!requestedMimeType || requestedMimeType === 'application/octet-stream') {
    return extractedMimeType ?? requestedMimeType ?? 'application/octet-stream';
  }
  return requestedMimeType;
}

export function webdavQuota(usage: Pick<StorageUsage, 'usedBytes' | 'reservedBytes' | 'quotaBytes'>): { usedBytes: string; availableBytes: string } | null {
  if (usage.quotaBytes === null) return null;
  const usedBytes = BigInt(usage.usedBytes) + BigInt(usage.reservedBytes);
  const availableBytes = BigInt(usage.quotaBytes) - usedBytes;
  return {
    usedBytes: usedBytes.toString(),
    availableBytes: (availableBytes > 0n ? availableBytes : 0n).toString(),
  };
}

async function syncRenameDirectories(sourcePath: string, targetPath: string): Promise<void> {
  const sourceDirectory = path.dirname(sourcePath);
  const targetDirectory = path.dirname(targetPath);
  const sourceHandle = await open(sourceDirectory, 'r');
  try { await sourceHandle.sync(); } finally { await sourceHandle.close(); }
  if (targetDirectory !== sourceDirectory) {
    const targetHandle = await open(targetDirectory, 'r');
    try { await targetHandle.sync(); } finally { await targetHandle.close(); }
  }
}

async function movedFolderMtimes(
  root: string,
  sourceRelativePath: string,
  targetRelativePath: string,
  files: Array<{ relativePath: string }>,
): Promise<Date[]> {
  const mtimes: Date[] = [];
  for (let index = 0; index < files.length; index += 32) {
    const batch = await Promise.all(files.slice(index, index + 32).map(async (file) => {
      const movedRelativePath = targetRelativePath + file.relativePath.slice(sourceRelativePath.length);
      const fileStat = await stat(resolveInside(root, movedRelativePath));
      if (!fileStat.isFile()) throw new DavError(409, 'Moved file is not a regular file');
      return fileStat.mtime;
    }));
    mtimes.push(...batch);
  }
  return mtimes;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function requestBaseUrl(req: Request): string {
  return config.publicUrl || `${req.protocol}://${req.get('host')}`;
}

function issueCredential(id: string): string {
  return `ovd_${id}_${randomBytes(32).toString('base64url')}`;
}

function readCredential(req: Request): { token: string; username?: string } | null {
  const authorization = req.header('authorization') ?? '';
  if (/^Bearer /i.test(authorization)) return { token: authorization.slice(7).trim() };
  if (/^Basic /i.test(authorization)) {
    try {
      const decoded = Buffer.from(authorization.slice(6).trim(), 'base64').toString('utf8');
      const separator = decoded.indexOf(':');
      if (separator < 0) return null;
      return { username: decoded.slice(0, separator), token: decoded.slice(separator + 1) };
    } catch { return null; }
  }
  return null;
}

async function authenticateDav(req: Request): Promise<DavIdentity> {
  const credential = readCredential(req);
  const match = credential?.token.match(TOKEN_PATTERN);
  if (!credential || !match) throw new DavError(401, 'WebDAV authentication required');
  const result = await db.query(`
    SELECT t.id AS "tokenId",t.user_id AS "userId",u.username,u.storage_key AS "storageKey",u.trash_enabled AS "trashEnabled",
      t.folder_id AS "folderId",COALESCE(f.relative_path,'') AS "scopePath",COALESCE(f.name,'내 파일') AS "scopeName",t.access,t.secret_hash AS "secretHash"
    FROM webdav_tokens t
    JOIN users u ON u.id=t.user_id AND u.disabled_at IS NULL
    LEFT JOIN folders f ON f.id=t.folder_id AND f.user_id=t.user_id AND f.trashed_at IS NULL
    WHERE t.id=$1 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now())
      AND (t.folder_id IS NULL OR f.id IS NOT NULL)
  `, [match[1]]);
  const identity = result.rows[0];
  if (!identity || (credential.username !== undefined && credential.username !== identity.username)) throw new DavError(401, 'WebDAV authentication required');
  const expected = Buffer.from(identity.secretHash, 'hex');
  const actual = Buffer.from(hashToken(credential.token), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new DavError(401, 'WebDAV authentication required');
  await db.query('UPDATE webdav_tokens SET last_used_at=now() WHERE id=$1', [identity.tokenId]);
  return identity as DavIdentity;
}

function strictSegments(value: string): string[] {
  const raw = value.replace(/^\/+|\/+$/g, '');
  if (!raw) return [];
  return raw.split('/').map((entry) => {
    let segment: string;
    try { segment = decodeURIComponent(entry); }
    catch { throw new DavError(400, 'Invalid WebDAV path encoding'); }
    if (!segment || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || safeSegment(segment) !== segment) {
      throw new DavError(400, 'Invalid WebDAV resource name');
    }
    return segment;
  });
}

function relativePath(identity: DavIdentity, segments: string[]): string {
  return [identity.scopePath, ...segments].filter(Boolean).join('/');
}

async function resourceAt(identity: DavIdentity, segments: string[], queryable: Queryable = db): Promise<DavResource | null> {
  const requestedPath = relativePath(identity, segments);
  if (!segments.length) {
    return {
      type: 'folder', id: identity.folderId, folderId: identity.folderId, name: identity.scopeName,
      relativePath: identity.scopePath, createdAt: new Date(0), modifiedAt: new Date(),
    };
  }
  const folder = await queryable.query(`
    SELECT id,parent_id AS "parentId",name,relative_path AS "relativePath",created_at AS "createdAt",modified_at AS "modifiedAt"
    FROM folders WHERE user_id=$1 AND relative_path=$2 AND trashed_at IS NULL
  `, [identity.userId, requestedPath]);
  if (folder.rowCount) return { type: 'folder', folderId: folder.rows[0].id, ...folder.rows[0] } as DavResource;
  const file = await queryable.query(`
    SELECT id,folder_id AS "folderId",stored_name AS name,relative_path AS "relativePath",mime_type AS "mimeType",
      size_bytes::text AS "sizeBytes",sha256,created_at AS "createdAt",COALESCE(client_last_modified,modified_at) AS "modifiedAt"
    FROM files WHERE user_id=$1 AND relative_path=$2 AND trashed_at IS NULL ORDER BY created_at LIMIT 1
  `, [identity.userId, requestedPath]);
  return file.rows[0] ? { type: 'file', ...file.rows[0] } as DavResource : null;
}

async function parentFolder(identity: DavIdentity, segments: string[], queryable: Queryable = db): Promise<{ id: string | null; relativePath: string }> {
  const parentSegments = segments.slice(0, -1);
  if (!parentSegments.length) return { id: identity.folderId, relativePath: identity.scopePath };
  const requestedPath = relativePath(identity, parentSegments);
  const result = await queryable.query<{ id: string; relativePath: string }>(`
    SELECT id,relative_path AS "relativePath" FROM folders WHERE user_id=$1 AND relative_path=$2 AND trashed_at IS NULL
  `, [identity.userId, requestedPath]);
  if (!result.rowCount) throw new DavError(409, 'Parent collection does not exist');
  return result.rows[0]!;
}

function xml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function webdavHref(segments: string[], collection: boolean): string {
  const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
  return `/webdav/${encoded}${collection && encoded ? '/' : ''}`;
}

function propertyResponse(resource: DavResource, segments: string[], quota?: { usedBytes: string; availableBytes: string } | null): string {
  const collection = resource.type === 'folder';
  const modified = new Date(resource.modifiedAt).toUTCString();
  const created = new Date(resource.createdAt).toISOString();
  return `<D:response><D:href>${xml(webdavHref(segments, collection))}</D:href><D:propstat><D:prop>`
    + `<D:displayname>${xml(resource.name)}</D:displayname>`
    + `<D:resourcetype>${collection ? '<D:collection/>' : ''}</D:resourcetype>`
    + `<D:creationdate>${xml(created)}</D:creationdate><D:getlastmodified>${xml(modified)}</D:getlastmodified>`
    + (collection && quota ? `<D:quota-used-bytes>${xml(quota.usedBytes)}</D:quota-used-bytes><D:quota-available-bytes>${xml(quota.availableBytes)}</D:quota-available-bytes>` : '')
    + (collection ? '' : `<D:getcontentlength>${xml(resource.sizeBytes)}</D:getcontentlength><D:getcontenttype>${xml(resource.mimeType)}</D:getcontenttype><D:getetag>"sha256-${xml(resource.sha256)}"</D:getetag>`)
    + `</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
}

function ensureWritable(identity: DavIdentity): void {
  if (identity.access !== 'readwrite') throw new DavError(403, 'This WebDAV token is read-only');
}

async function handlePropfind(req: Request, res: Response, identity: DavIdentity, segments: string[]): Promise<void> {
  const resource = await resourceAt(identity, segments);
  if (!resource) throw new DavError(404, 'Resource not found');
  const depth = req.header('depth') ?? '1';
  if (depth !== '0' && depth !== '1') throw new DavError(403, 'Only Depth 0 and 1 are supported');
  const quota = resource.type === 'folder' ? webdavQuota(await getStorageUsage(identity.userId)) : null;
  const responses = [propertyResponse(resource, segments, quota)];
  if (depth === '1' && resource.type === 'folder') {
    const [folders, files] = await Promise.all([
      db.query(`SELECT id,name,relative_path AS "relativePath",created_at AS "createdAt",modified_at AS "modifiedAt" FROM folders WHERE user_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND trashed_at IS NULL ORDER BY name`, [identity.userId, resource.folderId]),
      db.query(`SELECT id,folder_id AS "folderId",stored_name AS name,relative_path AS "relativePath",mime_type AS "mimeType",size_bytes::text AS "sizeBytes",sha256,created_at AS "createdAt",COALESCE(client_last_modified,modified_at) AS "modifiedAt" FROM files WHERE user_id=$1 AND folder_id IS NOT DISTINCT FROM $2 AND trashed_at IS NULL ORDER BY stored_name`, [identity.userId, resource.folderId]),
    ]);
    for (const folder of folders.rows) responses.push(propertyResponse({ type: 'folder', folderId: folder.id, ...folder } as DavResource, [...segments, folder.name]));
    for (const file of files.rows) responses.push(propertyResponse({ type: 'file', ...file } as DavResource, [...segments, file.name]));
  }
  req.resume();
  res.status(207).type('application/xml').send(`<?xml version="1.0" encoding="utf-8"?><D:multistatus xmlns:D="DAV:">${responses.join('')}</D:multistatus>`);
}

async function handleGet(req: Request, res: Response, identity: DavIdentity, segments: string[]): Promise<void> {
  const client = await db.connect();
  let resource: DavResource;
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  let fileSize = 0;
  let modifiedAt = new Date();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [`originvault:${identity.userId}`]);
    const current = await resourceAt(identity, segments, client);
    if (!current) throw new DavError(404, 'Resource not found');
    if (current.type !== 'file') throw new DavError(405, 'Collections cannot be downloaded');
    resource = current;
    const absolutePath = resolveInside(userFilesRoot(identity.storageKey), resource.relativePath);
    fileHandle = await open(absolutePath, 'r');
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile() || BigInt(fileStat.size) !== BigInt(resource.sizeBytes!)) throw new DavError(409, 'Stored resource is inconsistent');
    fileSize = fileStat.size;
    modifiedAt = new Date(resource.modifiedAt);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await fileHandle?.close().catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  res.setHeader('Content-Type', resource.mimeType ?? 'application/octet-stream');
  res.setHeader('ETag', `"sha256-${resource.sha256}"`);
  res.setHeader('Last-Modified', modifiedAt.toUTCString());
  res.setHeader('Accept-Ranges', 'bytes');
  let requestedRange = req.header('range');
  if (requestedRange?.includes(',')) requestedRange = undefined;
  let start = 0;
  let end = Math.max(0, fileSize - 1);
  if (requestedRange) {
    const match = requestedRange.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2]) || fileSize === 0) {
      await fileHandle!.close();
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).end();
      return;
    }
    if (match[1]) {
      start = Number(match[1]);
      end = match[2] ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
    } else {
      start = Math.max(0, fileSize - Number(match[2]));
      end = fileSize - 1;
    }
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= fileSize) {
      await fileHandle!.close();
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).end();
      return;
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  }
  res.setHeader('Content-Length', requestedRange ? end - start + 1 : fileSize);
  if (req.method === 'HEAD' || fileSize === 0) {
    await fileHandle!.close();
    res.end();
    return;
  }
  try {
    await pipeline(fileHandle!.createReadStream({ start, end, autoClose: false }), res);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (!req.destroyed && !res.destroyed && code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ECONNRESET') {
      logForRequest(req).error({ event: 'webdav_get_stream_failed', tokenId: identity.tokenId, relativePath: resource.relativePath, err: error }, 'WebDAV GET stream failed');
      res.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    await fileHandle!.close().catch(() => undefined);
  }
}

async function handlePut(req: Request, res: Response, identity: DavIdentity, segments: string[]): Promise<void> {
  ensureWritable(identity);
  if (!segments.length) throw new DavError(405, 'Cannot replace the WebDAV root');
  const name = segments.at(-1)!;
  let existing = await resourceAt(identity, segments);
  if (existing?.type === 'folder') throw new DavError(405, 'A collection already exists at this path');
  let parent = await parentFolder(identity, segments);
  const declaredLength = req.header('content-length');
  if (declaredLength && (!/^\d+$/.test(declaredLength) || BigInt(declaredLength) > BigInt(config.maxUploadBytes))) throw new DavError(413, 'File is too large');
  if (declaredLength) {
    const declaredBytes = BigInt(declaredLength);
    const existingBytes = existing?.sizeBytes ? BigInt(existing.sizeBytes) : 0n;
    await assertStorageAvailable(identity.userId, declaredBytes > existingBytes ? declaredBytes - existingBytes : 0n);
  }
  const clientModifiedTime = requestClientModifiedTime(req);

  const stagingDirectory = mutationStagingRoot(DAV_MUTATION_STAGING);
  await mkdir(stagingDirectory, { recursive: true, mode: 0o700 });
  const operationId = randomUUID();
  const stagedPath = mutationEditPath(stagingDirectory, operationId);
  const targetRelativePath = relativePath(identity, segments);
  const targetPath = resolveInside(userFilesRoot(identity.storageKey), targetRelativePath);
  const backupPath = mutationBackupPath(stagingDirectory, operationId);
  const client = await db.connect();
  const lockKey = `originvault:${identity.userId}`;
  let lockHeld = false;
  let transactionStarted = false;
  let backedUp = false;
  let installed = false;
  let committed = false;
  let restored = false;
  let stateKnown = false;
  let replacedExisting = false;
  let oldFileId = '';
  let oldSha256 = '';
  let oldRowVersion = '';
  let fileIdAtCommit = '';
  let sha256 = '';
  let size = 0n;
  let routeError: unknown;
  let journalWritten = false;
  let clientMtimeAccepted = false;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    lockHeld = true;
    existing = await resourceAt(identity, segments, client);
    if (existing?.type === 'folder') throw new DavError(405, 'A collection already exists at this path');
    parent = await parentFolder(identity, segments, client);
    const usage = await getStorageUsage(identity.userId, client);
    const initialOldSize = existing?.sizeBytes ? BigInt(existing.sizeBytes) : 0n;
    let maximumTargetBytes = BigInt(config.maxUploadBytes) > initialOldSize ? BigInt(config.maxUploadBytes) : initialOldSize;
    if (usage.quotaBytes !== null) {
      const available = BigInt(usage.quotaBytes) - (BigInt(usage.usedBytes) - initialOldSize + BigInt(usage.reservedBytes));
      const quotaMaximum = available > initialOldSize ? available : initialOldSize;
      if (quotaMaximum < maximumTargetBytes) maximumTargetBytes = quotaMaximum;
    }
    const hash = createHash('sha256');
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        size += BigInt(chunk.length);
        if (size > maximumTargetBytes) { callback(new StorageQuotaError()); return; }
        hash.update(chunk); callback(null, chunk);
      },
    });
    await pipeline(req, meter, createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }));
    sha256 = hash.digest('hex');
    let requestedLastModified = clientModifiedTime?.value ?? new Date();
    try {
      await utimes(stagedPath, new Date(), requestedLastModified);
    } catch (error) {
      if (!clientModifiedTime) throw error;
      logForRequest(req).warn({ event: 'webdav_mtime_not_supported', headerName: clientModifiedTime.headerName, err: error }, 'Filesystem rejected the WebDAV client modification time; upload time will be used');
      requestedLastModified = new Date();
      await utimes(stagedPath, new Date(), requestedLastModified);
    }
    const clientLastModified = (await stat(stagedPath)).mtime;
    clientMtimeAccepted = Boolean(clientModifiedTime && clientLastModified.getTime() === clientModifiedTime.value.getTime());
    if (clientModifiedTime && !clientMtimeAccepted) {
      logForRequest(req).warn({
        event: 'webdav_mtime_adjusted',
        headerName: clientModifiedTime.headerName,
        requested: clientModifiedTime.value.toISOString(),
        stored: clientLastModified.toISOString(),
      }, 'Filesystem adjusted the WebDAV client modification time');
    }
    const stagedHandle = await open(stagedPath, 'r');
    try { await stagedHandle.sync(); } finally { await stagedHandle.close(); }

    await client.query('BEGIN');
    transactionStarted = true;
    const currentToken = await client.query(`
      SELECT t.folder_id,COALESCE(f.relative_path,'') AS scope_path
      FROM webdav_tokens t JOIN users u ON u.id=t.user_id AND u.disabled_at IS NULL
       LEFT JOIN folders f ON f.id=t.folder_id AND f.user_id=t.user_id AND f.trashed_at IS NULL
      WHERE t.id=$1 AND t.user_id=$2 AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>now())
        AND (t.folder_id IS NULL OR f.id IS NOT NULL)
    `, [identity.tokenId, identity.userId]);
    if (!currentToken.rowCount || currentToken.rows[0].scope_path !== identity.scopePath) throw new DavError(409, 'WebDAV scope changed while the upload was in progress');
    if (parent.id) {
      const currentParent = await client.query('SELECT relative_path FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [parent.id, identity.userId]);
      if (!currentParent.rowCount || currentParent.rows[0].relative_path !== parent.relativePath) throw new DavError(409, 'Parent collection changed while the upload was in progress');
    }
      const lockedFolder = await client.query('SELECT id FROM folders WHERE user_id=$1 AND relative_path=$2 AND trashed_at IS NULL', [identity.userId, targetRelativePath]);
    if (lockedFolder.rowCount) throw new DavError(405, 'A collection already exists at this path');
    const reservedUpload = await client.query(
      'SELECT 1 FROM upload_sessions WHERE user_id=$1 AND final_relative_path=$2',
      [identity.userId, targetRelativePath],
    );
    if (reservedUpload.rowCount) throw new DavError(409, 'An upload is already finalizing at this path');
    const lockedFile = await client.query(`
      SELECT id,folder_id AS "folderId",stored_name AS name,relative_path AS "relativePath",mime_type AS "mimeType",
        size_bytes::text AS "sizeBytes",sha256,xmin::text AS "rowVersion",created_at AS "createdAt",modified_at AS "modifiedAt"
      FROM files WHERE user_id=$1 AND relative_path=$2 AND trashed_at IS NULL ORDER BY created_at LIMIT 1 FOR UPDATE
    `, [identity.userId, targetRelativePath]);
    existing = lockedFile.rows[0] ? { type: 'file', ...lockedFile.rows[0] } as DavResource : null;
    replacedExisting = Boolean(existing);
    const currentOldSize = existing?.sizeBytes ? BigInt(existing.sizeBytes) : 0n;
    const additional = size > currentOldSize ? size - currentOldSize : 0n;
    await assertStorageAvailable(identity.userId, additional, client);
    await mkdir(path.dirname(targetPath), { recursive: true });
    fileIdAtCommit = existing?.id ?? randomUUID();
    if (existing) {
      oldFileId = existing.id!;
      oldSha256 = existing.sha256!;
      oldRowVersion = (existing as DavResource & { rowVersion: string }).rowVersion;
    }
    await writeMutationJournal(stagingDirectory, {
      version: 1,
      operationId,
      source: 'webdav-put',
      kind: existing ? 'replace' : 'create',
      userId: identity.userId,
      fileId: fileIdAtCommit,
      relativePath: targetRelativePath,
      oldSha256: existing ? oldSha256 : null,
      oldRowVersion: existing ? oldRowVersion : undefined,
      newSha256: sha256,
      createdAt: new Date().toISOString(),
    });
    journalWritten = true;
    if (existing) {
      await link(targetPath, backupPath);
      backedUp = true;
      if (await fileSha256(backupPath) !== oldSha256) throw new DavError(409, 'Stored content does not match its indexed hash');
      const durableBackupDirectory = await open(stagingDirectory, 'r');
      try { await durableBackupDirectory.sync(); } finally { await durableBackupDirectory.close(); }
      await rename(stagedPath, targetPath);
    } else {
      try { await stat(targetPath); throw new DavError(409, 'An unindexed resource already exists at this path'); }
      catch (error: any) { if (error instanceof DavError || error?.code !== 'ENOENT') throw error; }
      await rename(stagedPath, targetPath);
    }
    installed = true;
    const targetDirectory = await open(path.dirname(targetPath), 'r');
    try { await targetDirectory.sync(); } finally { await targetDirectory.close(); }
    const stagingHandle = await open(stagingDirectory, 'r');
    try { await stagingHandle.sync(); } finally { await stagingHandle.close(); }
    const metadata = await extractMetadata(targetPath);
    const mimeType = webdavContentType(req.header('content-type'), metadata);
    if (existing) {
      await client.query(`
        UPDATE files SET folder_id=$1,stored_name=$2,relative_path=$3,mime_type=$4,size_bytes=$5,sha256=$6,
          upload_identity_hash=NULL,client_last_modified=$7,extracted_metadata=$8,is_hidden=$9,original_created_at=$10,modified_at=now(),
          text_encoding=NULL,text_has_bom=NULL
        WHERE id=$11 AND user_id=$12
      `, [parent.id, name, targetRelativePath, mimeType, size.toString(), sha256, clientLastModified, metadata, isHiddenResource(name, metadata), originalCreatedAtFromMetadata(metadata) ?? null, existing.id, identity.userId]);
    } else {
      await client.query(`
        INSERT INTO files(id,user_id,folder_id,original_name,stored_name,relative_path,mime_type,size_bytes,sha256,client_last_modified,extracted_metadata,is_hidden,original_created_at,modified_at)
        VALUES($1,$2,$3,$4,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
      `, [fileIdAtCommit, identity.userId, parent.id, name, targetRelativePath, mimeType, size.toString(), sha256, clientLastModified, metadata, isHiddenResource(name, metadata), originalCreatedAtFromMetadata(metadata) ?? null]);
    }
    await client.query('COMMIT');
    transactionStarted = false;
    committed = true;
    logForRequest(req).info({
      event: 'webdav_put_completed',
      relativePath: targetRelativePath,
      sizeBytes: size.toString(),
      sha256,
      mimeType,
      clientLastModified: clientLastModified.toISOString(),
      clientMtimeHeader: clientModifiedTime?.headerName,
      clientMtimeAccepted,
      metadataFieldCount: Object.keys(metadata).length,
    }, 'WebDAV upload stored and indexed without transforming the original bytes');
  } catch (error) {
    routeError = error;
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    if (installed) {
      try {
        const state = await client.query<{ id: string; sha256: string; rowVersion: string }>(
          'SELECT id,sha256,xmin::text AS "rowVersion" FROM files WHERE id=$1 AND user_id=$2',
          [fileIdAtCommit, identity.userId],
        );
        stateKnown = true;
        const targetState = await fileSha256(targetPath);
        if (state.rows[0]?.sha256 === sha256 && (!replacedExisting || state.rows[0]?.rowVersion !== oldRowVersion)
          && targetState === sha256) committed = true;
        else if (replacedExisting && state.rows[0]?.id === oldFileId && state.rows[0]?.sha256 === oldSha256 && state.rows[0]?.rowVersion === oldRowVersion) {
          if (targetState === sha256 || targetState === null) {
            await rename(backupPath, targetPath);
            const targetDirectory = await open(path.dirname(targetPath), 'r');
            try { await targetDirectory.sync(); } finally { await targetDirectory.close(); }
            restored = true;
          } else if (targetState === oldSha256) restored = true;
        } else if (!replacedExisting && !state.rowCount) {
          if (targetState === sha256) {
            await rm(targetPath, { force: true });
            const targetDirectory = await open(path.dirname(targetPath), 'r');
            try { await targetDirectory.sync(); } finally { await targetDirectory.close(); }
            restored = true;
          } else if (targetState === null) restored = true;
        }
      } catch (recoveryError) {
        logForRequest(req).error({ event: 'webdav_put_recovery_failed', targetRelativePath, backupPath: backedUp ? backupPath : undefined, err: recoveryError }, 'WebDAV PUT recovery failed; staged recovery data retained');
      }
    }
  } finally {
    await rm(stagedPath, { force: true }).catch(() => undefined);
    if ((backedUp || journalWritten) && (committed || restored || !installed)) {
      const cleanup = journalWritten
        ? removeMutationJournal(stagingDirectory, operationId, backedUp)
        : rm(backupPath, { force: true });
      await cleanup.catch((error) =>
        logForRequest(req).error({ event: 'webdav_put_artifact_cleanup_failed', targetRelativePath, operationId, err: error }, 'WebDAV PUT recovery artifact cleanup failed'),
      );
    }
    else if (journalWritten && installed)
      logForRequest(req).error({ event: 'webdav_put_backup_retained', targetRelativePath, backupPath: backedUp ? backupPath : undefined, operationId, stateKnown }, 'WebDAV PUT recovery artifacts were retained because database state could not be reconciled safely');
    let lockReleaseError: Error | undefined;
    if (lockHeld) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', [lockKey]);
        if (!unlocked.rows[0]?.unlocked) throw new Error('User mutation lock was not held by this connection');
      } catch (error) {
        lockReleaseError = error instanceof Error ? error : new Error('User mutation lock release failed');
      }
    }
    if (lockReleaseError)
      logForRequest(req).error({ event: 'webdav_put_lock_release_failed', err: lockReleaseError }, 'WebDAV PUT mutation lock connection was discarded');
    client.release(lockReleaseError);
  }
  if (!committed) throw routeError ?? new Error('WebDAV PUT failed');
  res.setHeader('ETag', `"sha256-${sha256}"`);
  if (clientModifiedTime?.headerName === 'x-oc-mtime' && clientMtimeAccepted) res.setHeader('X-OC-MTime', 'accepted');
  res.status(replacedExisting ? 204 : 201).end();
}

async function handleMkcol(req: Request, res: Response, identity: DavIdentity, segments: string[]): Promise<void> {
  ensureWritable(identity);
  if (!segments.length) throw new DavError(405, 'Collection already exists');
  if (Number(req.header('content-length') ?? 0) > 0) throw new DavError(415, 'MKCOL request bodies are not supported');
  const name = segments.at(-1)!;
  const requestedPath = relativePath(identity, segments);
  const absolutePath = resolveInside(userFilesRoot(identity.storageKey), requestedPath);
  const client = await db.connect();
  let created = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${identity.userId}`]);
    if (await resourceAt(identity, segments, client)) throw new DavError(405, 'Resource already exists');
    const parent = await parentFolder(identity, segments, client);
    await mkdir(absolutePath, { recursive: false, mode: 0o700 });
    created = true;
    await client.query('INSERT INTO folders(user_id,parent_id,name,relative_path,modified_at,original_created_at,original_modified_at,is_hidden) VALUES($1,$2,$3,$4,now(),now(),now(),$5)', [identity.userId, parent.id, name, requestedPath, isHiddenResource(name)]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (created) await rm(absolutePath, { recursive: true, force: true });
    throw error;
  } finally { client.release(); }
  res.status(201).end();
}

async function handleDelete(_req: Request, res: Response, identity: DavIdentity, segments: string[]): Promise<void> {
  ensureWritable(identity);
  if (!segments.length) throw new DavError(403, 'Cannot delete the WebDAV root');
  const client = await db.connect();
  let source = '';
  let staged = '';
  let moved = false;
  let prunedFolders: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${identity.userId}`]);
    const resource = await resourceAt(identity, segments, client);
    if (!resource) throw new DavError(404, 'Resource not found');
    if (identity.trashEnabled) {
      await moveSelectionsToTrash(client, identity.userId, identity.storageKey, [{ type: resource.type, id: resource.id! }]);
      await client.query('COMMIT');
      res.status(204).end();
      return;
    }
    const root = userFilesRoot(identity.storageKey);
    source = resolveInside(root, resource.relativePath);
    staged = resolveInside(root, `.originvault-dav-delete-${randomUUID()}`);
    await rename(source, staged);
    moved = true;
    if (resource.type === 'file') await client.query('DELETE FROM files WHERE id=$1 AND user_id=$2', [resource.id, identity.userId]);
    else {
      await client.query(`
        WITH RECURSIVE tree AS (
          SELECT id FROM folders WHERE id=$1 AND user_id=$2
          UNION ALL SELECT child.id FROM folders child JOIN tree parent ON child.parent_id=parent.id WHERE child.user_id=$2
        ) DELETE FROM files WHERE user_id=$2 AND folder_id IN (SELECT id FROM tree)
      `, [resource.id, identity.userId]);
      await client.query('DELETE FROM folders WHERE id=$1 AND user_id=$2', [resource.id, identity.userId]);
    }
    prunedFolders = await pruneEmptyActiveFolders(client, identity.userId, resource.type === 'file' ? resource.folderId : resource.parentId ?? null);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (moved) await rename(staged, source).catch(() => undefined);
    throw error;
  } finally { client.release(); }
  await rm(staged, { recursive: true, force: true });
  await removeEmptyActiveFolderPaths(identity.storageKey, prunedFolders);
  res.status(204).end();
}

function destinationSegments(req: Request): string[] {
  const value = req.header('destination');
  if (!value) throw new DavError(400, 'Destination header is required');
  let pathname: string;
  try { pathname = new URL(value, requestBaseUrl(req)).pathname; }
  catch { throw new DavError(400, 'Destination header is invalid'); }
  return webdavPathSegments(pathname);
}

export function webdavPathSegments(pathname: string): string[] {
  if (pathname !== '/webdav' && !pathname.startsWith('/webdav/')) throw new DavError(403, 'Destination must remain inside /webdav');
  return strictSegments(pathname.slice('/webdav'.length));
}

async function handleMove(req: Request, res: Response, identity: DavIdentity, sourceSegments: string[]): Promise<void> {
  ensureWritable(identity);
  if (!sourceSegments.length) throw new DavError(403, 'Cannot move the WebDAV root');
  const targetSegments = destinationSegments(req);
  if (!targetSegments.length) throw new DavError(403, 'Cannot overwrite the WebDAV root');
  const stagingDirectory = mutationStagingRoot(DAV_MUTATION_STAGING);
  const operationId = randomUUID();
  const client = await db.connect();
  const lockKey = `originvault:${identity.userId}`;
  let sourcePath = '';
  let targetPath = '';
  let sourceRelativePath = '';
  let targetRelativePath = '';
  let resourceId = '';
  let resourceType: 'file' | 'folder' = 'file';
  let folderFiles: Array<{ id: string; relativePath: string }> = [];
  let lockHeld = false;
  let transactionStarted = false;
  let journalWritten = false;
  let moved = false;
  let committed = false;
  let restored = false;
  let routeError: unknown;
  try {
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
    lockHeld = true;
    await client.query('BEGIN');
    transactionStarted = true;
    const source = await resourceAt(identity, sourceSegments, client);
    if (!source) throw new DavError(404, 'Resource not found');
    if (await resourceAt(identity, targetSegments, client)) throw new DavError(412, 'Destination already exists');
    const targetParent = await parentFolder(identity, targetSegments, client);
    targetRelativePath = relativePath(identity, targetSegments);
    if (source.type === 'folder' && (targetRelativePath === source.relativePath || targetRelativePath.startsWith(`${source.relativePath}/`))) throw new DavError(409, 'A folder cannot be moved into itself');
    const root = userFilesRoot(identity.storageKey);
    sourceRelativePath = source.relativePath;
    resourceId = source.id!;
    resourceType = source.type;
    sourcePath = resolveInside(root, source.relativePath);
    targetPath = resolveInside(root, targetRelativePath);
    const sourceFileStat = source.type === 'file' ? await stat(sourcePath) : null;
    if (sourceFileStat && !sourceFileStat.isFile()) throw new DavError(409, 'Stored resource is not a regular file');
    if (source.type === 'folder') {
      const descendants = await client.query<{ id: string; relativePath: string }>(`
        SELECT id,relative_path AS "relativePath" FROM files
        WHERE user_id=$1 AND left(relative_path,length($2)+1)=$2 || '/'
        ORDER BY relative_path
      `, [identity.userId, source.relativePath]);
      folderFiles = descendants.rows;
    }
    await writeMutationJournal(stagingDirectory, {
      version: 1,
      operationId,
      source: 'webdav-move',
      kind: 'move',
      userId: identity.userId,
      resourceType,
      resourceId,
      relativePath: sourceRelativePath,
      targetRelativePath,
      createdAt: new Date().toISOString(),
    });
    journalWritten = true;
    await rename(sourcePath, targetPath);
    moved = true;
    await syncRenameDirectories(sourcePath, targetPath);
    const folderFileMtimes = source.type === 'folder'
      ? await movedFolderMtimes(root, sourceRelativePath, targetRelativePath, folderFiles)
      : [];
    const targetName = targetSegments.at(-1)!;
    if (source.type === 'file') {
      await client.query(`
        UPDATE files SET folder_id=$1,original_name=$2,stored_name=$2,relative_path=$3,
          client_last_modified=$4,is_hidden=$5,
          extracted_metadata=extracted_metadata - 'System:FileName' - 'System:Directory'
            - 'System:FileAccessDate' - 'System:FileInodeChangeDate',modified_at=now()
        WHERE id=$6 AND user_id=$7
      `, [targetParent.id, targetName, targetRelativePath, sourceFileStat!.mtime, isHiddenResource(targetName), source.id, identity.userId]);
    } else {
      await client.query(`
        UPDATE folders SET name=CASE WHEN id=$1 THEN $4 ELSE name END,
          is_hidden=CASE WHEN id=$1 THEN $7 ELSE is_hidden END,
          parent_id=CASE WHEN id=$1 THEN $5 ELSE parent_id END,
          relative_path=$3 || substring(relative_path FROM length($2)+1),modified_at=now()
        WHERE user_id=$6 AND (relative_path=$2 OR left(relative_path,length($2)+1)=$2 || '/')
      `, [source.id, source.relativePath, targetRelativePath, targetName, targetParent.id, identity.userId, isHiddenResource(targetName)]);
      if (folderFiles.length) {
        const updatedFiles = await client.query(`
          UPDATE files AS indexed SET
            relative_path=$2 || substring(indexed.relative_path FROM length($1)+1),
            client_last_modified=moved.mtime,
            extracted_metadata=indexed.extracted_metadata - 'System:FileName' - 'System:Directory'
              - 'System:FileAccessDate' - 'System:FileInodeChangeDate',modified_at=now()
          FROM unnest($4::uuid[],$5::timestamptz[]) AS moved(id,mtime)
          WHERE indexed.user_id=$3 AND indexed.id=moved.id
            AND left(indexed.relative_path,length($1)+1)=$1 || '/'
        `, [source.relativePath, targetRelativePath, identity.userId, folderFiles.map((file) => file.id), folderFileMtimes]);
        if (updatedFiles.rowCount !== folderFiles.length) throw new DavError(409, 'Moved folder contents changed during the operation');
      }
    }
    await client.query('COMMIT');
    transactionStarted = false;
    committed = true;
  } catch (error) {
    routeError = error;
    if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
    if (moved) {
      try {
        const state = resourceType === 'file'
          ? await client.query<{ relativePath: string }>('SELECT relative_path AS "relativePath" FROM files WHERE id=$1 AND user_id=$2', [resourceId, identity.userId])
          : await client.query<{ relativePath: string }>('SELECT relative_path AS "relativePath" FROM folders WHERE id=$1 AND user_id=$2', [resourceId, identity.userId]);
        if (state.rows[0]?.relativePath === targetRelativePath) committed = true;
        else if (state.rows[0]?.relativePath === sourceRelativePath) {
          await rename(targetPath, sourcePath);
          await syncRenameDirectories(targetPath, sourcePath);
          restored = true;
        }
      } catch (recoveryError) {
        logForRequest(req).error({ event: 'webdav_move_recovery_failed', operationId, sourceRelativePath, targetRelativePath, err: recoveryError }, 'WebDAV MOVE recovery failed; journal retained for startup recovery');
      }
    }
  } finally {
    if (journalWritten && (committed || restored || !moved)) {
      await removeMutationJournal(stagingDirectory, operationId, false).catch((error) =>
        logForRequest(req).error({ event: 'webdav_move_journal_cleanup_failed', operationId, err: error }, 'WebDAV MOVE journal cleanup failed'),
      );
    } else if (journalWritten) {
      logForRequest(req).error({ event: 'webdav_move_journal_retained', operationId, sourceRelativePath, targetRelativePath }, 'WebDAV MOVE journal retained because filesystem and database state could not be reconciled');
    }
    let lockReleaseError: Error | undefined;
    if (lockHeld) {
      try {
        const unlocked = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', [lockKey]);
        if (!unlocked.rows[0]?.unlocked) throw new Error('User mutation lock was not held by this connection');
      } catch (error) {
        lockReleaseError = error instanceof Error ? error : new Error('User mutation lock release failed');
      }
    }
    if (lockReleaseError)
      logForRequest(req).error({ event: 'webdav_move_lock_release_failed', err: lockReleaseError }, 'WebDAV MOVE mutation lock connection was discarded');
    client.release(lockReleaseError);
  }
  if (!committed) throw routeError ?? new Error('WebDAV MOVE failed');
  res.status(201).end();
}

export function createWebdavRouter(): express.Router {
  const router = express.Router();
  router.use((req, res) => {
    void (async () => {
      const identity = await authenticateDav(req);
      const segments = strictSegments(req.path);
      res.setHeader('DAV', '1');
      res.setHeader('MS-Author-Via', 'DAV');
      res.setHeader('Allow', 'OPTIONS, PROPFIND, GET, HEAD, PUT, MKCOL, DELETE, MOVE');
      switch (req.method) {
        case 'OPTIONS': res.status(200).end(); return;
        case 'PROPFIND': await handlePropfind(req, res, identity, segments); return;
        case 'GET': case 'HEAD': await handleGet(req, res, identity, segments); return;
        case 'PUT': await handlePut(req, res, identity, segments); return;
        case 'MKCOL': await handleMkcol(req, res, identity, segments); return;
        case 'DELETE': await handleDelete(req, res, identity, segments); return;
        case 'MOVE': await handleMove(req, res, identity, segments); return;
        default: throw new DavError(405, 'WebDAV method not supported');
      }
    })().catch((error: unknown) => {
      const statusCode = error instanceof DavError || error instanceof StorageQuotaError ? error.statusCode : 500;
      if (statusCode === 401) res.setHeader('WWW-Authenticate', ['Basic realm="OriginVault WebDAV", charset="UTF-8"', 'Bearer realm="OriginVault WebDAV"']);
      if (statusCode >= 500) logForRequest(req).error({ event: 'webdav_request_failed', err: error }, 'WebDAV request failed');
      else logForRequest(req).warn({ event: 'webdav_request_rejected', statusCode, method: req.method }, 'WebDAV request rejected');
      if (!res.headersSent) res.status(statusCode).type('text/plain').send(error instanceof Error ? error.message : 'WebDAV request failed');
      else res.destroy(error instanceof Error ? error : new Error(String(error)));
    });
  });
  return router;
}

export function createWebdavManagementRouter(): express.Router {
  const router = express.Router();
  router.get('/api/webdav/tokens', requireAuth, asyncHandler(async (req, res) => {
    const result = await db.query(`
      SELECT t.id,t.name,t.folder_id AS "folderId",COALESCE(f.name,'내 파일') AS "folderName",t.access,
        t.created_at AS "createdAt",t.last_used_at AS "lastUsedAt",t.expires_at AS "expiresAt",t.revoked_at AS "revokedAt"
      FROM webdav_tokens t LEFT JOIN folders f ON f.id=t.folder_id
      WHERE t.user_id=$1 ORDER BY t.created_at DESC
    `, [req.user!.id]);
    res.json({ url: `${requestBaseUrl(req)}/webdav/`, username: req.user!.username, tokens: result.rows });
  }));
  router.post('/api/webdav/tokens', requireAuth, asyncHandler(async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 80) throw new DavError(400, 'Token name must be 1-80 characters');
    const rawFolderId = req.body?.folderId;
    if (rawFolderId !== undefined && rawFolderId !== null && rawFolderId !== '' && typeof rawFolderId !== 'string') throw new DavError(400, 'folderId must be a folder id or null');
    const folderId = rawFolderId ? rawFolderId : null;
    if (folderId && !UUID_PATTERN.test(folderId)) throw new DavError(400, 'folderId is invalid');
    if (folderId) {
      const folder = await db.query('SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [folderId, req.user!.id]);
      if (!folder.rowCount) throw new DavError(404, 'Folder not found');
    }
    if (req.body?.access !== undefined && req.body.access !== 'read' && req.body.access !== 'readwrite') throw new DavError(400, 'access must be read or readwrite');
    const access = req.body?.access === 'read' ? 'read' : 'readwrite';
    const id = randomUUID();
    const credential = issueCredential(id);
    await db.query('INSERT INTO webdav_tokens(id,user_id,folder_id,name,secret_hash,access) VALUES($1,$2,$3,$4,$5,$6)', [id, req.user!.id, folderId, name, hashToken(credential), access]);
    logForRequest(req).warn({ event: 'webdav_token_created', tokenId: id, folderId, access }, 'WebDAV token created');
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({ id, name, folderId, access, url: `${requestBaseUrl(req)}/webdav/`, username: req.user!.username, token: credential });
  }));
  router.post('/api/webdav/tokens/:id/reissue', requireAuth, asyncHandler(async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!UUID_PATTERN.test(id)) throw new DavError(404, 'WebDAV token not found');
    const credential = issueCredential(id);
    const result = await db.query(`
      UPDATE webdav_tokens
      SET secret_hash=$3,revoked_at=NULL,last_used_at=NULL
      WHERE id=$1 AND user_id=$2
      RETURNING id,name,folder_id AS "folderId",access
    `, [id, req.user!.id, hashToken(credential)]);
    if (!result.rowCount) throw new DavError(404, 'WebDAV token not found');
    logForRequest(req).warn({ event: 'webdav_token_reissued', tokenId: id }, 'WebDAV token secret reissued and previous credential invalidated');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...result.rows[0], url: `${requestBaseUrl(req)}/webdav/`, username: req.user!.username, token: credential });
  }));
  router.delete('/api/webdav/tokens/:id', requireAuth, asyncHandler(async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!UUID_PATTERN.test(id)) throw new DavError(404, 'WebDAV token not found');
    const result = await db.query('UPDATE webdav_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id', [id, req.user!.id]);
    if (!result.rowCount) throw new DavError(404, 'WebDAV token not found');
    logForRequest(req).warn({ event: 'webdav_token_revoked', tokenId: id }, 'WebDAV token revoked');
    res.status(204).end();
  }));
  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    const statusCode = error instanceof DavError ? error.statusCode : 500;
    if (statusCode >= 500) logForRequest(req).error({ event: 'webdav_management_failed', err: error }, 'WebDAV management request failed');
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'WebDAV request failed' });
  });
  return router;
}

export const webdavRouter = createWebdavRouter();
export const webdavManagementRouter = createWebdavManagementRouter();
