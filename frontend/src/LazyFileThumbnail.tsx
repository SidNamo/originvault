import { useEffect, useRef, useState, type ComponentType } from "react";
import { api } from "./api";
import { usePausableImage } from "./usePausableImage";

type ThumbnailSource = "files" | "trash" | "public";
const visibilityListeners = new Map<Element, (visible: boolean) => void>();
let viewportObserver: IntersectionObserver | undefined;

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
  kind: "image" | "video" | "unsupported";
  source: ThumbnailSource;
  shareToken?: string;
  fallback: ComponentType<{ size?: number }>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [ticket, setTicket] = useState<{ key: string; url: string }>();
  const resourceKey = `${source}:${shareToken ?? ""}:${fileId}:${version}`;
  const [failedResourceKey, setFailedResourceKey] = useState<string>();
  const previewFailed = failedResourceKey === resourceKey;
  const previewUrl = ticket?.key === resourceKey ? ticket.url : "";
  const previewable = kind === "image" || kind === "video";
  const nativeOnlyImage = kind === "image" && (
    mimeType?.split(";", 1)[0]?.trim().toLowerCase() === "image/svg+xml" ||
    /\.svgz?$/i.test(fileName)
  );
  const imageUrl = usePausableImage({
    active: nearViewport,
    enabled: kind === "image" && !nativeOnlyImage,
    resourceKey,
    url: previewUrl || undefined,
  });

  useEffect(() => {
    const element = containerRef.current;
    if (!element || !previewable) return;
    return observeNearViewport(element, setNearViewport);
  }, [previewable]);

  useEffect(() => {
    if (!nearViewport || !previewable || previewUrl) return;
    const controller = new AbortController();
    const request = source === "public"
      ? shareToken
        ? Promise.resolve(`${api.publicSharePreviewUrl(shareToken, fileId)}?v=${encodeURIComponent(version)}`)
        : Promise.reject(new Error("A public share token is required"))
      : source === "trash"
        ? api.trashFilePreviewTicket(fileId, controller.signal)
        : api.filePreviewTicket(fileId, controller.signal);
    void request
      .then((url) => {
        if (!controller.signal.aborted) setTicket({ key: resourceKey, url });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [fileId, nearViewport, previewUrl, previewable, resourceKey, shareToken, source, version]);

  const nativeImageUrl = nativeOnlyImage ? previewUrl : undefined;
  const videoUrl = nearViewport && kind === "video" ? previewUrl : undefined;
  return (
    <div ref={containerRef} className="file-preview-thumb" aria-hidden="true">
      {!previewFailed && (imageUrl || nativeImageUrl) && kind === "image" ? (
        <img
          src={imageUrl || nativeImageUrl}
          alt=""
          draggable={false}
          onError={() => setFailedResourceKey(resourceKey)}
        />
      ) : !previewFailed && videoUrl ? (
        <video
          src={videoUrl}
          muted
          playsInline
          preload="metadata"
          onError={() => setFailedResourceKey(resourceKey)}
        />
      ) : (
        <Fallback size={36} />
      )}
    </div>
  );
}
