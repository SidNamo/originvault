import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';
import sharp from 'sharp';
import { config } from '../src/config.js';
import { getOrCreateThumbnail, hasCachedThumbnail, pruneUnusedThumbnails, ThumbnailDeferredError, thumbnailFailureReason, thumbnailKind } from '../src/thumbnails.js';
import { backfillMissingThumbnails, type ThumbnailBackfillFile } from '../src/thumbnailMaintenance.js';

const execFileAsync = promisify(execFile);

test('video classification includes generic uploads without treating TypeScript or audio as video', () => {
  for (const name of ['clip.MP4', 'clip.mkv', 'clip.mov', 'clip.webm', 'clip.vob', 'clip.m2ts'])
    assert.equal(thumbnailKind(name, 'application/octet-stream'), 'video');
  assert.equal(thumbnailKind('module.ts', 'text/plain'), undefined);
  assert.equal(thumbnailKind('module.mts', 'application/octet-stream'), undefined);
  assert.equal(thumbnailKind('clip.ts', 'video/mp2t'), 'video');
  assert.equal(thumbnailKind('clip.mts', 'video/mp2t'), 'video');
  assert.equal(thumbnailKind('audio.ogg', 'application/ogg'), undefined);
  assert.equal(thumbnailKind('audio.mp4', 'audio/mp4'), undefined);
});

test('video format detection handles renamed containers and defers audio-only failures', async () => {
  const storageKey = `video-formats-${randomUUID()}`;
  const directory = path.join(config.dataRoot, storageKey);
  await mkdir(directory, { recursive: true });
  try {
    const sourcePath = path.join(directory, 'renamed.mp4');
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=64x48:rate=10',
      '-t', '0.2', '-c:v', 'libx264', '-threads', '1', '-f', 'matroska', sourcePath,
    ]);
    const bytes = await readFile(sourcePath);
    const thumbnail = await getOrCreateThumbnail({ sourcePath, sha256: createHash('sha256').update(bytes).digest('hex'), name: 'renamed.mp4', mimeType: 'video/mp4' });
    assert.ok(thumbnail);
    assert.equal((await sharp(thumbnail.path).metadata()).format, 'jpeg');
    const audioPath = path.join(directory, 'audio.mp4');
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440',
      '-t', '0.2', '-c:a', 'aac', audioPath,
    ]);
    const audio = await readFile(audioPath);
    const input = { sourcePath: audioPath, sha256: createHash('sha256').update(audio).digest('hex'), name: 'audio.mp4', mimeType: 'video/mp4' };
    await assert.rejects(getOrCreateThumbnail(input), (error) => thumbnailFailureReason(error) === 'no_video_stream');
    await assert.rejects(getOrCreateThumbnail(input), (error) => error instanceof ThumbnailDeferredError && error.reason === 'no_video_stream');
    assert.equal(await hasCachedThumbnail(input), false);
    assert.deepEqual(await readFile(audioPath), audio);
  } finally {
    await pruneUnusedThumbnails(new Set(), { minimumAgeMs: 0, now: Date.now() + 1_000 });
    await rm(directory, { recursive: true, force: true });
  }
});

test('video posters use seekable snapshots, correct aspect ratio, cache reuse, backfill and pruning', async () => {
  const storageKey = `video-test-${randomUUID()}`;
  const directory = path.join(config.dataRoot, storageKey);
  const sourcePath = path.join(directory, 'clip.mp4');
  await mkdir(directory, { recursive: true });
  try {
    // Leave the MP4 moov atom at the end: a non-seekable stdin cannot reliably decode it.
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=720x576:rate=25',
      '-t', '0.2', '-vf', 'setsar=64/45', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p', sourcePath,
    ]);
    const original = await readFile(sourcePath);
    const sha256 = createHash('sha256').update(original).digest('hex');
    const input = { sourcePath, sha256, name: 'clip.mp4', mimeType: 'application/octet-stream', verifySourceHash: true };
    const handle = await open(sourcePath, 'r');
    const snapshotPath = path.join(directory, 'snapshot.mp4');
    await rename(sourcePath, snapshotPath);
    await writeFile(sourcePath, 'the path was replaced after authorization');
    let thumbnail;
    try {
      thumbnail = await getOrCreateThumbnail({ ...input, sourceHandle: handle });
      assert.equal((await handle.stat()).size, original.length, 'caller retains ownership of the source handle');
    } finally {
      await handle.close();
    }
    assert.ok(thumbnail);
    assert.match(thumbnail.path, /\.video\.jpg$/);
    assert.equal(thumbnail.contentType, 'image/jpeg');
    const metadata = await sharp(thumbnail.path).metadata();
    assert.deepEqual([metadata.format, metadata.width, metadata.height], ['jpeg', 512, 288]);
    assert.deepEqual(await readFile(snapshotPath), original, 'thumbnail rendering must not modify the original');
    assert.deepEqual(await getOrCreateThumbnail(input), thumbnail, 'cached poster does not reopen a replaced path');

    await rename(snapshotPath, sourcePath);
    await rm(thumbnail.path);
    const file: ThumbnailBackfillFile = {
      id: randomUUID(), storageKey, name: input.name, relativePath: input.name, mimeType: input.mimeType,
      sha256, trashedAt: null, trashStoragePath: null, trashRootRelativePath: null,
    };
    const result = await backfillMissingThumbnails(async (cursor) => cursor ? [] : [file]);
    assert.equal(result.generatedThumbnails, 1);
    assert.equal(await hasCachedThumbnail(file), true);
    assert.equal((await pruneUnusedThumbnails(new Set([sha256]), { minimumAgeMs: 0, now: Date.now() + 1000 })).removedFiles, 0);
    assert.equal((await pruneUnusedThumbnails(new Set(), { minimumAgeMs: 0, now: Date.now() + 1000 })).removedFiles, 1);
    assert.equal(await hasCachedThumbnail(file), false);
    assert.ok(await getOrCreateThumbnail(input), 'a missing poster is regenerated on demand');
    const corruptPath = path.join(directory, 'corrupt.mp4');
    const corruptBytes = Buffer.from('not a movie');
    const corrupt = { sourcePath: corruptPath, sha256: createHash('sha256').update(corruptBytes).digest('hex'), name: 'corrupt.mp4' };
    await writeFile(corruptPath, corruptBytes);
    await assert.rejects(getOrCreateThumbnail(corrupt), /Video thumbnail renderer failed/);
    assert.equal(await hasCachedThumbnail(corrupt), false, 'failed decodes must not publish an empty poster');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
