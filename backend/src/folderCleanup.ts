import { rmdir } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import { logger } from './logger.js';
import { resolveInside, userFilesRoot } from './storage.js';

/** Removes indexed active folders that became empty, deepest parent first. */
export async function pruneEmptyActiveFolders(
  client: PoolClient,
  userId: string,
  firstFolderId: string | null,
): Promise<string[]> {
  const paths: string[] = [];
  let folderId = firstFolderId;
  while (folderId) {
    const folder = await client.query<{ parentId: string | null; relativePath: string }>(`
      SELECT parent_id AS "parentId",relative_path AS "relativePath"
      FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL FOR UPDATE
    `, [folderId, userId]);
    if (!folder.rowCount) break;
    const children = await client.query(`
      SELECT 1 FROM files WHERE user_id=$1 AND folder_id=$2 AND trashed_at IS NULL
      UNION ALL
      SELECT 1 FROM folders WHERE user_id=$1 AND parent_id=$2 AND trashed_at IS NULL
      LIMIT 1
    `, [userId, folderId]);
    if (children.rowCount) break;
    const current = folder.rows[0]!;
    await client.query('DELETE FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL', [folderId, userId]);
    paths.push(current.relativePath);
    folderId = current.parentId;
  }
  return paths;
}

/** Database cleanup commits first; stale or unindexed filesystem entries are never removed. */
export async function removeEmptyActiveFolderPaths(storageKey: string, relativePaths: string[]): Promise<void> {
  const root = userFilesRoot(storageKey);
  for (const relativePath of relativePaths) {
    try {
      await rmdir(resolveInside(root, relativePath));
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTEMPTY')
        logger.error({ event: 'empty_folder_cleanup_failed', storageKey, relativePath, err: error }, 'Empty folder cleanup failed');
    }
  }
}
