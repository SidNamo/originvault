import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import bcrypt from 'bcryptjs';
import Busboy from 'busboy';
import cors from 'cors';
import express from 'express';
import type { Pool, PoolClient } from 'pg';
import { accountRouter, normalizeDisplayName, normalizePassword, normalizeUsername } from './accountRoutes.js';
import { loadSessionUser, publicUser, requireAuth, signToken, type SessionUser } from './auth.js';
import { bulkOperationsRouter } from './bulkOperations.js';
import { config, isSupportedPublicUrlProtocol } from './config.js';
import { db, migrate } from './db.js';
import { resumableUploadRouter } from './resumableUploads.js';
import { extractMetadata, isHiddenResource, originalCreatedAtFromMetadata, resolveInside, safeRelativeDirectory, safeSegment, storeOriginal, userFilesRoot } from './storage.js';
import { pruneEmptyActiveFolders, removeEmptyActiveFolderPaths } from './folderCleanup.js';
import { logForRequest, logger, logSafePath, requestLogging } from './logger.js';
import { assertStorageAvailable, StorageQuotaError } from './quota.js';
import { shareRouter } from './shares.js';
import { webdavManagementRouter, webdavRouter } from './webdav.js';
import { filePreviewRouter } from './filePreview.js';
import { reconcileMutationJournals } from './mutationJournal.js';
import { createRateLimiter } from './rateLimit.js';
import { migrateLegacyTrashStorage, purgeExpiredTrash, TrashError, trashRouter, trashSelections } from './trash.js';

const app = express();
const registrationRateLimit = createRateLimiter({ windowMs: 60 * 60 * 1_000, max: 5 });
const loginRateLimit = createRateLimiter({ windowMs: 15 * 60 * 1_000, max: 10 });
const webdavRateLimit = createRateLimiter({ windowMs: 60 * 1_000, max: 600 });

function isAllowedBrowserOrigin(origin: string | undefined): boolean {
  return !origin || config.corsAllowedOrigins.includes(origin);
}

app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);
app.use((req, res, next) => {
  const origin = req.header('origin');
  if (!isAllowedBrowserOrigin(origin)) {
    res.status(403).json({ error: 'Request origin is not allowed' });
    return;
  }
  next();
});
app.use(requestLogging);
app.use('/webdav', webdavRateLimit, webdavRouter);
app.use(cors({
  origin: (origin, callback) => callback(null, isAllowedBrowserOrigin(origin)),
  credentials: true,
  exposedHeaders: ['ETag', 'X-Source-Encoding', 'X-Source-BOM', 'X-Content-SHA256', 'Content-Range'],
}));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (req, res) => {
  logForRequest(req).trace({ event: 'healthcheck_succeeded' }, 'Health check succeeded');
  res.json({ status: 'ok', service: 'originvault-backend' });
});
app.use(accountRouter);
app.use(shareRouter);
app.use(webdavManagementRouter);
app.use(filePreviewRouter);
app.use(trashRouter);
app.use('/api/bulk', bulkOperationsRouter);
app.use(resumableUploadRouter);

async function backfillOriginalCreationTimes(): Promise<void> {
  const rows = await db.query<{ id: string; storedName: string; metadata: Record<string, unknown> }>(`
    SELECT id,stored_name AS "storedName",extracted_metadata AS metadata FROM files
    WHERE (original_created_at IS NULL
      AND extracted_metadata ?| ARRAY['EXIF:DateTimeOriginal','XMP-exif:DateTimeOriginal','QuickTime:CreateDate','PDF:CreateDate','XMP:CreateDate','XMP-xmp:CreateDate','File:FileCreateDate'])
      OR (NOT is_hidden AND (
        stored_name LIKE '.%'
        OR extracted_metadata::text ILIKE '%hidden%'
        OR extracted_metadata::text ILIKE '%fileattributes%'
        OR extracted_metadata::text ILIKE '%dosattrib%'
      ))
    LIMIT 10000
  `);
  for (const file of rows.rows) {
    const originalCreatedAt = originalCreatedAtFromMetadata(file.metadata);
    const isHidden = isHiddenResource(file.storedName, file.metadata);
    if (originalCreatedAt || isHidden)
      await db.query(`UPDATE files
        SET original_created_at=COALESCE(original_created_at,$1),is_hidden=is_hidden OR $2
        WHERE id=$3`, [originalCreatedAt ?? null, isHidden, file.id]);
  }
  await db.query("UPDATE folders SET is_hidden=true WHERE NOT is_hidden AND name LIKE '.%'");
}

async function ensureFolderPath(user: SessionUser, baseFolderId: string | null, requestedDirectory: string, queryable: Pool | PoolClient = db): Promise<{ folderId: string | null; relativePath: string }> {
  let parentId = baseFolderId;
  let parentPath = '';
  if (parentId) {
    const base = await queryable.query('SELECT relative_path FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [parentId, user.id]);
    if (!base.rowCount) throw new Error('Base folder not found');
    parentPath = base.rows[0].relative_path;
  }

  const safeDirectory = safeRelativeDirectory(requestedDirectory);
  logger.trace({ event: 'folder_path_ensure_started', userId: user.id, username: user.username, baseFolderId, requestedDirectory, safeDirectory }, 'Ensuring physical and indexed folder path');
  for (const segment of safeDirectory.split('/').filter(Boolean)) {
    const relativePath = path.join(parentPath, segment);
    let existing = await queryable.query('SELECT id, relative_path FROM folders WHERE user_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 AND trashed_at IS NULL', [user.id, parentId, segment]);
    if (!existing.rowCount) {
      await mkdir(resolveInside(userFilesRoot(user.storageKey), relativePath), { recursive: true });
      try {
        existing = await queryable.query('INSERT INTO folders(user_id,parent_id,name,relative_path,is_hidden) VALUES($1,$2,$3,$4,$5) RETURNING id,relative_path', [user.id, parentId, segment, relativePath, isHiddenResource(segment)]);
        logger.info({ event: 'folder_created_during_upload', userId: user.id, username: user.username, folderId: existing.rows[0].id, relativePath }, 'Folder created from uploaded directory hierarchy');
      } catch (error: any) {
        if (error?.code !== '23505') throw error;
        existing = await queryable.query('SELECT id, relative_path FROM folders WHERE user_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND name=$3 AND trashed_at IS NULL', [user.id, parentId, segment]);
      }
    }
    parentId = existing.rows[0].id;
    parentPath = existing.rows[0].relative_path;
  }
  logger.debug({ event: 'folder_path_ensure_completed', userId: user.id, folderId: parentId, relativePath: parentPath }, 'Physical and indexed folder path ensured');
  return { folderId: parentId, relativePath: parentPath };
}

app.post('/api/auth/register', registrationRateLimit, async (req, res) => {
  let username: string;
  let password: string;
  let displayName: string;
  try {
    username = normalizeUsername(req.body?.username);
    password = normalizePassword(req.body?.password);
    displayName = normalizeDisplayName(req.body?.displayName, username);
  } catch (error) {
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Invalid registration details' });
  }
  logForRequest(req).trace({ event: 'registration_requested', username, passwordLength: password.length }, 'User registration requested');
  const client = await db.connect();
  try {
    const passwordHash = await bcrypt.hash(password, 12);
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['originvault:registration']);
    const setting = await client.query<{ registration_enabled: boolean }>('SELECT registration_enabled FROM app_settings WHERE id=1 FOR UPDATE');
    const count = await client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM users');
    const isFirstUser = count.rows[0]!.count === '0';
    if (!isFirstUser && !setting.rows[0]!.registration_enabled) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Registration is currently disabled' });
    }
    const result = await client.query<{ id: string; storage_key: string }>(`
      INSERT INTO users(username,display_name,storage_key,password_hash,is_admin,storage_quota_bytes)
      VALUES($1,$2,$1,$3,$4,$5) RETURNING id,storage_key
    `, [username, displayName, passwordHash, isFirstUser, config.defaultStorageQuotaBytes]);
    await mkdir(userFilesRoot(result.rows[0]!.storage_key), { recursive: true });
    await client.query('COMMIT');
    const user = await loadSessionUser(result.rows[0]!.id);
    if (!user) throw new Error('Registered user could not be loaded');
    logForRequest(req).info({ event: 'registration_succeeded', userId: user.id, username: user.username, isAdmin: user.isAdmin, storageRoot: userFilesRoot(user.storageKey) }, 'User registered and storage root created');
    return res.status(201).json({ token: signToken(user), user: publicUser(user) });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (error?.code === '23505') {
      logForRequest(req).warn({ event: 'registration_conflict', username }, 'Registration rejected because username exists');
      return res.status(409).json({ error: 'Username already exists' });
    }
    throw error;
  } finally { client.release(); }
});

app.post('/api/auth/login', loginRateLimit, async (req, res) => {
  const username = String(req.body.username ?? '').toLowerCase().trim();
  logForRequest(req).trace({ event: 'login_requested', username }, 'Login requested');
  const result = await db.query('SELECT id,username,password_hash,disabled_at FROM users WHERE username=$1', [username]);
  const user = result.rows[0];
  if (!user || user.disabled_at || !(await bcrypt.compare(String(req.body.password ?? ''), user.password_hash))) {
    logForRequest(req).warn({ event: 'login_failed', username }, 'Login failed');
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  const sessionUser = await loadSessionUser(user.id);
  if (!sessionUser) return res.status(401).json({ error: 'Invalid username or password' });
  logForRequest(req).info({ event: 'login_succeeded', userId: user.id, username: user.username }, 'Login succeeded');
  return res.json({ token: signToken(sessionUser), user: publicUser(sessionUser) });
});

app.get('/api/items', requireAuth, async (req, res) => {
  const folderId = typeof req.query.folderId === 'string' ? req.query.folderId : null;
  const [folders, files] = await Promise.all([
    db.query('SELECT id, name, parent_id AS "parentId", relative_path AS "relativePath", created_at AS "createdAt", original_created_at AS "originalCreatedAt", original_modified_at AS "originalModifiedAt" FROM folders WHERE user_id=$1 AND parent_id IS NOT DISTINCT FROM $2 AND trashed_at IS NULL AND ($3::boolean OR NOT is_hidden) ORDER BY name', [req.user!.id, folderId, req.user!.showHiddenFiles]),
    db.query('SELECT id, stored_name AS name, mime_type AS "mimeType", size_bytes::text AS "sizeBytes", sha256, original_created_at AS "originalCreatedAt", client_last_modified AS "originalModifiedAt", created_at AS "createdAt" FROM files WHERE user_id=$1 AND folder_id IS NOT DISTINCT FROM $2 AND trashed_at IS NULL AND ($3::boolean OR NOT is_hidden) ORDER BY created_at DESC', [req.user!.id, folderId, req.user!.showHiddenFiles]),
  ]);
  logForRequest(req).debug({ event: 'items_listed', folderId, folderCount: folders.rowCount, fileCount: files.rowCount }, 'Folder contents listed');
  res.json({ folders: folders.rows, files: files.rows });
});

app.get('/api/folders/tree', requireAuth, async (req, res) => {
  const startedAt = process.hrtime.bigint();
  logForRequest(req).trace({ event: 'folder_tree_listing_started' }, 'Complete folder tree listing started');
  const folders = await db.query(`
    SELECT id, name, parent_id AS "parentId", relative_path AS "relativePath", created_at AS "createdAt"
    FROM folders
    WHERE user_id=$1 AND trashed_at IS NULL AND ($2::boolean OR NOT is_hidden)
    ORDER BY relative_path COLLATE "C" ASC, id ASC
  `, [req.user!.id, req.user!.showHiddenFiles]);
  const rootFolderCount = folders.rows.filter((folder) => folder.parentId === null).length;
  logForRequest(req).debug({
    event: 'folder_tree_listed',
    folderCount: folders.rowCount,
    rootFolderCount,
    durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000,
  }, 'Complete folder tree listed as a deterministic flat collection');
  return res.json({ folders: folders.rows });
});

app.post('/api/folders', requireAuth, async (req, res) => {
  try {
    const name = safeSegment(String(req.body.name ?? ''));
    const parentId = req.body.parentId ? String(req.body.parentId) : null;
    let parentPath = '';
    if (parentId) {
      const parent = await db.query('SELECT relative_path FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [parentId, req.user!.id]);
      if (!parent.rowCount) return res.status(404).json({ error: 'Parent folder not found' });
      parentPath = parent.rows[0].relative_path;
    }
    const relativePath = path.join(parentPath, name);
    await mkdir(resolveInside(userFilesRoot(req.user!.storageKey), relativePath), { recursive: false });
    const result = await db.query('INSERT INTO folders(user_id, parent_id, name, relative_path, original_created_at, original_modified_at, is_hidden) VALUES($1,$2,$3,$4,now(),now(),$5) RETURNING id,name,parent_id AS "parentId",relative_path AS "relativePath",created_at AS "createdAt",original_created_at AS "originalCreatedAt",original_modified_at AS "originalModifiedAt"', [req.user!.id, parentId, name, relativePath, isHiddenResource(name)]);
    logForRequest(req).info({ event: 'folder_created', folderId: result.rows[0].id, parentId, relativePath }, 'Folder created on disk and indexed');
    return res.status(201).json(result.rows[0]);
  } catch (error: any) {
    if (error?.code === '23505' || error?.code === 'EEXIST') return res.status(409).json({ error: 'Folder already exists' });
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not create folder' });
  }
});

app.get('/api/folders/:id', requireAuth, async (req, res) => {
  const result = await db.query(`
    WITH RECURSIVE folder_tree AS (
      SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL
      UNION ALL
      SELECT child.id
      FROM folders child
      JOIN folder_tree parent ON child.parent_id=parent.id
      WHERE child.user_id=$2 AND child.trashed_at IS NULL
    )
    SELECT root.id,root.name,root.parent_id AS "parentId",root.relative_path AS "relativePath",
      root.created_at AS "createdAt",root.modified_at AS "modifiedAt",
      root.original_created_at AS "originalCreatedAt",root.original_modified_at AS "originalModifiedAt",
      (SELECT COUNT(*)::integer FROM files WHERE user_id=$2 AND folder_id=root.id AND trashed_at IS NULL) AS "directFileCount",
      (SELECT COUNT(*)::integer FROM folders WHERE user_id=$2 AND parent_id=root.id AND trashed_at IS NULL) AS "directFolderCount",
      (SELECT COUNT(*)::integer FROM files WHERE user_id=$2 AND folder_id IN (SELECT id FROM folder_tree) AND trashed_at IS NULL) AS "fileCount",
      (SELECT (COUNT(*)-1)::integer FROM folder_tree) AS "folderCount",
      COALESCE((SELECT SUM(size_bytes) FROM files WHERE user_id=$2 AND folder_id IN (SELECT id FROM folder_tree) AND trashed_at IS NULL),0)::text AS "sizeBytes"
    FROM folders root
    WHERE root.id=$1 AND root.user_id=$2 AND root.trashed_at IS NULL
  `, [req.params.id, req.user!.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'Folder not found' });
  logForRequest(req).debug({
    event: 'folder_detail_read',
    folderId: req.params.id,
    relativePath: result.rows[0].relativePath,
    fileCount: result.rows[0].fileCount,
    folderCount: result.rows[0].folderCount,
    sizeBytes: result.rows[0].sizeBytes,
  }, 'Folder detail and recursive totals read');
  return res.json(result.rows[0]);
});

app.patch('/api/folders/:id', requireAuth, async (req, res) => {
  const client = await db.connect();
  let oldPath = '';
  let newPath = '';
  let moved = false;
  try {
    const name = safeSegment(String(req.body.name ?? ''));
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${req.user!.id}`]);
    const folder = await client.query('SELECT id,parent_id,name,relative_path FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL FOR UPDATE', [req.params.id, req.user!.id]);
    if (!folder.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Folder not found' }); }
    oldPath = folder.rows[0].relative_path as string;
    newPath = path.join(path.dirname(oldPath) === '.' ? '' : path.dirname(oldPath), name);
    if (oldPath === newPath) { await client.query('COMMIT'); return res.json({ ...folder.rows[0], name }); }
    const root = userFilesRoot(req.user!.storageKey);
    await rename(resolveInside(root, oldPath), resolveInside(root, newPath));
    moved = true;
    logForRequest(req).debug({ event: 'physical_folder_renamed', folderId: req.params.id, oldPath, newPath }, 'Physical folder renamed');
    await client.query(`UPDATE folders SET name=CASE WHEN id=$1 THEN $4 ELSE name END,
      is_hidden=CASE WHEN id=$1 THEN $6 ELSE is_hidden END,
      relative_path=$3 || substring(relative_path FROM length($2)+1),modified_at=now()
      WHERE user_id=$5 AND (relative_path=$2 OR left(relative_path,length($2)+1)=$2 || '/')`, [req.params.id, oldPath, newPath, name, req.user!.id, isHiddenResource(name)]);
    await client.query(`UPDATE files SET relative_path=$2 || substring(relative_path FROM length($1)+1),modified_at=now()
      WHERE user_id=$3 AND left(relative_path,length($1)+1)=$1 || '/'`, [oldPath, newPath, req.user!.id]);
    await client.query('COMMIT');
    logForRequest(req).info({ event: 'folder_renamed', folderId: req.params.id, oldPath, newPath }, 'Folder and descendant index paths renamed');
    return res.json({ id: req.params.id, parentId: folder.rows[0].parent_id, name, relativePath: newPath });
  } catch (error: any) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (moved) await rename(resolveInside(userFilesRoot(req.user!.storageKey), newPath), resolveInside(userFilesRoot(req.user!.storageKey), oldPath)).catch(() => undefined);
    if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY' || error?.code === '23505') return res.status(409).json({ error: 'A folder with that name already exists' });
    return res.status(400).json({ error: error instanceof Error ? error.message : 'Could not rename folder' });
  } finally { client.release(); }
});

app.delete('/api/folders/:id', requireAuth, async (req, res) => {
  if (req.user!.trashEnabled) {
    try {
      const trashed = await trashSelections(req.user!.id, req.user!.storageKey, [{ type: 'folder', id: String(req.params.id) }]);
      logForRequest(req).info({ event: 'folder_trashed', folderId: req.params.id, ...trashed }, 'Folder moved to trash');
      return res.status(200).json({ trashed });
    } catch (error) {
      return res.status(error instanceof TrashError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'Could not move folder to trash' });
    }
  }
  const folder = await db.query('SELECT relative_path,parent_id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [req.params.id, req.user!.id]);
  if (!folder.rowCount) return res.status(404).json({ error: 'Folder not found' });
  const relativePath = folder.rows[0].relative_path as string;
  const root = userFilesRoot(req.user!.storageKey);
  const sourcePath = resolveInside(root, relativePath);
  const stagedPath = resolveInside(root, `.originvault-delete-${randomUUID()}`);
  const client = await db.connect();
  let staged = false;
  let prunedFolders: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${req.user!.id}`]);
    await rename(sourcePath, stagedPath);
    staged = true;
    await client.query(`DELETE FROM files WHERE user_id=$1 AND left(relative_path,length($2)+1)=$2 || '/'`, [req.user!.id, relativePath]);
    await client.query('DELETE FROM folders WHERE id=$1 AND user_id=$2', [req.params.id, req.user!.id]);
    prunedFolders = await pruneEmptyActiveFolders(client, req.user!.id, folder.rows[0].parent_id);
    await client.query('COMMIT');
    await rm(stagedPath, { recursive: true, force: true }).catch((error) => logger.error({ event: 'folder_delete_cleanup_failed', folderId: req.params.id, stagedPath, err: error }, 'Deleted folder staging cleanup failed'));
    await removeEmptyActiveFolderPaths(req.user!.storageKey, prunedFolders);
    logForRequest(req).warn({ event: 'folder_deleted', folderId: req.params.id, relativePath, recursive: true }, 'Folder and all descendants permanently deleted');
    return res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (staged) await rename(stagedPath, sourcePath).catch(() => undefined);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Could not delete folder' });
  } finally { client.release(); }
});

app.post('/api/files/upload', requireAuth, (req, res, next) => {
  let folderId: string | null = typeof req.query.folderId === 'string' ? req.query.folderId : null;
  const relativeDirectory = typeof req.query.relativeDirectory === 'string' ? req.query.relativeDirectory : '';
  let destinationFolderId = folderId;
  let clientLastModified: Date | undefined;
  let uploadPromise: Promise<{ stored: Awaited<ReturnType<typeof storeOriginal>>; client: PoolClient }> | undefined;
  let originalName = '';
  let mimeType = 'application/octet-stream';
  try {
    logForRequest(req).trace({ event: 'upload_request_parsing_started', folderId, relativeDirectory, maxUploadBytes: config.maxUploadBytes }, 'Multipart upload parsing started');
    const busboy = Busboy({ headers: req.headers, limits: { fileSize: config.maxUploadBytes, files: 1, fields: 5 } });
    busboy.on('field', (name, value) => {
      if (name === 'folderId') folderId = value || null;
      if (name === 'lastModified') clientLastModified = new Date(Number(value));
    });
    busboy.on('file', (_name, stream, info) => {
      originalName = info.filename;
      mimeType = info.mimeType || mimeType;
      logForRequest(req).debug({ event: 'upload_file_stream_received', originalName, mimeType, folderId, relativeDirectory }, 'Upload file stream received');
      stream.on('limit', () => stream.destroy(Object.assign(new Error('File is too large'), { code: 'LIMIT_FILE_SIZE' })));
      uploadPromise = (async () => {
        const client = await db.connect();
        try {
          await client.query('BEGIN');
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${req.user!.id}`]);
          const destination = await ensureFolderPath(req.user!, folderId, relativeDirectory, client);
          destinationFolderId = destination.folderId;
          const stored = await storeOriginal({ storageKey: req.user!.storageKey, username: req.user!.username, folderPath: destination.relativePath, originalName, stream, clientLastModified });
          return { stored, client };
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          client.release();
          throw error;
        }
      })().catch((error) => { stream.resume(); throw error; });
      void uploadPromise.catch(() => undefined);
    });
    busboy.on('error', next);
    busboy.on('finish', async () => {
      try {
        if (!uploadPromise) return res.status(400).json({ error: 'A file is required' });
        const context = await uploadPromise;
        const { stored, client } = context;
        const metadata = await extractMetadata(stored.absolutePath);
        let committed = false;
        try {
          await assertStorageAvailable(req.user!.id, BigInt(stored.size), client);
          const result = await client.query(`INSERT INTO files(user_id, folder_id, original_name, stored_name, relative_path, mime_type, size_bytes, sha256, client_last_modified, extracted_metadata, is_hidden, original_created_at)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`, [req.user!.id, destinationFolderId, originalName, stored.storedName, stored.relativePath, mimeType, stored.size, stored.sha256, clientLastModified ?? null, metadata, isHiddenResource(stored.storedName, metadata), originalCreatedAtFromMetadata(metadata) ?? null]);
          await client.query('COMMIT');
          committed = true;
          logForRequest(req).info({ event: 'upload_completed', fileId: result.rows[0].id, folderId: destinationFolderId, originalName, storedName: stored.storedName, relativePath: stored.relativePath, mimeType, sizeBytes: stored.size, sha256: stored.sha256, metadataFieldCount: Object.keys(metadata).length }, 'Original upload stored and indexed');
          return res.status(201).json({ id: result.rows[0].id, name: originalName, sizeBytes: String(stored.size), sha256: stored.sha256 });
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          if (!committed) await unlink(stored.absolutePath).catch(() => undefined);
          throw error;
        } finally { client.release(); }
      } catch (error) { next(error); }
    });
    req.pipe(busboy);
  } catch (error) { next(error); }
});

app.get('/api/files/:id', requireAuth, async (req, res) => {
  const result = await db.query(`SELECT id, stored_name AS name, stored_name AS "storedName", relative_path AS "relativePath", mime_type AS "mimeType", size_bytes::text AS "sizeBytes", sha256, original_created_at AS "originalCreatedAt", client_last_modified AS "originalModifiedAt", extracted_metadata AS metadata, created_at AS "createdAt", modified_at AS "modifiedAt" FROM files WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL`, [req.params.id, req.user!.id]);
  if (!result.rowCount) return res.status(404).json({ error: 'File not found' });
  logForRequest(req).debug({ event: 'file_detail_read', fileId: req.params.id, relativePath: result.rows[0].relativePath, metadataFieldCount: Object.keys(result.rows[0].metadata ?? {}).length }, 'File detail and metadata read');
  return res.json(result.rows[0]);
});

app.get('/api/files/:id/download', requireAuth, async (req, res) => {
  const client = await db.connect();
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  let file: any;
  let fileSize = 0;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [`originvault:${req.user!.id}`]);
    const result = await client.query('SELECT stored_name AS original_name,relative_path,mime_type,size_bytes::text,sha256,client_last_modified FROM files WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [req.params.id, req.user!.id]);
    if (!result.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'File not found' });
    }
    file = result.rows[0];
    const absolutePath = resolveInside(userFilesRoot(req.user!.storageKey), file.relative_path);
    fileHandle = await open(absolutePath, 'r');
    const fileStat = await fileHandle.stat();
    if (!fileStat.isFile() || BigInt(fileStat.size) !== BigInt(file.size_bytes)) throw new Error('Stored file is inconsistent');
    fileSize = fileStat.size;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    await fileHandle?.close().catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  res.attachment(file.original_name);
  res.setHeader('Content-Type', file.mime_type);
  res.setHeader('ETag', `"sha256-${file.sha256}"`);
  res.setHeader('X-Content-SHA256', file.sha256);
  res.setHeader('Accept-Ranges', 'bytes');
  if (file.client_last_modified) res.setHeader('Last-Modified', new Date(file.client_last_modified).toUTCString());
  let requestedRange = req.header('range');
  if (requestedRange?.includes(',')) requestedRange = undefined;
  let start = 0;
  let end = Math.max(0, fileSize - 1);
  if (requestedRange) {
    const match = requestedRange.match(/^bytes=(\d*)-(\d*)$/);
    if (!match || (!match[1] && !match[2]) || fileSize === 0) {
      await fileHandle!.close();
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      return res.status(416).end();
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
      return res.status(416).end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
  }
  res.setHeader('Content-Length', requestedRange ? end - start + 1 : fileSize);
  logForRequest(req).info({ event: 'original_download_started', fileId: req.params.id, originalName: file.original_name, relativePath: file.relative_path, sha256: file.sha256 }, 'Authenticated original download started');
  if (req.method === 'HEAD' || fileSize === 0) {
    await fileHandle!.close();
    return res.end();
  }
  try {
    await pipeline(fileHandle!.createReadStream({ start, end, autoClose: false }), res);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (!req.destroyed && !res.destroyed && code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ECONNRESET') {
      logForRequest(req).error({ event: 'original_download_stream_failed', fileId: req.params.id, err: error }, 'Authenticated original download stream failed');
      res.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    await fileHandle!.close().catch(() => undefined);
  }
});

app.delete('/api/files/:id', requireAuth, async (req, res) => {
  if (req.user!.trashEnabled) {
    try {
      const trashed = await trashSelections(req.user!.id, req.user!.storageKey, [{ type: 'file', id: String(req.params.id) }]);
      logForRequest(req).info({ event: 'file_trashed', fileId: req.params.id, ...trashed }, 'File moved to trash');
      return res.status(200).json({ trashed });
    } catch (error) {
      return res.status(error instanceof TrashError ? error.statusCode : 500).json({ error: error instanceof Error ? error.message : 'Could not move file to trash' });
    }
  }
  const file = await db.query('SELECT relative_path,folder_id FROM files WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [req.params.id, req.user!.id]);
  if (!file.rowCount) return res.status(404).json({ error: 'File not found' });
  const root = userFilesRoot(req.user!.storageKey);
  const sourcePath = resolveInside(root, file.rows[0].relative_path);
  const stagedPath = resolveInside(root, `.originvault-delete-${randomUUID()}`);
  const client = await db.connect();
  let staged = false;
  let prunedFolders: string[] = [];
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${req.user!.id}`]);
    await rename(sourcePath, stagedPath);
    staged = true;
    await client.query('DELETE FROM files WHERE id=$1 AND user_id=$2', [req.params.id, req.user!.id]);
    prunedFolders = await pruneEmptyActiveFolders(client, req.user!.id, file.rows[0].folder_id);
    await client.query('COMMIT');
    await unlink(stagedPath).catch((error) => logger.error({ event: 'file_delete_cleanup_failed', fileId: req.params.id, stagedPath, err: error }, 'Deleted file staging cleanup failed'));
    await removeEmptyActiveFolderPaths(req.user!.storageKey, prunedFolders);
    logForRequest(req).warn({ event: 'file_deleted', fileId: req.params.id, relativePath: file.rows[0].relative_path }, 'Original file permanently deleted');
    return res.status(204).end();
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if (staged) await rename(stagedPath, sourcePath).catch(() => undefined);
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Could not delete file' });
  } finally { client.release(); }
});

app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ event: 'unhandled_request_error', requestId: _req.requestId, userId: _req.user?.id, method: _req.method, path: logSafePath(_req.path), err: error }, 'Unhandled request error');
  if (res.headersSent) {
    if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
    return;
  }
  if (error?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'File is too large' });
  if (error instanceof StorageQuotaError) return res.status(507).json({ error: error.message });
  return res.status(500).json({ error: 'Internal server error' });
});

async function start(): Promise<void> {
  const unsafeSecret = (value: string) => value.length < 32 || /development|change|replace|example/i.test(value);
  if (unsafeSecret(config.jwtSecret)) throw new Error('JWT_SECRET must be set to a strong random value');
  if (unsafeSecret(config.shareSecret)) throw new Error('SHARE_SECRET must be set to a strong random value');
  if (config.legacyShareSecret && unsafeSecret(config.legacyShareSecret)) throw new Error('LEGACY_SHARE_SECRET must be a strong random value when set');
  if (config.jwtSecret === config.shareSecret) throw new Error('JWT_SECRET and SHARE_SECRET must be different values');
  if (!config.postgresDatabase || !config.postgresUser || !config.postgresPassword)
    throw new Error('POSTGRES_DB, POSTGRES_USER, and POSTGRES_PASSWORD must be set');
  if (!Number.isSafeInteger(config.maxUploadBytes) || config.maxUploadBytes < 0) throw new Error('MAX_UPLOAD_BYTES must be a non-negative safe integer');
  if (!/^\d+$/.test(config.defaultStorageQuotaBytes)) throw new Error('DEFAULT_STORAGE_QUOTA_BYTES must be a non-negative integer');
  if (!config.publicUrl) throw new Error('PUBLIC_URL must be set');
  let publicUrl: URL;
  try { publicUrl = new URL(config.publicUrl); } catch { throw new Error('PUBLIC_URL must be an absolute HTTP or HTTPS URL'); }
  if (!isSupportedPublicUrlProtocol(publicUrl) || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password)
    throw new Error('PUBLIC_URL must be an HTTPS origin, or an HTTP origin using a literal IP address, without credentials, path, query, or fragment');
  logger.info({ event: 'service_starting', port: config.port, dataRoot: config.dataRoot, logDir: config.logDir, logLevel: config.logLevel, logRetentionDays: config.logRetentionDays, maxUploadBytes: config.maxUploadBytes }, 'OriginVault backend starting');
  await mkdir(config.dataRoot, { recursive: true });
  logger.debug({ event: 'data_root_ready', dataRoot: config.dataRoot }, 'Data root is ready');
  const instanceLockClient = await db.connect();
  const instanceLock = await instanceLockClient.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('originvault:backend-instance')) AS locked",
  );
  if (!instanceLock.rows[0]?.locked) {
    instanceLockClient.release();
    throw new Error('Another OriginVault backend instance is already using this database');
  }
  await migrate();
  await backfillOriginalCreationTimes();
  await reconcileMutationJournals();
  await migrateLegacyTrashStorage();
  await purgeExpiredTrash();
  const trashCleanupTimer = setInterval(() => { void purgeExpiredTrash(); }, 6 * 60 * 60 * 1_000);
  trashCleanupTimer.unref();
  const server = app.listen(config.port, () => logger.info({ event: 'service_ready', port: config.port }, 'OriginVault backend is ready'));
  const shutdown = (signal: string) => {
    logger.warn({ event: 'service_shutdown_started', signal }, 'OriginVault backend shutdown started');
    server.close(async (error) => {
      clearInterval(trashCleanupTimer);
      if (error) logger.error({ event: 'http_server_close_failed', err: error }, 'HTTP server close failed');
      await instanceLockClient.query("SELECT pg_advisory_unlock(hashtext('originvault:backend-instance'))").catch((lockError) => logger.error({ event: 'instance_lock_release_failed', err: lockError }, 'Backend instance lock release failed'));
      instanceLockClient.release();
      await db.end().catch((dbError) => logger.error({ event: 'database_pool_close_failed', err: dbError }, 'Database pool close failed'));
      logger.info({ event: 'service_shutdown_completed', signal }, 'OriginVault backend shutdown completed');
      process.exit(error ? 1 : 0);
    });
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

process.on('uncaughtException', (error) => { logger.fatal({ event: 'uncaught_exception', err: error }, 'Uncaught exception terminated the process'); logger.flush(); process.exit(1); });
process.on('unhandledRejection', (error) => { logger.fatal({ event: 'unhandled_rejection', err: error }, 'Unhandled promise rejection terminated the process'); logger.flush(); process.exit(1); });
start().catch((error) => { logger.fatal({ event: 'service_start_failed', err: error }, 'OriginVault backend failed to start'); logger.flush(); process.exit(1); });
