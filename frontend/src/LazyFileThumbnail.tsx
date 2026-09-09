import { useEffect, useRef, useState, type ComponentType } from "react";
import { api } from "./api";
import {
  clearPausableImageCache,
  hasCachedPausableImage,
  usePausableImage,
} from "./usePausableImage";

type ThumbnailSource = "files" | "trash" | "public";
type PreviewTicket = { url: string; expiresAt: number };
type ActivePreviewTicket = PreviewTicket & { key: string };
type PendingPreviewTicket = {
  generation: number;
  controller: AbortController;
  promise: Promise<PreviewTicket>;
};
const PREVIEW_TICKET_TTL_MS = 11 * 60 * 60 * 1_000;
const PREVIEW_TICKET_REQUEST_TIMEOUT_MS = 30_000;
const MAX_CACHED_PREVIEW_TICKETS = 5_000;
const MAX_PENDING_PREVIEW_TICKETS = 256;
const previewTickets = new Map<string, PreviewTicket>();
const pendingPreviewTickets = new Map<string, PendingPreviewTicket>();
const previewCacheResetListeners = new Set<() => void>();
let previewTicketGeneration = 0;
const visibilityListeners = new Map<Element, (visible: boolean) => void>();
let viewportObserver: IntersectionObserver | undefined;

function cachedPreviewTicket(key: string) {
  const ticket = previewTickets.get(key);
  if (!ticket) return;
  if (ticket.expiresAt <= Date.now()) {
    previewTickets.delete(key);
    return;
  }
  previewTickets.delete(key);
  previewTickets.set(key, ticket);
  return ticket;
}

function rememberPreviewTicket(key: string, url: string) {
  const ticket = {
    url,
    expiresAt: Date.now() + PREVIEW_TICKET_TTL_MS,
  };
  previewTickets.delete(key);
  previewTickets.set(key, ticket);
  while (previewTickets.size > MAX_CACHED_PREVIEW_TICKETS) {
    const oldest = previewTickets.keys().next().value;
    if (oldest === undefined) break;
    previewTickets.delete(oldest);
  }
  return ticket;
}

function forgetPreviewTicket(key: string, url: string) {
  if (previewTickets.get(key)?.url === url) previewTickets.delete(key);
}

function loadPreviewTicket(
  key: string,
  request: (signal: AbortSignal) => Promise<string>,
) {
  const cached = cachedPreviewTicket(key);
  if (cached) return Promise.resolve(cached);
  const pending = pendingPreviewTickets.get(key);
  if (pending?.generation === previewTicketGeneration) return pending.promise;
  while (pendingPreviewTickets.size >= MAX_PENDING_PREVIEW_TICKETS) {
    const oldestKey = pendingPreviewTickets.keys().next().value;
    if (oldestKey === undefined) break;
    pendingPreviewTickets.get(oldestKey)?.controller.abort();
    pendingPreviewTickets.delete(oldestKey);
  }
  const generation = previewTicketGeneration;
  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    PREVIEW_TICKET_REQUEST_TIMEOUT_MS,
  );
  let nextPending: PendingPreviewTicket;
  const promise = Promise.resolve()
    .then(() => request(controller.signal))
    .then((url) => {
      if (
        generation !== previewTicketGeneration ||
        controller.signal.aborted
      )
        throw new DOMException("Preview ticket request was cancelled", "AbortError");
      return rememberPreviewTicket(key, url);
    })
    .finally(() => {
      window.clearTimeout(timeout);
      if (pendingPreviewTickets.get(key) === nextPending)
        pendingPreviewTickets.delete(key);
    });
  nextPending = { generation, controller, promise };
  pendingPreviewTickets.set(key, nextPending);
  return promise;
}

export function clearLazyFileThumbnailCache() {
  previewTicketGeneration += 1;
  for (const pending of pendingPreviewTickets.values())
    pending.controller.abort();
  previewTickets.clear();
  pendingPreviewTickets.clear();
  clearPausableImageCache();
  for (const listener of previewCacheResetListeners) listener();
}

function observeNearViewport(element: Element, listener: (visible: boolean) => void) {
  if (!("IntersectionObserver" in window)) {
    listener(true);
    return () => undefined;
  }
  viewportObserver ??= new IntersectionObserver(
    (entries) => {
      for (const entry of entries)
        visibilityListeners.get(entry.target)?.(entry.isIntersecting);
    },
    { rootMargin: "240px 0px", threshold: 0 },
  );
  visibilityListeners.set(element, listener);
  viewportObserver.observe(element);
  return () => {
    viewportObserver?.unobserve(element);
    visibilityListeners.delete(element);
    if (!visibilityListeners.size) {
      viewportObserver?.disconnect();
      viewportObserver = undefined;
    }
  };
}

export function LazyFileThumbnail({
  fileId,
  fileName,
  mimeType,
  version,
  kind,
  source,
  shareToken,
  fallback: Fallback,
}: {
  fileId: string;
  fileName: string;
  mimeType?: string;
  version: string;
  kind: "image" | "video" | "pdf" | "unsupported";
  source: ThumbnailSource;
  shareToken?: string;
  fallback: ComponentType<{ size?: number }>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const resourceKey = `${source}:${shareToken ?? ""}:${fileId}:${version}`;
  const [ticket, setTicket] = useState<ActivePreviewTicket>();
  const [ticketRequestAttempt, setTicketRequestAttempt] = useState(0);
  const [failedResourceKey, setFailedResourceKey] = useState<string>();
  const ticketRefreshRef = useRef({ key: resourceKey, count: 0 });
  const ticketRequestFailureRef = useRef({ key: resourceKey, count: 0 });
  if (ticketRefreshRef.current.key !== resourceKey)
    ticketRefreshRef.current = { key: resourceKey, count: 0 };
  if (ticketRequestFailureRef.current.key !== resourceKey)
    ticketRequestFailureRef.current = { key: resourceKey, count: 0 };
  const previewFailed = failedResourceKey === resourceKey;
  const previewUrl =
    ticket?.key === resourceKey && ticket.expiresAt > Date.now()
      ? ticket.url
      : "";
  const previewable = kind === "image" || kind === "video" || kind === "pdf";
  const nativeOnlyImage = kind === "image" && (
    mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "image/svg+xml" ||
    /\.svg$/i.test(fileName)
  );
  const pausableImage = kind === "image" || kind === "pdf";
  const serverThumbnail = kind === "pdf" || (kind === "image" && !nativeOnlyImage);
  const handlePreviewRequestError = (failedUrl: string, status?: number) => {
    if (!failedUrl || failedUrl !== previewUrl) return;
    const canRefreshTicket = status === 401 || status === 403 || status === 404;
    if (canRefreshTicket && ticketRefreshRef.current.count < 1) {
      ticketRefreshRef.current.count += 1;
      forgetPreviewTicket(resourceKey, failedUrl);
      setTicket(undefined);
      return;
    }
    setFailedResourceKey(resourceKey);
  };
  const imageUrl = usePausableImage({
    active: nearViewport,
    enabled: pausableImage && !previewFailed,
    resourceKey,
    url: previewUrl || undefined,
    onRequestError: handlePreviewRequestError,
  });

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !previewable) return;
    return observeNearViewport(element, setNearViewport);
  }, [previewable]);

  useEffect(() => {
    if (!nearViewport) {
      setTicket((current) =>
        current?.key === resourceKey ? undefined : current,
      );
      return;
    }
    const cached = cachedPreviewTicket(resourceKey);
    setTicket(cached ? { key: resourceKey, ...cached } : undefined);
  }, [nearViewport, resourceKey]);

  useEffect(() => {
    const reset = () => {
      setTicket(undefined);
      setFailedResourceKey(undefined);
      ticketRefreshRef.current = { key: resourceKey, count: 0 };
      ticketRequestFailureRef.current = { key: resourceKey, count: 0 };
      setTicketRequestAttempt((value) => value + 1);
    };
    previewCacheResetListeners.add(reset);
    return () => {
      previewCacheResetListeners.delete(reset);
    };
  }, [resourceKey]);

  useEffect(() => {
    if (!ticket || ticket.key !== resourceKey) return;
    const remaining = ticket.expiresAt - Date.now();
    if (remaining <= 0) {
      forgetPreviewTicket(resourceKey, ticket.url);
      setTicket(undefined);
      return;
    }
    const timeout = window.setTimeout(() => {
      forgetPreviewTicket(resourceKey, ticket.url);
      setTicket((current) =>
        current?.key === resourceKey && current.url === ticket.url
          ? undefined
          : current,
      );
    }, remaining);
    return () => window.clearTimeout(timeout);
  }, [resourceKey, ticket]);

  useEffect(() => {
    const cachedImageReady =
      pausableImage &&
      (Boolean(imageUrl) || hasCachedPausableImage(resourceKey));
    if (!nearViewport || !previewable || previewUrl || cachedImageReady) return;
    let disposed = false;
    let retryTimer: number | undefined;
    const request = (signal: AbortSignal) => source === "public"
      ? shareToken
        ? Promise.resolve(`${
            serverThumbnail
              ? api.publicShareThumbnailUrl(shareToken, fileId)
              : api.publicSharePreviewUrl(shareToken, fileId)
          }?v=${encodeURIComponent(version)}`)
        : Promise.reject(new Error("A public share token is required"))
      : source === "trash"
        ? api.trashFilePreviewTicket(fileId, signal)
        : api.filePreviewTicket(fileId, signal);
    void loadPreviewTicket(resourceKey, request)
      .then((nextTicket) => {
        if (disposed) return;
        ticketRequestFailureRef.current = { key: resourceKey, count: 0 };
        setFailedResourceKey((current) =>
          current === resourceKey ? undefined : current,
        );
        setTicket({ key: resourceKey, ...nextTicket });
      })
      .catch(() => {
        if (disposed) return;
        const failures = ticketRequestFailureRef.current;
        if (failures.key !== resourceKey) return;
        if (failures.count >= 2) {
          setFailedResourceKey(resourceKey);
          return;
        }
        failures.count += 1;
        retryTimer = window.setTimeout(
          () => setTicketRequestAttempt((value) => value + 1),
          500 * 2 ** (failures.count - 1),
        );
      });
    return () => {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
    };
  }, [fileId, imageUrl, nearViewport, pausableImage, previewUrl, previewable, resourceKey, serverThumbnail, shareToken, source, ticketRequestAttempt, version]);

  const videoUrl = nearViewport && kind === "video" ? previewUrl : undefined;
  return (
    <div ref={containerRef} className="file-preview-thumb" aria-hidden="true">
      {!previewFailed && imageUrl && pausableImage ? (
        <img
          src={imageUrl}
          alt=""
          draggable={false}
          onLoad={() => {
            ticketRefreshRef.current.count = 0;
            setFailedResourceKey((current) =>
              current === resourceKey ? undefined : current,
            );
          }}
          onError={() =>
            imageUrl === previewUrl
              ? handlePreviewRequestError(previewUrl, 404)
              : setFailedResourceKey(resourceKey)
          }
        />
      ) : !previewFailed && videoUrl ? (
        <video
          src={videoUrl}
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={() => {
            ticketRefreshRef.current.count = 0;
            setFailedResourceKey((current) =>
              current === resourceKey ? undefined : current,
            );
          }}
          onError={() => handlePreviewRequestError(videoUrl, 404)}
        />
      ) : (
        <Fallback size={36} />
      )}
    </div>
  );
}
