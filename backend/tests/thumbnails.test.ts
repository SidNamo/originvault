import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
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
  ThumbnailDeferredError,
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

test('image byte signatures recover mislabeled PNG, JPEG and HEIC originals', async () => {
  const directory = path.join(config.dataRoot, `image-formats-${randomUUID()}`);
  const generated: string[] = [];
  await mkdir(directory, { recursive: true });
  try {
    const source = sharp({ create: { width: 48, height: 32, channels: 3, background: '#ab6382' } });
    const heicPath = path.join(directory, 'actual.heic');
    await promisify(execFile)('magick', ['-size', '48x32', 'xc:#725ab1', heicPath]);
    const cases = [
      { bytes: await source.clone().png().toBuffer(), name: 'wrong.heic', mimeType: 'image/heic' },
      { bytes: await source.clone().jpeg().toBuffer(), name: 'wrong.heif', mimeType: 'image/heif' },
      { bytes: await readFile(heicPath), name: 'wrong.jpg', mimeType: 'image/jpeg' },
    ];
    for (const [index, item] of cases.entries()) {
      const sourcePath = path.join(directory, String(index));
      await writeFile(sourcePath, item.bytes);
      const thumbnail = await getOrCreateThumbnail({ ...item, sourcePath, sha256: createHash('sha256').update(item.bytes).digest('hex') });
      assert.ok(thumbnail);
      generated.push(thumbnail.path);
      const result = await sharp(thumbnail.path).metadata();
      assert.deepEqual([result.format, result.width, result.height], ['webp', 48, 32]);
      assert.deepEqual(await readFile(sourcePath), item.bytes);
    }
  } finally {
    await Promise.all(generated.map((filePath) => rm(filePath, { force: true })));
    await rm(directory, { recursive: true, force: true });
  }
});

test('failed derivatives persist a bounded retry interval, expire and recover for new bytes', async () => {
  const directory = path.join(config.dataRoot, `image-retry-${randomUUID()}`);
  const sourcePath = path.join(directory, 'image.jpg');
  await mkdir(directory, { recursive: true });
  const bytes = Buffer.from('not an image');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const input = { sourcePath, sha256, name: 'image.jpg', mimeType: 'image/jpeg' };
  const failurePath = path.join(config.dataRoot, '.originvault-thumbnails/v1', sha256.slice(0, 2), `${sha256}.webp.failure.json`);
  try {
    await writeFile(sourcePath, bytes);
    await assert.rejects(getOrCreateThumbnail(input), /unsupported image format/);
    const failure = JSON.parse(await readFile(failurePath, 'utf8'));
    await assert.rejects(getOrCreateThumbnail(input), (error) => error instanceof ThumbnailDeferredError && error.retryAfter > 0);
    assert.deepEqual(JSON.parse(await readFile(failurePath, 'utf8')), failure, 'deferred requests do not extend the retry interval');
    await writeFile(failurePath, JSON.stringify({ ...failure, retryAt: Date.now() - 1 }));
    await assert.rejects(getOrCreateThumbnail(input), /unsupported image format/);
    const repaired = await sharp({ create: { width: 23, height: 17, channels: 3, background: '#293dab' } }).jpeg().toBuffer();
    await writeFile(sourcePath, repaired);
    assert.ok(await getOrCreateThumbnail({ ...input, sha256: createHash('sha256').update(repaired).digest('hex') }));
    await pruneUnusedThumbnails(new Set(), { minimumAgeMs: 0, now: Date.now() + 1_000 });
    await assert.rejects(readFile(failurePath), (error: any) => error.code === 'ENOENT');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a JPEG missing its end marker can produce a thumbnail without modifying its bytes', async () => {
  const directory = path.join(config.dataRoot, `jpeg-recovery-${randomUUID()}`);
  const sourcePath = path.join(directory, 'truncated.jpg');
  await mkdir(directory, { recursive: true });
  const complete = await sharp({ create: { width: 200, height: 120, channels: 3, background: '#239a74' } }).jpeg().toBuffer();
  const truncated = complete.subarray(0, complete.length - 2);
  let thumbnailPath: string | undefined;
  try {
    await writeFile(sourcePath, truncated);
    const thumbnail = await getOrCreateThumbnail({ sourcePath, name: 'truncated.jpg', sha256: createHash('sha256').update(truncated).digest('hex') });
    assert.ok(thumbnail);
    thumbnailPath = thumbnail.path;
    assert.deepEqual([(await sharp(thumbnail.path).metadata()).width, (await sharp(thumbnail.path).metadata()).height], [200, 120]);
    assert.deepEqual(await readFile(sourcePath), truncated);
  } finally {
    if (thumbnailPath) await rm(thumbnailPath, { force: true });
    await rm(directory, { recursive: true, force: true });
  }
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
