import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { logger } from './logger.js';
import { resolveInside, userFilesRoot } from './storage.js';
import {
  getOrCreateThumbnail,
  hasCachedThumbnail,
  thumbnailKind,
} from './thumbnails.js';

export type ThumbnailBackfillFile = {
  id: string;
  storageKey: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sha256: string;
  trashedAt: Date | string | null;
  trashStoragePath: string | null;
  trashRootRelativePath: string | null;
};

export type ThumbnailBackfillStats = {
  scannedFiles: number;
  eligibleHashes: number;
  existingThumbnails: number;
  generatedThumbnails: number;
  unavailableFiles: number;
  failedThumbnails: number;
};

export type ThumbnailBackfillPage = (
  cursor: string | null,
  limit: number,
) => Promise<ThumbnailBackfillFile[]>;

export function thumbnailBackfillSourcePath(file: ThumbnailBackfillFile): string {
  const root = userFilesRoot(file.storageKey);
  if (!file.trashedAt) return resolveInside(root, file.relativePath);
  if (!file.trashStoragePath || !file.trashRootRelativePath)
    throw new Error('Trashed file storage has not been isolated');
  const rootRelativePath = file.trashRootRelativePath;
  if (
    file.relativePath !== rootRelativePath &&
    !file.relativePath.startsWith(`${rootRelativePath}/`)
  )
    throw new Error('Trashed file path is outside its trash root');
  const suffix = file.relativePath.slice(rootRelativePath.length);
  return resolveInside(root, `${file.trashStoragePath}${suffix}`);
}

export async function backfillMissingThumbnails(
  fetchPage: ThumbnailBackfillPage,
  options: { batchSize?: number; concurrency?: number } = {},
): Promise<ThumbnailBackfillStats> {
  const batchSize = Math.max(1, Math.min(1_000, options.batchSize ?? 250));
  const concurrency = Math.max(1, Math.min(4, options.concurrency ?? 2));
  const stats: ThumbnailBackfillStats = {
    scannedFiles: 0,
    eligibleHashes: 0,
    existingThumbnails: 0,
    generatedThumbnails: 0,
    unavailableFiles: 0,
    failedThumbnails: 0,
  };
  let cursor: string | null = null;

  const attemptFile = async (
    file: ThumbnailBackfillFile,
    sha256: string,
  ): Promise<boolean> => {
    try {
      if (await hasCachedThumbnail({ sha256, name: file.name, mimeType: file.mimeType })) {
        stats.existingThumbnails += 1;
        return true;
      }
      const thumbnail = await getOrCreateThumbnail({
        sourcePath: thumbnailBackfillSourcePath(file),
        verifySourceHash: true,
        priority: 'background',
        sha256,
        name: file.name,
        mimeType: file.mimeType,
      });
      if (!thumbnail) throw new Error('File no longer supports a server thumbnail');
      stats.generatedThumbnails += 1;
      return true;
    } catch (error: any) {
      if (error?.code === 'ENOENT' || error?.code === 'ESTALE') {
        stats.unavailableFiles += 1;
        logger.debug({ event: 'thumbnail_backfill_source_unavailable', fileId: file.id, sha256 }, 'Thumbnail backfill source is unavailable');
      } else {
        stats.failedThumbnails += 1;
        logger.warn({ event: 'thumbnail_backfill_file_failed', fileId: file.id, sha256, err: error }, 'Existing file thumbnail backfill failed');
      }
      return false;
    }
  };

  while (true) {
    const rows = await fetchPage(cursor, batchSize);
    if (!rows.length) break;
    stats.scannedFiles += rows.length;
    // Keep dedupe memory bounded; a completed cache entry dedupes later pages.
    const eligibleKeys = new Set<string>();
    const completedKeys = new Set<string>();
    const attemptsByKey = new Map<string, Promise<boolean>>();
    let nextIndex = 0;
    const processNext = async (): Promise<void> => {
      while (nextIndex < rows.length) {
        const file = rows[nextIndex++];
        if (!file) continue;
        const kind = thumbnailKind(file.name, file.mimeType);
        if (!kind) continue;
        const sha256 = file.sha256.trim().toLowerCase();
        const derivativeKey = `${kind}:${sha256}`;
        if (completedKeys.has(derivativeKey)) continue;
        if (!eligibleKeys.has(derivativeKey)) {
          eligibleKeys.add(derivativeKey);
          stats.eligibleHashes += 1;
        }
        const previousAttempt = attemptsByKey.get(derivativeKey) ?? Promise.resolve(false);
        const attempt = previousAttempt.then((succeeded) => succeeded || completedKeys.has(derivativeKey)
          ? true
          : attemptFile(file, sha256));
        attemptsByKey.set(derivativeKey, attempt);
        const succeeded = await attempt;
        if (succeeded) completedKeys.add(derivativeKey);
        if (attemptsByKey.get(derivativeKey) === attempt) attemptsByKey.delete(derivativeKey);
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(concurrency, rows.length) },
      () => processNext(),
    ));
    const nextCursor = rows.at(-1)?.id;
    if (!nextCursor || nextCursor === cursor)
      throw new Error('Thumbnail backfill page did not advance its cursor');
    cursor = nextCursor;
    if (rows.length < batchSize) break;
    await yieldToEventLoop();
  }
  return stats;
}
