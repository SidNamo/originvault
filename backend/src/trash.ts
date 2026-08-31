import { randomUUID } from 'node:crypto';
import { lstat, mkdir, rename, rm, rmdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { PoolClient } from 'pg';
import { requireAuth } from './auth.js';
import { db } from './db.js';
import { logForRequest, logger } from './logger.js';
import { resolveInside, userFilesRoot } from './storage.js';

const TRASH_RETENTION_DAYS = 30;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type TrashSelection = { type: 'file' | 'folder'; id: string };
type TrashType = TrashSelection['type'];
type TrashRootRow = { id: string; relativePath: string; trashStoragePath: string | null };
type PhysicalMove = { from: string; to: string };

export class TrashError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

const asyncHandler = (handler: (req: Request, res: Response, next: NextFunction) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => { handler(req, res, next).catch(next); };

function checkedId(value: unknown): string {
  const id = String(value ?? '');
  if (!UUID_PATTERN.test(id)) throw new TrashError(404, 'Trash item not found');
  return id;
}

function checkedSelections(value: unknown): TrashSelection[] {
  if (!Array.isArray(value) || !value.length || value.length > 1_000)
    throw new TrashError(400, 'Select between 1 and 1000 trash items');
  const selections = new Map<string, TrashSelection>();
  for (const item of value) {
    if (!item || typeof item !== 'object') throw new TrashError(400, 'Invalid trash selection');
    const type = (item as { type?: unknown }).type;
    if (type !== 'file' && type !== 'folder') throw new TrashError(400, 'Invalid trash selection');
    const id = checkedId((item as { id?: unknown }).id);
    selections.set(`${type}:${id}`, { type, id });
  }
  return [...selections.values()];
}

function pathContains(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function trashStoragePath(id: string): string {
  return path.posix.join('.originvault-trash', id);
}

async function rollbackPhysicalMoves(moves: PhysicalMove[]): Promise<void> {
  for (const move of [...moves].reverse()) await rename(move.to, move.from).catch(() => undefined);
}

function trashStorageError(error: unknown): never {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EEXIST' || code === 'ENOTEMPTY')
    throw new TrashError(409, 'An item already exists at the original location');
  if (code === 'ENOENT') throw new TrashError(409, 'The original folder must be restored first');
  throw error;
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

async function removeEmptyTrashedDirectories(root: string, startPath: string, rootPath: string): Promise<void> {
  let current = startPath;
  while (current === rootPath || current.startsWith(`${rootPath}${path.sep}`)) {
    try {
      await rmdir(current);
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY')
        logger.error({ event: 'trash_empty_folder_cleanup_failed', path: current, err: error }, 'Empty trash folder cleanup failed');
      break;
    }
    if (current === rootPath) break;
    current = path.dirname(current);
  }
}

function restoreNameCandidate(name: string, type: TrashType, index: number): string {
  if (!index) return name;
  if (type === 'folder') return `${name} (${index})`;
  const parsed = path.posix.parse(name);
  return `${parsed.name} (${index})${parsed.ext}`;
}

async function renamedRestoreDestination(
  client: PoolClient,
  userId: string,
  storageKey: string,
  type: TrashType,
  relativePath: string,
  name: string,
): Promise<{ relativePath: string; name: string }> {
  const parent = path.posix.dirname(relativePath);
  const parentPath = parent === '.' ? '' : parent;
  const root = userFilesRoot(storageKey);
  for (let index = 1; index < 100_000; index += 1) {
    const candidateName = restoreNameCandidate(name, type, index);
    const candidatePath = parentPath ? `${parentPath}/${candidateName}` : candidateName;
    const indexed = await client.query(`
      SELECT 1 FROM files WHERE user_id=$1 AND trashed_at IS NULL AND relative_path=$2
      UNION ALL
      SELECT 1 FROM folders WHERE user_id=$1 AND trashed_at IS NULL AND relative_path=$2
      LIMIT 1
    `, [userId, candidatePath]);
    if (!indexed.rowCount && !(await pathExists(resolveInside(root, candidatePath)))) {
      return { relativePath: candidatePath, name: candidateName };
    }
  }
  throw new TrashError(409, 'Could not allocate an available restore name');
}

async function activeItemsAtPath(client: PoolClient, userId: string, relativePath: string) {
  return client.query<TrashSelection>(`
    SELECT id,'file'::text AS type FROM files WHERE user_id=$1 AND trashed_at IS NULL AND relative_path=$2
    UNION ALL
    SELECT id,'folder'::text AS type FROM folders WHERE user_id=$1 AND trashed_at IS NULL AND relative_path=$2
  `, [userId, relativePath]);
}

async function restoreHasCollision(userId: string, storageKey: string, type: TrashType, id: string): Promise<boolean> {
  const source = await db.query<TrashRootRow>(
    type === 'file'
      ? `SELECT id,relative_path AS "relativePath",trash_storage_path AS "trashStoragePath" FROM files
          WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL`
      : `SELECT id,relative_path AS "relativePath",trash_storage_path AS "trashStoragePath" FROM folders
          WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL AND trash_root_id=id`,
    [id, userId],
  );
  if (!source.rowCount) throw new TrashError(404, 'Trash item not found');
  const existing = await db.query(`
    SELECT 1 FROM files WHERE user_id=$1 AND trashed_at IS NULL AND relative_path=$2
    UNION ALL
    SELECT 1 FROM folders WHERE user_id=$1 AND trashed_at IS NULL AND relative_path=$2
    LIMIT 1
  `, [userId, source.rows[0]!.relativePath]);
  return Boolean(existing.rowCount) || pathExists(resolveInside(userFilesRoot(storageKey), source.rows[0]!.relativePath));
}

async function overwriteRestoreCollision(client: PoolClient, userId: string, storageKey: string, relativePath: string): Promise<void> {
  const existing = await activeItemsAtPath(client, userId, relativePath);
  if ((existing.rowCount ?? 0) > 1) throw new TrashError(409, 'Multiple items exist at the original location');
  if (existing.rowCount) {
    await moveSelectionsToTrash(client, userId, storageKey, existing.rows);
    return;
  }
  if (await pathExists(resolveInside(userFilesRoot(storageKey), relativePath)))
    throw new TrashError(409, 'An unindexed item exists at the original location');
}

export async function moveSelectionsToTrash(
  client: PoolClient,
  userId: string,
  storageKey: string,
  selections: TrashSelection[],
): Promise<{ files: number; folders: number }> {
  if (!selections.length) throw new TrashError(400, 'At least one item is required');
  const fileIds = [...new Set(selections.filter((item) => item.type === 'file').map((item) => checkedId(item.id)))];
  const folderIds = [...new Set(selections.filter((item) => item.type === 'folder').map((item) => checkedId(item.id)))];
  const [files, folders] = await Promise.all([
    client.query<{ id: string; relativePath: string }>(`
      SELECT id,relative_path AS "relativePath" FROM files
      WHERE user_id=$1 AND trashed_at IS NULL AND id=ANY($2::uuid[]) FOR UPDATE
    `, [userId, fileIds]),
    client.query<{ id: string; relativePath: string }>(`
      SELECT id,relative_path AS "relativePath" FROM folders
      WHERE user_id=$1 AND trashed_at IS NULL AND id=ANY($2::uuid[]) FOR UPDATE
    `, [userId, folderIds]),
  ]);
  if (files.rowCount !== fileIds.length || folders.rowCount !== folderIds.length)
    throw new TrashError(404, 'One or more items were not found');

  const folderRoots = [...folders.rows]
    .sort((left, right) => left.relativePath.length - right.relativePath.length)
    .filter((folder, index, all) => !all.slice(0, index).some((root) => pathContains(root.relativePath, folder.relativePath)));
  const fileRoots = files.rows.filter((file) =>
    !folderRoots.some((folder) => pathContains(folder.relativePath, file.relativePath)));
  let trashedFiles = 0;
  let trashedFolders = 0;
  const root = userFilesRoot(storageKey);
  const physicalMoves: PhysicalMove[] = [];
  try {
    await mkdir(resolveInside(root, '.originvault-trash'), { recursive: true, mode: 0o700 });
    for (const folder of folderRoots) {
      const nestedRoots = await client.query<TrashRootRow & { type: TrashType }>(`
        SELECT id,relative_path AS "relativePath",trash_storage_path AS "trashStoragePath",'folder'::text AS type
        FROM folders
        WHERE user_id=$1 AND trashed_at IS NOT NULL AND trash_root_id=id
          AND left(relative_path,length($2)+1)=$2 || '/'
        UNION ALL
        SELECT id,relative_path AS "relativePath",trash_storage_path AS "trashStoragePath",'file'::text AS type
        FROM files
        WHERE user_id=$1 AND trashed_at IS NOT NULL AND trash_root_id=id
          AND left(relative_path,length($2)+1)=$2 || '/'
      `, [userId, folder.relativePath]);
      for (const nested of [...nestedRoots.rows.filter((item) => item.type === 'folder')]
        .sort((left, right) => left.relativePath.length - right.relativePath.length)
        .concat(nestedRoots.rows.filter((item) => item.type === 'file'))) {
        const sourceRelativePath = nested.trashStoragePath ?? nested.relativePath;
        if (sourceRelativePath === nested.relativePath) continue;
        const from = resolveInside(root, sourceRelativePath);
        const to = resolveInside(root, nested.relativePath);
        await rename(from, to);
        physicalMoves.push({ from, to });
      }
      const storagePath = trashStoragePath(folder.id);
      const from = resolveInside(root, folder.relativePath);
      const to = resolveInside(root, storagePath);
      await rename(from, to);
      physicalMoves.push({ from, to });
      const affected = await client.query<{ files: string; folders: string }>(`
      WITH RECURSIVE tree AS (
        SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL
        UNION ALL
        SELECT child.id FROM folders child JOIN tree parent ON child.parent_id=parent.id
        WHERE child.user_id=$2
      ), updated_folders AS (
        UPDATE folders SET trashed_at=clock_timestamp(),trash_root_id=$1,
          trash_storage_path=CASE WHEN id=$1 THEN $3 ELSE NULL END,modified_at=now()
        WHERE user_id=$2 AND id IN (SELECT id FROM tree)
        RETURNING id
      ), updated_files AS (
        UPDATE files SET trashed_at=clock_timestamp(),trash_root_id=$1,
          trash_storage_path=NULL,modified_at=now()
        WHERE user_id=$2 AND folder_id IN (SELECT id FROM tree)
        RETURNING id
      )
      SELECT (SELECT COUNT(*)::text FROM updated_files) AS files,
        (SELECT COUNT(*)::text FROM updated_folders) AS folders
      `, [folder.id, userId, storagePath]);
      trashedFiles += Number(affected.rows[0]?.files ?? 0);
      trashedFolders += Number(affected.rows[0]?.folders ?? 0);
    }
    for (const file of fileRoots) {
      const storagePath = trashStoragePath(file.id);
      const from = resolveInside(root, file.relativePath);
      const to = resolveInside(root, storagePath);
      await rename(from, to);
      physicalMoves.push({ from, to });
      const updated = await client.query(`
      UPDATE files SET trashed_at=clock_timestamp(),trash_root_id=id,trash_storage_path=$3,modified_at=now()
      WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL
      `, [file.id, userId, storagePath]);
      trashedFiles += updated.rowCount ?? 0;
    }
  } catch (error) {
    await rollbackPhysicalMoves(physicalMoves);
    throw error;
  }
  return { files: trashedFiles, folders: trashedFolders };
}

export async function trashSelections(userId: string, storageKey: string, selections: TrashSelection[]) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${userId}`]);
    const trashed = await moveSelectionsToTrash(client, userId, storageKey, selections);
    await client.query('COMMIT');
    return trashed;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function restoreTrashRoot(
  client: PoolClient,
  userId: string,
  storageKey: string,
  type: TrashType,
  id: string,
  collisionChoice?: 'overwrite' | 'rename',
) {
  const source = await client.query<TrashRootRow & { name: string }>(
    type === 'file'
      ? `SELECT id,stored_name AS name,relative_path AS "relativePath",trash_storage_path AS "trashStoragePath" FROM files
          WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL AND trash_root_id=id FOR UPDATE`
      : `SELECT id,name,relative_path AS "relativePath",trash_storage_path AS "trashStoragePath" FROM folders
          WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL AND trash_root_id=id FOR UPDATE`,
    [id, userId],
  );
  if (!source.rowCount) throw new TrashError(404, 'Trash item not found');
  const root = userFilesRoot(storageKey);
  if (collisionChoice === 'overwrite')
    await overwriteRestoreCollision(client, userId, storageKey, source.rows[0]!.relativePath);
  const sourceRelativePath = source.rows[0]!.trashStoragePath ?? source.rows[0]!.relativePath;
  const from = resolveInside(root, sourceRelativePath);
  const destination = collisionChoice === 'rename'
    ? await renamedRestoreDestination(client, userId, storageKey, type, source.rows[0]!.relativePath, source.rows[0]!.name)
    : { relativePath: source.rows[0]!.relativePath, name: source.rows[0]!.name };
  const to = resolveInside(root, destination.relativePath);
  let moved = false;
  try {
    if (from !== to) {
      await rename(from, to);
      moved = true;
    }
    if (type === 'file') {
      const updated = await client.query(`
        UPDATE files SET original_name=$3,stored_name=$3,relative_path=$4,
          trashed_at=NULL,trash_root_id=NULL,trash_storage_path=NULL
        WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL AND trash_root_id=id
      `, [id, userId, destination.name, destination.relativePath]);
      if (!updated.rowCount) throw new TrashError(404, 'Trash item not found');
      return { files: 1, folders: 0 };
    }
    const [files, folders] = await Promise.all([
      client.query(`UPDATE files SET relative_path=$3 || substring(relative_path FROM length($4)+1),
        trashed_at=NULL,trash_root_id=NULL,trash_storage_path=NULL WHERE user_id=$1 AND trash_root_id=$2`, [userId, id, destination.relativePath, source.rows[0]!.relativePath]),
      client.query(`UPDATE folders SET name=CASE WHEN id=$2 THEN $3 ELSE name END,
        relative_path=$4 || substring(relative_path FROM length($5)+1),
        trashed_at=NULL,trash_root_id=NULL,trash_storage_path=NULL WHERE user_id=$1 AND trash_root_id=$2`, [userId, id, destination.name, destination.relativePath, source.rows[0]!.relativePath]),
    ]);
    return { files: files.rowCount ?? 0, folders: folders.rowCount ?? 0 };
  } catch (error) {
    if (moved) await rename(to, from).catch(() => undefined);
    trashStorageError(error);
  }
}

type TrashedFileRow = TrashRootRow & {
  name: string;
  folderId: string | null;
  rootId: string;
  rootRelativePath: string;
};

type TrashedFolderRow = TrashRootRow & {
  parentId: string | null;
  rootId: string;
  rootRelativePath: string;
};

async function trashedFile(client: PoolClient, userId: string, id: string): Promise<TrashedFileRow> {
  const result = await client.query<TrashedFileRow>(`
    SELECT files.id,files.stored_name AS name,files.folder_id AS "folderId",files.relative_path AS "relativePath",
      files.trash_root_id AS "rootId",COALESCE(root_file.trash_storage_path,root_folder.trash_storage_path) AS "trashStoragePath",
      COALESCE(root_file.relative_path,root_folder.relative_path) AS "rootRelativePath"
    FROM files
    LEFT JOIN files root_file ON root_file.id=files.trash_root_id
    LEFT JOIN folders root_folder ON root_folder.id=files.trash_root_id
    WHERE files.id=$1 AND files.user_id=$2 AND files.trashed_at IS NOT NULL
    FOR UPDATE OF files
  `, [id, userId]);
  if (!result.rowCount) throw new TrashError(404, 'Trash item not found');
  const file = result.rows[0]!;
  if (!file.trashStoragePath || !file.rootRelativePath)
    throw new TrashError(409, 'Trashed file storage has not been isolated');
  return file;
}

async function trashedFolder(client: PoolClient, userId: string, id: string): Promise<TrashedFolderRow> {
  const result = await client.query<TrashedFolderRow>(`
    SELECT folders.id,folders.parent_id AS "parentId",folders.relative_path AS "relativePath",folders.trash_root_id AS "rootId",
      COALESCE(root_file.trash_storage_path,root_folder.trash_storage_path) AS "trashStoragePath",
      COALESCE(root_file.relative_path,root_folder.relative_path) AS "rootRelativePath"
    FROM folders
    LEFT JOIN files root_file ON root_file.id=folders.trash_root_id
    LEFT JOIN folders root_folder ON root_folder.id=folders.trash_root_id
    WHERE folders.id=$1 AND folders.user_id=$2 AND folders.trashed_at IS NOT NULL
    FOR UPDATE OF folders
  `, [id, userId]);
  if (!result.rowCount) throw new TrashError(404, 'Trash item not found');
  const folder = result.rows[0]!;
  if (!folder.trashStoragePath || !folder.rootRelativePath)
    throw new TrashError(409, 'Trashed folder storage has not been isolated');
  return folder;
}

function trashedFilePath(root: string, file: TrashRootRow & { rootRelativePath: string }): string {
  const suffix = file.relativePath.slice(file.rootRelativePath.length);
  return resolveInside(root, `${file.trashStoragePath}${suffix}`);
}

async function ensureActiveRestoreParent(
  client: PoolClient,
  userId: string,
  storageKey: string,
  relativePath: string,
): Promise<string | null> {
  const parentPath = path.posix.dirname(relativePath);
  if (parentPath === '.') return null;
  const root = userFilesRoot(storageKey);
  await mkdir(resolveInside(root, parentPath), { recursive: true, mode: 0o700 });
  let parentId: string | null = null;
  let currentPath = '';
  for (const segment of parentPath.split('/')) {
    currentPath = currentPath ? `${currentPath}/${segment}` : segment;
    const existing = await client.query<{ id: string }>(`
      SELECT id FROM folders WHERE user_id=$1 AND relative_path=$2 AND trashed_at IS NULL FOR UPDATE
    `, [userId, currentPath]);
    if (existing.rowCount) {
      parentId = existing.rows[0]!.id;
      continue;
    }
    const insertedFolder: { rows: Array<{ id: string }> } = await client.query<{ id: string }>(`
      INSERT INTO folders(user_id,parent_id,name,relative_path)
      VALUES($1,$2,$3,$4) RETURNING id
    `, [userId, parentId, segment, currentPath]);
    parentId = insertedFolder.rows[0]!.id;
  }
  return parentId;
}

async function pruneEmptyTrashedFolders(client: PoolClient, userId: string, firstFolderId: string | null): Promise<void> {
  let folderId = firstFolderId;
  while (folderId) {
    const folder = await client.query<{ id: string; parentId: string | null }>(`
      SELECT id,parent_id AS "parentId" FROM folders
      WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL FOR UPDATE
    `, [folderId, userId]);
    if (!folder.rowCount) return;
    const children = await client.query(`
      SELECT 1 FROM files WHERE user_id=$1 AND folder_id=$2 AND trashed_at IS NOT NULL
      UNION ALL
      SELECT 1 FROM folders WHERE user_id=$1 AND parent_id=$2 AND trashed_at IS NOT NULL
      LIMIT 1
    `, [userId, folderId]);
    if (children.rowCount) return;
    const parentId = folder.rows[0]!.parentId;
    await client.query('DELETE FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL', [folderId, userId]);
    folderId = parentId;
  }
}

async function restoreTrashedFile(
  client: PoolClient,
  userId: string,
  storageKey: string,
  id: string,
  collisionChoice?: 'overwrite' | 'rename',
) {
  const file = await trashedFile(client, userId, id);
  if (file.rootId === file.id)
    return restoreTrashRoot(client, userId, storageKey, 'file', id, collisionChoice);
  if (collisionChoice === 'overwrite')
    await overwriteRestoreCollision(client, userId, storageKey, file.relativePath);
  const destination = collisionChoice === 'rename'
    ? await renamedRestoreDestination(client, userId, storageKey, 'file', file.relativePath, file.name)
    : { relativePath: file.relativePath, name: file.name };
  const root = userFilesRoot(storageKey);
  const from = trashedFilePath(root, file);
  const to = resolveInside(root, destination.relativePath);
  const destinationFolderId = await ensureActiveRestoreParent(client, userId, storageKey, destination.relativePath);
  let moved = false;
  try {
    await rename(from, to);
    moved = true;
    const updated = await client.query(`
      UPDATE files SET folder_id=$3,original_name=$4,stored_name=$4,relative_path=$5,
        trashed_at=NULL,trash_root_id=NULL,trash_storage_path=NULL
      WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL
    `, [id, userId, destinationFolderId, destination.name, destination.relativePath]);
    if (!updated.rowCount) throw new TrashError(404, 'Trash item not found');
    await pruneEmptyTrashedFolders(client, userId, file.folderId);
    return { files: 1, folders: 0 };
  } catch (error) {
    if (moved) await rename(to, from).catch(() => undefined);
    trashStorageError(error);
  }
}

async function permanentlyDeleteTrashedFile(userId: string, storageKey: string, id: string) {
  const client = await db.connect();
  let sourcePath = '';
  let stagedPath = '';
  let staged = false;
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${userId}`]);
    const file = await trashedFile(client, userId, id);
    if (file.rootId === file.id) {
      await client.query('ROLLBACK');
      return permanentlyDeleteTrashRoot(userId, storageKey, 'file', id);
    }
    const root = userFilesRoot(storageKey);
    sourcePath = trashedFilePath(root, file);
    stagedPath = resolveInside(root, `.originvault-delete-${randomUUID()}`);
    await rename(sourcePath, stagedPath);
    staged = true;
    const deleted = await client.query('DELETE FROM files WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL', [id, userId]);
    if (!deleted.rowCount) throw new TrashError(404, 'Trash item not found');
    await pruneEmptyTrashedFolders(client, userId, file.folderId);
    await client.query('COMMIT');
    committed = true;
    await unlink(stagedPath).catch((error) =>
      logger.error({ event: 'trash_permanent_cleanup_failed', userId, type: 'file', itemId: id, stagedPath, err: error }, 'Trash bytes could not be removed after database deletion'),
    );
    await removeEmptyTrashedDirectories(root, path.dirname(sourcePath), resolveInside(root, file.trashStoragePath!));
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (staged) await rename(stagedPath, sourcePath).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function permanentlyDeleteTrashedFolder(userId: string, storageKey: string, id: string) {
  const client = await db.connect();
  let sourcePath = '';
  let stagedPath = '';
  let staged = false;
  let committed = false;
  let root = '';
  let trashRootPath = '';
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${userId}`]);
    const folder = await trashedFolder(client, userId, id);
    if (folder.rootId === folder.id) {
      await client.query('ROLLBACK');
      return permanentlyDeleteTrashRoot(userId, storageKey, 'folder', id);
    }
    root = userFilesRoot(storageKey);
    sourcePath = trashedFilePath(root, folder);
    trashRootPath = resolveInside(root, folder.trashStoragePath!);
    stagedPath = resolveInside(root, `.originvault-delete-${randomUUID()}`);
    await rename(sourcePath, stagedPath);
    staged = true;
    await client.query(`
      WITH RECURSIVE tree AS (
        SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL
        UNION ALL
        SELECT child.id FROM folders child JOIN tree parent ON child.parent_id=parent.id
        WHERE child.user_id=$2 AND child.trashed_at IS NOT NULL
      ) DELETE FROM files WHERE user_id=$2 AND folder_id IN (SELECT id FROM tree) AND trashed_at IS NOT NULL
    `, [id, userId]);
    await client.query('DELETE FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL', [id, userId]);
    await pruneEmptyTrashedFolders(client, userId, folder.parentId);
    await client.query('COMMIT');
    committed = true;
    await rm(stagedPath, { recursive: true, force: true }).catch((error) =>
      logger.error({ event: 'trash_permanent_cleanup_failed', userId, type: 'folder', itemId: id, stagedPath, err: error }, 'Trash bytes could not be removed after database deletion'),
    );
    await removeEmptyTrashedDirectories(root, path.dirname(sourcePath), trashRootPath);
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (staged) await rename(stagedPath, sourcePath).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function permanentlyDeleteTrashRoot(userId: string, storageKey: string, type: TrashType, id: string) {
  const client = await db.connect();
  let sourcePath = '';
  let stagedPath = '';
  let staged = false;
  let committed = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${userId}`]);
    const source = await client.query<TrashRootRow>(
      type === 'file'
        ? `SELECT relative_path AS "relativePath",trash_storage_path AS "trashStoragePath" FROM files WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL AND trash_root_id=id FOR UPDATE`
        : `SELECT relative_path AS "relativePath",trash_storage_path AS "trashStoragePath" FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL AND trash_root_id=id FOR UPDATE`,
      [id, userId],
    );
    if (!source.rowCount) throw new TrashError(404, 'Trash item not found');
    const root = userFilesRoot(storageKey);
    sourcePath = resolveInside(root, source.rows[0]!.trashStoragePath ?? source.rows[0]!.relativePath);
    stagedPath = resolveInside(root, `.originvault-delete-${randomUUID()}`);
    await rename(sourcePath, stagedPath);
    staged = true;
    if (type === 'file') {
      await client.query('DELETE FROM files WHERE id=$1 AND user_id=$2', [id, userId]);
    } else {
      await client.query(`
        WITH RECURSIVE tree AS (
          SELECT id FROM folders WHERE id=$1 AND user_id=$2
          UNION ALL
          SELECT child.id FROM folders child JOIN tree parent ON child.parent_id=parent.id WHERE child.user_id=$2
        ) DELETE FROM files WHERE user_id=$2 AND folder_id IN (SELECT id FROM tree)
      `, [id, userId]);
      await client.query('DELETE FROM folders WHERE id=$1 AND user_id=$2', [id, userId]);
    }
    await client.query('COMMIT');
    committed = true;
    try {
      if (type === 'file') await unlink(stagedPath);
      else await rm(stagedPath, { recursive: true, force: true });
    } catch (error) {
      logger.error({ event: 'trash_permanent_cleanup_failed', userId, type, itemId: id, stagedPath, err: error }, 'Trash bytes could not be removed after database deletion');
    }
  } catch (error) {
    if (!committed) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (staged) await rename(stagedPath, sourcePath).catch(() => undefined);
    }
    throw error;
  } finally {
    client.release();
  }
}

async function permanentlyDeleteTrashedSelection(userId: string, storageKey: string, selection: TrashSelection): Promise<void> {
  if (selection.type === 'file') await permanentlyDeleteTrashedFile(userId, storageKey, selection.id);
  else await permanentlyDeleteTrashedFolder(userId, storageKey, selection.id);
}

async function permanentlyDeleteAllTrash(userId: string, storageKey: string): Promise<number> {
  const roots = await db.query<TrashSelection>(`
    SELECT id,'folder'::text AS type FROM folders WHERE user_id=$1 AND trashed_at IS NOT NULL AND trash_root_id=id
    UNION ALL
    SELECT id,'file'::text AS type FROM files WHERE user_id=$1 AND trashed_at IS NOT NULL AND trash_root_id=id
  `, [userId]);
  for (const selection of roots.rows)
    await permanentlyDeleteTrashedSelection(userId, storageKey, selection);
  return roots.rows.length;
}

export async function purgeExpiredTrash(): Promise<void> {
  const expired = await db.query<{ id: string; userId: string; storageKey: string; type: TrashType }>(`
    SELECT folders.id,folders.user_id AS "userId",users.storage_key AS "storageKey",'folder'::text AS type
    FROM folders JOIN users ON users.id=folders.user_id
    WHERE folders.trashed_at<clock_timestamp()-INTERVAL '${TRASH_RETENTION_DAYS} days' AND folders.trash_root_id=folders.id
    UNION ALL
    SELECT files.id,files.user_id AS "userId",users.storage_key AS "storageKey",'file'::text AS type
    FROM files JOIN users ON users.id=files.user_id
    WHERE files.trashed_at<clock_timestamp()-INTERVAL '${TRASH_RETENTION_DAYS} days' AND files.trash_root_id=files.id
  `);
  for (const item of expired.rows) {
    try {
      await permanentlyDeleteTrashRoot(item.userId, item.storageKey, item.type, item.id);
      logger.info({ event: 'trash_item_expired', userId: item.userId, type: item.type, itemId: item.id }, 'Expired trash item permanently deleted');
    } catch (error) {
      logger.error({ event: 'trash_expiry_cleanup_failed', userId: item.userId, type: item.type, itemId: item.id, err: error }, 'Expired trash item could not be deleted');
    }
  }
}

export async function migrateLegacyTrashStorage(): Promise<void> {
  const roots = await db.query<TrashRootRow & { userId: string; storageKey: string; type: TrashType }>(`
    SELECT * FROM (
      SELECT folders.id,folders.user_id AS "userId",folders.relative_path AS "relativePath",users.storage_key AS "storageKey",'folder'::text AS type
      FROM folders JOIN users ON users.id=folders.user_id
      WHERE folders.trashed_at IS NOT NULL AND folders.trash_root_id=folders.id AND folders.trash_storage_path IS NULL
      UNION ALL
      SELECT files.id,files.user_id AS "userId",files.relative_path AS "relativePath",users.storage_key AS "storageKey",'file'::text AS type
      FROM files JOIN users ON users.id=files.user_id
      WHERE files.trashed_at IS NOT NULL AND files.trash_root_id=files.id AND files.trash_storage_path IS NULL
    ) AS roots
    ORDER BY length("relativePath") DESC
  `);
  for (const item of roots.rows) {
    const root = userFilesRoot(item.storageKey);
    const from = resolveInside(root, item.relativePath);
    const storagePath = trashStoragePath(item.id);
    const to = resolveInside(root, storagePath);
    let moved = false;
    try {
      await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
      await rename(from, to);
      moved = true;
      const updated = await db.query(
        `UPDATE ${item.type === 'file' ? 'files' : 'folders'} SET trash_storage_path=$1
         WHERE id=$2 AND user_id=$3 AND trashed_at IS NOT NULL AND trash_root_id=id AND trash_storage_path IS NULL`,
        [storagePath, item.id, item.userId],
      );
      if (!updated.rowCount) throw new Error('Trash item changed while legacy storage was migrating');
      logger.info({ event: 'legacy_trash_storage_migrated', userId: item.userId, type: item.type, itemId: item.id }, 'Legacy trash bytes moved into isolated storage');
    } catch (error) {
      if (moved) await rename(to, from).catch(() => undefined);
      logger.error({ event: 'legacy_trash_storage_migration_failed', userId: item.userId, type: item.type, itemId: item.id, err: error }, 'Legacy trash bytes could not be isolated');
    }
  }
}

export function createTrashRouter(): express.Router {
  const router = express.Router();
  router.get('/api/trash', requireAuth, asyncHandler(async (req, res) => {
    const result = await db.query(`
      SELECT id,'folder'::text AS type,name,original_created_at AS "originalCreatedAt",original_modified_at AS "originalModifiedAt",trashed_at AS "trashedAt",
        trashed_at+INTERVAL '${TRASH_RETENTION_DAYS} days' AS "expiresAt",
        (SELECT COUNT(*)::integer FROM files WHERE user_id=folders.user_id AND trash_root_id=folders.id) AS "fileCount",
        (SELECT COUNT(*)::integer FROM folders child WHERE child.user_id=folders.user_id AND child.trash_root_id=folders.id) AS "folderCount",
        COALESCE((SELECT SUM(size_bytes) FROM files WHERE user_id=folders.user_id AND trash_root_id=folders.id),0)::text AS "sizeBytes"
      FROM folders WHERE user_id=$1 AND trashed_at IS NOT NULL AND trash_root_id=id
      UNION ALL
      SELECT id,'file'::text AS type,stored_name AS name,original_created_at AS "originalCreatedAt",client_last_modified AS "originalModifiedAt",trashed_at AS "trashedAt",
        trashed_at+INTERVAL '${TRASH_RETENTION_DAYS} days' AS "expiresAt",1::integer AS "fileCount",0::integer AS "folderCount",size_bytes::text AS "sizeBytes"
      FROM files WHERE user_id=$1 AND trashed_at IS NOT NULL AND trash_root_id=id
      ORDER BY "trashedAt" DESC
    `, [req.user!.id]);
    res.json({ items: result.rows, retentionDays: TRASH_RETENTION_DAYS });
  }));
  router.get('/api/trash/folders/:id', requireAuth, asyncHandler(async (req, res) => {
    const folder = await db.query<{ id: string; name: string; parentId: string | null; rootId: string }>(`
      SELECT id,name,parent_id AS "parentId",trash_root_id AS "rootId"
      FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL
    `, [checkedId(req.params.id), req.user!.id]);
    if (!folder.rowCount) throw new TrashError(404, 'Trash folder not found');
    const current = folder.rows[0]!;
    const parent = current.parentId
      ? await db.query<{ id: string }>(`
        SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NOT NULL AND trash_root_id=$3
      `, [current.parentId, req.user!.id, current.rootId])
      : { rowCount: 0, rows: [] };
    const [folders, files] = await Promise.all([
      db.query(`
        SELECT id,'folder'::text AS type,name,parent_id AS "parentId",created_at AS "createdAt",
          original_created_at AS "originalCreatedAt",original_modified_at AS "originalModifiedAt",modified_at AS "modifiedAt",trashed_at AS "trashedAt"
        FROM folders WHERE user_id=$1 AND parent_id=$2 AND trashed_at IS NOT NULL AND trash_root_id=$3
        ORDER BY lower(name) COLLATE "C",id
      `, [req.user!.id, current.id, current.rootId]),
      db.query(`
        SELECT id,'file'::text AS type,stored_name AS name,mime_type AS "mimeType",size_bytes::text AS "sizeBytes",
          sha256,original_created_at AS "originalCreatedAt",client_last_modified AS "originalModifiedAt",created_at AS "createdAt",modified_at AS "modifiedAt",trashed_at AS "trashedAt"
        FROM files WHERE user_id=$1 AND folder_id=$2 AND trashed_at IS NOT NULL AND trash_root_id=$3
        ORDER BY lower(stored_name) COLLATE "C",id
      `, [req.user!.id, current.id, current.rootId]),
    ]);
    res.json({
      folder: { id: current.id, name: current.name, parentId: parent.rowCount ? current.parentId : null },
      folders: folders.rows,
      files: files.rows,
    });
  }));
  router.post('/api/trash/delete', requireAuth, asyncHandler(async (req, res) => {
    const selections = checkedSelections(req.body?.selections);
    for (const selection of selections)
      await permanentlyDeleteTrashedSelection(req.user!.id, req.user!.storageKey, selection);
    logForRequest(req).warn({ event: 'trash_items_permanently_deleted', selectionCount: selections.length }, 'Trash items permanently deleted');
    res.json({ deleted: selections.length });
  }));
  router.delete('/api/trash', requireAuth, asyncHandler(async (req, res) => {
    const deleted = await permanentlyDeleteAllTrash(req.user!.id, req.user!.storageKey);
    logForRequest(req).warn({ event: 'trash_all_permanently_deleted', selectionCount: deleted }, 'All trash items permanently deleted');
    res.json({ deleted });
  }));
  router.get('/api/trash/:type/:id/restore-collision', requireAuth, asyncHandler(async (req, res) => {
    const type = req.params.type === 'file' || req.params.type === 'folder' ? req.params.type : null;
    if (!type) throw new TrashError(404, 'Trash item not found');
    res.json({ conflict: await restoreHasCollision(req.user!.id, req.user!.storageKey, type, checkedId(req.params.id)) });
  }));
  router.post('/api/trash/:type/:id/restore', requireAuth, asyncHandler(async (req, res) => {
    const type = req.params.type === 'file' || req.params.type === 'folder' ? req.params.type : null;
    if (!type) throw new TrashError(404, 'Trash item not found');
    const collisionChoice = req.body?.collision === 'overwrite' || req.body?.collision === 'rename'
      ? req.body.collision
      : undefined;
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${req.user!.id}`]);
      const itemId = checkedId(req.params.id);
      const restored = type === 'file'
        ? await restoreTrashedFile(client, req.user!.id, req.user!.storageKey, itemId, collisionChoice)
        : await restoreTrashRoot(client, req.user!.id, req.user!.storageKey, type, itemId, collisionChoice);
      await client.query('COMMIT');
      logForRequest(req).info({ event: 'trash_item_restored', type, itemId: req.params.id, ...restored }, 'Trash item restored');
      res.json({ restored });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));
  router.delete('/api/trash/:type/:id', requireAuth, asyncHandler(async (req, res) => {
    const type = req.params.type === 'file' || req.params.type === 'folder' ? req.params.type : null;
    if (!type) throw new TrashError(404, 'Trash item not found');
    const itemId = checkedId(req.params.id);
    await permanentlyDeleteTrashedSelection(req.user!.id, req.user!.storageKey, { type, id: itemId });
    logForRequest(req).warn({ event: 'trash_item_permanently_deleted', type, itemId: req.params.id }, 'Trash item permanently deleted');
    res.status(204).end();
  }));
  router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (!(error instanceof TrashError)) { next(error); return; }
    res.status(error.statusCode).json({ error: error.message });
  });
  return router;
}

export const trashRouter = createTrashRouter();
