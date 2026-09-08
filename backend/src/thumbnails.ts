import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import sharp from 'sharp';
import { config } from './config.js';
import { logger } from './logger.js';

export type ThumbnailKind = 'image' | 'pdf';

export type CachedThumbnail = {
  path: string;
  contentType: 'image/webp' | 'image/jpeg';
};

const THUMBNAIL_VERSION = 'v1';
const THUMBNAIL_EDGE = 512;
const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_PDF_RENDER_BYTES = 16 * 1024 * 1024;
const PDF_RENDER_TIMEOUT_MS = 30_000;
const UNUSED_THUMBNAIL_GRACE_MS = 24 * 60 * 60 * 1_000;
const IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'png', 'gif', 'webp', 'avif', 'bmp', 'ico', 'tif',
  'tiff', 'heic', 'heif',
]);
const pendingThumbnails = new Map<string, Promise<CachedThumbnail>>();

export class ThumbnailGenerationError extends Error {}

export function thumbnailKind(name: string, mimeType = ''): ThumbnailKind | undefined {
  const extension = path.extname(name).slice(1).toLowerCase();
  const mime = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (extension === 'svg' || extension === 'svgz' || mime === 'image/svg+xml')
    return undefined;
  if (IMAGE_EXTENSIONS.has(extension) || mime.startsWith('image/')) return 'image';
  if (extension === 'pdf' || mime === 'application/pdf') return 'pdf';
  return undefined;
}

function thumbnailRoot(): string {
  return path.join(config.dataRoot, '.originvault-thumbnails', THUMBNAIL_VERSION);
}

function thumbnailCacheRoot(): string {
  return path.join(config.dataRoot, '.originvault-thumbnails');
}

function thumbnailTarget(sha256: string, kind: ThumbnailKind): CachedThumbnail {
  if (!/^[a-f\d]{64}$/i.test(sha256)) throw new ThumbnailGenerationError('Invalid thumbnail content hash');
  const extension = kind === 'pdf' ? 'jpg' : 'webp';
  return {
    path: path.join(thumbnailRoot(), sha256.slice(0, 2).toLowerCase(), `${sha256.toLowerCase()}.${extension}`),
    contentType: kind === 'pdf' ? 'image/jpeg' : 'image/webp',
  };
}

async function isUsableThumbnail(filePath: string): Promise<boolean> {
  try {
    const details = await stat(filePath);
    return details.isFile() && details.size > 0;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function renderPdfFirstPage(sourcePath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'pdftocairo',
      [
        '-f', '1',
        '-l', '1',
        '-singlefile',
        '-scale-to', String(THUMBNAIL_EDGE),
        '-jpeg',
        '-jpegopt', 'quality=82,optimize=y',
        sourcePath,
        '-',
      ],
      {
        encoding: null,
        maxBuffer: MAX_PDF_RENDER_BYTES,
        timeout: PDF_RENDER_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const rendered = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
        if (!rendered.length) {
          reject(new ThumbnailGenerationError('PDF renderer produced an empty thumbnail'));
          return;
        }
        resolve(rendered);
      },
    );
  });
}

async function createThumbnail(
  sourcePath: string,
  target: CachedThumbnail,
  kind: ThumbnailKind,
): Promise<CachedThumbnail> {
  await mkdir(path.dirname(target.path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${target.path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    if (kind === 'pdf') {
      const rendered = await renderPdfFirstPage(sourcePath);
      await writeFile(temporaryPath, rendered, { flag: 'wx', mode: 0o600 });
    } else {
      await sharp(sourcePath, {
        animated: false,
        failOn: 'error',
        limitInputPixels: MAX_IMAGE_PIXELS,
        pages: 1,
        sequentialRead: true,
      })
        .rotate()
        .resize({
          width: THUMBNAIL_EDGE,
          height: THUMBNAIL_EDGE,
          fit: 'inside',
          withoutEnlargement: true,
        })
        .webp({ effort: 4, quality: 82 })
        .timeout({ seconds: 30 })
        .toFile(temporaryPath);
    }
    if (!(await isUsableThumbnail(temporaryPath)))
      throw new ThumbnailGenerationError('Thumbnail renderer produced an empty file');
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, target.path);
    return target;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof ThumbnailGenerationError) throw error;
    throw new ThumbnailGenerationError(
      error instanceof Error ? error.message : 'Thumbnail generation failed',
    );
  }
}

export async function getOrCreateThumbnail(input: {
  sourcePath: string;
  sha256: string;
  name: string;
  mimeType?: string;
}): Promise<CachedThumbnail | undefined> {
  const kind = thumbnailKind(input.name, input.mimeType);
  if (!kind) return undefined;
  const target = thumbnailTarget(input.sha256, kind);
  if (await isUsableThumbnail(target.path)) {
    const now = new Date();
    await utimes(target.path, now, now).catch(() => undefined);
    return target;
  }
  const key = `${kind}:${input.sha256.toLowerCase()}`;
  const pending = pendingThumbnails.get(key);
  if (pending) return pending;
  const creation = createThumbnail(input.sourcePath, target, kind)
    .finally(() => {
      if (pendingThumbnails.get(key) === creation) pendingThumbnails.delete(key);
    });
  pendingThumbnails.set(key, creation);
  return creation;
}

export async function prepareFileThumbnail(input: {
  sourcePath: string;
  sha256: string;
  name: string;
  mimeType?: string;
}): Promise<void> {
  if (!thumbnailKind(input.name, input.mimeType)) return;
  try {
    await getOrCreateThumbnail(input);
  } catch (error) {
    logger.warn({
      event: 'thumbnail_preparation_failed',
      sha256: input.sha256,
      name: input.name,
      err: error,
    }, 'Server thumbnail could not be prepared; it can be retried when requested');
  }
}

async function cacheDirectoryEntries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error: any) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

export async function pruneUnusedThumbnails(
  referencedHashes: ReadonlySet<string>,
  options: { now?: number; minimumAgeMs?: number } = {},
): Promise<{ scannedFiles: number; removedFiles: number; removedBytes: number; failedFiles: number }> {
  const now = options.now ?? Date.now();
  const minimumAgeMs = Math.max(0, options.minimumAgeMs ?? UNUSED_THUMBNAIL_GRACE_MS);
  const cutoff = now - minimumAgeMs;
  const cacheRoot = thumbnailCacheRoot();
  let scannedFiles = 0;
  let removedFiles = 0;
  let removedBytes = 0;
  let failedFiles = 0;

  for (const version of await cacheDirectoryEntries(cacheRoot)) {
    if (!version.isDirectory() || !/^v\d+$/.test(version.name)) continue;
    const versionPath = path.join(cacheRoot, version.name);
    for (const shard of await cacheDirectoryEntries(versionPath)) {
      if (!shard.isDirectory() || !/^[a-f\d]{2}$/i.test(shard.name)) continue;
      const shardPath = path.join(versionPath, shard.name);
      for (const entry of await cacheDirectoryEntries(shardPath)) {
        if (!entry.isFile()) continue;
        const match = entry.name.match(/^([a-f\d]{64})\.(?:webp|jpg)(\.[^.]+\.tmp)?$/i);
        if (!match?.[1]) continue;
        scannedFiles += 1;
        const sha256 = match[1].toLowerCase();
        const isTemporary = Boolean(match[2]);
        if (
          version.name === THUMBNAIL_VERSION &&
          !isTemporary &&
          referencedHashes.has(sha256)
        )
          continue;
        const filePath = path.join(shardPath, entry.name);
        try {
          const details = await stat(filePath);
          if (!details.isFile() || details.mtimeMs > cutoff) continue;
          await unlink(filePath);
          removedFiles += 1;
          removedBytes += details.size;
        } catch (error: any) {
          if (error?.code === 'ENOENT') continue;
          failedFiles += 1;
          logger.warn({ event: 'thumbnail_cache_file_cleanup_failed', filePath, err: error }, 'Unused thumbnail cache file could not be removed');
        }
      }
    }
  }
  return { scannedFiles, removedFiles, removedBytes, failedFiles };
}

export function parseThumbnailRange(
  value: string | undefined,
  size: number,
): { start: number; end: number } | undefined | null {
  if (!value) return undefined;
  if (value.includes(',')) return null;
  const match = value.match(/^bytes=(\d*)-(\d*)$/);
  if (!match || (!match[1] && !match[2]) || size <= 0) return null;
  let start: number;
  let end: number;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return null;
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    return null;
  return { start, end };
}

export async function sendThumbnail(
  req: Request,
  res: Response,
  thumbnail: CachedThumbnail,
  sha256: string,
): Promise<void> {
  const fileHandle = await open(thumbnail.path, 'r');
  try {
    const details = await fileHandle.stat();
    if (!details.isFile() || details.size <= 0)
      throw new ThumbnailGenerationError('Cached thumbnail is invalid');
    const etag = `"thumbnail-${THUMBNAIL_VERSION}-${sha256.toLowerCase()}"`;
    res.setHeader('Content-Type', thumbnail.contentType);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', etag);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (req.header('if-none-match') === etag) {
      res.status(304).end();
      return;
    }
    const requestedRange = req.header('if-range') && req.header('if-range') !== etag
      ? undefined
      : req.header('range');
    const range = parseThumbnailRange(requestedRange, details.size);
    if (range === null) {
      res.setHeader('Content-Range', `bytes */${details.size}`);
      res.status(416).end();
      return;
    }
    const start = range?.start ?? 0;
    const end = range?.end ?? details.size - 1;
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${details.size}`);
    }
    res.setHeader('Content-Length', end - start + 1);
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    await pipeline(fileHandle.createReadStream({ start, end, autoClose: false }), res);
  } finally {
    await fileHandle.close().catch(() => undefined);
  }
}
