import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ifRangePermitsRange,
  parsePublicArchiveRequest,
  parsePublicByteRange,
  planPublicArchivePaths,
  PUBLIC_SHARE_LIMITS,
  publicFileRecord,
  publicFolderRecord,
  rebaseArchiveSegments,
  safeArchiveSegment,
} from '../src/shares.js';

const FILE_ID = '042f76d4-5a8c-4e8f-9650-0a0b22dcc51f';
const FOLDER_ID = '315fa698-160f-4eb7-9494-0c919798b203';

test('public archive requests are strict, bounded, normalized, and de-duplicated', () => {
  assert.deepEqual(parsePublicArchiveRequest({ mode: 'all' }), { mode: 'all', selections: [] });
  assert.deepEqual(parsePublicArchiveRequest({
    mode: 'selection',
    selections: [
      { type: 'file', id: FILE_ID.toUpperCase() },
      { type: 'file', id: FILE_ID },
      { type: 'folder', id: FOLDER_ID },
    ],
  }), {
    mode: 'selection',
    selections: [
      { type: 'file', id: FILE_ID },
      { type: 'folder', id: FOLDER_ID },
    ],
  });
  assert.throws(() => parsePublicArchiveRequest({ mode: 'all', selections: [] }), /must not include selections/);
  assert.throws(() => parsePublicArchiveRequest({ mode: 'selection', selections: [] }), /At least one/);
  assert.throws(() => parsePublicArchiveRequest({ mode: 'selection', selections: [{ type: 'file', id: 'invalid' }] }), /valid file or folder id/);
  assert.throws(() => parsePublicArchiveRequest({
    mode: 'selection',
    selections: Array.from({ length: PUBLIC_SHARE_LIMITS.archiveSelections + 1 }, () => ({ type: 'file', id: FILE_ID })),
  }), /No more than/);
});

test('archive paths are rebased to the shared root and reject outside or non-canonical storage paths', () => {
  assert.deepEqual(rebaseArchiveSegments('account/Shared', 'account/Shared'), []);
  assert.deepEqual(rebaseArchiveSegments('account/Shared', 'account/Shared/Photos/Raw'), ['Photos', 'Raw']);
  assert.throws(() => rebaseArchiveSegments('account/Shared', 'account/Shared-old/private'), /outside the shared root/);
  assert.throws(() => rebaseArchiveSegments('account/Shared', 'account/Shared/../private'), /hierarchy is inconsistent/);
});

test('archive planning sanitizes names, prevents ZIP slip, preserves directories, and resolves collisions', () => {
  assert.equal(safeArchiveSegment('../../evil?.txt'), '.._.._evil_.txt');
  assert.equal(safeArchiveSegment('CON'), '_CON');
  const plan = planPublicArchivePaths('../Shared?', [
    ['Photos'],
    ['Photos', 'Empty'],
  ], [
    { id: 'a', name: 'report?.txt', directorySegments: ['Photos'] },
    { id: 'b', name: 'REPORT?.txt', directorySegments: ['Photos'] },
    { id: 'c', name: 'Empty', directorySegments: ['Photos'] },
  ]);
  assert.deepEqual(plan.directories.map((entry) => entry.archivePath), [
    '.._Shared_',
    '.._Shared_/Photos',
    '.._Shared_/Photos/Empty',
  ]);
  assert.deepEqual(plan.files, [
    { id: 'a', archivePath: '.._Shared_/Photos/report_.txt' },
    { id: 'b', archivePath: '.._Shared_/Photos/REPORT_ (1).txt' },
    { id: 'c', archivePath: '.._Shared_/Photos/Empty (1)' },
  ]);
  for (const archivePath of [...plan.directories.map((entry) => entry.archivePath), ...plan.files.map((entry) => entry.archivePath)]) {
    assert.equal(archivePath.startsWith('/'), false);
    assert.equal(archivePath.includes('\\'), false);
    assert.equal(archivePath.split('/').some((segment) => segment === '.' || segment === '..'), false);
  }
});

test('public record serializers allowlist fields and omit storage and ownership data', () => {
  const file = publicFileRecord({
    id: FILE_ID,
    name: 'safe.txt',
    mimeType: 'text/plain',
    sizeBytes: '12',
    sha256: 'a'.repeat(64),
    originalCreatedAt: '2025-12-31T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
    clientLastModified: null,
    relativePath: 'private/safe.txt',
    storedName: 'safe.txt',
    storageKey: 'private-owner',
    userId: 'secret',
    metadata: { secret: true },
  });
  assert.deepEqual(file, {
    id: FILE_ID,
    name: 'safe.txt',
    mimeType: 'text/plain',
    sizeBytes: '12',
    sha256: 'a'.repeat(64),
    originalCreatedAt: '2025-12-31T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
    clientLastModified: null,
    kind: 'text',
  });
  assert.deepEqual(publicFolderRecord({
    id: FOLDER_ID,
    name: 'Shared',
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
    parentId: 'outside',
    relativePath: 'private/Shared',
    userId: 'secret',
  }), {
    id: FOLDER_ID,
    name: 'Shared',
    createdAt: '2026-01-01T00:00:00.000Z',
    modifiedAt: '2026-01-02T00:00:00.000Z',
  });
});

test('single byte ranges and If-Range validators handle boundaries safely', () => {
  assert.deepEqual(parsePublicByteRange(undefined, 10), { kind: 'none' });
  assert.deepEqual(parsePublicByteRange('bytes=0-0', 10), { kind: 'range', start: 0, end: 0 });
  assert.deepEqual(parsePublicByteRange('bytes=5-', 10), { kind: 'range', start: 5, end: 9 });
  assert.deepEqual(parsePublicByteRange('bytes=-3', 10), { kind: 'range', start: 7, end: 9 });
  assert.deepEqual(parsePublicByteRange('bytes=0-999', 10), { kind: 'range', start: 0, end: 9 });
  for (const value of ['bytes=10-', 'bytes=-0', 'bytes=0-1,4-5', 'items=0-1', 'bytes=-'])
    assert.deepEqual(parsePublicByteRange(value, 10), { kind: 'unsatisfiable' });

  const etag = '"sha256-value"';
  const modifiedAt = '2026-01-01T12:00:00.000Z';
  assert.equal(ifRangePermitsRange(undefined, etag, modifiedAt), true);
  assert.equal(ifRangePermitsRange(etag, etag, modifiedAt), true);
  assert.equal(ifRangePermitsRange('"different"', etag, modifiedAt), false);
  assert.equal(ifRangePermitsRange(`W/${etag}`, etag, modifiedAt), false);
  assert.equal(ifRangePermitsRange('Thu, 01 Jan 2026 13:00:00 GMT', etag, modifiedAt), true);
  assert.equal(ifRangePermitsRange('Thu, 01 Jan 2026 11:00:00 GMT', etag, modifiedAt), false);
});
