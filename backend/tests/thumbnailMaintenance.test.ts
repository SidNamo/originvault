import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { config } from '../src/config.js';
import {
  backfillMissingThumbnails,
  thumbnailBackfillSourcePath,
  type ThumbnailBackfillFile,
} from '../src/thumbnailMaintenance.js';
import { hasCachedThumbnail } from '../src/thumbnails.js';

test('thumbnail backfill generates only missing content hashes', async () => {
  const storageKey = `backfill-${randomUUID()}`;
  const directory = path.join(config.dataRoot, storageKey);
  const sourcePath = path.join(directory, 'existing.png');
  const source = await sharp({
    create: {
      width: 900,
      height: 600,
      channels: 3,
      background: '#65438a',
    },
  }).png().toBuffer();
  const sha256 = createHash('sha256').update(source).digest('hex');
  const file: ThumbnailBackfillFile = {
    id: randomUUID(),
    storageKey,
    name: 'existing.png',
    relativePath: 'existing.png',
    mimeType: 'application/octet-stream',
    sha256,
    trashedAt: null,
    trashStoragePath: null,
    trashRootRelativePath: null,
  };
  await mkdir(directory, { recursive: true });
  await writeFile(sourcePath, source);
  try {
    const fetchPage = async (cursor: string | null) => cursor ? [] : [file, { ...file, id: randomUUID() }];
    const first = await backfillMissingThumbnails(fetchPage, { batchSize: 10, concurrency: 2 });
    assert.equal(first.scannedFiles, 2);
    assert.equal(first.eligibleHashes, 1);
    assert.equal(first.generatedThumbnails, 1);
    assert.equal(first.existingThumbnails, 0);
    assert.equal(await hasCachedThumbnail(file), true);

    const second = await backfillMissingThumbnails(fetchPage, { batchSize: 10, concurrency: 2 });
    assert.equal(second.generatedThumbnails, 0);
    assert.equal(second.existingThumbnails, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('thumbnail backfill retries duplicate content after unavailable sources', async () => {
  const storageKey = `backfill-fallback-${randomUUID()}`;
  const directory = path.join(config.dataRoot, storageKey);
  const validSource = await sharp({
    create: {
      width: 731,
      height: 487,
      channels: 3,
      background: '#8a542f',
    },
  }).png().toBuffer();
  const staleSource = await sharp({
    create: {
      width: 731,
      height: 487,
      channels: 3,
      background: '#285b81',
    },
  }).png().toBuffer();
  const sha256 = createHash('sha256').update(validSource).digest('hex');
  const base: ThumbnailBackfillFile = {
    id: randomUUID(),
    storageKey,
    name: 'missing.png',
    relativePath: 'missing.png',
    mimeType: 'image/png',
    sha256,
    trashedAt: null,
    trashStoragePath: null,
    trashRootRelativePath: null,
  };
  const stale = { ...base, id: randomUUID(), name: 'stale.png', relativePath: 'stale.png' };
  const valid = { ...base, id: randomUUID(), name: 'valid.png', relativePath: 'valid.png' };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, stale.relativePath), staleSource);
  await writeFile(path.join(directory, valid.relativePath), validSource);
  try {
    const fetchPage = async (cursor: string | null) => cursor ? [] : [base, stale, valid];
    const result = await backfillMissingThumbnails(fetchPage, { batchSize: 10, concurrency: 3 });
    assert.equal(result.scannedFiles, 3);
    assert.equal(result.eligibleHashes, 1);
    assert.equal(result.unavailableFiles, 2);
    assert.equal(result.failedThumbnails, 0);
    assert.equal(result.generatedThumbnails, 1);
    assert.equal(await hasCachedThumbnail(valid), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('thumbnail backfill continues duplicate fallback across pages', async () => {
  const storageKey = `backfill-pages-${randomUUID()}`;
  const directory = path.join(config.dataRoot, storageKey);
  const source = await sharp({
    create: {
      width: 619,
      height: 413,
      channels: 3,
      background: '#742d55',
    },
  }).png().toBuffer();
  const sha256 = createHash('sha256').update(source).digest('hex');
  const missing: ThumbnailBackfillFile = {
    id: randomUUID(),
    storageKey,
    name: 'missing.png',
    relativePath: 'missing.png',
    mimeType: 'image/png',
    sha256,
    trashedAt: null,
    trashStoragePath: null,
    trashRootRelativePath: null,
  };
  const valid = { ...missing, id: randomUUID(), name: 'valid.png', relativePath: 'valid.png' };
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, valid.relativePath), source);
  try {
    const fetchPage = async (cursor: string | null, limit: number) => {
      assert.equal(limit, 1);
      if (cursor === null) return [missing];
      if (cursor === missing.id) return [valid];
      return [];
    };
    const result = await backfillMissingThumbnails(fetchPage, { batchSize: 1, concurrency: 2 });
    assert.equal(result.scannedFiles, 2);
    assert.equal(result.unavailableFiles, 1);
    assert.equal(result.generatedThumbnails, 1);
    assert.equal(await hasCachedThumbnail(valid), true);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('thumbnail backfill resolves nested trashed files inside the isolated root', () => {
  const file: ThumbnailBackfillFile = {
    id: randomUUID(),
    storageKey: 'storage-key',
    name: 'photo.heic',
    relativePath: 'album/nested/photo.heic',
    mimeType: 'image/heic',
    sha256: 'a'.repeat(64),
    trashedAt: new Date(),
    trashStoragePath: '.originvault-trash/root',
    trashRootRelativePath: 'album',
  };
  assert.equal(
    thumbnailBackfillSourcePath(file),
    path.join(config.dataRoot, 'storage-key', '.originvault-trash/root/nested/photo.heic'),
  );
  assert.throws(
    () => thumbnailBackfillSourcePath({ ...file, relativePath: 'another/photo.heic' }),
    /outside its trash root/,
  );
});
