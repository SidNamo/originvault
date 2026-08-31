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
  Video,
  X,
} from "lucide-react";
import { api, type PublicShareFile } from "./api";
import { formatBytes } from "./format";

const encodings = [
  "utf-8",
  "utf-16le",
  "utf-16be",
  "euc-kr",
  "cp949",
  "shift_jis",
  "euc-jp",
  "gb18030",
  "big5",
  "windows-1252",
  "iso-8859-1",
];

const detailDate = (value?: string | null) =>
  value ? new Date(value).toLocaleString("ko-KR") : "알 수 없음";

function KindIcon({ kind }: { kind: PublicShareFile["kind"] }) {
  if (kind === "image") return <Image />;
  if (kind === "video") return <Video />;
  if (kind === "audio") return <Music />;
  if (kind === "pdf" || kind === "text" || kind === "subtitle")
    return <FileText />;
  return <FileQuestion />;
}

export function PublicPreviewViewer({
  token,
  file,
  files,
  onNavigate,
  onClose,
  onDownload,
}: {
  token: string;
  file: PublicShareFile;
  files: PublicShareFile[];
  onNavigate: (file: PublicShareFile) => void;
  onClose: () => void;
  onDownload: (file: PublicShareFile) => void;
}) {
  const [text, setText] = useState("");
  const [encoding, setEncoding] = useState("auto");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [playlistOpen, setPlaylistOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const closeButton = useRef<HTMLButtonElement>(null);
  const previewable = files.filter((item) => item.kind !== "unsupported");
  const index = previewable.findIndex((item) => item.id === file.id);
  const previous = index > 0 ? previewable[index - 1] : undefined;
  const next = index >= 0 ? previewable[index + 1] : undefined;
  const textLike = file.kind === "text" || file.kind === "subtitle";
  useEffect(() => {
    window.requestAnimationFrame(() => closeButton.current?.focus());
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.target instanceof HTMLElement && event.target.closest("select,button"))
        return;
      if (event.key === "ArrowLeft" && previous) onNavigate(previous);
      if (event.key === "ArrowRight" && next) onNavigate(next);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [file.id, next, onClose, onNavigate, previous]);
  useEffect(() => {
    if (!textLike) return;
    let active = true;
    setLoading(true);
    setError("");
    setText("");
    void api
      .publicShareText(token, file.id, encoding)
      .then((result) => {
        if (active) {
          setText(result.text);
          if (encoding === "auto") setEncoding(result.encoding);
        }
      })
      .catch((value) => {
        if (active)
          setError(value instanceof Error ? value.message : "텍스트를 읽지 못했습니다.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [encoding, file.id, textLike, token]);
  const streamUrl = api.publicSharePreviewUrl(token, file.id);
  return (
    <div className="preview-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="preview-dialog public-preview-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={`${file.name} 미리보기`}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="preview-header">
          <div className="preview-title">
            <KindIcon kind={file.kind} />
            <span>
              <strong>{file.name}</strong>
              <small>{formatBytes(file.sizeBytes)} · {file.mimeType}</small>
            </span>
          </div>
          <div className="preview-actions">
            <button className="icon-action" aria-label="이전 파일" disabled={!previous} onClick={() => previous && onNavigate(previous)}>
              <ChevronLeft />
            </button>
            <button className="icon-action" aria-label="다음 파일" disabled={!next} onClick={() => next && onNavigate(next)}>
              <ChevronRight />
            </button>
            <button
              className={`secondary compact preview-list-toggle ${playlistOpen ? "active" : ""}`}
              aria-label={playlistOpen ? "파일 목록 닫기" : "파일 목록 열기"}
              aria-expanded={playlistOpen}
              onClick={() => {
                setDetailsOpen(false);
                setPlaylistOpen((value) => !value);
              }}
            >
              <List />
              <span>목록</span>
            </button>
            <button
              className={`secondary compact preview-detail-toggle ${detailsOpen ? "active" : ""}`}
              aria-label={detailsOpen ? "파일 상세정보 닫기" : "파일 상세정보 열기"}
              aria-expanded={detailsOpen}
              onClick={() => {
                setPlaylistOpen(false);
                setDetailsOpen((value) => !value);
              }}
            >
              <Info />
              <span>상세정보</span>
            </button>
            <button className="secondary compact preview-download" onClick={() => onDownload(file)}>
              <Download />
              <span>원본 다운로드</span>
            </button>
            <button ref={closeButton} className="icon-action" aria-label="미리보기 닫기" onClick={onClose}>
              <X />
            </button>
          </div>
        </header>
        <div className={`preview-body ${playlistOpen || detailsOpen ? "with-playlist" : ""}`}>
          <main className="preview-main">
            {file.kind === "image" ? (
              <div className="preview-media-stage"><img className="preview-image" src={streamUrl} alt={file.name} /></div>
            ) : file.kind === "video" ? (
              <div className="preview-media-stage"><video className="preview-video" src={streamUrl} controls autoPlay playsInline /></div>
            ) : file.kind === "audio" ? (
              <div className="preview-audio-stage"><Music /><strong>{file.name}</strong><audio src={streamUrl} controls autoPlay /></div>
            ) : file.kind === "pdf" ? (
              <div className="preview-pdf-wrap"><iframe className="preview-pdf" src={streamUrl} title={`${file.name} PDF 미리보기`} sandbox="allow-downloads" /></div>
            ) : textLike ? (
              <div className="preview-text-layout">
                <div className="text-toolbar">
                  <label>
                    인코딩
                    <select value={encoding} disabled={loading} onChange={(event) => setEncoding(event.target.value)}>
                      <option value="auto">자동 감지</option>
                      {encodings.map((value) => <option value={value} key={value}>{value}</option>)}
                    </select>
                  </label>
                </div>
                {loading ? (
                  <div className="preview-state"><LoaderCircle className="spin" /><span>텍스트를 읽는 중입니다.</span></div>
                ) : error ? (
                  <div className="preview-state error-state"><FileQuestion /><strong>텍스트를 열 수 없습니다</strong><span>{error}</span></div>
                ) : <pre className="preview-text public-preview-text">{text}</pre>}
              </div>
            ) : (
              <div className="preview-state"><FileQuestion /><strong>미리보기를 지원하지 않는 형식입니다</strong><span>원본 다운로드로 확인하세요.</span></div>
            )}
          </main>
          {playlistOpen && <aside className="preview-playlist">
            <div className="playlist-heading">
              <div><span>같은 폴더</span><strong>{previewable.length}개 미리보기 항목</strong></div>
              <button className="icon-action" title="파일 목록 닫기" aria-label="파일 목록 닫기" onClick={() => setPlaylistOpen(false)}><X /></button>
            </div>
            <div className="playlist-list">
              {previewable.map((entry) => <button className={entry.id === file.id ? "active" : ""} key={entry.id} onClick={() => onNavigate(entry)}>
                <span className="playlist-kind"><KindIcon kind={entry.kind} /></span>
                <span><strong>{entry.name}</strong><small>{formatBytes(entry.sizeBytes)}</small></span>
              </button>)}
            </div>
            <dl className="preview-mini-facts"><div><dt>SHA-256</dt><dd>{file.sha256}</dd></div></dl>
          </aside>}
          {detailsOpen && <aside className="preview-playlist preview-details-panel">
            <div className="playlist-heading">
              <div><span>공유 파일</span><strong>상세정보</strong></div>
              <button className="icon-action" title="상세정보 닫기" aria-label="파일 상세정보 닫기" onClick={() => setDetailsOpen(false)}><X /></button>
            </div>
            <div className="preview-details-scroll">
              <dl className="preview-detail-facts">
                <div><dt>파일명</dt><dd>{file.name}</dd></div>
                <div><dt>파일 형식</dt><dd>{file.mimeType}</dd></div>
                <div><dt>크기</dt><dd>{formatBytes(file.sizeBytes)}</dd></div>
                <div><dt>원본 생성 일시</dt><dd>{detailDate(file.originalCreatedAt)}</dd></div>
                <div><dt>원본 수정 일시</dt><dd>{detailDate(file.clientLastModified)}</dd></div>
                <div><dt>최근 변경 일시</dt><dd>{detailDate(file.modifiedAt)}</dd></div>
                <div><dt>SHA-256</dt><dd className="preview-detail-hash">{file.sha256}</dd></div>
              </dl>
            </div>
          </aside>}
        </div>
      </section>
    </div>
  );
}
