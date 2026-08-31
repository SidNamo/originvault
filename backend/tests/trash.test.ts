import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import type { PoolClient } from 'pg';
import { moveSelectionsToTrash, TrashError } from '../src/trash.js';
import { userFilesRoot } from '../src/storage.js';

const USER_ID = '0f31df48-1c02-44ec-9400-1ad57ccf1eb0';
const ROOT_FOLDER_ID = '4ab60df5-df34-4b24-b98f-99b8ac0253a0';
const CHILD_FOLDER_ID = '9a540b9b-fb96-4a24-b587-7d4fce4ca731';
const NESTED_FILE_ID = 'cb0e56f5-4212-46a1-b0ad-7ce750ded23d';
const OUTSIDE_FILE_ID = 'e5ca0ed5-15e0-4b07-8cfe-bc5c1c3f7ab6';
const STORAGE_KEY = `trash-test-${process.pid}`;

test('trash selection keeps nested items under one folder root', async () => {
  const root = userFilesRoot(STORAGE_KEY);
  await mkdir(path.join(root, 'projects/archive'), { recursive: true });
  await writeFile(path.join(root, 'projects/archive/readme.txt'), 'nested');
  await writeFile(path.join(root, 'todo.txt'), 'outside');
  const calls: Array<{ sql: string; values: unknown[] | undefined }> = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      if (sql.includes('FROM files\n      WHERE user_id=$1 AND trashed_at IS NULL')) {
        return {
          rowCount: 2,
          rows: [
            { id: NESTED_FILE_ID, relativePath: 'projects/archive/readme.txt' },
            { id: OUTSIDE_FILE_ID, relativePath: 'todo.txt' },
          ],
        };
      }
      if (sql.includes('FROM folders\n      WHERE user_id=$1 AND trashed_at IS NULL')) {
        return {
          rowCount: 2,
          rows: [
            { id: ROOT_FOLDER_ID, relativePath: 'projects' },
            { id: CHILD_FOLDER_ID, relativePath: 'projects/archive' },
          ],
        };
      }
      if (sql.includes("'folder'::text AS type")) return { rowCount: 0, rows: [] };
      if (sql.includes('WITH RECURSIVE tree')) {
        return { rowCount: 1, rows: [{ files: '2', folders: '2' }] };
      }
      if (sql.includes('UPDATE files SET trashed_at=clock_timestamp(),trash_root_id=id')) {
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    },
  } as unknown as PoolClient;

  const result = await moveSelectionsToTrash(client, USER_ID, STORAGE_KEY, [
    { type: 'folder', id: CHILD_FOLDER_ID },
    { type: 'file', id: OUTSIDE_FILE_ID },
    { type: 'folder', id: ROOT_FOLDER_ID },
    { type: 'file', id: NESTED_FILE_ID },
  ]);

  assert.deepEqual(result, { files: 3, folders: 2 });
  const subtreeUpdates = calls.filter((call) => call.sql.includes('WITH RECURSIVE tree'));
  assert.equal(subtreeUpdates.length, 1);
  assert.deepEqual(subtreeUpdates[0]!.values, [ROOT_FOLDER_ID, USER_ID, `.originvault-trash/${ROOT_FOLDER_ID}`]);
  const directFileUpdate = calls.find((call) => call.sql.includes('UPDATE files SET trashed_at=clock_timestamp(),trash_root_id=id'));
  assert.deepEqual(directFileUpdate?.values, [OUTSIDE_FILE_ID, USER_ID, `.originvault-trash/${OUTSIDE_FILE_ID}`]);
  assert.equal(await readFile(path.join(root, '.originvault-trash', ROOT_FOLDER_ID, 'archive/readme.txt'), 'utf8'), 'nested');
  assert.equal(await readFile(path.join(root, '.originvault-trash', OUTSIDE_FILE_ID), 'utf8'), 'outside');
});

test('trash selections reject an empty or malformed selection', async () => {
  const client = {} as PoolClient;
  await assert.rejects(() => moveSelectionsToTrash(client, USER_ID, STORAGE_KEY, []), TrashError);
  await assert.rejects(
    () => moveSelectionsToTrash(client, USER_ID, STORAGE_KEY, [{ type: 'file', id: 'not-a-uuid' }]),
    TrashError,
  );
});
