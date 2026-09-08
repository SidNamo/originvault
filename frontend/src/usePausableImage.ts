import { useEffect, useRef, useState } from "react";

type ImageTransfer = {
  controller: AbortController;
  promise: Promise<void>;
  url: string;
};

type ImageDownloadError = {
  id: number;
  url: string;
  status?: number;
};

type ImageDownload = {
  key: string;
  chunks: ArrayBuffer[];
  receivedBytes: number;
  accountedBytes: number;
  totalBytes?: number;
  contentType: string;
  etag?: string;
  blob?: Blob;
  directUrl?: string;
  tooLarge: boolean;
  error?: ImageDownloadError;
  retryCount: number;
  retryUrl?: string;
  retryTimer?: number;
  transfer?: ImageTransfer;
  subscribers: Set<() => void>;
  generation: number;
};

type ImageSource = {
  key: string;
  url: string;
  blob?: Blob;
  owned: boolean;
};

const MAX_CACHED_IMAGE_BYTES = 256 * 1024 * 1024;
const MAX_CACHED_IMAGE_ENTRIES = 5_000;
const CACHE_PRUNE_INTERVAL_BYTES = 4 * 1024 * 1024;
const CACHED_THUMBNAIL_EDGE = 512;
const imageDownloads = new Map<string, ImageDownload>();
const imageCacheResetListeners = new Set<() => void>();
let imageCacheGeneration = 0;
let imageErrorId = 0;
let cachedImageBytes = 0;

class ImageResponseError extends Error {
  constructor(readonly status: number) {
    super(`Image range request failed with status ${status}`);
  }
}

class ImageTooLargeError extends Error {}
class ImageCacheCapacityError extends Error {}

const createDownload = (key: string): ImageDownload => ({
  key,
  chunks: [],
  receivedBytes: 0,
  accountedBytes: 0,
  contentType: "application/octet-stream",
  tooLarge: false,
  retryCount: 0,
  subscribers: new Set(),
  generation: imageCacheGeneration,
});

const isCurrentDownload = (download: ImageDownload) =>
  download.generation === imageCacheGeneration &&
  imageDownloads.get(download.key) === download;

function touchDownload(download: ImageDownload) {
  if (!isCurrentDownload(download)) return;
  imageDownloads.delete(download.key);
  imageDownloads.set(download.key, download);
}

function pruneImageDownloads(protectedKey?: string, incomingBytes = 0) {
  while (
    imageDownloads.size > MAX_CACHED_IMAGE_ENTRIES ||
    cachedImageBytes + incomingBytes > MAX_CACHED_IMAGE_BYTES
  ) {
    let removed = false;
    for (const [key, download] of imageDownloads) {
      if (
        key === protectedKey ||
        download.subscribers.size ||
        download.transfer
      )
        continue;
      imageDownloads.delete(key);
      cachedImageBytes -= download.accountedBytes;
      removed = true;
      break;
    }
    if (!removed) break;
  }
}

function accountDownload(download: ImageDownload, bytes: number) {
  if (!isCurrentDownload(download)) return false;
  const difference = bytes - download.accountedBytes;
  if (difference > 0) {
    pruneImageDownloads(download.key, difference);
    if (cachedImageBytes + difference > MAX_CACHED_IMAGE_BYTES)
      return false;
  }
  cachedImageBytes += difference;
  download.accountedBytes = bytes;
  return true;
}

function getDownload(key: string) {
  const existing = imageDownloads.get(key);
  if (existing) {
    touchDownload(existing);
    return existing;
  }
  const created = createDownload(key);
  imageDownloads.set(key, created);
  pruneImageDownloads(key);
  return created;
}

function notifyDownload(download: ImageDownload) {
  for (const subscriber of download.subscribers) subscriber();
}

async function compactThumbnail(blob: Blob): Promise<Blob> {
  const mimeType = blob.type.toLowerCase();
  if (
    typeof createImageBitmap !== "function" ||
    mimeType === "image/gif" ||
    mimeType === "image/svg+xml"
  )
    return blob;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(blob);
    const scale = Math.min(
      1,
      CACHED_THUMBNAIL_EDGE / Math.max(bitmap.width, bitmap.height),
    );
    if (scale >= 1) return blob;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return blob;
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve) =>
      canvas.toBlob(
        (thumbnail) => resolve(thumbnail ?? blob),
        "image/webp",
        0.82,
      ),
    );
  } catch {
    return blob;
  } finally {
    bitmap?.close();
  }
}

export function clearPausableImageCache() {
  for (const download of imageDownloads.values()) {
    download.transfer?.controller.abort();
    if (download.retryTimer !== undefined)
      window.clearTimeout(download.retryTimer);
  }
  imageCacheGeneration += 1;
  imageDownloads.clear();
  cachedImageBytes = 0;
  for (const listener of imageCacheResetListeners) listener();
}

export function hasCachedPausableImage(key: string) {
  const download = imageDownloads.get(key);
  return Boolean(download && isCurrentDownload(download) && download.blob);
}

function contentRange(value: string | null) {
  const match = value?.match(/^bytes (\d+)-(\d+)\/(\d+)$/);
  if (!match) return;
  const start = Number(match[1]);
  const end = Number(match[2]);
  const total = Number(match[3]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    !Number.isSafeInteger(total) ||
    start < 0 ||
    end < start ||
    total <= end
  )
    return;
  return { start, total };
}

async function cancelResponseBody(response: Response) {
  if (response.body) await response.body.cancel().catch(() => undefined);
}

async function finishDownload(
  download: ImageDownload,
  transfer: ImageTransfer,
) {
  if (
    !isCurrentDownload(download) ||
    download.transfer !== transfer ||
    (download.totalBytes !== undefined &&
      download.receivedBytes !== download.totalBytes)
  )
    return;
  const original = new Blob(download.chunks, {
    type: download.contentType,
  });
  download.chunks = [];
  const compacted = await compactThumbnail(original).catch(() => original);
  if (!isCurrentDownload(download) || download.transfer !== transfer) return;
  const blob = accountDownload(download, compacted.size)
    ? compacted
    : original;
  if (blob === original) accountDownload(download, original.size);
  download.blob = blob;
  download.directUrl = undefined;
  download.error = undefined;
  download.retryCount = 0;
  download.retryUrl = undefined;
}

async function runTransfer(
  download: ImageDownload,
  transfer: ImageTransfer,
) {
  if (
    download.totalBytes !== undefined &&
    download.receivedBytes === download.totalBytes
  ) {
    await finishDownload(download, transfer);
    return;
  }

  const requestedOffset = download.receivedBytes;
  const headers = new Headers({ Range: `bytes=${requestedOffset}-` });
  if (download.etag) headers.set("If-Range", download.etag);
  const response = await fetch(transfer.url, {
    cache: "no-store",
    credentials: "same-origin",
    headers,
    signal: transfer.controller.signal,
  });
  if (!isCurrentDownload(download) || download.transfer !== transfer) {
    await cancelResponseBody(response);
    return;
  }
  if (!response.ok) throw new ImageResponseError(response.status);

  if (response.status === 206) {
    const range = contentRange(response.headers.get("Content-Range"));
    if (!range || range.start !== requestedOffset)
      throw new Error("Image range response did not match the requested offset");
    download.totalBytes = range.total;
  } else if (response.status === 200) {
    if (requestedOffset) {
      download.chunks = [];
      download.receivedBytes = 0;
      accountDownload(download, 0);
    }
    const contentLength = response.headers.get("Content-Length");
    const length = contentLength === null ? Number.NaN : Number(contentLength);
    download.totalBytes = Number.isSafeInteger(length) && length >= 0
      ? length
      : undefined;
  } else {
    throw new Error(`Unexpected image response status ${response.status}`);
  }

  if (
    download.totalBytes !== undefined &&
    download.totalBytes > MAX_CACHED_IMAGE_BYTES
  ) {
    await cancelResponseBody(response);
    throw new ImageTooLargeError();
  }
  if (
    download.totalBytes !== undefined &&
    !accountDownload(download, download.totalBytes)
  ) {
    await cancelResponseBody(response);
    throw new ImageCacheCapacityError();
  }
  download.contentType = response.headers.get("Content-Type")
    ?.split(";", 1)[0]
    ?.trim() || download.contentType;
  download.etag = response.headers.get("ETag") || download.etag;

  let lastPrunedBytes = download.receivedBytes;
  const retain = (bytes: ArrayBuffer) => {
    if (!isCurrentDownload(download) || download.transfer !== transfer)
      throw new DOMException("Image transfer was replaced", "AbortError");
    if (download.receivedBytes + bytes.byteLength > MAX_CACHED_IMAGE_BYTES)
      throw new ImageTooLargeError();
    if (
      download.totalBytes === undefined &&
      !accountDownload(download, download.receivedBytes + bytes.byteLength)
    )
      throw new ImageCacheCapacityError();
    download.chunks.push(bytes);
    download.receivedBytes += bytes.byteLength;
    if (
      download.receivedBytes - lastPrunedBytes >=
      CACHE_PRUNE_INTERVAL_BYTES
    ) {
      pruneImageDownloads(download.key);
      lastPrunedBytes = download.receivedBytes;
    }
  };

  const reader = response.body?.getReader();
  if (!reader) {
    retain(await response.arrayBuffer());
  } else {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength) retain(value.slice().buffer as ArrayBuffer);
    }
  }
  if (
    download.totalBytes !== undefined &&
    download.receivedBytes !== download.totalBytes
  )
    throw new Error("Image response ended before all bytes were received");
  await finishDownload(download, transfer);
}

function ensureTransfer(download: ImageDownload, url?: string) {
  if (!isCurrentDownload(download) || download.blob || download.transfer)
    return;
  if (!url || download.directUrl !== url) download.directUrl = undefined;
  const downloadComplete =
    download.totalBytes !== undefined &&
    download.receivedBytes === download.totalBytes;
  if (!url && !downloadComplete) return;
  if (download.retryTimer !== undefined || download.directUrl === url) return;
  if (download.tooLarge && url) {
    download.directUrl = url;
    download.error = undefined;
    return;
  }
  if (download.error?.url === url) return;
  if (download.retryUrl !== url) {
    download.retryCount = 0;
    download.retryUrl = url;
  }
  download.error = undefined;

  const controller = new AbortController();
  const transfer: ImageTransfer = {
    controller,
    promise: Promise.resolve(),
    url: url ?? "",
  };
  download.transfer = transfer;
  transfer.promise = runTransfer(download, transfer)
    .catch((error: unknown) => {
      if (!isCurrentDownload(download) || download.transfer !== transfer)
        return;
      if (
        error instanceof ImageTooLargeError ||
        error instanceof ImageCacheCapacityError
      ) {
        controller.abort();
        accountDownload(download, 0);
        download.chunks = [];
        download.receivedBytes = 0;
        download.totalBytes = undefined;
        download.etag = undefined;
        download.tooLarge = error instanceof ImageTooLargeError;
        download.directUrl = transfer.url;
        download.error = undefined;
        return;
      }
      if (
        controller.signal.aborted ||
        (error instanceof DOMException && error.name === "AbortError")
      )
        return;
      const nextError = {
        id: ++imageErrorId,
        url: transfer.url,
        status: error instanceof ImageResponseError ? error.status : undefined,
      };
      const retryable =
        nextError.status === undefined ||
        nextError.status === 408 ||
        nextError.status === 429 ||
        nextError.status >= 500;
      if (retryable && download.retryCount < 2 && download.subscribers.size) {
        download.retryCount += 1;
        download.retryTimer = window.setTimeout(() => {
          if (!isCurrentDownload(download)) return;
          download.retryTimer = undefined;
          notifyDownload(download);
        }, 500 * 2 ** (download.retryCount - 1));
        return;
      }
      download.error = nextError;
    })
    .finally(() => {
      if (!isCurrentDownload(download) || download.transfer !== transfer)
        return;
      download.transfer = undefined;
      if (!download.blob && download.accountedBytes > download.receivedBytes)
        accountDownload(download, download.receivedBytes);
      touchDownload(download);
      pruneImageDownloads();
      notifyDownload(download);
    });
}

export function usePausableImage({
  active,
  enabled,
  resourceKey,
  url,
  onRequestError,
}: {
  active: boolean;
  enabled: boolean;
  resourceKey: string;
  url?: string;
  onRequestError?: (url: string, status?: number) => void;
}) {
  const [source, setSource] = useState<ImageSource>();
  const [cacheEpoch, setCacheEpoch] = useState(0);
  const sourceRef = useRef<ImageSource | undefined>(undefined);
  const onRequestErrorRef = useRef(onRequestError);
  const seenErrorRef = useRef<{ key: string; id: number } | undefined>(
    undefined,
  );
  onRequestErrorRef.current = onRequestError;

  useEffect(() => {
    const reset = () => {
      const current = sourceRef.current;
      if (current?.owned) URL.revokeObjectURL(current.url);
      sourceRef.current = undefined;
      seenErrorRef.current = undefined;
      setSource(undefined);
      setCacheEpoch((value) => value + 1);
    };
    imageCacheResetListeners.add(reset);
    return () => {
      imageCacheResetListeners.delete(reset);
      const current = sourceRef.current;
      if (current?.owned) URL.revokeObjectURL(current.url);
      sourceRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    const replaceSource = (next?: ImageSource) => {
      const previous = sourceRef.current;
      if (
        previous?.key === next?.key &&
        previous?.url === next?.url &&
        previous?.blob === next?.blob
      )
        return;
      if (previous?.owned) URL.revokeObjectURL(previous.url);
      sourceRef.current = next;
      setSource(next);
    };

    if (!enabled) {
      replaceSource();
      return;
    }
    if (!active) {
      const download = imageDownloads.get(resourceKey);
      if (download?.blob) {
        const current = sourceRef.current;
        if (
          current?.key !== resourceKey ||
          current.blob !== download.blob
        )
          replaceSource({
            key: resourceKey,
            url: URL.createObjectURL(download.blob),
            blob: download.blob,
            owned: true,
          });
      } else {
        replaceSource();
      }
      return;
    }

    const download = getDownload(resourceKey);
    if (!download.subscribers.size && download.error) {
      download.error = undefined;
      download.retryCount = 0;
      download.retryUrl = undefined;
    }
    let disposed = false;
    const refresh = () => {
      if (disposed || !isCurrentDownload(download)) return;
      ensureTransfer(download, url);
      if (download.blob) {
        const current = sourceRef.current;
        if (
          current?.key !== resourceKey ||
          current.blob !== download.blob
        )
          replaceSource({
            key: resourceKey,
            url: URL.createObjectURL(download.blob),
            blob: download.blob,
            owned: true,
          });
      } else if (download.directUrl) {
        replaceSource({
          key: resourceKey,
          url: download.directUrl,
          owned: false,
        });
      } else {
        replaceSource();
      }
      if (
        download.error &&
        download.error.status !== undefined &&
        download.error.status !== 408 &&
        download.error.status !== 429 &&
        download.error.status < 500 &&
        (seenErrorRef.current?.key !== resourceKey ||
          seenErrorRef.current.id !== download.error.id)
      ) {
        seenErrorRef.current = {
          key: resourceKey,
          id: download.error.id,
        };
        onRequestErrorRef.current?.(
          download.error.url,
          download.error.status,
        );
      }
    };

    download.subscribers.add(refresh);
    touchDownload(download);
    refresh();
    return () => {
      disposed = true;
      download.subscribers.delete(refresh);
      if (!download.blob) replaceSource();
      if (!download.subscribers.size) {
        download.transfer?.controller.abort();
        if (download.retryTimer !== undefined) {
          window.clearTimeout(download.retryTimer);
          download.retryTimer = undefined;
        }
        download.retryCount = 0;
        download.retryUrl = undefined;
      }
      touchDownload(download);
      pruneImageDownloads();
    };
  }, [active, cacheEpoch, enabled, resourceKey, url]);

  return enabled &&
    source?.key === resourceKey &&
    (source.owned || source.url === url)
    ? source.url
    : undefined;
}
