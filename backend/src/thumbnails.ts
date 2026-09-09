import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants, createWriteStream } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  open,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  utimes,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Request, Response } from 'express';
import sharp from 'sharp';
import { config } from './config.js';
import { logger } from './logger.js';

export type ThumbnailKind = 'image' | 'pdf';
type ImageDerivative = 'thumbnail' | 'preview';

export type CachedThumbnail = {
  path: string;
  contentType: 'image/webp' | 'image/jpeg';
};

const THUMBNAIL_VERSION = 'v1';
const THUMBNAIL_EDGE = 512;
const IMAGE_PREVIEW_EDGE = 2560;
const MAX_IMAGE_PIXELS = 100_000_000;
const MAX_PDF_RENDER_BYTES = 16 * 1024 * 1024;
const MAX_IMAGE_RENDER_BYTES = 64 * 1024 * 1024;
const PDF_RENDER_TIMEOUT_MS = 30_000;
const IMAGE_RENDER_TIMEOUT_MS = 35_000;
const MAX_RENDERER_ERROR_BYTES = 64 * 1024;
const UNUSED_THUMBNAIL_GRACE_MS = 24 * 60 * 60 * 1_000;
const MAX_CONCURRENT_DERIVATIVE_RENDERS = 2;
const MAX_QUEUED_DERIVATIVE_RENDERS = 32;

const SHARP_IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'png', 'apng', 'gif', 'webp', 'avif', 'tif', 'tiff',
]);
const MAGICK_CODERS_BY_EXTENSION: Readonly<Record<string, string>> = {
  heic: 'HEIC', heics: 'HEIC', heif: 'HEIC', heifs: 'HEIC', hif: 'HEIC',
  jxl: 'JXL',
  jp2: 'JP2', j2c: 'JP2', j2k: 'JP2', jpc: 'JP2', jpf: 'JP2', jpm: 'JP2', jpx: 'JP2', jpt: 'JP2',
  bmp: 'BMP', dib: 'BMP', ico: 'ICON', cur: 'ICON',
  psd: 'PSD', psb: 'PSD', xcf: 'XCF',
  exr: 'EXR', hdr: 'HDR', rgbe: 'HDR',
  tga: 'TGA', icb: 'TGA', vda: 'TGA', vst: 'TGA',
  dds: 'DDS', qoi: 'QOI', dcm: 'DCM',
  pnm: 'PNM', pbm: 'PNM', pgm: 'PNM', ppm: 'PNM', pam: 'PNM',
  pcx: 'PCX', dcx: 'PCX', fits: 'FITS', fts: 'FITS',
  mpo: 'JPEG', jps: 'JPEG',
  '3fr': 'DNG', arw: 'DNG', cr2: 'DNG', cr3: 'DNG', crw: 'DNG', dcr: 'DNG',
  dng: 'DNG', erf: 'DNG', fff: 'DNG', iiq: 'DNG', k25: 'DNG', kdc: 'DNG',
  mdc: 'DNG', mef: 'DNG', mos: 'DNG', mrw: 'DNG', nef: 'DNG', nrw: 'DNG',
  orf: 'DNG', pef: 'DNG', raf: 'DNG', raw: 'DNG', rw2: 'DNG', rwl: 'DNG',
  sr2: 'DNG', srf: 'DNG', srw: 'DNG', sti: 'DNG', x3f: 'DNG',
};
const MAGICK_CODERS_BY_MIME: Readonly<Record<string, string>> = {
  'image/heic': 'HEIC',
  'image/heic-sequence': 'HEIC',
  'image/heif': 'HEIC',
  'image/heif-sequence': 'HEIC',
  'image/x-heic': 'HEIC',
  'image/x-heif': 'HEIC',
  'image/jxl': 'JXL',
  'image/jpeg2000': 'JP2',
  'image/jp2': 'JP2',
  'image/jpx': 'JP2',
  'image/jpm': 'JP2',
  'image/x-jp2': 'JP2',
  'image/x-jpeg2000': 'JP2',
  'application/photoshop': 'PSD',
  'application/x-photoshop': 'PSD',
  'image/vnd.adobe.photoshop': 'PSD',
  'image/x-photoshop': 'PSD',
  'image/x-xcf': 'XCF',
  'image/x-adobe-dng': 'DNG',
  'image/x-dcraw': 'DNG',
  'image/x-canon-cr2': 'DNG',
  'image/x-canon-cr3': 'DNG',
  'image/x-fuji-raf': 'DNG',
  'image/x-nikon-nef': 'DNG',
  'image/x-olympus-orf': 'DNG',
  'image/x-panasonic-rw2': 'DNG',
  'image/x-pentax-pef': 'DNG',
  'image/x-sony-arw': 'DNG',
  'image/x-exr': 'EXR',
  'image/vnd.radiance': 'HDR',
  'image/x-hdr': 'HDR',
  'image/x-tga': 'TGA',
  'image/qoi': 'QOI',
  'image/vnd-ms.dds': 'DDS',
  'image/x-dds': 'DDS',
  'image/x-pcx': 'PCX',
  'image/x-portable-anymap': 'PNM',
  'image/x-portable-bitmap': 'PNM',
  'image/x-portable-graymap': 'PNM',
  'image/x-portable-pixmap': 'PNM',
  'application/dicom': 'DCM',
  'image/dicom-rle': 'DCM',
};
const IMAGE_EXTENSIONS = new Set([
  ...SHARP_IMAGE_EXTENSIONS,
  ...Object.keys(MAGICK_CODERS_BY_EXTENSION),
]);
const BROWSER_IMAGE_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'jpe', 'jfif', 'pjpeg', 'png', 'apng', 'gif', 'webp', 'avif', 'bmp', 'ico', 'svg',
]);
const BROWSER_IMAGE_MIMES = new Set([
  'image/jpeg', 'image/pjpeg', 'image/png', 'image/apng', 'image/gif', 'image/webp', 'image/avif',
  'image/bmp', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/svg+xml',
]);
const pendingThumbnails = new Map<string, Promise<CachedThumbnail>>();
const derivativeRenderWaiters: Array<(release: () => void) => void> = [];
let activeDerivativeRenders = 0;

export class ThumbnailGenerationError extends Error {
  readonly code?: string;

  constructor(message: string, options: { cause?: unknown; code?: string } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.code = options.code ?? (typeof options.cause === 'object' && options.cause !== null
      && 'code' in options.cause && typeof options.cause.code === 'string'
      ? options.cause.code
      : undefined);
  }
}

export class ThumbnailRendererBusyError extends ThumbnailGenerationError {}

function derivativeRenderRelease(): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = derivativeRenderWaiters.shift();
    if (next) next(derivativeRenderRelease());
    else activeDerivativeRenders -= 1;
  };
}

async function acquireDerivativeRenderSlot(): Promise<() => void> {
  if (activeDerivativeRenders < MAX_CONCURRENT_DERIVATIVE_RENDERS) {
    activeDerivativeRenders += 1;
    return derivativeRenderRelease();
  }
  if (derivativeRenderWaiters.length >= MAX_QUEUED_DERIVATIVE_RENDERS)
    throw new ThumbnailRendererBusyError('Thumbnail renderer is busy');
  return new Promise((resolve) => derivativeRenderWaiters.push(resolve));
}

async function withDerivativeRenderSlot<T>(work: () => Promise<T>): Promise<T> {
  const release = await acquireDerivativeRenderSlot();
  try {
    return await work();
  } finally {
    release();
  }
}

function imageExtension(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

function normalizedMime(mimeType = ''): string {
  return mimeType.split(';', 1)[0]!.trim().toLowerCase();
}

function isSvg(name: string, mimeType = ''): boolean {
  const extension = imageExtension(name);
  return extension === 'svg' || extension === 'svgz' || normalizedMime(mimeType) === 'image/svg+xml';
}

function magickCoder(name: string, mimeType = ''): string | undefined {
  return MAGICK_CODERS_BY_EXTENSION[imageExtension(name)]
    ?? MAGICK_CODERS_BY_MIME[normalizedMime(mimeType)];
}

export function thumbnailKind(name: string, mimeType = ''): ThumbnailKind | undefined {
  const extension = imageExtension(name);
  const mime = normalizedMime(mimeType);
  if (isSvg(name, mimeType)) return undefined;
  if (IMAGE_EXTENSIONS.has(extension) || MAGICK_CODERS_BY_MIME[mime] || mime.startsWith('image/')) return 'image';
  if (extension === 'pdf' || mime === 'application/pdf') return 'pdf';
  return undefined;
}

export function requiresGeneratedImagePreview(name: string, mimeType = ''): boolean {
  if (isSvg(name, mimeType) || thumbnailKind(name, mimeType) !== 'image') return false;
  const extension = imageExtension(name);
  const mime = normalizedMime(mimeType);
  if (MAGICK_CODERS_BY_MIME[mime] && !BROWSER_IMAGE_MIMES.has(mime)) return true;
  if (extension && IMAGE_EXTENSIONS.has(extension)) return !BROWSER_IMAGE_EXTENSIONS.has(extension);
  return !BROWSER_IMAGE_MIMES.has(mime);
}

function thumbnailRoot(): string {
  return path.join(config.dataRoot, '.originvault-thumbnails', THUMBNAIL_VERSION);
}

function thumbnailCacheRoot(): string {
  return path.join(config.dataRoot, '.originvault-thumbnails');
}

function derivativeTarget(
  sha256: string,
  kind: ThumbnailKind,
  derivative: ImageDerivative,
): CachedThumbnail {
  if (!/^[a-f\d]{64}$/i.test(sha256)) throw new ThumbnailGenerationError('Invalid thumbnail content hash');
  if (derivative === 'preview' && kind !== 'image')
    throw new ThumbnailGenerationError('Only images support generated detail previews');
  const extension = kind === 'pdf' ? 'jpg' : 'webp';
  const suffix = derivative === 'preview' ? `.preview.${extension}` : `.${extension}`;
  return {
    path: path.join(thumbnailRoot(), sha256.slice(0, 2).toLowerCase(), `${sha256.toLowerCase()}${suffix}`),
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

function isExpectedPipeClosure(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === 'EPIPE' || code === 'ERR_STREAM_PREMATURE_CLOSE';
}

function rendererEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { LANG: process.env.LANG ?? 'C.UTF-8' };
  for (const name of [
    'PATH',
    'LD_LIBRARY_PATH',
    'MAGICK_CODER_MODULE_PATH',
    'MAGICK_CONFIGURE_PATH',
  ]) {
    const value = process.env[name];
    if (value) environment[name] = value;
  }
  return { ...environment, ...overrides };
}

async function renderStreamedProcess(options: {
  command: string;
  args: string[];
  sourceHandle: FileHandle;
  targetPath: string;
  timeoutMs: number;
  errorLabel: string;
  maximumOutputBytes?: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<void> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let rendererError = '';
  let rendererErrorBytes = 0;
  let rendererErrorTruncated = false;
  let timedOut = false;
  child.stderr.on('data', (chunk: Buffer) => {
    rendererErrorBytes += chunk.length;
    const capturedBytes = Buffer.byteLength(rendererError);
    if (capturedBytes < MAX_RENDERER_ERROR_BYTES) {
      const remaining = MAX_RENDERER_ERROR_BYTES - capturedBytes;
      rendererError += chunk.subarray(0, remaining).toString('utf8');
    }
    if (rendererErrorBytes > MAX_RENDERER_ERROR_BYTES) rendererErrorTruncated = true;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, options.timeoutMs);
  timeout.unref();
  const input = pipeline(
    options.sourceHandle.createReadStream({ start: 0, autoClose: false }),
    child.stdin,
  ).catch((error) => {
    if (!isExpectedPipeClosure(error)) child.kill('SIGKILL');
    throw error;
  });
  let outputBytes = 0;
  const outputLimit = options.maximumOutputBytes === undefined
    ? undefined
    : new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          outputBytes += chunk.length;
          if (outputBytes > options.maximumOutputBytes!) {
            callback(new ThumbnailGenerationError(`${options.errorLabel} output exceeded its limit`));
            return;
          }
          callback(null, chunk);
        },
      });
  const output = (outputLimit
    ? pipeline(child.stdout, outputLimit, createWriteStream(options.targetPath, { flags: 'wx', mode: 0o600 }))
    : pipeline(child.stdout, createWriteStream(options.targetPath, { flags: 'wx', mode: 0o600 })))
    .catch((error) => {
      child.kill('SIGKILL');
      throw error;
    });
  try {
    const [inputResult, outputResult, exitResult] = await Promise.allSettled([input, output, exited]);
    if (timedOut) throw new ThumbnailGenerationError(`${options.errorLabel} timed out`);
    if (exitResult.status === 'rejected')
      throw new ThumbnailGenerationError(`${options.errorLabel} could not start`, { cause: exitResult.reason });
    if (inputResult.status === 'rejected' && !isExpectedPipeClosure(inputResult.reason)) throw inputResult.reason;
    if (outputResult.status === 'rejected') throw outputResult.reason;
    if (exitResult.value.code !== 0) {
      const details = rendererError.trim();
      throw new ThumbnailGenerationError(details
        ? `${options.errorLabel} failed: ${details}${rendererErrorTruncated ? ' (truncated)' : ''}`
        : `${options.errorLabel} exited with ${exitResult.value.signal ?? `code ${exitResult.value.code ?? 'unknown'}`}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

function renderPdfFirstPage(sourceHandle: FileHandle, targetPath: string): Promise<void> {
  return renderStreamedProcess({
    command: 'pdftocairo',
    args: [
      '-f', '1',
      '-l', '1',
      '-singlefile',
      '-scale-to', String(THUMBNAIL_EDGE),
      '-jpeg',
      '-jpegopt', 'quality=82,optimize=y',
      '-',
      '-',
    ],
    sourceHandle,
    targetPath,
    timeoutMs: PDF_RENDER_TIMEOUT_MS,
    errorLabel: 'PDF renderer',
    maximumOutputBytes: MAX_PDF_RENDER_BYTES,
    env: rendererEnvironment(),
    cwd: '/tmp',
  });
}

async function renderWithImageMagick(
  sourceHandle: FileHandle,
  targetPath: string,
  coder: string,
  edge: number,
  quality: number,
): Promise<void> {
  const temporaryDirectory = await mkdtemp('/tmp/originvault-magick-');
  try {
    await renderStreamedProcess({
      command: 'magick',
      args: [
        '-limit', 'thread', '2',
        '-limit', 'memory', '128MiB',
        '-limit', 'map', '256MiB',
        '-limit', 'disk', '512MiB',
        '-limit', 'width', '16KP',
        '-limit', 'height', '16KP',
        '-limit', 'list-length', '16',
        '-limit', 'time', '30',
        `${coder}:-[0]`,
        '-auto-orient',
        '-thumbnail', `${edge}x${edge}>`,
        '-colorspace', 'sRGB',
        '-strip',
        '-quality', String(quality),
        'webp:-',
      ],
      sourceHandle,
      targetPath,
      timeoutMs: IMAGE_RENDER_TIMEOUT_MS,
      errorLabel: 'ImageMagick',
      maximumOutputBytes: MAX_IMAGE_RENDER_BYTES,
      cwd: temporaryDirectory,
      env: rendererEnvironment({
        HOME: temporaryDirectory,
        MAGICK_TEMPORARY_PATH: temporaryDirectory,
        TMPDIR: temporaryDirectory,
        OMP_NUM_THREADS: '2',
      }),
    });
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch((error) =>
      logger.warn({ event: 'image_renderer_temporary_cleanup_failed', temporaryDirectory, err: error }, 'Image renderer temporary directory could not be removed'));
  }
}

async function renderWithSharp(
  sourceHandle: FileHandle,
  targetPath: string,
  edge: number,
  quality: number,
): Promise<void> {
  const transformer = sharp({
    animated: false,
    failOn: 'error',
    limitInputPixels: MAX_IMAGE_PIXELS,
    pages: 1,
    sequentialRead: true,
  })
    .rotate()
    .resize({
      width: edge,
      height: edge,
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ effort: 4, quality })
    .timeout({ seconds: 30 });
  await pipeline(
    sourceHandle.createReadStream({ start: 0, autoClose: false }),
    transformer,
    createWriteStream(targetPath, { flags: 'wx', mode: 0o600 }),
  );
}

type DerivativeInput = {
  sourcePath: string;
  sourceHandle?: FileHandle;
  verifySourceHash?: boolean;
  sha256: string;
  name: string;
  mimeType?: string;
};

async function sourceHandleSha256(sourceHandle: FileHandle): Promise<string> {
  const hash = createHash('sha256');
  const source = sourceHandle.createReadStream({ start: 0, autoClose: false });
  for await (const chunk of source) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function createDerivative(
  input: DerivativeInput,
  target: CachedThumbnail,
  kind: ThumbnailKind,
  derivative: ImageDerivative,
): Promise<CachedThumbnail> {
  await mkdir(path.dirname(target.path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${target.path}.${process.pid}-${randomUUID()}.tmp`;
  let openedSource: FileHandle | undefined;
  try {
    return await withDerivativeRenderSlot(async () => {
      const sourceHandle = input.sourceHandle
        ?? await open(input.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!input.sourceHandle) openedSource = sourceHandle;
      const sourceDetails = await sourceHandle.stat();
      if (!sourceDetails.isFile()) throw new ThumbnailGenerationError('Thumbnail source is not a regular file');
      if (input.verifySourceHash
        && await sourceHandleSha256(sourceHandle) !== input.sha256.toLowerCase())
        throw new ThumbnailGenerationError('Thumbnail source does not match its indexed hash', { code: 'ESTALE' });
      if (kind === 'pdf') {
        await renderPdfFirstPage(sourceHandle, temporaryPath);
      } else {
        const edge = derivative === 'preview' ? IMAGE_PREVIEW_EDGE : THUMBNAIL_EDGE;
        const quality = derivative === 'preview' ? 88 : 82;
        const coder = magickCoder(input.name, input.mimeType);
        if (coder) await renderWithImageMagick(sourceHandle, temporaryPath, coder, edge, quality);
        else await renderWithSharp(sourceHandle, temporaryPath, edge, quality);
      }
      if (!(await isUsableThumbnail(temporaryPath)))
        throw new ThumbnailGenerationError('Thumbnail renderer produced an empty file');
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, target.path);
      return target;
    });
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    if (error instanceof ThumbnailGenerationError) throw error;
    throw new ThumbnailGenerationError(
      error instanceof Error ? error.message : 'Thumbnail generation failed',
      { cause: error },
    );
  } finally {
    await openedSource?.close().catch(() => undefined);
  }
}

async function getOrCreateDerivative(
  input: DerivativeInput,
  kind: ThumbnailKind,
  derivative: ImageDerivative,
): Promise<CachedThumbnail> {
  const target = derivativeTarget(input.sha256, kind, derivative);
  if (await isUsableThumbnail(target.path)) {
    const now = new Date();
    await utimes(target.path, now, now).catch(() => undefined);
    return target;
  }
  const key = `${derivative}:${kind}:${input.sha256.toLowerCase()}`;
  const pending = pendingThumbnails.get(key);
  if (pending) return pending;
  const creation = createDerivative(input, target, kind, derivative)
    .finally(() => {
      if (pendingThumbnails.get(key) === creation) pendingThumbnails.delete(key);
    });
  pendingThumbnails.set(key, creation);
  return creation;
}

export async function hasCachedThumbnail(input: Pick<DerivativeInput, 'sha256' | 'name' | 'mimeType'>): Promise<boolean> {
  const kind = thumbnailKind(input.name, input.mimeType);
  return kind ? isUsableThumbnail(derivativeTarget(input.sha256, kind, 'thumbnail').path) : false;
}

export async function getOrCreateThumbnail(input: DerivativeInput): Promise<CachedThumbnail | undefined> {
  const kind = thumbnailKind(input.name, input.mimeType);
  return kind ? getOrCreateDerivative(input, kind, 'thumbnail') : undefined;
}

export async function getOrCreateImagePreview(input: DerivativeInput): Promise<CachedThumbnail | undefined> {
  return requiresGeneratedImagePreview(input.name, input.mimeType)
    ? getOrCreateDerivative(input, 'image', 'preview')
    : undefined;
}

export async function prepareFileThumbnail(input: DerivativeInput): Promise<void> {
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
        const match = entry.name.match(/^([a-f\d]{64})(?:\.preview)?\.(?:webp|jpg)(\.[^.]+\.tmp)?$/i);
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

async function sendCachedDerivative(
  req: Request,
  res: Response,
  thumbnail: CachedThumbnail,
  sha256: string,
  derivative: ImageDerivative,
): Promise<void> {
  const fileHandle = await open(thumbnail.path, 'r');
  try {
    const details = await fileHandle.stat();
    if (!details.isFile() || details.size <= 0)
      throw new ThumbnailGenerationError('Cached thumbnail is invalid');
    const etag = `"${derivative === 'preview' ? 'image-preview' : 'thumbnail'}-${THUMBNAIL_VERSION}-${sha256.toLowerCase()}"`;
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

export function sendThumbnail(
  req: Request,
  res: Response,
  thumbnail: CachedThumbnail,
  sha256: string,
): Promise<void> {
  return sendCachedDerivative(req, res, thumbnail, sha256, 'thumbnail');
}

export function sendImagePreview(
  req: Request,
  res: Response,
  preview: CachedThumbnail,
  sha256: string,
): Promise<void> {
  return sendCachedDerivative(req, res, preview, sha256, 'preview');
}
