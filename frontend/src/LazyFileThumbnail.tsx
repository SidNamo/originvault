import { useEffect, useLayoutEffect, useRef, useState, type ComponentType } from "react";
import { api } from "./api";

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
  version,
  kind,
  source,
  shareToken,
  fallback: Fallback,
}: {
  fileId: string;
  version: string;
  kind: "image" | "video" | "unsupported";
  source: ThumbnailSource;
  shareToken?: string;
  fallback: ComponentType<{ size?: number }>;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [nearViewport, setNearViewport] = useState(false);
  const [ticket, setTicket] = useState<{ key: string; url: string }>();
  const resourceKey = `${source}:${shareToken ?? ""}:${fileId}:${version}`;
  const previewUrl = ticket?.key === resourceKey ? ticket.url : "";
  const previewable = kind === "image" || kind === "video";

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

  useLayoutEffect(() => {
    if (!nearViewport || !previewUrl) return;
    return () => {
      const media = imageRef.current ?? videoRef.current;
      if (!media) return;
      media.removeAttribute("src");
      if (media.tagName === "VIDEO") (media as HTMLVideoElement).load();
    };
  }, [nearViewport, previewUrl]);

  const activeUrl = nearViewport ? previewUrl : undefined;
  return (
    <div ref={containerRef} className="file-preview-thumb" aria-hidden="true">
      {activeUrl && kind === "image" ? (
        <img ref={imageRef} src={activeUrl} alt="" />
      ) : activeUrl && kind === "video" ? (
        <video ref={videoRef} src={activeUrl} muted playsInline preload="metadata" />
      ) : (
        <Fallback size={36} />
      )}
    </div>
  );
}
