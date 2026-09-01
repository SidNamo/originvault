import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('resumable upload input normalization and identity are stable and destination-sensitive', async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'originvault-resumable-'));
  process.env.DATA_ROOT = temp;
  process.env.LOG_DIR = path.join(temp, 'logs');
  try {
    const { normalizeUploadInput, parseUploadOffset, uploadIdentityHash } = await import('../src/resumableUploads.js');
    const request = {
      fingerprint: 'photos/trip/raw.jpg:9:1785700000000',
      originalName: 'raw?.jpg',
      sizeBytes: '9',
      mimeType: 'image/jpeg',
      lastModified: 1785700000000,
      folderId: '4b9aefb6-d26f-4c24-a005-853379e1b387',
      relativeDirectory: '여행/원본',
    };
    const first = normalizeUploadInput(request, 1024n);
    const equivalent = normalizeUploadInput({
      fingerprint: 'photos/trip/raw.jpg:9:1785700000000',
      originalName: 'raw?.jpg',
      sizeBytes: 9,
      mimeType: 'image/jpeg',
      lastModified: '2026-08-02T19:46:40.000Z',
      folderId: '4b9aefb6-d26f-4c24-a005-853379e1b387',
      relativeDirectory: '여행\\원본',
    }, 1024n);

    assert.equal(first.originalName, 'raw_.jpg');
    assert.equal(first.relativeDirectory, '여행/원본');
    assert.equal(parseUploadOffset('0'), 0n);
    assert.equal(parseUploadOffset('9007199254740993'), 9007199254740993n);
    assert.equal(uploadIdentityHash('user-1', first), uploadIdentityHash('user-1', equivalent));

    const otherDestination = { ...first, relativeDirectory: '여행/편집본' };
    assert.notEqual(uploadIdentityHash('user-1', first), uploadIdentityHash('user-1', otherDestination));
    assert.notEqual(uploadIdentityHash('user-1', first), uploadIdentityHash('user-2', first));
    assert.throws(() => parseUploadOffset('-1'), /Upload-Offset/);
    assert.throws(() => normalizeUploadInput({ ...request, sizeBytes: '1025' }, 1024n), /too large/i);
    assert.throws(() => normalizeUploadInput({ ...request, relativeDirectory: '../private' }, 1024n), /Invalid relative directory/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
