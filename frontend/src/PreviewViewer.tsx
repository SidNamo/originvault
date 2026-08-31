import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileQuestion,
  FileText,
  Image,
  Info,
  List,
  LoaderCircle,
  Music,
  Pencil,
  Save,
  Subtitles,
  Video,
  X,
} from "lucide-react";
import {
  api,
  type FilePreview,
  type PreviewSibling,
  type VaultFile,
} from "./api";
import { formatBytes } from "./format";
import { cuesToWebVtt, parseSubtitles, type SubtitleCue } from "./subtitles";

const encodingLabels: Record<string, string> = {
  "utf-8": "UTF-8",
  "utf-16le": "UTF-16 LE",
  "utf-16be": "UTF-16 BE",
  "euc-kr": "EUC-KR",
  cp949: "CP949",
  shift_jis: "Shift_JIS",
  "euc-jp": "EUC-JP",
  gb18030: "GB18030",
  big5: "Big5",
  "windows-1252": "Windows-1252",
  "iso-8859-1": "ISO-8859-1",
};

interface RecoveredTextDraft {
  draft: string;
  encoding: string;
  hasBom: boolean;
  etag: string;
}

const recoveredTextDrafts = new Map<string, RecoveredTextDraft>();

const mediaKind = (kind?: string) =>
  kind === "image" || kind === "video" || kind === "audio";
const previewDetailValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
const previewDetailDate = (value?: string | null) => {
  if (!value) return "알 수 없음";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("ko-KR") : "알 수 없음";
};

type LineEnding = "lf" | "crlf" | "cr";
type LineSeparator = "\n" | "\r\n" | "\r";
const normalizeLineEndings = (value: string) => value.replace(/\r\n|\r/g, "\n");
const extractLineEndings = (value: string): LineSeparator[] =>
  (value.match(/\r\n|\r|\n/g) ?? []) as LineSeparator[];
const detectLineEnding = (value: string): LineEnding => {
  const separators = extractLineEndings(value);
  if (!separators.length) return "lf";
  const counts = new Map<LineSeparator, number>();
  for (const separator of separators)
    counts.set(separator, (counts.get(separator) ?? 0) + 1);
  const dominant = separators.reduce((current, separator) =>
    (counts.get(separator) ?? 0) > (counts.get(current) ?? 0)
      ? separator
      : current,
  );
  return dominant === "\r\n" ? "crlf" : dominant === "\r" ? "cr" : "lf";
};
const applyLineEndings = (
  value: string,
  sourceText: string,
  sourceLineEndings: LineSeparator[],
  fallback: LineEnding,
) => {
  const normalized = normalizeLineEndings(value);
  const sourceLines = normalizeLineEndings(sourceText).split("\n");
  const draftLines = normalized.split("\n");
  const sourcePositions = new Map<string, number[]>();
  for (const [index, line] of sourceLines.entries()) {
    const positions = sourcePositions.get(line) ?? [];
    positions.push(index);
    sourcePositions.set(line, positions);
  }
  const mappedLines: Array<number | undefined> = [];
  let previousSourceIndex = -1;
  for (const line of draftLines) {
    const sourceIndex = sourcePositions
      .get(line)
      ?.find((index) => index > previousSourceIndex);
    mappedLines.push(sourceIndex);
    if (sourceIndex !== undefined) previousSourceIndex = sourceIndex;
  }
  const fallbackSeparator =
    fallback === "crlf" ? "\r\n" : fallback === "cr" ? "\r" : "\n";
  let index = 0;
  return normalized.replace(/\n/g, () => {
    const sourceIndex = mappedLines[index++];
    return sourceIndex === undefined
      ? fallbackSeparator
      : (sourceLineEndings[sourceIndex] ?? fallbackSeparator);
  });
};

function KindIcon({ kind }: { kind?: string }) {
  if (kind === "image") return <Image />;
  if (kind === "video") return <Video />;
  if (kind === "audio") return <Music />;
  if (kind === "pdf") return <FileText />;
  if (kind === "text" || kind === "subtitle") return <FileText />;
  return <FileQuestion />;
}

export function PreviewViewer({
  file,
  onNavigate,
  onClose,
  onDownload,
  onChanged,
  onMessage,
  source = "active",
  openDetails = false,
}: {
  file: Pick<VaultFile, "id" | "name">;
  onNavigate: (file: PreviewSibling) => void;
  onClose: () => void;
  onDownload: (file: Pick<VaultFile, "id" | "name">) => void;
  onChanged: () => Promise<void> | void;
  onMessage: (message: string) => void;
  source?: "active" | "trash";
  openDetails?: boolean;
}) {
  const readOnly = source === "trash";
  const [preview, setPreview] = useState<FilePreview>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [text, setText] = useState("");
  const [draft, setDraft] = useState("");
  const [encoding, setEncoding] = useState("utf-8");
  const [hasBom, setHasBom] = useState(false);
  const [savedBom, setSavedBom] = useState(false);
  const [lineEnding, setLineEnding] = useState<LineEnding>("lf");
  const [sourceLineEndings, setSourceLineEndings] = useState<LineSeparator[]>(
    [],
  );
  const [etag, setEtag] = useState("");
  const [textLoading, setTextLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [playlistOpen, setPlaylistOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(openDetails);
  const [subtitleId, setSubtitleId] = useState("");
  const [subtitleEncoding, setSubtitleEncoding] = useState("auto");
  const [detectedSubtitleEncoding, setDetectedSubtitleEncoding] = useState("");
  const [subtitleSource, setSubtitleSource] = useState<{
    name: string;
    text: string;
  }>();
  const [subtitleCues, setSubtitleCues] = useState<SubtitleCue[]>([]);
  const [subtitleError, setSubtitleError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [vttUrl, setVttUrl] = useState("");
  const [viewerNotice, setViewerNotice] = useState("");
  const requestSequence = useRef(0);
  const textRequestSequence = useRef(0);
  const currentFileId = useRef(file.id);
  const dialogRef = useRef<HTMLElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const playlistToggleRef = useRef<HTMLButtonElement>(null);
  const detailsToggleRef = useRef<HTMLButtonElement>(null);
  const mediaRef = useRef<HTMLMediaElement>(null);
  currentFileId.current = file.id;
  const dirty = editing && (draft !== text || hasBom !== savedBom);
  const notify = (message: string) => {
    setViewerNotice(message);
    onMessage(message);
  };

  const loadText = async (
    fileId: string,
    requestedEncoding: string,
    offerRecovery = false,
  ) => {
    const sequence = ++textRequestSequence.current;
    setTextLoading(true);
    setError("");
    try {
      const result = await (readOnly
        ? api.trashFileText(fileId, requestedEncoding)
        : api.fileText(fileId, requestedEncoding));
      if (
        sequence !== textRequestSequence.current ||
        currentFileId.current !== fileId
      )
        return;
      const detectedLineEnding = detectLineEnding(result.text);
      const normalized = normalizeLineEndings(result.text);
      const loadedHasBom = result.encoding.startsWith("utf-") && result.hasBom;
      const recovery = offerRecovery
        ? recoveredTextDrafts.get(fileId)
        : undefined;
      const canRecover =
        recovery?.etag === result.etag && recovery.encoding === result.encoding;
      const restore = Boolean(
        canRecover &&
          window.confirm(
            "로그인 만료로 보존된 저장 전 텍스트가 있습니다. 편집 내용을 복원할까요?",
          ),
      );
      if (recovery && !restore) recoveredTextDrafts.delete(fileId);
      setText(normalized);
      setDraft(restore ? normalizeLineEndings(recovery!.draft) : normalized);
      setLineEnding(detectedLineEnding);
      setSourceLineEndings(extractLineEndings(result.text));
      setEncoding(result.encoding);
      setHasBom(restore ? recovery!.hasBom : loadedHasBom);
      setSavedBom(loadedHasBom);
      setEtag(result.etag);
      setEditing(restore);
      if (restore) notify("저장 전 편집 내용을 복원했습니다.");
    } catch (value) {
      if (
        sequence === textRequestSequence.current &&
        currentFileId.current === fileId
      )
        setError(
          value instanceof Error ? value.message : "텍스트를 읽지 못했습니다.",
        );
    } finally {
      if (
        sequence === textRequestSequence.current &&
        currentFileId.current === fileId
      )
        setTextLoading(false);
    }
  };

  useEffect(() => {
    setDetailsOpen(openDetails);
  }, [file.id, openDetails]);
  useEffect(() => {
    const sequence = ++requestSequence.current;
    textRequestSequence.current += 1;
    setLoading(true);
    setError("");
    setMediaError("");
    setPreview(undefined);
    setText("");
    setDraft("");
    setEditing(false);
    setSaving(false);
    setSavedBom(false);
    setSourceLineEndings([]);
    setSubtitleId("");
    setSubtitleEncoding("auto");
    setDetectedSubtitleEncoding("");
    setSubtitleSource(undefined);
    setSubtitleCues([]);
    setCurrentTime(0);
    setDuration(0);
    setViewerNotice("");
    void api
      [readOnly ? "trashFilePreview" : "filePreview"](file.id)
      .then(async (result) => {
        if (sequence !== requestSequence.current) return;
        setPreview(result);
        if (result.file.kind === "text" || result.file.kind === "subtitle") {
          const recovery = recoveredTextDrafts.get(file.id);
          await loadText(
            file.id,
            recovery?.encoding ?? result.file.encoding ?? "auto",
            true,
          );
        }
        if (sequence !== requestSequence.current) return;
        setSubtitleId(
          result.file.kind === "video" || result.file.kind === "audio"
            ? (result.subtitles[0]?.id ?? "")
            : "",
        );
      })
      .catch((value) => {
        if (sequence === requestSequence.current)
          setError(
            value instanceof Error
              ? value.message
              : "파일을 미리 볼 수 없습니다.",
          );
      })
      .finally(() => {
        if (sequence === requestSequence.current) setLoading(false);
      });
  }, [file.id]);

  useEffect(() => {
    if (!etag) return;
    if (dirty)
      recoveredTextDrafts.set(file.id, { draft, encoding, hasBom, etag });
    else if (editing) recoveredTextDrafts.delete(file.id);
  }, [dirty, draft, editing, encoding, etag, file.id, hasBom]);

  const subtitleFiles =
    preview?.siblings.filter((entry) => entry.kind === "subtitle") ?? [];
  useEffect(() => {
    if (!subtitleId || !preview) {
      setSubtitleCues([]);
      setSubtitleSource(undefined);
      setDetectedSubtitleEncoding("");
      setSubtitleError("");
      return;
    }
    const selected = subtitleFiles.find((entry) => entry.id === subtitleId);
    if (!selected) return;
    let active = true;
    setSubtitleSource(undefined);
    setSubtitleCues([]);
    setDetectedSubtitleEncoding("");
    setSubtitleError("");
    void api
      [readOnly ? "trashFileText" : "fileText"](selected.id, subtitleEncoding)
      .then((result) => {
        if (!active) return;
        setDetectedSubtitleEncoding(result.encoding);
        setSubtitleSource({ name: selected.name, text: result.text });
      })
      .catch((value) => {
        if (active) {
          setSubtitleSource(undefined);
          setSubtitleCues([]);
          setSubtitleError(
            value instanceof Error ? value.message : "자막을 읽지 못했습니다.",
          );
        }
      });
    return () => {
      active = false;
    };
  }, [subtitleId, subtitleEncoding, preview?.file.id]);

  useEffect(() => {
    if (!subtitleSource) return;
    const cues = parseSubtitles(
      subtitleSource.name,
      subtitleSource.text,
      duration,
    );
    setSubtitleCues(cues);
    setSubtitleError(
      cues.length ? "" : "자막 시간 정보를 해석하지 못했습니다.",
    );
  }, [subtitleSource, duration]);

  useEffect(() => {
    if (!subtitleCues.length) {
      setVttUrl("");
      return;
    }
    const url = URL.createObjectURL(
      new Blob([cuesToWebVtt(subtitleCues)], { type: "text/vtt" }),
    );
    setVttUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [subtitleCues]);

  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  const playlist =
    preview?.file.kind === "unsupported"
      ? []
      : (preview?.siblings.filter((entry) =>
          mediaKind(preview.file.kind)
            ? mediaKind(entry.kind)
            : preview.file.kind === "pdf"
              ? entry.kind === "pdf"
              : entry.kind === "text" || entry.kind === "subtitle",
        ) ?? []);
  const currentIndex = playlist.findIndex((entry) => entry.id === file.id);
  const previous = currentIndex > 0 ? playlist[currentIndex - 1] : undefined;
  const next =
    currentIndex >= 0 && currentIndex < playlist.length - 1
      ? playlist[currentIndex + 1]
      : undefined;
  const nextPlayable =
    currentIndex >= 0
      ? playlist
          .slice(currentIndex + 1)
          .find((entry) => entry.kind === "video" || entry.kind === "audio")
      : undefined;

  const confirmLeave = () => {
    if (saving) {
      notify("저장이 끝난 뒤 이동하거나 닫을 수 있습니다.");
      return false;
    }
    if (!dirty) return true;
    const confirmed = window.confirm("저장하지 않은 수정 내용을 버릴까요?");
    if (confirmed) recoveredTextDrafts.delete(file.id);
    return confirmed;
  };
  const navigate = (target?: PreviewSibling) => {
    if (target && confirmLeave()) onNavigate(target);
  };
  const close = () => {
    if (confirmLeave()) onClose();
  };

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    const backdrop = backdropRef.current;
    const siblings = backdrop
      ? Array.from(backdrop.parentElement?.children ?? []).filter(
          (element): element is HTMLElement =>
            element instanceof HTMLElement && element !== backdrop,
        )
      : [];
    const previousState = siblings.map((element) => ({
      element,
      inert: element.hasAttribute("inert"),
      ariaHidden: element.getAttribute("aria-hidden"),
    }));
    for (const sibling of siblings) {
      sibling.setAttribute("inert", "");
      sibling.setAttribute("aria-hidden", "true");
    }
    window.requestAnimationFrame(() => closeButtonRef.current?.focus());
    return () => {
      for (const state of previousState) {
        if (!state.inert) state.element.removeAttribute("inert");
        if (state.ariaHidden === null)
          state.element.removeAttribute("aria-hidden");
        else state.element.setAttribute("aria-hidden", state.ariaHidden);
      }
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector<HTMLElement>("[data-select-key]")?.focus();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "Tab" && dialogRef.current) {
        const focusable = Array.from(
          dialogRef.current.querySelectorAll<HTMLElement>(
            'button:not(:disabled),a[href],textarea:not(:disabled),input:not(:disabled),select:not(:disabled),video[controls],audio[controls],[tabindex]:not([tabindex="-1"])',
          ),
        );
        if (focusable.length) {
          const first = focusable[0]!;
          const last = focusable.at(-1)!;
          if (!dialogRef.current.contains(document.activeElement)) {
            event.preventDefault();
            (event.shiftKey ? last : first).focus();
          } else if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
        return;
      }
      const target = event.target as HTMLElement;
      if (target.closest("textarea,input,select,video,audio,button")) return;
      if (event.key === "ArrowLeft") navigate(previous);
      if (event.key === "ArrowRight") navigate(next);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  const changeEncoding = async (nextEncoding: string) => {
    if (
      dirty &&
      !window.confirm("수정 내용을 버리고 다른 인코딩으로 다시 읽을까요?")
    )
      return;
    recoveredTextDrafts.delete(file.id);
    setEditing(false);
    await loadText(file.id, nextEncoding);
  };

  const save = async () => {
    if (!etag || saving || textLoading) return;
    const savedFileId = file.id;
    const savedDraft = draft;
    const savedEncoding = encoding;
    const savedHasBom = hasBom;
    const savedEtag = etag;
    const savedBody = applyLineEndings(
      savedDraft,
      text,
      sourceLineEndings,
      lineEnding,
    );
    setSaving(true);
    try {
      const result = await api.saveFileText(
        savedFileId,
        savedBody,
        savedEncoding,
        savedHasBom,
        savedEtag,
      );
      if (currentFileId.current !== savedFileId) return;
      setText(savedDraft);
      setDraft(savedDraft);
      setSavedBom(savedHasBom);
      setSourceLineEndings(extractLineEndings(savedBody));
      setLineEnding(detectLineEnding(savedBody));
      setEtag(result.etag);
      setEditing(false);
      recoveredTextDrafts.delete(savedFileId);
      setPreview((current) =>
        current
          ? {
              ...current,
              file: {
                ...current.file,
                ...result.file,
                kind: current.file.kind,
                encoding: savedEncoding,
                hasBom: savedHasBom,
              },
            }
          : current,
      );
      await onChanged();
      notify(
        `${encodingLabels[savedEncoding] ?? savedEncoding} 인코딩으로 저장했습니다.`,
      );
    } catch (value) {
      notify(
        value instanceof Error ? value.message : "텍스트 저장에 실패했습니다.",
      );
    } finally {
      if (currentFileId.current === savedFileId) setSaving(false);
    }
  };

  const mediaFailed = () => {
    const message =
      "이 브라우저가 파일 형식 또는 내부 코덱을 재생하지 못합니다. 원본을 다운로드해 확인하세요.";
    setMediaError(message);
  };
  const activeCues = subtitleCues.filter(
    (cue) => currentTime >= cue.start && currentTime < cue.end,
  );
  const seek = (cue: SubtitleCue) => {
    if (!mediaRef.current) return;
    mediaRef.current.currentTime = cue.start;
    void mediaRef.current.play().catch(() => undefined);
  };

  return (
    <div
      ref={backdropRef}
      className="preview-backdrop"
      role="presentation"
      onMouseDown={close}
    >
      <section
        ref={dialogRef}
        className={`preview-dialog ${viewerNotice ? "has-notice" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={`${file.name} 미리보기`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="preview-header">
          <div className="preview-title">
            <KindIcon kind={preview?.file.kind} />
            <span>
              <strong>{preview?.file.name ?? file.name}</strong>
              <small>
                {preview
                  ? `${formatBytes(preview.file.sizeBytes)} · ${preview.file.mimeType}`
                  : "파일 불러오는 중"}
              </small>
            </span>
          </div>
          <div className="preview-actions">
            <button
              className="icon-action"
              title="이전 파일"
              aria-label="이전 파일"
              disabled={!previous || saving}
              onClick={() => navigate(previous)}
            >
              <ChevronLeft />
            </button>
            <button
              className="icon-action"
              title="다음 파일"
              aria-label="다음 파일"
              disabled={!next || saving}
              onClick={() => navigate(next)}
            >
              <ChevronRight />
            </button>
            <button
              ref={playlistToggleRef}
              className={`secondary compact preview-list-toggle ${playlistOpen ? "active" : ""}`}
              aria-label={playlistOpen ? "파일 목록 닫기" : "파일 목록 열기"}
              aria-expanded={playlistOpen}
              disabled={saving}
              onClick={() => {
                setDetailsOpen(false);
                setPlaylistOpen((value) => !value);
              }}
            >
              <List />
              <span>목록</span>
            </button>
            <button
              ref={detailsToggleRef}
              className={`secondary compact preview-detail-toggle ${detailsOpen ? "active" : ""}`}
              aria-label={detailsOpen ? "파일 상세정보 닫기" : "파일 상세정보 열기"}
              aria-expanded={detailsOpen}
              disabled={!preview || saving}
              onClick={() => {
                setPlaylistOpen(false);
                setDetailsOpen((value) => !value);
              }}
            >
              <Info />
              <span>상세정보</span>
            </button>
            <button
              className="secondary compact preview-download"
              aria-label="원본 다운로드"
              onClick={() => onDownload(preview?.file ?? file)}
            >
              <Download />
              <span>원본 다운로드</span>
            </button>
            <button
              ref={closeButtonRef}
              className="icon-action"
              title="닫기"
              aria-label="미리보기 닫기"
              onClick={close}
            >
              <X />
            </button>
          </div>
        </header>
        {viewerNotice && (
          <div className="preview-notice" role="status" aria-live="polite">
            {viewerNotice}
          </div>
        )}
        <div
          className={`preview-body ${playlistOpen || detailsOpen ? "with-playlist" : ""}`}
        >
          <main className="preview-main">
            {loading ? (
              <div className="preview-state">
                <LoaderCircle className="spin" />
                <span>미리보기를 준비하고 있습니다.</span>
              </div>
            ) : error ? (
              <div className="preview-state error-state">
                <FileQuestion />
                <strong>파일을 열 수 없습니다</strong>
                <span>{error}</span>
              </div>
            ) : preview?.file.kind === "image" ? (
              <div className="preview-media-stage">
                {mediaError ? (
                  <div className="preview-state error-state">
                    <Image />
                    <strong>이미지를 표시할 수 없습니다</strong>
                    <span>{mediaError}</span>
                  </div>
                ) : (
                  <img
                    className="preview-image"
                    src={preview.file.streamUrl}
                    alt={preview.file.name}
                    onError={mediaFailed}
                  />
                )}
              </div>
            ) : preview?.file.kind === "video" ? (
              <div className="preview-media-stage">
                {mediaError ? (
                  <div className="preview-state error-state">
                    <Video />
                    <strong>동영상을 재생할 수 없습니다</strong>
                    <span>{mediaError}</span>
                  </div>
                ) : (
                  <video
                    ref={(node) => {
                      mediaRef.current = node;
                    }}
                    className="preview-video"
                    src={preview.file.streamUrl}
                    controls
                    autoPlay
                    playsInline
                    onError={mediaFailed}
                    onTimeUpdate={(event) =>
                      setCurrentTime(event.currentTarget.currentTime)
                    }
                    onLoadedMetadata={(event) =>
                      setDuration(event.currentTarget.duration || 0)
                    }
                    onEnded={() => navigate(nextPlayable)}
                  >
                    {vttUrl && (
                      <track
                        key={vttUrl}
                        kind="subtitles"
                        src={vttUrl}
                        srcLang="und"
                        label={subtitleSource?.name ?? "자막"}
                        default
                      />
                    )}
                  </video>
                )}
              </div>
            ) : preview?.file.kind === "audio" ? (
              <div
                className={`preview-audio-layout ${subtitleCues.length ? "with-transcript" : ""}`}
              >
                <div className="preview-audio-stage">
                  <Music />
                  <strong>{preview.file.name}</strong>
                  {mediaError ? (
                    <p>{mediaError}</p>
                  ) : (
                    <audio
                      ref={(node) => {
                        mediaRef.current = node;
                      }}
                      src={preview.file.streamUrl}
                      controls
                      autoPlay
                      onError={mediaFailed}
                      onTimeUpdate={(event) =>
                        setCurrentTime(event.currentTarget.currentTime)
                      }
                      onLoadedMetadata={(event) =>
                        setDuration(event.currentTarget.duration || 0)
                      }
                      onEnded={() => navigate(nextPlayable)}
                    />
                  )}
                  {!!activeCues.length && (
                    <div
                      className="audio-current-caption"
                      role="status"
                      aria-live="polite"
                    >
                      {activeCues.map((cue) => (
                        <span key={cue.id}>{cue.text}</span>
                      ))}
                    </div>
                  )}
                </div>
                {!!subtitleCues.length && (
                  <div className="subtitle-transcript">
                    {subtitleCues.map((cue) => (
                      <button
                        key={cue.id}
                        className={
                          activeCues.some((active) => active.id === cue.id)
                            ? "active"
                            : ""
                        }
                        onClick={() => seek(cue)}
                      >
                        <time>
                          {Math.floor(cue.start / 60)}:
                          {String(Math.floor(cue.start % 60)).padStart(2, "0")}
                        </time>
                        <span>{cue.text}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : preview?.file.kind === "pdf" ? (
              <div className="preview-pdf-wrap">
                <iframe
                  className="preview-pdf"
                  src={preview.file.streamUrl}
                  title={`${preview.file.name} PDF 미리보기`}
                  sandbox="allow-downloads"
                />
                <button
                  className="secondary compact pdf-fallback"
                  onClick={() => onDownload(preview.file)}
                >
                  <Download />
                  PDF가 보이지 않으면 원본 다운로드
                </button>
              </div>
            ) : preview?.file.kind === "text" ||
              preview?.file.kind === "subtitle" ? (
              <div className="preview-text-layout">
                <div className="text-toolbar">
                  <label>
                    인코딩
                    <select
                      value={encoding}
                      disabled={textLoading || saving}
                      onChange={(event) =>
                        void changeEncoding(event.target.value)
                      }
                    >
                      {(preview.encodings ?? Object.keys(encodingLabels)).map(
                        (value) => (
                          <option value={value} key={value}>
                            {encodingLabels[value] ?? value}
                          </option>
                        ),
                      )}
                    </select>
                  </label>
                  <label className="bom-control">
                    <input
                      type="checkbox"
                      checked={hasBom}
                      disabled={
                        readOnly || !encoding.startsWith("utf-") || !editing || saving
                      }
                      onChange={(event) => setHasBom(event.target.checked)}
                    />
                    BOM 포함
                  </label>
                  <span className="text-size-note">
                    {readOnly ? "휴지통 파일은 읽기 전용 · " : "저장은 서버 한도와 할당량 적용 · "}
                    미리보기 별도 제한 없음 ·
                    큰 파일은 브라우저 메모리에 따라 느릴 수 있음
                  </span>
                  {!readOnly && (editing ? (
                    <>
                      <button
                        className="secondary compact"
                        disabled={saving}
                        onClick={() => {
                          if (
                            !dirty ||
                            window.confirm("수정 내용을 취소할까요?")
                          ) {
                            setDraft(text);
                            setHasBom(savedBom);
                            setEditing(false);
                            recoveredTextDrafts.delete(file.id);
                          }
                        }}
                      >
                        취소
                      </button>
                      <button
                        className="primary compact"
                        disabled={!dirty || saving || textLoading}
                        onClick={() => void save()}
                      >
                        <Save />
                        {saving ? "저장 중" : "저장"}
                      </button>
                    </>
                  ) : (
                    <button
                      className="secondary compact"
                      disabled={textLoading}
                      onClick={() => setEditing(true)}
                    >
                      <Pencil />
                      수정
                    </button>
                   ))}
                </div>
                {textLoading ? (
                  <div className="preview-state">
                    <LoaderCircle className="spin" />
                    <span>선택한 인코딩으로 읽는 중입니다.</span>
                  </div>
                ) : editing ? (
                  <textarea
                    className="preview-editor"
                    aria-label={`${preview.file.name} 텍스트 편집`}
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    readOnly={saving}
                    spellCheck={false}
                    autoFocus
                  />
                ) : (
                  <pre className="preview-text">{text}</pre>
                )}
              </div>
            ) : (
              <div className="preview-state">
                <FileQuestion />
                <strong>사이트에서 미리 볼 수 없는 형식입니다</strong>
                <span>
                  브라우저가 지원하지 않는 파일입니다. 원본 다운로드를
                  이용하세요.
                </span>
              </div>
            )}
          </main>
          {playlistOpen && preview && (
            <aside className="preview-playlist">
              <div className="playlist-heading">
                <div>
                  <span>같은 폴더</span>
                  <strong>{playlist.length}개 미리보기 항목</strong>
                </div>
                <button
                  className="icon-action"
                  title="파일 목록 닫기"
                  aria-label="파일 목록 닫기"
                  onClick={() => {
                    setPlaylistOpen(false);
                    window.requestAnimationFrame(() =>
                      playlistToggleRef.current?.focus(),
                    );
                  }}
                >
                  <X />
                </button>
              </div>
              {(preview.file.kind === "video" ||
                preview.file.kind === "audio") && (
                <div className="subtitle-controls">
                  <label>
                    <Subtitles />
                    자막
                    <select
                      value={subtitleId}
                      onChange={(event) => {
                        setSubtitleEncoding("auto");
                        setSubtitleId(event.target.value);
                      }}
                    >
                      <option value="">자막 없음</option>
                      {subtitleFiles.map((entry) => (
                        <option value={entry.id} key={entry.id}>
                          {entry.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {subtitleId && (
                    <label>
                      자막 인코딩
                      <select
                        value={subtitleEncoding}
                        onChange={(event) =>
                          setSubtitleEncoding(event.target.value)
                        }
                      >
                        <option value="auto">자동 감지</option>
                        {(preview.encodings ?? []).map((value) => (
                          <option value={value} key={value}>
                            {encodingLabels[value] ?? value}
                          </option>
                        ))}
                      </select>
                      {detectedSubtitleEncoding &&
                        subtitleEncoding === "auto" && (
                          <small className="subtitle-encoding-detected">
                            감지:{" "}
                            {encodingLabels[detectedSubtitleEncoding] ??
                              detectedSubtitleEncoding}
                          </small>
                        )}
                    </label>
                  )}
                  {subtitleError && <small role="alert">{subtitleError}</small>}
                </div>
              )}
              <div className="playlist-list">
                {playlist.map((entry) => (
                  <button
                    className={entry.id === file.id ? "active" : ""}
                    key={entry.id}
                    disabled={saving}
                    onClick={() => navigate(entry)}
                  >
                    <span className="playlist-kind">
                      <KindIcon kind={entry.kind} />
                    </span>
                    <span>
                      <strong>{entry.name}</strong>
                      <small>{formatBytes(entry.sizeBytes)}</small>
                    </span>
                  </button>
                ))}
              </div>
              <dl className="preview-mini-facts">
                <div>
                  <dt>SHA-256</dt>
                  <dd>{preview.file.sha256}</dd>
                </div>
                <div>
                  <dt>저장 경로</dt>
                  <dd>{preview.file.relativePath}</dd>
                </div>
              </dl>
            </aside>
          )}
          {detailsOpen && preview && (
            <aside className="preview-playlist preview-details-panel">
              <div className="playlist-heading">
                <div>
                  <span>원본 파일</span>
                  <strong>상세정보와 메타데이터</strong>
                </div>
                <button
                  className="icon-action"
                  title="상세정보 닫기"
                  aria-label="파일 상세정보 닫기"
                  onClick={() => {
                    setDetailsOpen(false);
                    window.requestAnimationFrame(() =>
                      detailsToggleRef.current?.focus(),
                    );
                  }}
                >
                  <X />
                </button>
              </div>
              <div className="preview-details-scroll">
                <dl className="preview-detail-facts">
                  <div>
                    <dt>파일명</dt>
                    <dd>{preview.file.name}</dd>
                  </div>
                  <div>
                    <dt>파일 형식</dt>
                    <dd>{preview.file.mimeType}</dd>
                  </div>
                  <div>
                    <dt>크기</dt>
                    <dd>{formatBytes(preview.file.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt>보관 경로</dt>
                    <dd>{preview.file.relativePath}</dd>
                  </div>
                  <div>
                    <dt>저장 파일명</dt>
                    <dd>{preview.file.storedName}</dd>
                  </div>
                  <div>
                    <dt>원본 생성 일시</dt>
                    <dd>{previewDetailDate(preview.file.originalCreatedAt)}</dd>
                  </div>
                  <div>
                    <dt>원본 수정 일시</dt>
                    <dd>
                      {previewDetailDate(preview.file.originalModifiedAt)}
                    </dd>
                  </div>
                  <div>
                    <dt>최근 변경 일시</dt>
                    <dd>{previewDetailDate(preview.file.modifiedAt)}</dd>
                  </div>
                  <div>
                    <dt>SHA-256</dt>
                    <dd className="preview-detail-hash">
                      {preview.file.sha256}
                    </dd>
                  </div>
                </dl>
                <h3>추출된 메타데이터</h3>
                {Object.keys(preview.file.metadata ?? {}).length ? (
                  <dl className="preview-detail-metadata">
                    {Object.entries(preview.file.metadata).map(
                      ([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{previewDetailValue(value)}</dd>
                        </div>
                      ),
                    )}
                  </dl>
                ) : (
                  <p className="preview-detail-empty">
                    추출된 메타데이터가 없습니다.
                  </p>
                )}
              </div>
            </aside>
          )}
        </div>
      </section>
    </div>
  );
}
