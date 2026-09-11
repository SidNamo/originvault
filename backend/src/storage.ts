import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { link, mkdir, stat, unlink, utimes } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const length = Buffer.byteLength(character);
    if (bytes + length > maximumBytes) break;
    result += character;
    bytes += length;
  }
  return result;
}

function fitFileName(name: string, suffix = '', preserveExtension = true): string {
  const extension = preserveExtension ? path.extname(name) : '';
  const budget = 255 - Buffer.byteLength(suffix);
  if (Buffer.byteLength(extension) >= budget) return `${truncateUtf8(name, budget)}${suffix}`;
  const stem = extension ? name.slice(0, -extension.length) : name;
  return `${truncateUtf8(stem, budget - Buffer.byteLength(extension))}${suffix}${extension}`;
}

export function safeSegment(value: string): string {
  const clean = path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid file or folder name');
  return fitFileName(clean);
}

export function fileNameCandidate(requested: string, index: number, kind: 'file' | 'folder' = 'file'): string {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('File name index must be a non-negative integer');
  return fitFileName(safeSegment(requested), index ? ` (${index})` : '', kind === 'file');
}

export function storedContentType(requested: string | undefined, metadata: Record<string, unknown>): string {
  const normalize = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const mime = value.split(';', 1)[0]!.trim().toLowerCase();
    return mime.length <= 255 && /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(mime) ? mime : undefined;
  };
  const extracted = normalize(metadata['File:MIMEType']);
  return extracted && extracted !== 'application/octet-stream'
    ? extracted
    : normalize(requested) ?? extracted ?? 'application/octet-stream';
}

export function safeRelativeDirectory(value: string): string {
  if (!value) return '';
  return value
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment === '.' || segment === '..') throw new Error('Invalid relative directory');
      return safeSegment(segment);
    })
    .join('/');
}

export function isHiddenResource(name: string, metadata?: Record<string, unknown>): boolean {
  if (name.startsWith('.')) return true;
  for (const [key, value] of Object.entries(metadata ?? {})) {
    const normalizedKey = key.toLowerCase();
    if (!normalizedKey.includes('hidden') && !normalizedKey.includes('fileattributes') && !normalizedKey.includes('dosattrib')) continue;
    if (typeof value === 'number' && normalizedKey.includes('attributes') && (value & 0x2) !== 0) return true;
    const normalizedValue = String(value).toLowerCase();
    if (normalizedValue === 'true' || normalizedValue === 'hidden' || /\bhidden\b/.test(normalizedValue)) return true;
  }
  return false;
}

export const ORIGINAL_CREATION_METADATA_KEYS = [
  'Composite:SubSecDateTimeOriginal', 'ExifIFD:DateTimeOriginal', 'EXIF:DateTimeOriginal',
  'XMP-exif:DateTimeOriginal', 'Keys:CreationDate', 'UserData:DateTimeOriginal', 'QuickTime:CreationDate',
  'QuickTime:CreateDate', 'Matroska:DateTimeOriginal', 'PDF:CreateDate', 'XMP-photoshop:DateCreated',
  'XMP:CreateDate', 'XMP-xmp:CreateDate', 'ExifIFD:CreateDate', 'EXIF:CreateDate',
  'Track1:MediaCreateDate', 'Track1:TrackCreateDate',
] as const;

function metadataDate(value: unknown, offset?: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.trim().match(/^(\d{4})[:-](\d{2})[:-](\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/);
  if (!match) return undefined;
  const [, year, month, day, hour = '00', minute = '00', second = '00', fraction = ''] = match;
  if (Number(year) === 0 || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return undefined;
  const calendar = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.getUTCMonth() + 1 !== Number(month) || calendar.getUTCDate() !== Number(day))
    return undefined;
  const separateOffset = typeof offset === 'string' && /^[+-]\d{2}:?\d{2}$/.test(offset.trim()) ? offset.trim() : undefined;
  // Exif dates without an offset remain available verbatim in metadata; index deterministically in UTC.
  const timezone = match[8] ?? separateOffset ?? 'Z';
  const date = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${fraction}${timezone}`);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export function originalCreatedAtFromMetadata(metadata: Record<string, unknown>): Date | undefined {
  const trackKeys = Object.keys(metadata).filter((key) => /^Track\d+:(Media|Track)CreateDate$/.test(key)).sort();
  for (const key of [...ORIGINAL_CREATION_METADATA_KEYS, ...trackKeys]) {
    const group = key.split(':', 1)[0];
    const offset = key.endsWith(':DateTimeOriginal') ? metadata[`${group}:OffsetTimeOriginal`]
      : key.endsWith(':CreateDate') ? metadata[`${group}:OffsetTimeDigitized`] : undefined;
    const date = metadataDate(metadata[key], offset);
    if (date) return date;
  }
  // Filesystem birth/modify times describe the server copy, not the uploaded original.
  return undefined;
}

export function userFilesRoot(storageKey: string): string {
  return path.join(config.dataRoot, storageKey);
}

export function resolveInside(root: string, relativePath: string): string {
  const resolvedRoot = path.resolve(root);
  const target = path.resolve(resolvedRoot, relativePath);
  if (target !== resolvedRoot && !target.startsWith(`${resolvedRoot}${path.sep}`)) {
    logger.warn({ event: 'storage_path_escape_blocked', root: resolvedRoot, requestedPath: relativePath }, 'Blocked storage path traversal');
    throw new Error('Path escapes storage root');
  }
  return target;
}

export async function storeOriginal(input: {
  storageKey: string;
  username: string;
  folderPath: string;
  originalName: string;
  stream: Readable;
  clientLastModified?: Date;
}): Promise<{ storedName: string; relativePath: string; size: number; sha256: string; absolutePath: string }> {
  const root = userFilesRoot(input.storageKey);
  const directory = resolveInside(root, input.folderPath);
  logger.trace({ event: 'original_storage_started', username: input.username, folderPath: input.folderPath, originalName: input.originalName }, 'Original byte stream storage started');
  await mkdir(directory, { recursive: true });
  const temporaryPath = resolveInside(directory, `.originvault-upload-${randomUUID()}`);
  const hash = createHash('sha256');
  let size = 0;
  let storedName = '';
  let finalPath = '';
  let installed = false;
  input.stream.on('data', (chunk: Buffer) => { size += chunk.length; hash.update(chunk); });
  try {
    await pipeline(input.stream, createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }));
    for (let index = 0; index < 100_000; index += 1) {
      storedName = fileNameCandidate(input.originalName, index);
      finalPath = resolveInside(directory, storedName);
      try {
        await link(temporaryPath, finalPath);
        installed = true;
        break;
      } catch (error: any) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    if (!installed) throw new Error('Could not allocate an available destination file name');
    await unlink(temporaryPath);
    if (input.clientLastModified && Number.isFinite(input.clientLastModified.getTime())) {
      await utimes(finalPath, new Date(), input.clientLastModified);
    }
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    if (installed) await unlink(finalPath).catch(() => undefined);
    logger.error({ event: 'original_storage_failed', username: input.username, folderPath: input.folderPath, originalName: input.originalName, err: error }, 'Original byte stream storage failed');
    throw error;
  }
  const fileStat = await stat(finalPath);
  const result = {
    storedName,
    relativePath: path.relative(root, finalPath),
    size: fileStat.size,
    sha256: hash.digest('hex'),
    absolutePath: finalPath,
  };
  logger.info({ event: 'original_storage_completed', username: input.username, relativePath: result.relativePath, storedName: result.storedName, sizeBytes: result.size, sha256: result.sha256, clientLastModified: input.clientLastModified?.toISOString() }, 'Original byte stream stored without transformation');
  return result;
}

export async function extractMetadata(filePath: string): Promise<Record<string, unknown>> {
  const startedAt = process.hrtime.bigint();
  logger.trace({ event: 'metadata_extraction_started', filePath }, 'Read-only metadata extraction started');
  try {
    const { stdout } = await execFileAsync('exiftool', ['-json', '-G1', '-n', '-api', 'QuickTimeUTC=1', filePath], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 30_000,
      env: { ...process.env, TZ: 'UTC' },
    });
    const parsed = JSON.parse(stdout) as Record<string, unknown>[];
    const metadata = parsed[0] ?? {};
    delete metadata['SourceFile'];
    delete metadata['System:FileName'];
    delete metadata['System:Directory'];
    delete metadata['System:FileAccessDate'];
    delete metadata['System:FileInodeChangeDate'];
    logger.debug({ event: 'metadata_extraction_completed', filePath, fieldCount: Object.keys(metadata).length, durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000 }, 'Read-only metadata extraction completed');
    return metadata;
  } catch (error) {
    logger.warn({ event: 'metadata_extraction_failed', filePath, durationMs: Number(process.hrtime.bigint() - startedAt) / 1_000_000, err: error }, 'Metadata extraction failed; original remains intact');
    return { extractionWarning: error instanceof Error ? error.message : 'Metadata extraction failed' };
  }
}
