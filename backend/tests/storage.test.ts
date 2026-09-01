import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

test('safe path and exact bytes survive storage', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'originvault-'));
  process.env.DATA_ROOT = temp;
  process.env.LOG_DIR = path.join(temp, 'logs');
  const { resolveInside, safeRelativeDirectory, safeSegment, storeOriginal } = await import('../src/storage.js');
  const original = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0x00, 0xfe, 0x7f]);
  const expectedHash = createHash('sha256').update(original).digest('hex');
  try {
    const result = await storeOriginal({ storageKey: 'tester', username: 'tester', folderPath: 'photos/2026', originalName: 'raw.jpg', stream: Readable.from(original) });
    assert.equal(result.relativePath, path.join('photos', '2026', 'raw.jpg'));
    assert.equal(result.absolutePath, path.join(temp, 'tester', 'photos', '2026', 'raw.jpg'));
    assert.deepEqual(await readFile(result.absolutePath), original);
    assert.equal(result.sha256, expectedHash);
    const [firstConcurrent, secondConcurrent] = await Promise.all([
      storeOriginal({ storageKey: 'tester', username: 'tester', folderPath: 'photos/2026', originalName: 'same.txt', stream: Readable.from(Buffer.from('first')) }),
      storeOriginal({ storageKey: 'tester', username: 'tester', folderPath: 'photos/2026', originalName: 'same.txt', stream: Readable.from(Buffer.from('second')) }),
    ]);
    assert.notEqual(firstConcurrent.storedName, secondConcurrent.storedName);
    assert.deepEqual(new Set([await readFile(firstConcurrent.absolutePath, 'utf8'), await readFile(secondConcurrent.absolutePath, 'utf8')]), new Set(['first', 'second']));
    assert.throws(() => resolveInside(temp, '../../etc/passwd'));
    assert.equal(safeSegment('../photo?.jpg'), 'photo_.jpg');
    assert.equal(safeRelativeDirectory('여행/2026/원본'), '여행/2026/원본');
    assert.throws(() => safeRelativeDirectory('photos/../private'));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});

test('hidden markers and embedded creation dates are recognized', async () => {
  const { isHiddenResource, originalCreatedAtFromMetadata } = await import('../src/storage.js');
  assert.equal(isHiddenResource('.env'), true);
  assert.equal(isHiddenResource('photo.jpg', { 'File:FileAttributes': 0x22 }), true);
  assert.equal(isHiddenResource('photo.jpg', { 'System:FileAttributes': 'Archive, Hidden' }), true);
  assert.equal(isHiddenResource('photo.jpg', { 'File:FileAttributes': 'Archive' }), false);
  assert.equal(
    originalCreatedAtFromMetadata({ 'PDF:CreateDate': '2025:07:22 16:25:53+09:00' })?.toISOString(),
    '2025-07-22T07:25:53.000Z',
  );
  assert.equal(originalCreatedAtFromMetadata({ 'PDF:CreateDate': 'not a date' }), undefined);
});
