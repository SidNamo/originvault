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

export function safeSegment(value: string): string {
  const clean = path.basename(value).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').trim();
  if (!clean || clean === '.' || clean === '..') throw new Error('Invalid file or folder name');
  return clean.slice(0, 255);
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

export function originalCreatedAtFromMetadata(metadata: Record<string, unknown>): Date | undefined {
  const keys = [
    'EXIF:DateTimeOriginal', 'XMP-exif:DateTimeOriginal', 'QuickTime:CreateDate',
    'PDF:CreateDate', 'XMP:CreateDate', 'XMP-xmp:CreateDate', 'File:FileCreateDate',
  ];
  const value = keys.map((key) => metadata[key]).find((candidate) => typeof candidate === 'string' && candidate.trim());
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim()
    .replace(/^(\d{4}):(\d{2}):(\d{2})/, '$1-$2-$3')
    .replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isFinite(date.getTime()) ? date : undefined;
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

function candidateName(requested: string, index: number): string {
  const parsed = path.parse(safeSegment(requested));
  return index === 0 ? `${parsed.name}${parsed.ext}` : `${parsed.name} (${index})${parsed.ext}`;
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
      storedName = candidateName(input.originalName, index);
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
    const { stdout } = await execFileAsync('exiftool', ['-json', '-G1', '-n', filePath], {
      maxBuffer: 10 * 1024 * 1024,
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
