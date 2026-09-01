import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { config } from './config.js';
import { db } from './db.js';
import { logger } from './logger.js';
import { resolveInside, userFilesRoot } from './storage.js';

export const PREVIEW_MUTATION_STAGING = '.originvault-preview-staging';
export const DAV_MUTATION_STAGING = '.dav-staging';
const UPLOAD_SESSION_STAGING = '.upload-sessions';

interface MutationJournalBase {
  version: 1;
  operationId: string;
  userId: string;
  createdAt: string;
}

export interface ContentMutationJournalRecord extends MutationJournalBase {
  source: 'text-edit' | 'webdav-put';
  kind: 'replace' | 'create';
  fileId: string;
  relativePath: string;
  oldSha256: string | null;
  oldRowVersion?: string;
  newSha256: string;
}

export interface MoveMutationJournalRecord extends MutationJournalBase {
  source: 'webdav-move';
  kind: 'move';
  resourceType: 'file' | 'folder';
  resourceId: string;
  relativePath: string;
  targetRelativePath: string;
}

export type MutationJournalRecord = ContentMutationJournalRecord | MoveMutationJournalRecord;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

export function mutationStagingRoot(name: string): string {
  return resolveInside(config.dataRoot, name);
}

function journalPath(stagingRoot: string, operationId: string): string {
  return resolveInside(stagingRoot, `journal-${operationId}.json`);
}

export function mutationBackupPath(stagingRoot: string, operationId: string): string {
  return resolveInside(stagingRoot, `backup-${operationId}`);
}

export function mutationEditPath(stagingRoot: string, operationId: string): string {
  return resolveInside(stagingRoot, `edit-${operationId}`);
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function fileSha256(filePath: string): Promise<string | null> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } catch (error: any) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function validRelativePath(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !path.isAbsolute(value)
    && !value.includes('\\')
    && !value.split('/').some((segment) => !segment || segment === '.' || segment === '..');
}

function validRecord(value: unknown): value is MutationJournalRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  const common = record.version === 1
    && UUID_PATTERN.test(String(record.operationId ?? ''))
    && UUID_PATTERN.test(String(record.userId ?? ''))
    && typeof record.createdAt === 'string'
    && Number.isFinite(new Date(record.createdAt).getTime());
  if (!common || !validRelativePath(record.relativePath)) return false;
  if (record.source === 'webdav-move') {
    return record.kind === 'move'
      && (record.resourceType === 'file' || record.resourceType === 'folder')
      && UUID_PATTERN.test(String(record.resourceId ?? ''))
      && validRelativePath(record.targetRelativePath)
      && record.targetRelativePath !== record.relativePath;
  }
  return (record.source === 'text-edit' || record.source === 'webdav-put')
    && (record.kind === 'replace' || record.kind === 'create')
    && UUID_PATTERN.test(String(record.fileId ?? ''))
    && (record.oldSha256 === null || SHA256_PATTERN.test(String(record.oldSha256 ?? '')))
    && (record.oldRowVersion === undefined || /^\d+$/.test(String(record.oldRowVersion)))
    && SHA256_PATTERN.test(String(record.newSha256 ?? ''))
    && ((record.source === 'text-edit' && record.kind === 'replace' && record.oldSha256 !== null)
      || (record.source === 'webdav-put' && ((record.kind === 'replace' && record.oldSha256 !== null)
        || (record.kind === 'create' && record.oldSha256 === null))));
}

export async function writeMutationJournal(stagingRoot: string, record: MutationJournalRecord): Promise<void> {
  if (!validRecord(record)) throw new Error('Invalid mutation journal record');
  await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const finalPath = journalPath(stagingRoot, record.operationId);
  const temporaryPath = resolveInside(stagingRoot, `journal-${record.operationId}.tmp`);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, finalPath);
  await syncDirectory(stagingRoot);
}

export async function removeMutationJournal(stagingRoot: string, operationId: string, removeBackup: boolean): Promise<void> {
  if (removeBackup) {
    await rm(mutationBackupPath(stagingRoot, operationId), { force: true });
    await syncDirectory(stagingRoot);
  }
  await rm(journalPath(stagingRoot, operationId), { force: true });
  await syncDirectory(stagingRoot);
}

async function pathEntryExists(filePath: string): Promise<boolean> {
  try {
    await lstat(filePath);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function durableRename(sourcePath: string, targetPath: string): Promise<void> {
  await rename(sourcePath, targetPath);
  const sourceDirectory = path.dirname(sourcePath);
  const targetDirectory = path.dirname(targetPath);
  await syncDirectory(sourceDirectory);
  if (targetDirectory !== sourceDirectory) await syncDirectory(targetDirectory);
}

async function reconcileMoveJournal(client: PoolClient, storageKey: string, record: MoveMutationJournalRecord): Promise<boolean> {
  const indexed = record.resourceType === 'file'
    ? await client.query<{ relativePath: string }>('SELECT relative_path AS "relativePath" FROM files WHERE id=$1 AND user_id=$2', [record.resourceId, record.userId])
    : await client.query<{ relativePath: string }>('SELECT relative_path AS "relativePath" FROM folders WHERE id=$1 AND user_id=$2', [record.resourceId, record.userId]);
  const root = userFilesRoot(storageKey);
  const sourcePath = resolveInside(root, record.relativePath);
  const targetPath = resolveInside(root, record.targetRelativePath);
  const [sourceExists, targetExists] = await Promise.all([pathEntryExists(sourcePath), pathEntryExists(targetPath)]);
  if (!indexed.rowCount) return !sourceExists && !targetExists;
  const indexedPath = indexed.rows[0]!.relativePath;
  if (indexedPath === record.targetRelativePath) {
    if (targetExists && !sourceExists) return true;
    if (sourceExists && !targetExists) {
      await durableRename(sourcePath, targetPath);
      return true;
    }
  } else if (indexedPath === record.relativePath) {
    if (sourceExists && !targetExists) return true;
    if (!sourceExists && targetExists) {
      await durableRename(targetPath, sourcePath);
      return true;
    }
  } else if (!sourceExists && !targetExists) {
    return true;
  }
  return false;
}

async function reconcileJournal(stagingRoot: string, record: MutationJournalRecord): Promise<boolean> {
  const client = await db.connect();
  let reconciled = false;
  let removeBackup = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${record.userId}`]);
    const user = await client.query<{ storageKey: string }>(
      'SELECT storage_key AS "storageKey" FROM users WHERE id=$1',
      [record.userId],
    );
    if (!user.rowCount) {
      reconciled = true;
      removeBackup = true;
    } else if (record.source === 'webdav-move') {
      reconciled = await reconcileMoveJournal(client, user.rows[0]!.storageKey, record);
    } else {
      const [indexed, pathOwner, reservation] = await Promise.all([
        client.query<{ id: string; relativePath: string; sha256: string; rowVersion: string }>(`
          SELECT id,relative_path AS "relativePath",sha256,xmin::text AS "rowVersion" FROM files
          WHERE id=$1 AND user_id=$2
        `, [record.fileId, record.userId]),
        client.query<{ id: string; sha256: string }>(`
          SELECT id,sha256 FROM files WHERE user_id=$1 AND relative_path=$2
        `, [record.userId, record.relativePath]),
        client.query('SELECT 1 FROM upload_sessions WHERE user_id=$1 AND final_relative_path=$2', [record.userId, record.relativePath]),
      ]);
      const root = userFilesRoot(user.rows[0]!.storageKey);
      const indexedFile = indexed.rows[0];
      const targetRelativePath = indexedFile?.relativePath ?? record.relativePath;
      const targetPath = resolveInside(root, targetRelativePath);
      const targetSha256 = await fileSha256(targetPath);
      const backupPath = mutationBackupPath(stagingRoot, record.operationId);
      const backupSha256 = record.kind === 'replace' ? await fileSha256(backupPath) : null;

      const legacySameHashReplacement = record.kind === 'replace'
        && record.oldSha256 === record.newSha256
        && record.oldRowVersion === undefined
        && backupSha256 === record.oldSha256;
      if (legacySameHashReplacement) {
        logger.error({ event: 'mutation_journal_same_hash_ambiguous', operationId: record.operationId }, 'Legacy same-content replacement journal cannot distinguish commit from rollback and was retained');
      } else if (indexedFile?.sha256 === record.newSha256 && targetSha256 === record.newSha256
        && (record.kind === 'create' || record.oldSha256 !== record.newSha256 || indexedFile.rowVersion !== record.oldRowVersion)) {
        reconciled = true;
        removeBackup = true;
      } else if (indexedFile && targetSha256 === indexedFile.sha256
        && indexedFile.sha256 !== record.oldSha256) {
        reconciled = true;
        removeBackup = true;
      } else if (record.kind === 'replace' && backupSha256 === record.oldSha256
        && (targetSha256 === record.newSha256 || targetSha256 === null)) {
        await rename(backupPath, targetPath);
        await syncDirectory(path.dirname(targetPath));
        reconciled = true;
        removeBackup = true;
      } else if (record.kind === 'replace' && indexedFile?.sha256 === record.oldSha256
        && targetSha256 === record.oldSha256) {
        reconciled = true;
        removeBackup = true;
      } else if (record.kind === 'create' && !indexedFile && pathOwner.rowCount) {
        if (targetSha256 === pathOwner.rows[0]!.sha256) reconciled = true;
      } else if (record.kind === 'create' && !indexedFile && !reservation.rowCount) {
        if (targetSha256 === record.newSha256) {
          await rm(targetPath, { force: true });
          await syncDirectory(path.dirname(targetPath));
          reconciled = true;
        } else if (targetSha256 === null) reconciled = true;
      }
    }

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    logger.error({ event: 'mutation_journal_recovery_failed', operationId: record.operationId, source: record.source, err: error }, 'Mutation journal recovery failed and its artifacts were retained');
    return false;
  } finally {
    client.release();
  }

  if (!reconciled) {
    logger.error({ event: 'mutation_journal_state_ambiguous', operationId: record.operationId, source: record.source }, 'Mutation journal state was ambiguous and its artifacts were retained');
    return false;
  }
  try {
    await removeMutationJournal(stagingRoot, record.operationId, removeBackup);
  } catch (error) {
    logger.error({ event: 'mutation_journal_cleanup_failed', operationId: record.operationId, source: record.source, err: error }, 'Reconciled mutation journal cleanup failed');
    return false;
  }
  logger.warn({ event: 'mutation_journal_reconciled', operationId: record.operationId, source: record.source }, 'Interrupted storage mutation was reconciled');
  return true;
}

export async function reconcileMutationJournals(): Promise<void> {
  const reservedUsers = await db.query<{ id: string; storageKey: string }>(`
    SELECT id,storage_key AS "storageKey" FROM users
    WHERE storage_key IN ($1,$2,$3)
  `, [UPLOAD_SESSION_STAGING, PREVIEW_MUTATION_STAGING, DAV_MUTATION_STAGING]);
  if (reservedUsers.rowCount)
    throw new Error(`Reserved storage roots are still assigned to users: ${reservedUsers.rows.map((row) => row.id).join(', ')}`);

  const pending: Array<{ stagingRoot: string; record: MutationJournalRecord }> = [];
  let invalidJournals = 0;
  for (const directoryName of [PREVIEW_MUTATION_STAGING, DAV_MUTATION_STAGING]) {
    const stagingRoot = mutationStagingRoot(directoryName);
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    await syncDirectory(config.dataRoot);
    const entries = await readdir(stagingRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.startsWith('journal-') || !entry.name.endsWith('.json')) continue;
      const sourcePath = resolveInside(stagingRoot, entry.name);
      try {
        const parsed: unknown = JSON.parse(await readFile(sourcePath, 'utf8'));
        if (!validRecord(parsed) || entry.name !== `journal-${parsed.operationId}.json`) throw new Error('Invalid mutation journal');
        pending.push({ stagingRoot, record: parsed });
      } catch (error) {
        invalidJournals += 1;
        logger.error({ event: 'mutation_journal_invalid', sourcePath, err: error }, 'Mutation journal could not be parsed and was retained');
      }
    }
  }
  pending.sort((left, right) => new Date(right.record.createdAt).getTime() - new Date(left.record.createdAt).getTime());
  let remaining = pending;
  let madeProgress = false;
  do {
    madeProgress = false;
    const next: typeof remaining = [];
    for (const entry of remaining) {
      if (await reconcileJournal(entry.stagingRoot, entry.record)) madeProgress = true;
      else next.push(entry);
    }
    remaining = next;
  } while (madeProgress && remaining.length);
  const unresolved = invalidJournals + remaining.length;
  if (unresolved) throw new Error(`${unresolved} storage mutation journal(s) could not be reconciled safely`);

  for (const directoryName of [PREVIEW_MUTATION_STAGING, DAV_MUTATION_STAGING]) {
    const stagingRoot = mutationStagingRoot(directoryName);
    const entries = await readdir(stagingRoot, { withFileTypes: true });
    const orphanBackups = entries.filter((entry) => entry.isFile() && entry.name.startsWith('backup-'));
    if (orphanBackups.length)
      throw new Error(`Unmapped storage mutation backups require manual recovery in ${stagingRoot}`);
    await Promise.all(entries
      .filter((entry) => entry.name.startsWith('edit-') || entry.name.endsWith('.tmp'))
      .map((entry) => rm(resolveInside(stagingRoot, entry.name), { recursive: entry.isDirectory(), force: true })));
    await syncDirectory(stagingRoot);
  }
}
