import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { config } from '../src/config.js';
import {
  getOrCreateImagePreview,
  getOrCreateThumbnail,
  parseThumbnailRange,
  pruneUnusedThumbnails,
  requiresGeneratedImagePreview,
  thumbnailKind,
} from '../src/thumbnails.js';

test('thumbnail classification covers raster images and PDFs without rendering SVG', () => {
  assert.equal(thumbnailKind('photo.JPEG', 'application/octet-stream'), 'image');
  assert.equal(thumbnailKind('iphone.HEIC', 'application/octet-stream'), 'image');
  assert.equal(thumbnailKind('camera.CR3', 'application/octet-stream'), 'image');
  assert.equal(thumbnailKind('archive.PSD', 'application/octet-stream'), 'image');
  assert.equal(thumbnailKind('upload', 'image/x-heic'), 'image');
  assert.equal(thumbnailKind('document.bin', 'application/pdf'), 'pdf');
  assert.equal(thumbnailKind('vector.svg', 'image/svg+xml'), undefined);
  assert.equal(thumbnailKind('archive.zip', 'application/zip'), undefined);
  assert.equal(requiresGeneratedImagePreview('iphone.heic', 'image/heic'), true);
  assert.equal(requiresGeneratedImagePreview('upload', 'image/x-heic'), true);
  assert.equal(requiresGeneratedImagePreview('misnamed.jpg', 'image/heic'), true);
  assert.equal(requiresGeneratedImagePreview('camera.nef', 'application/octet-stream'), true);
  assert.equal(requiresGeneratedImagePreview('photo.avif', 'image/avif'), false);
  assert.equal(requiresGeneratedImagePreview('vector.svg', 'image/svg+xml'), false);
});

test('thumbnail byte ranges support resumable browser requests', () => {
  assert.equal(parseThumbnailRange(undefined, 10), undefined);
  assert.deepEqual(parseThumbnailRange('bytes=3-', 10), { start: 3, end: 9 });
  assert.deepEqual(parseThumbnailRange('bytes=2-5', 10), { start: 2, end: 5 });
  assert.deepEqual(parseThumbnailRange('bytes=-4', 10), { start: 6, end: 9 });
  assert.equal(parseThumbnailRange('bytes=10-', 10), null);
  assert.equal(parseThumbnailRange('bytes=0-1,4-5', 10), null);
});

test('raster thumbnails are generated, reused, and pruned by content hash', async () => {
  const sourceDirectory = path.join(config.dataRoot, `thumbnail-test-${randomUUID()}`);
  const sourcePath = path.join(sourceDirectory, 'pixel.png');
  const source = await sharp({
    create: {
      width: 1024,
      height: 768,
      channels: 3,
      background: '#356a52',
    },
  }).png().toBuffer();
  const sha256 = createHash('sha256').update(source).digest('hex');
  await mkdir(sourceDirectory, { recursive: true });
  await writeFile(sourcePath, source);
  try {
    const first = await getOrCreateThumbnail({
      sourcePath,
      sha256,
      name: 'pixel.png',
      mimeType: 'image/png',
    });
    const preview = await getOrCreateImagePreview({
      sourcePath,
      sha256,
      name: 'pixel.tiff',
      mimeType: 'image/tiff',
    });
    await rm(sourcePath);
    const second = await getOrCreateThumbnail({
      sourcePath,
      sha256,
      name: 'pixel.png',
      mimeType: 'image/png',
    });
    assert.ok(first);
    assert.deepEqual(second, first);
    assert.equal(first.contentType, 'image/webp');
    assert.ok(preview);
    assert.match(preview.path, /\.preview\.webp$/);
    const thumbnailBytes = await readFile(first.path);
    assert.equal(thumbnailBytes.subarray(0, 4).toString('ascii'), 'RIFF');
    const metadata = await sharp(thumbnailBytes).metadata();
    assert.equal(metadata.width, 512);
    assert.equal(metadata.height, 384);
    const recent = await pruneUnusedThumbnails(new Set(), {
      minimumAgeMs: 60_000,
      now: Date.now(),
    });
    assert.equal(recent.removedFiles, 0);
    const retained = await pruneUnusedThumbnails(new Set([sha256]), {
      minimumAgeMs: 0,
      now: Date.now() + 1_000,
    });
    assert.equal(retained.removedFiles, 0);
    const pruned = await pruneUnusedThumbnails(new Set(), {
      minimumAgeMs: 0,
      now: Date.now() + 1_000,
    });
    assert.equal(pruned.removedFiles, 2);
    await assert.rejects(readFile(first.path), (error: any) => error?.code === 'ENOENT');
  } finally {
    await rm(sourceDirectory, { recursive: true, force: true });
  }
});
