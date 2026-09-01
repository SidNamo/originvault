import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fileSha256,
  mutationBackupPath,
  removeMutationJournal,
  type MutationJournalRecord,
  writeMutationJournal,
} from '../src/mutationJournal.js';

const record: MutationJournalRecord = {
  version: 1,
  operationId: '155bcbaa-5685-4bc5-8f7b-d59f471f9384',
  source: 'text-edit',
  kind: 'replace',
  userId: '315fa698-160f-4eb7-9494-0c919798b203',
  fileId: '042f76d4-5a8c-4e8f-9650-0a0b22dcc51f',
  relativePath: 'notes/readme.txt',
  oldSha256: 'a'.repeat(64),
  oldRowVersion: '42',
  newSha256: 'b'.repeat(64),
  createdAt: '2026-08-28T00:00:00.000Z',
};

const moveRecord: MutationJournalRecord = {
  version: 1,
  operationId: '5fd83962-f03c-4508-80bd-90600c4f0e10',
  source: 'webdav-move',
  kind: 'move',
  userId: '315fa698-160f-4eb7-9494-0c919798b203',
  resourceType: 'file',
  resourceId: '042f76d4-5a8c-4e8f-9650-0a0b22dcc51f',
  relativePath: 'incoming/photo.jpg.part',
  targetRelativePath: 'photos/photo.jpg',
  createdAt: '2026-08-28T00:00:00.000Z',
};

test('mutation journals are validated, persisted, and removed with their backup', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'originvault-journal-'));
  try {
    await writeMutationJournal(directory, record);
    const journal = JSON.parse(
      await readFile(path.join(directory, `journal-${record.operationId}.json`), 'utf8'),
    );
    assert.deepEqual(journal, record);

    const backup = mutationBackupPath(directory, record.operationId);
    await writeFile(backup, 'original bytes');
    assert.equal(
      await fileSha256(backup),
      '52c3935626c104b2cbc9031291a1c4d56614c38f52072a361d658a58a9c48698',
    );
    await removeMutationJournal(directory, record.operationId, true);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('mutation journals reject unsafe paths and inconsistent operation kinds', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'originvault-journal-'));
  try {
    await assert.rejects(
      writeMutationJournal(directory, { ...record, relativePath: '../outside.txt' }),
      /Invalid mutation journal record/,
    );
    await assert.rejects(
      writeMutationJournal(directory, {
        ...record,
        source: 'text-edit',
        kind: 'create',
        oldSha256: null,
      }),
      /Invalid mutation journal record/,
    );
    await assert.rejects(
      writeMutationJournal(directory, { ...record, oldRowVersion: 'not-an-xmin' }),
      /Invalid mutation journal record/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('WebDAV MOVE journals validate and persist both paths', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'originvault-journal-'));
  try {
    await writeMutationJournal(directory, moveRecord);
    const journal = JSON.parse(
      await readFile(path.join(directory, `journal-${moveRecord.operationId}.json`), 'utf8'),
    );
    assert.deepEqual(journal, moveRecord);
    await removeMutationJournal(directory, moveRecord.operationId, false);
    assert.deepEqual(await readdir(directory), []);
    await assert.rejects(
      writeMutationJournal(directory, { ...moveRecord, targetRelativePath: '../outside.jpg' }),
      /Invalid mutation journal record/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
