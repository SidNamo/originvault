import path from 'node:path';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, realpath, rename, rm, utimes } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ZipArchive } from 'archiver';
import express, { type Request, type Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { requireAuth } from './auth.js';
import { db } from './db.js';
import { logForRequest } from './logger.js';
import { assertStorageAvailable, StorageQuotaError } from './quota.js';
import { resolveInside, safeSegment, userFilesRoot } from './storage.js';
import { moveSelectionsToTrash } from './trash.js';
import { pruneEmptyActiveFolders, removeEmptyActiveFolderPaths } from './folderCleanup.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SELECTIONS = 1_000;

export type BulkSelection = { type: 'file' | 'folder'; id: string };

interface FileRow {
  id: string;
  folderId: string | null;
  name: string;
  storedName: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  originalCreatedAt: Date | string | null;
  clientLastModified: Date | string | null;
  isHidden: boolean;
  extractedMetadata: unknown;
  textEncoding: string | null;
  textHasBom: boolean | null;
}

interface FolderRow {
  id: string;
  parentId: string | null;
  name: string;
  relativePath: string;
  originalCreatedAt: Date | string | null;
  originalModifiedAt: Date | string | null;
  isHidden: boolean;
}

interface SelectedRows {
  files: FileRow[];
  folders: FolderRow[];
}

type Queryable = Pool | PoolClient;

class BulkOperationError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'BulkOperationError';
  }
}

/** Strictly validates and de-duplicates a bulk selection request. */
export function parseBulkSelections(value: unknown): BulkSelection[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new BulkOperationError(400, 'At least one file or folder must be selected');
  }
  if (value.length > MAX_SELECTIONS) {
    throw new BulkOperationError(400, `No more than ${MAX_SELECTIONS} items may be selected at once`);
  }

  const unique = new Map<string, BulkSelection>();
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') throw new BulkOperationError(400, 'Invalid selection');
    const type = (entry as { type?: unknown }).type;
    const id = (entry as { id?: unknown }).id;
    if ((type !== 'file' && type !== 'folder') || typeof id !== 'string' || !UUID_PATTERN.test(id)) {
      throw new BulkOperationError(400, 'Each selection must contain a valid file or folder id');
    }
    const normalizedId = id.toLowerCase();
    unique.set(`${type}:${normalizedId}`, { type, id: normalizedId });
  }
  return [...unique.values()];
}

/** Accepts the grouped copy shape while retaining the selection array used by bulk move. */
export function parseCopySelections(value: unknown): BulkSelection[] {
  if (Array.isArray(value)) return parseBulkSelections(value);
  if (!value || typeof value !== 'object') {
    throw new BulkOperationError(400, 'selections must contain files and folders arrays');
  }
  const files = (value as { files?: unknown }).files;
  const folders = (value as { folders?: unknown }).folders;
  if (!Array.isArray(files) || !Array.isArray(folders)) {
    throw new BulkOperationError(400, 'selections must contain files and folders arrays');
  }
  if (files.length + folders.length > MAX_SELECTIONS) {
    throw new BulkOperationError(400, `No more than ${MAX_SELECTIONS} items may be selected at once`);
  }
  return parseBulkSelections([
    ...files.map((id) => ({ type: 'file', id })),
    ...folders.map((id) => ({ type: 'folder', id })),
  ]);
}

function parseDestinationFolderId(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new BulkOperationError(400, 'destinationFolderId must be a valid folder id or null');
  }
  return value.toLowerCase();
}

function safeRelativePath(value: string, kind: 'file' | 'folder'): string {
  if (!value || value.includes('\\') || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value)) {
    throw new BulkOperationError(409, `${kind === 'file' ? 'File' : 'Folder'} storage path is invalid`);
  }
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f]/.test(segment))) {
    throw new BulkOperationError(409, `${kind === 'file' ? 'File' : 'Folder'} storage path is invalid`);
  }
  return segments.join('/');
}

export function isPathWithin(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function relativeJoin(directory: string, name: string): string {
  return directory ? `${directory}/${name}` : name;
}

function verifiedStorageSegment(value: string, kind: 'file' | 'folder'): string {
  try {
    const safeValue = safeSegment(value);
    if (safeValue !== value) throw new Error('Storage name is not canonical');
    return safeValue;
  } catch {
    throw new BulkOperationError(409, `${kind === 'file' ? 'File' : 'Folder'} storage name is invalid`);
  }
}

function parentPath(relativePath: string): string {
  const parent = path.posix.dirname(relativePath);
  return parent === '.' ? '' : parent;
}

function selectionIds(selections: BulkSelection[], type: BulkSelection['type']): string[] {
  return selections.filter((entry) => entry.type === type).map((entry) => entry.id);
}

async function readSelectedRows(queryable: Queryable, userId: string, selections: BulkSelection[]): Promise<SelectedRows> {
  const fileIds = selectionIds(selections, 'file');
  const folderIds = selectionIds(selections, 'folder');
  const [fileResult, folderResult] = await Promise.all([
    fileIds.length
      ? queryable.query<FileRow>(`
           SELECT id, folder_id AS "folderId", stored_name AS name, stored_name AS "storedName",
                 relative_path AS "relativePath", mime_type AS "mimeType", size_bytes::text AS "sizeBytes",
                  sha256, original_created_at AS "originalCreatedAt", client_last_modified AS "clientLastModified",is_hidden AS "isHidden",
                 extracted_metadata AS "extractedMetadata", text_encoding AS "textEncoding",
                 text_has_bom AS "textHasBom"
          FROM files WHERE user_id=$1 AND id=ANY($2::uuid[]) AND trashed_at IS NULL
          ORDER BY relative_path COLLATE "C", id`, [userId, fileIds])
      : Promise.resolve({ rows: [] as FileRow[], rowCount: 0 }),
    folderIds.length
      ? queryable.query<FolderRow>(`
           SELECT id, parent_id AS "parentId", name, relative_path AS "relativePath",
              original_created_at AS "originalCreatedAt", original_modified_at AS "originalModifiedAt",is_hidden AS "isHidden"
          FROM folders WHERE user_id=$1 AND id=ANY($2::uuid[]) AND trashed_at IS NULL
          ORDER BY relative_path COLLATE "C", id`, [userId, folderIds])
      : Promise.resolve({ rows: [] as FolderRow[], rowCount: 0 }),
  ]);

  // Returning the same response for absent and foreign-owned ids avoids leaking ownership information.
  if (fileResult.rows.length !== fileIds.length || folderResult.rows.length !== folderIds.length) {
    throw new BulkOperationError(404, 'One or more selected items were not found');
  }
  for (const file of fileResult.rows) safeRelativePath(file.relativePath, 'file');
  for (const folder of folderResult.rows) safeRelativePath(folder.relativePath, 'folder');
  return { files: fileResult.rows, folders: folderResult.rows };
}

async function expandFiles(queryable: Queryable, userId: string, fileIds: string[], folderIds: string[]): Promise<FileRow[]> {
  const result = await queryable.query<FileRow>(`
    WITH RECURSIVE folder_tree AS (
      SELECT id FROM folders WHERE user_id=$1 AND id=ANY($2::uuid[]) AND trashed_at IS NULL
      UNION
      SELECT child.id
      FROM folders child
      JOIN folder_tree parent ON child.parent_id=parent.id
      WHERE child.user_id=$1 AND child.trashed_at IS NULL
    )
    SELECT f.id, f.folder_id AS "folderId", f.stored_name AS name, f.stored_name AS "storedName",
           f.relative_path AS "relativePath", f.mime_type AS "mimeType", f.size_bytes::text AS "sizeBytes",
            f.sha256, f.original_created_at AS "originalCreatedAt", f.client_last_modified AS "clientLastModified",f.is_hidden AS "isHidden",
           f.extracted_metadata AS "extractedMetadata", f.text_encoding AS "textEncoding",
           f.text_has_bom AS "textHasBom"
    FROM files f
    WHERE f.user_id=$1 AND f.trashed_at IS NULL
      AND (f.id=ANY($3::uuid[]) OR f.folder_id IN (SELECT id FROM folder_tree))
    ORDER BY f.relative_path COLLATE "C", f.id`, [userId, folderIds, fileIds]);
  for (const file of result.rows) safeRelativePath(file.relativePath, 'file');
  return result.rows;
}

async function expandFolders(queryable: Queryable, userId: string, folderIds: string[]): Promise<FolderRow[]> {
  if (!folderIds.length) return [];
  const result = await queryable.query<FolderRow>(`
    WITH RECURSIVE folder_tree AS (
      SELECT id, parent_id, name, relative_path, original_created_at, original_modified_at, is_hidden
      FROM folders WHERE user_id=$1 AND id=ANY($2::uuid[]) AND trashed_at IS NULL
      UNION
      SELECT child.id, child.parent_id, child.name, child.relative_path, child.original_created_at, child.original_modified_at, child.is_hidden
      FROM folders child
      JOIN folder_tree parent ON child.parent_id=parent.id
      WHERE child.user_id=$1 AND child.trashed_at IS NULL
    )
    SELECT id, parent_id AS "parentId", name, relative_path AS "relativePath",
      original_created_at AS "originalCreatedAt", original_modified_at AS "originalModifiedAt",is_hidden AS "isHidden"
    FROM folder_tree
    ORDER BY relative_path COLLATE "C", id`, [userId, folderIds]);
  for (const folder of result.rows) safeRelativePath(folder.relativePath, 'folder');
  return result.rows;
}

function topLevelMutationRows(selected: SelectedRows): SelectedRows {
  const folders = selected.folders.filter((candidate) => !selected.folders.some(
    (other) => other.id !== candidate.id && isPathWithin(candidate.relativePath, other.relativePath),
  ));
  const files = selected.files.filter((file) => !folders.some(
    (folder) => file.relativePath.startsWith(`${folder.relativePath}/`),
  ));
  return { files, folders };
}

function logicalFilePath(file: FileRow): string {
  // original_name is display metadata and must never be trusted as an archive path.
  // safeSegment keeps a readable filename while removing traversal and platform metacharacters.
  return relativeJoin(parentPath(file.relativePath), safeSegment(file.name));
}

async function validateStoredPath(root: string, relativePath: string, expected: 'file' | 'folder'): Promise<string> {
  const absolutePath = resolveInside(root, relativePath);
  try {
    const [rootRealPath, targetRealPath, stats] = await Promise.all([
      realpath(root),
      realpath(absolutePath),
      lstat(absolutePath),
    ]);
    const relation = path.relative(rootRealPath, targetRealPath);
    if (relation.startsWith('..') || path.isAbsolute(relation) || stats.isSymbolicLink()) {
      throw new BulkOperationError(409, 'Storage link escapes the user storage root');
    }
    if ((expected === 'file' && !stats.isFile()) || (expected === 'folder' && !stats.isDirectory())) {
      throw new BulkOperationError(409, `Selected ${expected} is not available in storage`);
    }
    return absolutePath;
  } catch (error) {
    if (error instanceof BulkOperationError) throw error;
    throw new BulkOperationError(409, `Selected ${expected} is not available in storage`);
  }
}

async function validateStoredPaths(root: string, files: FileRow[], folders: FolderRow[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const entries: Array<{ key: string; relativePath: string; expected: 'file' | 'folder' }> = [
    ...files.map((file) => ({ key: `file:${file.id}`, relativePath: file.relativePath, expected: 'file' as const })),
    ...folders.map((folder) => ({ key: `folder:${folder.id}`, relativePath: folder.relativePath, expected: 'folder' as const })),
  ];
  // Bound filesystem concurrency so very large folder downloads do not exhaust descriptors.
  for (let index = 0; index < entries.length; index += 32) {
    const chunk = entries.slice(index, index + 32);
    const absolutePaths = await Promise.all(chunk.map((entry) => validateStoredPath(root, entry.relativePath, entry.expected)));
    chunk.forEach((entry, chunkIndex) => result.set(entry.key, absolutePaths[chunkIndex]!));
  }
  return result;
}

function reserveArchiveFileName(requestedName: string, reserved: Set<string>): string {
  if (!reserved.has(requestedName)) {
    reserved.add(requestedName);
    return requestedName;
  }
  const directory = parentPath(requestedName);
  const baseName = path.posix.basename(requestedName);
  const extension = path.posix.extname(baseName);
  const stem = extension ? baseName.slice(0, -extension.length) : baseName;
  for (let index = 1; ; index += 1) {
    const candidate = relativeJoin(directory, `${stem} (${index})${extension}`);
    if (!reserved.has(candidate)) {
      reserved.add(candidate);
      return candidate;
    }
  }
}

/** Produces the same suffix style as uploads while keeping copied names storage-safe. */
export function copyNameCandidate(requestedName: string, index: number, kind: 'file' | 'folder'): string {
  if (!Number.isInteger(index) || index < 0) throw new Error('Copy name index must be a non-negative integer');
  const safeName = safeSegment(requestedName);
  const suffix = index === 0 ? '' : ` (${index})`;
  const truncateUtf8 = (value: string, maximumBytes: number): string => {
    let result = '';
    let bytes = 0;
    for (const character of value) {
      const characterBytes = Buffer.byteLength(character);
      if (bytes + characterBytes > maximumBytes) break;
      result += character;
      bytes += characterBytes;
    }
    return result;
  };
  const suffixBytes = Buffer.byteLength(suffix);
  if (kind === 'folder') return `${truncateUtf8(safeName, 255 - suffixBytes)}${suffix}`;

  const extension = path.posix.extname(safeName);
  const stem = extension ? safeName.slice(0, -extension.length) : safeName;
  const extensionBytes = Buffer.byteLength(extension);
  if (extensionBytes + suffixBytes >= 255) {
    return `${truncateUtf8(safeName, 255 - suffixBytes)}${suffix}`;
  }
  return `${truncateUtf8(stem, 255 - extensionBytes - suffixBytes)}${suffix}${extension}`;
}

export function copyDisplayNameCandidate(requestedName: string, index: number): string {
  if (!Number.isInteger(index) || index < 0) throw new Error('Copy name index must be a non-negative integer');
  if (index === 0) return requestedName;
  const extension = path.posix.extname(requestedName);
  const stem = extension ? requestedName.slice(0, -extension.length) : requestedName;
  return `${stem} (${index})${extension}`;
}

function sendOperationError(req: Request, res: Response, error: unknown, event: string): void {
  const requestLogger = logForRequest(req);
  if (error instanceof BulkOperationError || error instanceof StorageQuotaError) {
    const status = error instanceof BulkOperationError ? error.status : error.statusCode;
    const fields = { event, statusCode: status, error: error.message };
    if (status >= 500 && status !== 507) requestLogger.error(fields, 'Bulk operation failed');
    else requestLogger.warn(fields, 'Bulk operation rejected');
    if (!res.headersSent) res.status(status).json({ error: error.message });
    else res.destroy(error);
    return;
  }
  requestLogger.error({ event, err: error }, 'Bulk operation failed unexpectedly');
  const normalizedError = error instanceof Error ? error : new Error(String(error));
  if (!res.headersSent) res.status(500).json({ error: 'Bulk operation failed' });
  else res.destroy(normalizedError);
}

async function acquireUserMutationLock(client: PoolClient, userId: string): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${userId}`]);
}

async function pathExists(value: string): Promise<boolean> {
  try {
    await lstat(value);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function reserveCopyDestinationName(
  requestedName: string,
  kind: 'file' | 'folder',
  root: string,
  destinationPath: string,
  reserved: Set<string>,
): Promise<{ name: string; index: number }> {
  for (let index = 0; index < 100_000; index += 1) {
    let candidate: string;
    try {
      candidate = copyNameCandidate(requestedName, index, kind);
    } catch {
      throw new BulkOperationError(409, `Selected ${kind} name is invalid`);
    }
    if (reserved.has(candidate)) continue;
    const targetPath = resolveInside(root, relativeJoin(destinationPath, candidate));
    if (await pathExists(targetPath)) {
      reserved.add(candidate);
      continue;
    }
    reserved.add(candidate);
    return { name: candidate, index };
  }
  throw new BulkOperationError(409, `Could not allocate an available destination ${kind} name`);
}

async function copyFileDurably(source: string, target: string, expectedSizeBytes: string): Promise<void> {
  const sourceStats = await lstat(source);
  if (!sourceStats.isFile() || BigInt(sourceStats.size) !== BigInt(expectedSizeBytes)) {
    throw new BulkOperationError(409, 'Selected file size does not match storage');
  }
  await copyFile(source, target, constants.COPYFILE_EXCL);
  await utimes(target, sourceStats.atime, sourceStats.mtime);
  const copiedStats = await lstat(target);
  if (!copiedStats.isFile() || BigInt(copiedStats.size) !== BigInt(expectedSizeBytes)) {
    throw new BulkOperationError(500, 'Copied file size does not match the source');
  }
  const handle = await open(target, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function rollbackPhysicalMoves(
  moves: Array<{ from: string; to: string }>,
  req: Request,
  operation: 'move' | 'copy' | 'delete',
): Promise<boolean> {
  let succeeded = true;
  for (const move of [...moves].reverse()) {
    try {
      await rename(move.to, move.from);
      logForRequest(req).debug({ event: `bulk_${operation}_physical_rollback_item_completed`, restoredPath: move.from }, 'Physical item restored during rollback');
    } catch (error) {
      succeeded = false;
      logForRequest(req).fatal({ event: `bulk_${operation}_physical_rollback_item_failed`, sourcePath: move.to, restorePath: move.from, err: error }, 'Physical rollback failed; manual recovery is required');
    }
  }
  return succeeded;
}

export function createBulkOperationsRouter(): express.Router {
  const router = express.Router();
  router.use(requireAuth);

  router.post('/manifest', async (req, res) => {
    try {
      const selections = parseBulkSelections(req.body?.selections);
      logForRequest(req).trace({ event: 'bulk_manifest_started', selectionCount: selections.length }, 'Bulk original-download manifest expansion started');
      await readSelectedRows(db, req.user!.id, selections);
      const files = await expandFiles(db, req.user!.id, selectionIds(selections, 'file'), selectionIds(selections, 'folder'));
      const totalSizeBytes = files.reduce((sum, file) => sum + BigInt(file.sizeBytes), 0n).toString();
      const manifest = files.map((file) => ({
        id: file.id,
        name: file.name,
        relativePath: logicalFilePath(file),
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        sha256: file.sha256,
        downloadUrl: `/api/files/${encodeURIComponent(file.id)}/download`,
      }));
      logForRequest(req).info({ event: 'bulk_manifest_completed', selectionCount: selections.length, fileCount: files.length, totalSizeBytes }, 'Bulk original-download manifest expanded');
      return res.json({ files: manifest, count: manifest.length, totalSizeBytes });
    } catch (error) {
      sendOperationError(req, res, error, 'bulk_manifest_failed');
    }
  });

  router.post('/download', async (req, res) => {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [`originvault:${req.user!.id}`]);
      const selections = parseBulkSelections(req.body?.selections);
      const selected = await readSelectedRows(client, req.user!.id, selections);
      const folderIds = selected.folders.map((folder) => folder.id);
      const [files, folders] = await Promise.all([
        expandFiles(client, req.user!.id, selected.files.map((file) => file.id), folderIds),
        expandFolders(client, req.user!.id, folderIds),
      ]);
      const root = userFilesRoot(req.user!.storageKey);
      const absolutePaths = await validateStoredPaths(root, files, folders);
      const reservedNames = new Set<string>();
      const directoryEntryNames: string[] = [];
      for (const folder of folders) {
        // Reserve both forms so a file whose display name matches a folder is renamed safely.
        if (!reservedNames.has(folder.relativePath)) {
          reservedNames.add(folder.relativePath);
          reservedNames.add(`${folder.relativePath}/`);
          directoryEntryNames.push(`${folder.relativePath}/`);
        }
      }
      const fileEntries = files.map((file) => ({
        file,
        archivePath: reserveArchiveFileName(logicalFilePath(file), reservedNames),
      }));
      logForRequest(req).debug({ event: 'bulk_zip_validated', selectionCount: selections.length, fileCount: files.length, folderCount: folders.length }, 'ZIP source ownership and storage paths validated');

      const archive = new ZipArchive({ zlib: { level: 6 } });
      const archiveName = `originvault-selection-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${archiveName}"`);
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      archive.on('warning', (error) => {
        logForRequest(req).warn({ event: 'bulk_zip_warning', code: error.code, err: error }, 'ZIP creation warning');
      });
      archive.on('error', (error) => {
        logForRequest(req).error({ event: 'bulk_zip_stream_failed', err: error }, 'ZIP stream failed');
        res.destroy(error);
      });
      res.on('finish', () => {
        logForRequest(req).info({ event: 'bulk_zip_stream_completed', fileCount: files.length, folderCount: folders.length, archiveBytes: archive.pointer() }, 'ZIP download stream completed');
      });
      archive.pipe(res);

      // Explicit directory entries preserve empty selected folders in the archive.
      for (const entryName of directoryEntryNames) {
        archive.append('', { name: entryName });
      }
      for (const { file, archivePath } of fileEntries) {
        const dateValue = file.clientLastModified ? new Date(file.clientLastModified) : undefined;
        archive.file(absolutePaths.get(`file:${file.id}`)!, {
          name: archivePath,
          ...(dateValue && Number.isFinite(dateValue.getTime()) ? { date: dateValue } : {}),
        });
        logForRequest(req).trace({ event: 'bulk_zip_file_queued', fileId: file.id, archivePath, sizeBytes: file.sizeBytes }, 'Original file queued into ZIP without transformation');
      }
      logForRequest(req).info({ event: 'bulk_zip_stream_started', selectionCount: selections.length, fileCount: files.length, folderCount: folders.length }, 'Authenticated ZIP download stream started');
      await archive.finalize();
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      sendOperationError(req, res, error, 'bulk_zip_failed');
    } finally {
      client.release();
    }
  });

  router.post('/collisions', async (req, res) => {
    try {
      const mode = req.body?.mode;
      if (mode !== 'move' && mode !== 'copy') throw new BulkOperationError(400, 'mode must be move or copy');
      const selections = parseBulkSelections(req.body?.selections);
      const destinationFolderId = parseDestinationFolderId(req.body?.destinationFolderId);
      const selected = topLevelMutationRows(await readSelectedRows(db, req.user!.id, selections));
      let destinationPath = '';
      if (destinationFolderId) {
        const destination = await db.query<FolderRow>(`
          SELECT id,parent_id AS "parentId",name,relative_path AS "relativePath"
          FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL`, [destinationFolderId, req.user!.id]);
        if (!destination.rowCount) throw new BulkOperationError(404, 'Destination folder not found');
        destinationPath = safeRelativePath(destination.rows[0]!.relativePath, 'folder');
      }
      const candidates = [
        ...selected.folders
          .filter((folder) => mode === 'copy' || folder.parentId !== destinationFolderId)
          .map((folder) => ({ source: { type: 'folder' as const, id: folder.id }, name: folder.name, relativePath: relativeJoin(destinationPath, verifiedStorageSegment(folder.name, 'folder')) })),
        ...selected.files
          .filter((file) => mode === 'copy' || file.folderId !== destinationFolderId)
          .map((file) => ({ source: { type: 'file' as const, id: file.id }, name: file.name, relativePath: relativeJoin(destinationPath, verifiedStorageSegment(file.storedName, 'file')) })),
      ];
      if (new Set(candidates.map((candidate) => candidate.relativePath)).size !== candidates.length) {
        throw new BulkOperationError(409, 'Selected items have conflicting destination names');
      }
      if (!candidates.length) return res.json({ conflicts: [] });
      const existing = await db.query<{ id: string; type: 'file' | 'folder'; relativePath: string }>(`
        SELECT id,'file'::text AS type,relative_path AS "relativePath"
        FROM files WHERE user_id=$1 AND trashed_at IS NULL AND relative_path=ANY($2::text[])
        UNION ALL
        SELECT id,'folder'::text AS type,relative_path AS "relativePath"
        FROM folders WHERE user_id=$1 AND trashed_at IS NULL AND relative_path=ANY($2::text[])
      `, [req.user!.id, candidates.map((candidate) => candidate.relativePath)]);
      const existingByPath = new Map(existing.rows.map((item) => [item.relativePath, item]));
      const conflicts = candidates.flatMap((candidate) => {
        const target = existingByPath.get(candidate.relativePath);
        return target ? [{ source: candidate.source, existing: { type: target.type, id: target.id }, name: candidate.name }] : [];
      });
      res.json({ conflicts });
    } catch (error) {
      sendOperationError(req, res, error, 'bulk_collision_check_failed');
    }
  });

  router.post('/move', async (req, res) => {
    const physicalMoves: Array<{ from: string; to: string }> = [];
    const client = await db.connect();
    let committed = false;
    try {
      const selections = parseBulkSelections(req.body?.selections);
      const destinationFolderId = parseDestinationFolderId(req.body?.destinationFolderId);
      logForRequest(req).trace({ event: 'bulk_move_started', selectionCount: selections.length, destinationFolderId }, 'Bulk move validation started');
      await client.query('BEGIN');
      await acquireUserMutationLock(client, req.user!.id);

      const selected = topLevelMutationRows(await readSelectedRows(client, req.user!.id, selections));
      let destinationPath = '';
      if (destinationFolderId) {
        const destinationResult = await client.query<FolderRow>(`
          SELECT id, parent_id AS "parentId", name, relative_path AS "relativePath"
          FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL`, [destinationFolderId, req.user!.id]);
        if (!destinationResult.rowCount) throw new BulkOperationError(404, 'Destination folder not found');
        destinationPath = safeRelativePath(destinationResult.rows[0]!.relativePath, 'folder');
      }
      for (const folder of selected.folders) {
        if (destinationFolderId === folder.id || (destinationPath && isPathWithin(destinationPath, folder.relativePath))) {
          throw new BulkOperationError(409, 'A folder cannot be moved into itself or one of its descendants');
        }
      }

      const movingFolders = selected.folders.filter((folder) => folder.parentId !== destinationFolderId);
      const movingFiles = selected.files.filter((file) => file.folderId !== destinationFolderId);
      const root = userFilesRoot(req.user!.storageKey);
      if (destinationFolderId) await validateStoredPath(root, destinationPath, 'folder');
      await validateStoredPaths(root, movingFiles, movingFolders);

      const folderTargets = movingFolders.map((folder) => ({ row: folder, relativePath: relativeJoin(destinationPath, verifiedStorageSegment(folder.name, 'folder')) }));
      const fileTargets = movingFiles.map((file) => ({ row: file, relativePath: relativeJoin(destinationPath, verifiedStorageSegment(file.storedName, 'file')) }));
      const allTargets = [...folderTargets.map((target) => target.relativePath), ...fileTargets.map((target) => target.relativePath)];
      if (new Set(allTargets).size !== allTargets.length) throw new BulkOperationError(409, 'Selected items have conflicting destination names');

      const movingFolderIds = movingFolders.map((folder) => folder.id);
      const movingFileIds = movingFiles.map((file) => file.id);
      if (movingFolders.length) {
        const conflict = await client.query('SELECT id FROM folders WHERE user_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=ANY($3::text[]) AND trashed_at IS NULL AND NOT (id=ANY($4::uuid[])) LIMIT 1', [req.user!.id, destinationFolderId, movingFolders.map((folder) => folder.name), movingFolderIds]);
        if (conflict.rowCount) throw new BulkOperationError(409, 'A folder with the same name already exists at the destination');
      }
      if (movingFiles.length) {
        const conflict = await client.query('SELECT id FROM files WHERE user_id=$1 AND folder_id IS NOT DISTINCT FROM $2 AND stored_name=ANY($3::text[]) AND trashed_at IS NULL AND NOT (id=ANY($4::uuid[])) LIMIT 1', [req.user!.id, destinationFolderId, movingFiles.map((file) => file.storedName), movingFileIds]);
        if (conflict.rowCount) throw new BulkOperationError(409, 'A file with the same stored name already exists at the destination');
      }
      for (const relativePath of allTargets) {
        if (await pathExists(resolveInside(root, relativePath))) throw new BulkOperationError(409, 'An item with the same name already exists at the destination');
      }
      logForRequest(req).debug({ event: 'bulk_move_validated', movingFileCount: movingFiles.length, movingFolderCount: movingFolders.length, skippedCount: selected.files.length + selected.folders.length - movingFiles.length - movingFolders.length }, 'Bulk move ownership, hierarchy, and conflicts validated');

      for (const target of folderTargets) {
        const from = resolveInside(root, target.row.relativePath);
        const to = resolveInside(root, target.relativePath);
        await rename(from, to);
        physicalMoves.push({ from, to });
        logForRequest(req).trace({ event: 'bulk_move_physical_folder_completed', folderId: target.row.id, oldPath: target.row.relativePath, newPath: target.relativePath }, 'Physical folder moved');
      }
      for (const target of fileTargets) {
        const from = resolveInside(root, target.row.relativePath);
        const to = resolveInside(root, target.relativePath);
        await rename(from, to);
        physicalMoves.push({ from, to });
        logForRequest(req).trace({ event: 'bulk_move_physical_file_completed', fileId: target.row.id, oldPath: target.row.relativePath, newPath: target.relativePath }, 'Physical original file moved');
      }

      for (const target of folderTargets) {
        await client.query(`
          UPDATE folders
          SET parent_id=CASE WHEN id=$1 THEN $2 ELSE parent_id END,
              relative_path=$4 || substring(relative_path FROM length($3)+1)
          WHERE user_id=$5 AND (relative_path=$3 OR left(relative_path,length($3)+1)=$3 || '/')`,
        [target.row.id, destinationFolderId, target.row.relativePath, target.relativePath, req.user!.id]);
        await client.query(`
          UPDATE files
          SET relative_path=$2 || substring(relative_path FROM length($1)+1)
          WHERE user_id=$3 AND left(relative_path,length($1)+1)=$1 || '/'`,
        [target.row.relativePath, target.relativePath, req.user!.id]);
      }
      for (const target of fileTargets) {
        await client.query('UPDATE files SET folder_id=$1, relative_path=$2 WHERE id=$3 AND user_id=$4', [destinationFolderId, target.relativePath, target.row.id, req.user!.id]);
      }
      await client.query('COMMIT');
      committed = true;
      const skipped = selected.files.length + selected.folders.length - movingFiles.length - movingFolders.length;
      logForRequest(req).info({ event: 'bulk_move_completed', destinationFolderId, destinationPath, movedFileCount: movingFiles.length, movedFolderCount: movingFolders.length, skippedCount: skipped }, 'Bulk move committed in storage and database');
      return res.json({ moved: { files: movingFiles.length, folders: movingFolders.length }, destinationFolderId, skipped });
    } catch (error) {
      if (!committed) {
        await client.query('ROLLBACK').catch((rollbackError) => logForRequest(req).error({ event: 'bulk_move_database_rollback_failed', err: rollbackError }, 'Bulk move database rollback failed'));
        const rollbackSucceeded = await rollbackPhysicalMoves(physicalMoves, req, 'move');
        if (!rollbackSucceeded) {
          sendOperationError(req, res, new BulkOperationError(500, 'Move failed and storage rollback requires manual recovery'), 'bulk_move_failed');
          return;
        }
      }
      sendOperationError(req, res, error, 'bulk_move_failed');
    } finally {
      client.release();
    }
  });

  router.post('/copy', async (req, res) => {
    const physicalMoves: Array<{ from: string; to: string }> = [];
    const client = await db.connect();
    let committed = false;
    let stagingRoot: string | undefined;
    try {
      const selections = parseCopySelections(req.body?.selections);
      const destinationFolderId = parseDestinationFolderId(req.body?.destinationFolderId);
      logForRequest(req).trace({ event: 'bulk_copy_started', selectionCount: selections.length, destinationFolderId }, 'Bulk copy validation started');
      await client.query('BEGIN');
      await acquireUserMutationLock(client, req.user!.id);

      const selected = topLevelMutationRows(await readSelectedRows(client, req.user!.id, selections));
      let destinationPath = '';
      if (destinationFolderId) {
        const destinationResult = await client.query<FolderRow>(`
          SELECT id, parent_id AS "parentId", name, relative_path AS "relativePath"
          FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL`, [destinationFolderId, req.user!.id]);
        if (!destinationResult.rowCount) throw new BulkOperationError(404, 'Destination folder not found');
        destinationPath = safeRelativePath(destinationResult.rows[0]!.relativePath, 'folder');
      }
      for (const folder of selected.folders) {
        if (destinationFolderId === folder.id || (destinationPath && isPathWithin(destinationPath, folder.relativePath))) {
          throw new BulkOperationError(409, 'A folder cannot be copied into itself or one of its descendants');
        }
      }

      const selectedFolderIds = selected.folders.map((folder) => folder.id);
      const [expandedFiles, expandedFolders] = await Promise.all([
        expandFiles(client, req.user!.id, selected.files.map((file) => file.id), selectedFolderIds),
        expandFolders(client, req.user!.id, selectedFolderIds),
      ]);
      const root = userFilesRoot(req.user!.storageKey);
      if (destinationFolderId) await validateStoredPath(root, destinationPath, 'folder');
      const absolutePaths = await validateStoredPaths(root, expandedFiles, expandedFolders);
      let totalSizeBytes = 0n;
      for (const file of expandedFiles) {
        let size: bigint;
        try {
          size = BigInt(file.sizeBytes);
        } catch {
          throw new BulkOperationError(409, 'Selected file size is invalid');
        }
        if (size < 0n) throw new BulkOperationError(409, 'Selected file size is invalid');
        totalSizeBytes += size;
      }
      await assertStorageAvailable(req.user!.id, totalSizeBytes, client);

      const [destinationFolders, destinationFiles] = await Promise.all([
        client.query<{ name: string }>(
          'SELECT name FROM folders WHERE user_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND trashed_at IS NULL',
          [req.user!.id, destinationFolderId],
        ),
        client.query<{ name: string; storedName: string }>(`
          SELECT stored_name AS name, stored_name AS "storedName"
          FROM files WHERE user_id=$1 AND folder_id IS NOT DISTINCT FROM $2 AND trashed_at IS NULL`,
        [req.user!.id, destinationFolderId]),
      ]);
      const reservedNames = new Set<string>();
      for (const folder of destinationFolders.rows) reservedNames.add(folder.name);
      for (const file of destinationFiles.rows) {
        reservedNames.add(file.storedName);
        try {
          reservedNames.add(safeSegment(file.name));
        } catch {
          // The physical stored name still reserves the path for legacy display names.
        }
      }

      type TopFolderPlan = {
        source: FolderRow;
        id: string;
        name: string;
        relativePath: string;
      };
      type TopFilePlan = {
        source: FileRow;
        id: string;
        name: string;
        storedName: string;
        relativePath: string;
      };
      const newFolderIds = new Map(expandedFolders.map((folder) => [folder.id, randomUUID()]));
      const topFolderPlans: TopFolderPlan[] = [];
      for (const folder of selected.folders) {
        const sourceName = verifiedStorageSegment(folder.name, 'folder');
        const { name } = await reserveCopyDestinationName(sourceName, 'folder', root, destinationPath, reservedNames);
        topFolderPlans.push({
          source: folder,
          id: newFolderIds.get(folder.id)!,
          name,
          relativePath: relativeJoin(destinationPath, name),
        });
      }
      const topFilePlans: TopFilePlan[] = [];
      for (const file of selected.files) {
        const reserved = await reserveCopyDestinationName(
          verifiedStorageSegment(file.storedName, 'file'),
          'file',
          root,
          destinationPath,
          reservedNames,
        );
        topFilePlans.push({
          source: file,
          id: randomUUID(),
          name: copyDisplayNameCandidate(file.name, reserved.index),
          storedName: reserved.name,
          relativePath: relativeJoin(destinationPath, reserved.name),
        });
      }
      const topFileBySourceId = new Map(topFilePlans.map((plan) => [plan.source.id, plan]));
      const rootPlanFor = (relativePath: string): TopFolderPlan => {
        const plan = topFolderPlans.find((candidate) => isPathWithin(relativePath, candidate.source.relativePath));
        if (!plan) throw new BulkOperationError(409, 'Selected folder hierarchy is invalid');
        return plan;
      };

      const copiedFolders = expandedFolders.map((source) => {
        const rootPlan = rootPlanFor(source.relativePath);
        const isRoot = source.id === rootPlan.source.id;
        const parentId = isRoot
          ? destinationFolderId
          : source.parentId ? newFolderIds.get(source.parentId) : undefined;
        if (!isRoot && !parentId) throw new BulkOperationError(409, 'Selected folder hierarchy is invalid');
        const relativePath = `${rootPlan.relativePath}${source.relativePath.slice(rootPlan.source.relativePath.length)}`;
        safeRelativePath(relativePath, 'folder');
        return {
          source,
          id: newFolderIds.get(source.id)!,
          parentId: parentId ?? null,
          name: isRoot ? rootPlan.name : source.name,
          relativePath,
          rootPlan,
        };
      });
      const copiedFiles = expandedFiles.map((source) => {
        const topPlan = topFileBySourceId.get(source.id);
        if (topPlan) {
          return {
            source,
            id: topPlan.id,
            folderId: destinationFolderId,
            name: topPlan.name,
            storedName: topPlan.storedName,
            relativePath: topPlan.relativePath,
            rootPlan: undefined,
          };
        }
        const rootPlan = rootPlanFor(source.relativePath);
        const folderId = source.folderId ? newFolderIds.get(source.folderId) : undefined;
        if (!folderId) throw new BulkOperationError(409, 'Selected file hierarchy is invalid');
        const relativePath = `${rootPlan.relativePath}${source.relativePath.slice(rootPlan.source.relativePath.length)}`;
        safeRelativePath(relativePath, 'file');
        return {
          source,
          id: randomUUID(),
          folderId,
          name: source.name,
          storedName: source.storedName,
          relativePath,
          rootPlan,
        };
      });
      logForRequest(req).debug({ event: 'bulk_copy_validated', copiedFileCount: copiedFiles.length, copiedFolderCount: copiedFolders.length, totalSizeBytes: totalSizeBytes.toString() }, 'Bulk copy ownership, hierarchy, quota, and destination names validated');

      stagingRoot = resolveInside(root, `.originvault-copy-${randomUUID()}`);
      await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
      const stagedFolderRoots = new Map<string, string>();
      for (const plan of topFolderPlans) {
        const stagedPath = resolveInside(stagingRoot, `folder-${plan.id}`);
        await mkdir(stagedPath, { recursive: false, mode: 0o700 });
        stagedFolderRoots.set(plan.source.id, stagedPath);
      }
      const stagedFiles = new Map<string, string>();
      for (const plan of topFilePlans) {
        stagedFiles.set(plan.source.id, resolveInside(stagingRoot, `file-${plan.id}`));
      }

      const nestedFolders = copiedFolders
        .filter((folder) => folder.source.id !== folder.rootPlan.source.id)
        .sort((left, right) => left.relativePath.length - right.relativePath.length || left.relativePath.localeCompare(right.relativePath));
      for (const folder of nestedFolders) {
        const stagedRoot = stagedFolderRoots.get(folder.rootPlan.source.id)!;
        const suffix = path.posix.relative(folder.rootPlan.relativePath, folder.relativePath);
        await mkdir(resolveInside(stagedRoot, suffix), { recursive: false, mode: 0o700 });
      }
      for (const file of copiedFiles) {
        let stagedPath = stagedFiles.get(file.source.id);
        if (!stagedPath) {
          const rootPlan = file.rootPlan!;
          const stagedRoot = stagedFolderRoots.get(rootPlan.source.id)!;
          stagedPath = resolveInside(stagedRoot, path.posix.relative(rootPlan.relativePath, file.relativePath));
        }
        await copyFileDurably(absolutePaths.get(`file:${file.source.id}`)!, stagedPath, file.source.sizeBytes);
        logForRequest(req).trace({ event: 'bulk_copy_file_staged', sourceFileId: file.source.id, copiedFileId: file.id, sizeBytes: file.source.sizeBytes }, 'Independent original file copy staged');
      }
      for (const stagedRoot of stagedFolderRoots.values()) await syncDirectory(stagedRoot);
      await syncDirectory(stagingRoot);

      for (const plan of topFolderPlans) {
        const from = stagedFolderRoots.get(plan.source.id)!;
        const to = resolveInside(root, plan.relativePath);
        if (await pathExists(to)) throw new BulkOperationError(409, 'An item with the same name already exists at the destination');
        await rename(from, to);
        physicalMoves.push({ from, to });
        logForRequest(req).trace({ event: 'bulk_copy_folder_installed', sourceFolderId: plan.source.id, copiedFolderId: plan.id, relativePath: plan.relativePath }, 'Staged folder copy atomically installed');
      }
      for (const plan of topFilePlans) {
        const from = stagedFiles.get(plan.source.id)!;
        const to = resolveInside(root, plan.relativePath);
        if (await pathExists(to)) throw new BulkOperationError(409, 'An item with the same name already exists at the destination');
        await rename(from, to);
        physicalMoves.push({ from, to });
        logForRequest(req).trace({ event: 'bulk_copy_file_installed', sourceFileId: plan.source.id, copiedFileId: plan.id, relativePath: plan.relativePath }, 'Staged original file copy atomically installed');
      }
      await syncDirectory(resolveInside(root, destinationPath));

      const orderedFolders = [...copiedFolders].sort((left, right) => left.relativePath.length - right.relativePath.length || left.relativePath.localeCompare(right.relativePath));
      for (const folder of orderedFolders) {
        await client.query(`
          INSERT INTO folders(id,user_id,parent_id,name,relative_path,original_created_at,original_modified_at,is_hidden)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        `, [folder.id, req.user!.id, folder.parentId, folder.name, folder.relativePath, folder.source.originalCreatedAt, folder.source.originalModifiedAt, folder.source.isHidden]);
      }
      for (const file of copiedFiles) {
        await client.query(`
          INSERT INTO files(
            id,user_id,folder_id,original_name,stored_name,relative_path,mime_type,size_bytes,sha256,
            original_created_at,client_last_modified,extracted_metadata,text_encoding,text_has_bom,is_hidden
          ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
        `, [
          file.id,
          req.user!.id,
          file.folderId,
          file.name,
          file.storedName,
          file.relativePath,
          file.source.mimeType,
          file.source.sizeBytes,
          file.source.sha256,
          file.source.originalCreatedAt,
          file.source.clientLastModified,
          file.source.extractedMetadata,
          file.source.textEncoding,
          file.source.textHasBom,
          file.source.isHidden,
        ]);
      }
      await client.query('COMMIT');
      committed = true;

      let cleanupPending = false;
      try {
        await rm(stagingRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupPending = true;
        logForRequest(req).error({ event: 'bulk_copy_staging_cleanup_deferred', stagingRoot, err: cleanupError }, 'Bulk copy committed but staging cleanup must be retried later');
      }
      const topLevelItems = [
        ...topFolderPlans.map((plan) => ({ id: plan.id, type: 'folder' as const, name: plan.name, relativePath: plan.relativePath })),
        ...topFilePlans.map((plan) => ({ id: plan.id, type: 'file' as const, name: plan.name, relativePath: plan.relativePath })),
      ];
      logForRequest(req).info({ event: 'bulk_copy_completed', destinationFolderId, copiedFileCount: copiedFiles.length, copiedFolderCount: copiedFolders.length, totalSizeBytes: totalSizeBytes.toString(), cleanupPending }, 'Bulk copy committed in storage and database');
      return res.json({
        copied: { files: copiedFiles.length, folders: copiedFolders.length },
        destinationFolderId,
        topLevelItems,
        cleanupPending,
      });
    } catch (error) {
      if (!committed) {
        await client.query('ROLLBACK').catch((rollbackError) => logForRequest(req).error({ event: 'bulk_copy_database_rollback_failed', err: rollbackError }, 'Bulk copy database rollback failed'));
        const rollbackSucceeded = await rollbackPhysicalMoves(physicalMoves, req, 'copy');
        if (stagingRoot) {
          await rm(stagingRoot, { recursive: true, force: true }).catch((cleanupError) =>
            logForRequest(req).error({ event: 'bulk_copy_staging_cleanup_failed', stagingRoot, err: cleanupError }, 'Failed bulk copy staging cleanup could not be completed'),
          );
        }
        if (!rollbackSucceeded) {
          sendOperationError(req, res, new BulkOperationError(500, 'Copy failed and storage rollback requires manual recovery'), 'bulk_copy_failed');
          return;
        }
      }
      sendOperationError(req, res, error, 'bulk_copy_failed');
    } finally {
      client.release();
    }
  });

  router.post('/delete', async (req, res) => {
    const physicalMoves: Array<{ from: string; to: string }> = [];
    const client = await db.connect();
    let committed = false;
    let stagingRoot: string | undefined;
    let prunedFolders: string[] = [];
    try {
      const selections = parseBulkSelections(req.body?.selections);
      if (req.user!.trashEnabled) {
        await client.query('BEGIN');
        await acquireUserMutationLock(client, req.user!.id);
        const trashed = await moveSelectionsToTrash(client, req.user!.id, req.user!.storageKey, selections);
        await client.query('COMMIT');
        committed = true;
        logForRequest(req).info({ event: 'bulk_items_trashed', selectionCount: selections.length, ...trashed }, 'Bulk items moved to trash');
        return res.json({ deleted: trashed, cleanupPending: false, trashed: true });
      }
      logForRequest(req).warn({ event: 'bulk_delete_started', selectionCount: selections.length, permanent: true }, 'Permanent bulk delete validation started');
      await client.query('BEGIN');
      await acquireUserMutationLock(client, req.user!.id);
      const selected = topLevelMutationRows(await readSelectedRows(client, req.user!.id, selections));
      const selectedFolderIds = selected.folders.map((folder) => folder.id);
      const [expandedFiles, expandedFolders] = await Promise.all([
        expandFiles(client, req.user!.id, selected.files.map((file) => file.id), selectedFolderIds),
        expandFolders(client, req.user!.id, selectedFolderIds),
      ]);
      const root = userFilesRoot(req.user!.storageKey);
      await validateStoredPaths(root, selected.files, selected.folders);
      stagingRoot = resolveInside(root, `.originvault-delete-${randomUUID()}`);
      await mkdir(stagingRoot, { recursive: false, mode: 0o700 });

      for (const folder of selected.folders) {
        const from = resolveInside(root, folder.relativePath);
        const to = resolveInside(stagingRoot, `folder-${folder.id}`);
        await rename(from, to);
        physicalMoves.push({ from, to });
        logForRequest(req).trace({ event: 'bulk_delete_folder_staged', folderId: folder.id, relativePath: folder.relativePath }, 'Folder staged for permanent deletion');
      }
      for (const file of selected.files) {
        const from = resolveInside(root, file.relativePath);
        const to = resolveInside(stagingRoot, `file-${file.id}`);
        await rename(from, to);
        physicalMoves.push({ from, to });
        logForRequest(req).trace({ event: 'bulk_delete_file_staged', fileId: file.id, relativePath: file.relativePath }, 'Original file staged for permanent deletion');
      }

      await client.query(`
        WITH RECURSIVE folder_tree AS (
          SELECT id FROM folders WHERE user_id=$1 AND id=ANY($2::uuid[])
          UNION
          SELECT child.id FROM folders child JOIN folder_tree parent ON child.parent_id=parent.id WHERE child.user_id=$1
        )
        DELETE FROM files
        WHERE user_id=$1 AND (id=ANY($3::uuid[]) OR folder_id IN (SELECT id FROM folder_tree))`,
      [req.user!.id, selectedFolderIds, selected.files.map((file) => file.id)]);
      if (selectedFolderIds.length) {
        await client.query('DELETE FROM folders WHERE user_id=$1 AND id=ANY($2::uuid[])', [req.user!.id, selectedFolderIds]);
      }
      const pruneStarts = [...selected.files.map((file) => file.folderId), ...selected.folders.map((folder) => folder.parentId)];
      for (const folderId of new Set(pruneStarts.filter((id): id is string => Boolean(id))))
        prunedFolders.push(...await pruneEmptyActiveFolders(client, req.user!.id, folderId));
      await client.query('COMMIT');
      committed = true;

      let cleanupPending = false;
      try {
        await rm(stagingRoot, { recursive: true, force: true });
      } catch (cleanupError) {
        cleanupPending = true;
        logForRequest(req).error({ event: 'bulk_delete_staging_cleanup_failed', stagingRoot, err: cleanupError }, 'Bulk delete committed but staged bytes could not be removed');
      }
      await removeEmptyActiveFolderPaths(req.user!.storageKey, prunedFolders);
      logForRequest(req).warn({ event: 'bulk_delete_completed', deletedFileCount: expandedFiles.length, deletedFolderCount: expandedFolders.length, cleanupPending, permanent: true }, 'Permanent bulk delete committed');
      return res.json({ deleted: { files: expandedFiles.length, folders: expandedFolders.length }, cleanupPending });
    } catch (error) {
      if (!committed) {
        await client.query('ROLLBACK').catch((rollbackError) => logForRequest(req).error({ event: 'bulk_delete_database_rollback_failed', err: rollbackError }, 'Bulk delete database rollback failed'));
        const rollbackSucceeded = await rollbackPhysicalMoves(physicalMoves, req, 'delete');
        if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
        if (!rollbackSucceeded) {
          sendOperationError(req, res, new BulkOperationError(500, 'Delete failed and storage rollback requires manual recovery'), 'bulk_delete_failed');
          return;
        }
      }
      sendOperationError(req, res, error, 'bulk_delete_failed');
    } finally {
      client.release();
    }
  });

  return router;
}

export const bulkOperationsRouter = createBulkOperationsRouter();
export default bulkOperationsRouter;
