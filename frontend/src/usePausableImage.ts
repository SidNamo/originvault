import { useEffect, useRef, useState } from "react";

type ImageDownload = {
  key: string;
  chunks: ArrayBuffer[];
  receivedBytes: number;
  totalBytes?: number;
  contentType: string;
  etag?: string;
};

const createDownload = (key: string): ImageDownload => ({
  key,
  chunks: [],
  receivedBytes: 0,
  contentType: "application/octet-stream",
});

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
  return { start, end, total };
}

export function usePausableImage({
  active,
  enabled,
  resourceKey,
  url,
}: {
  active: boolean;
  enabled: boolean;
  resourceKey: string;
  url?: string;
}) {
  const downloadRef = useRef<ImageDownload>(createDownload(resourceKey));
  const sourceRef = useRef<{ key: string; url: string } | undefined>(undefined);
  const currentKeyRef = useRef(resourceKey);
  const [source, setSource] = useState<{ key: string; url: string }>();
  currentKeyRef.current = resourceKey;

  useEffect(() => {
    if (downloadRef.current.key !== resourceKey)
      downloadRef.current = createDownload(resourceKey);
    const previous = sourceRef.current;
    if (previous && previous.key !== resourceKey) {
      URL.revokeObjectURL(previous.url);
      sourceRef.current = undefined;
      setSource(undefined);
    }
  }, [resourceKey]);

  useEffect(
    () => () => {
      if (sourceRef.current) URL.revokeObjectURL(sourceRef.current.url);
    },
    [],
  );

  useEffect(() => {
    if (
      !enabled ||
      !active ||
      !url ||
      (source?.key === resourceKey && source.url)
    )
      return;
    if (downloadRef.current.key !== resourceKey)
      downloadRef.current = createDownload(resourceKey);
    const download = downloadRef.current;
    const controller = new AbortController();

    const publish = () => {
      if (
        controller.signal.aborted ||
        currentKeyRef.current !== download.key ||
        (download.totalBytes !== undefined &&
          download.receivedBytes !== download.totalBytes)
      )
        return;
      const blob = new Blob(
        download.chunks,
        { type: download.contentType },
      );
      const objectUrl = URL.createObjectURL(blob);
      const previous = sourceRef.current;
      if (previous) URL.revokeObjectURL(previous.url);
      sourceRef.current = { key: download.key, url: objectUrl };
      download.chunks = [];
      setSource(sourceRef.current);
    };

    void (async () => {
      if (
        download.totalBytes !== undefined &&
        download.receivedBytes === download.totalBytes
      ) {
        publish();
        return;
      }
      const requestedOffset = download.receivedBytes;
      const headers = new Headers({ Range: `bytes=${requestedOffset}-` });
      if (download.etag) headers.set("If-Range", download.etag);
      const response = await fetch(url, {
        cache: "no-store",
        credentials: "same-origin",
        headers,
        signal: controller.signal,
      });
      if (!response.ok)
        throw new Error(`Image range request failed with status ${response.status}`);

      if (response.status === 206) {
        const range = contentRange(response.headers.get("Content-Range"));
        if (!range || range.start !== requestedOffset)
          throw new Error("Image range response did not match the requested offset");
        download.totalBytes = range.total;
      } else if (response.status === 200) {
        if (requestedOffset) {
          download.chunks = [];
          download.receivedBytes = 0;
        }
        const contentLength = response.headers.get("Content-Length");
        const length = contentLength === null ? Number.NaN : Number(contentLength);
        download.totalBytes = Number.isSafeInteger(length) && length >= 0
          ? length
          : undefined;
      } else {
        throw new Error(`Unexpected image response status ${response.status}`);
      }
      download.contentType = response.headers.get("Content-Type")
        ?.split(";", 1)[0]
        ?.trim() || download.contentType;
      download.etag = response.headers.get("ETag") || download.etag;

      const reader = response.body?.getReader();
      if (!reader) {
        const bytes = await response.arrayBuffer();
        download.chunks.push(bytes);
        download.receivedBytes += bytes.byteLength;
      } else {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value.byteLength) continue;
          const retained = value.slice().buffer as ArrayBuffer;
          download.chunks.push(retained);
          download.receivedBytes += retained.byteLength;
        }
      }
      if (
        download.totalBytes !== undefined &&
        download.receivedBytes !== download.totalBytes
      )
        throw new Error("Image response ended before all bytes were received");
      publish();
    })().catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        // Keep received chunks so a later viewport entry can retry from the same offset.
      }
    });
    return () => controller.abort();
  }, [active, enabled, resourceKey, source?.key, source?.url, url]);

  return source?.key === resourceKey ? source.url : undefined;
}
