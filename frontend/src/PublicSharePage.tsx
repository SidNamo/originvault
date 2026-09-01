import { useEffect, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  Download,
  Eye,
  File,
  FileImage,
  FileVideo,
  Folder,
  Info,
  Link2,
  MoreHorizontal,
  Package,
  ShieldCheck,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  api,
  type BulkSelection,
  type PublicShare,
  type PublicShareFile,
  type PublicShareFolder,
  type PublicShareFolderDetail,
} from "./api";
import { formatBytes } from "./format";
import { PublicPreviewViewer } from "./PublicPreviewViewer";
import { ListingControls, type ListingSortDirection, type ListingSortField, type ListingViewMode } from "./ListingControls";
import { LazyFileThumbnail } from "./LazyFileThumbnail";

type PublicItem =
  | { type: "file"; item: PublicShareFile }
  | { type: "folder"; item: PublicShareFolder };
type PublicDetail = PublicShareFile | PublicShareFolderDetail;

const itemKey = (type: PublicItem["type"], id: string) => `${type}:${id}`;
const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString("ko-KR") : "-";

export function PublicSharePage({ token }: { token: string }) {
  const [share, setShare] = useState<PublicShare>();
  const [history, setHistory] = useState<PublicShareFolder[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [password, setPassword] = useState("");
  const [unlocking, setUnlocking] = useState(false);
  const [sortField, setSortField] = useState<ListingSortField>(() => {
    const saved = localStorage.getItem("originvault.sortField.v3");
    return saved === "name" || saved === "kind" || saved === "size" || saved === "originalCreated" || saved === "originalModified" ? saved : "originalCreated";
  });
  const [sortDirection, setSortDirection] = useState<ListingSortDirection>(() => localStorage.getItem("originvault.sortDirection.v3") === "asc" ? "asc" : "desc");
  const [viewMode, setViewMode] = useState<ListingViewMode>(() => {
    const saved = localStorage.getItem("originvault.viewMode");
    return saved === "details" || saved === "grid-2" || saved === "grid-3" || saved === "preview" ? saved : "details";
  });
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>();
  const [marqueeSelecting, setMarqueeSelecting] = useState(false);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    item?: PublicItem;
  }>();
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [detailTarget, setDetailTarget] = useState<PublicItem>();
  const [detail, setDetail] = useState<PublicDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [previewFile, setPreviewFile] = useState<PublicShareFile>();
  const gridRef = useRef<HTMLDivElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const selectionAnchor = useRef<string | undefined>(undefined);
  const dragSelection = useRef<
    | {
        pointerId: number;
        startX: number;
        startY: number;
        base: Set<string>;
        dragging: boolean;
      }
    | undefined
  >(undefined);
  const suppressCardClick = useRef(false);

  const folders = share?.folders ?? [];
  const files = share?.files ?? (share?.file ? [share.file] : []);
  const directionFactor = sortDirection === "asc" ? 1 : -1;
  const compareDate = (left?: string | null, right?: string | null) => {
    const leftTime = left ? new Date(left).getTime() : Number.NaN;
    const rightTime = right ? new Date(right).getTime() : Number.NaN;
    const leftKnown = Number.isFinite(leftTime);
    const rightKnown = Number.isFinite(rightTime);
    if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
    return leftKnown ? (leftTime - rightTime) * directionFactor : 0;
  };
  const compareItems = (left: { name: string; kind: string; sizeBytes?: string; createdAt?: string | null; modifiedAt?: string | null }, right: { name: string; kind: string; sizeBytes?: string; createdAt?: string | null; modifiedAt?: string | null }) => {
    let compared = 0;
    if (sortField === "kind") compared = left.kind.localeCompare(right.kind, "ko");
    else if (sortField === "size") {
      const leftSize = BigInt(left.sizeBytes ?? "0");
      const rightSize = BigInt(right.sizeBytes ?? "0");
      compared = leftSize === rightSize ? 0 : leftSize < rightSize ? -1 : 1;
    } else if (sortField === "originalCreated") compared = compareDate(left.createdAt, right.createdAt);
    else if (sortField === "originalModified") compared = compareDate(left.modifiedAt, right.modifiedAt);
    if (!compared) compared = left.name.localeCompare(right.name, "ko");
    return (sortField === "originalCreated" || sortField === "originalModified") ? compared : compared * directionFactor;
  };
  const sortedFolders = [...folders].sort((left, right) => compareItems({ name: left.name, kind: "folder", createdAt: left.originalCreatedAt ?? left.createdAt, modifiedAt: left.originalModifiedAt ?? left.modifiedAt }, { name: right.name, kind: "folder", createdAt: right.originalCreatedAt ?? right.createdAt, modifiedAt: right.originalModifiedAt ?? right.modifiedAt }));
  const sortedFiles = [...files].sort((left, right) => compareItems({ name: left.name, kind: left.mimeType, sizeBytes: left.sizeBytes, createdAt: left.originalCreatedAt ?? left.createdAt, modifiedAt: left.clientLastModified ?? left.modifiedAt }, { name: right.name, kind: right.mimeType, sizeBytes: right.sizeBytes, createdAt: right.originalCreatedAt ?? right.createdAt, modifiedAt: right.clientLastModified ?? right.modifiedAt }));
  const keys = [
    ...sortedFolders.map((folder) => itemKey("folder", folder.id)),
    ...sortedFiles.map((file) => itemKey("file", file.id)),
  ];
  const selections: BulkSelection[] = keys
    .filter((key) => selectedKeys.has(key))
    .map((key) => {
      const [type, id] = key.split(":");
      return { type: type as "file" | "folder", id };
    });
  const canWrite = share?.type === "folder" && share.access === "readwrite";
  const currentFolderId = share?.currentFolder?.id;

  const load = async (folderId?: string) => {
    setLoading(true);
    setError("");
    try {
      const result = await api.publicShare(token, folderId);
      setShare(result);
      setPasswordRequired(false);
      setSelectedKeys(new Set());
      selectionAnchor.current = undefined;
      return true;
    } catch (value) {
      if ((value as { status?: number }).status === 401) {
        setPasswordRequired(true);
        setError("");
      } else
        setError(
          value instanceof Error
            ? value.message
            : "공유 항목을 불러오지 못했습니다.",
        );
      return false;
    } finally {
      setLoading(false);
    }
  };
  const reportPublicError = (value: unknown, fallback: string) => {
    if ((value as { status?: number }).status === 401) {
      setShare(undefined);
      setPasswordRequired(true);
      setError("");
      return;
    }
    setError(value instanceof Error ? value.message : fallback);
  };
  useEffect(() => {
    setShare(undefined);
    setHistory([]);
    setPasswordRequired(false);
    setPassword("");
    void load();
  }, [token]);
  useEffect(() => {
    localStorage.setItem("originvault.sortField.v3", sortField);
    localStorage.setItem("originvault.sortDirection.v3", sortDirection);
    localStorage.setItem("originvault.viewMode", viewMode);
  }, [sortDirection, sortField, viewMode]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node))
        setContextMenu(undefined);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setContextMenu(undefined);
    };
    document.addEventListener("pointerdown", close, true);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", close, true);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const unlock = async (event: React.FormEvent) => {
    event.preventDefault();
    setUnlocking(true);
    setError("");
    try {
      await api.unlockPublicShare(token, password);
      setPassword("");
      await load(history.at(-1)?.id);
    } catch (value) {
      setError(value instanceof Error ? value.message : "비밀번호를 확인하지 못했습니다.");
    } finally {
      setUnlocking(false);
    }
  };
  const openFolder = async (folder: PublicShareFolder) => {
    if (await load(folder.id)) setHistory((previous) => [...previous, folder]);
  };
  const goBack = async () => {
    const next = history.slice(0, -1);
    setHistory(next);
    await load(next.at(-1)?.id);
  };
  const selectItem = (
    key: string,
    event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
  ) => {
    const additive = Boolean(event.ctrlKey || event.metaKey);
    if (event.shiftKey) {
      const anchorIndex = selectionAnchor.current
        ? keys.indexOf(selectionAnchor.current)
        : -1;
      const targetIndex = keys.indexOf(key);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const range = keys.slice(
          Math.min(anchorIndex, targetIndex),
          Math.max(anchorIndex, targetIndex) + 1,
        );
        setSelectedKeys((previous) =>
          additive ? new Set([...previous, ...range]) : new Set(range),
        );
        return;
      }
    }
    selectionAnchor.current = key;
    if (additive)
      setSelectedKeys((previous) => {
        const next = new Set(previous);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
      });
    else setSelectedKeys(new Set([key]));
  };
  const handlePointerDown = (event: React.PointerEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (
      share?.type !== "folder" ||
      event.pointerType === "touch" ||
      event.button !== 0 ||
      target.closest("button, a, input, select, textarea, label, [contenteditable='true'], [role='dialog'], .item-context-menu, .preview-backdrop, .drawer-backdrop")
    )
      return;
    dragSelection.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: event.ctrlKey || event.metaKey ? new Set(selectedKeys) : new Set(),
      dragging: false,
    };
    setMarqueeSelecting(true);
  };
  const handlePointerMove = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragSelection.current;
    const grid = gridRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !grid) return;
    if (
      !drag.dragging &&
      Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5
    )
      return;
    if (!drag.dragging) {
      drag.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    event.preventDefault();
    const left = Math.min(drag.startX, event.clientX);
    const top = Math.min(drag.startY, event.clientY);
    const right = Math.max(drag.startX, event.clientX);
    const bottom = Math.max(drag.startY, event.clientY);
    setSelectionBox({
      left,
      top,
      width: right - left,
      height: bottom - top,
    });
    const hits = new Set(drag.base);
    grid.querySelectorAll<HTMLElement>("[data-public-select-key]").forEach((card) => {
      const rect = card.getBoundingClientRect();
      if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top)
        hits.add(card.dataset.publicSelectKey!);
    });
    setSelectedKeys(hits);
  };
  const finishPointer = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragSelection.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.dragging) {
      suppressCardClick.current = true;
      window.setTimeout(() => { suppressCardClick.current = false; }, 0);
    } else if (!(event.target as HTMLElement).closest("[data-public-select-key]")) {
      setSelectedKeys(new Set());
      selectionAnchor.current = undefined;
    }
    setSelectionBox(undefined);
    setMarqueeSelecting(false);
    dragSelection.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const finishSelectionGesture = (event: React.PointerEvent<HTMLElement>) => {
    finishPointer(event);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const showItemMenu = (event: React.MouseEvent<HTMLElement>, item: PublicItem) => {
    event.preventDefault();
    event.stopPropagation();
    const key = itemKey(item.type, item.item.id);
    if (!selectedKeys.has(key)) {
      selectionAnchor.current = key;
      setSelectedKeys(new Set([key]));
    }
    setContextMenu({ x: event.clientX, y: event.clientY, item });
  };
  const handleCardClick = (key: string, event: React.MouseEvent<HTMLElement>) => {
    if (!suppressCardClick.current) selectItem(key, event);
  };
  const downloadAll = async () => {
    setArchiveBusy(true);
    try {
      await api.publicShareArchive(token, { mode: "all" });
    } catch (value) {
      reportPublicError(value, "전체 다운로드에 실패했습니다.");
    } finally {
      setArchiveBusy(false);
    }
  };
  const downloadSelected = async () => {
    if (!selections.length) return;
    setArchiveBusy(true);
    try {
      await api.publicShareArchive(token, { mode: "selection", selections });
    } catch (value) {
      reportPublicError(value, "선택 다운로드에 실패했습니다.");
    } finally {
      setArchiveBusy(false);
    }
  };
  const openDetail = async (target: PublicItem) => {
    setDetailTarget(target);
    setDetail(undefined);
    setDetailLoading(true);
    try {
      setDetail(
        target.type === "file"
          ? await api.publicShareFile(token, target.item.id)
          : await api.publicShareFolder(token, target.item.id),
      );
    } catch (value) {
      reportPublicError(value, "상세정보를 불러오지 못했습니다.");
      setDetailTarget(undefined);
    } finally {
      setDetailLoading(false);
    }
  };
  const uploadFiles = async (filesToUpload: FileList | null) => {
    if (!filesToUpload || !currentFolderId || uploadBusy) return;
    setUploadBusy(true);
    setError("");
    try {
      for (const file of Array.from(filesToUpload))
        await api.publicShareUpload(token, currentFolderId, file);
      await load(currentFolderId);
    } catch (value) {
      reportPublicError(value, "파일 업로드에 실패했습니다.");
    } finally {
      setUploadBusy(false);
      if (pickerRef.current) pickerRef.current.value = "";
    }
  };
  const deleteSelected = async () => {
    if (!selections.length || !window.confirm(`선택한 ${selections.length}개 항목을 삭제할까요?`)) return;
    setUploadBusy(true);
    try {
      await api.publicShareDelete(token, selections);
      setSelectedKeys(new Set());
      await load(currentFolderId);
    } catch (value) {
      reportPublicError(value, "선택 삭제에 실패했습니다.");
    } finally {
      setUploadBusy(false);
    }
  };
  const currentFiles = sortedFiles;

  return (
    <main
      className="public-share-shell"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={finishSelectionGesture}
      onPointerCancel={finishSelectionGesture}
    >
      {selectionBox && <div className="selection-box main-selection-box" style={selectionBox} />}
      <header>
        <div className="public-brand">
          <div className="logo"><Archive /></div>
          <span><strong>OriginVault</strong><small>Shared original</small></span>
        </div>
        <div className="secure-label"><ShieldCheck />검증된 원본 공유</div>
      </header>
      <section className="public-share-card">
        {loading ? (
          <div className="public-state"><div className="loading-ring" /><h2>공유 항목을 불러오는 중입니다</h2></div>
        ) : passwordRequired ? (
          <form className="public-state public-password-form" onSubmit={unlock}>
            <ShieldCheck />
            <h2>비밀번호가 필요한 공유입니다</h2>
            <p>공유 소유자가 설정한 비밀번호를 입력하세요.</p>
            <label>
              공유 비밀번호
              <input type="password" autoComplete="current-password" autoFocus value={password} onChange={(event) => setPassword(event.target.value)} required />
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="primary" disabled={unlocking}>{unlocking ? "확인 중" : "공유 열기"}</button>
          </form>
        ) : error ? (
          <div className="public-state">
            <Link2 /><h2>공유 링크를 열 수 없습니다</h2><p>{error}</p>
            <button className="secondary" onClick={() => void load(history.at(-1)?.id)}>다시 시도</button>
          </div>
        ) : share ? (
          <>
            <div className="public-heading">
              {history.length > 0 && <button className="icon-action" aria-label="상위 폴더" onClick={() => void goBack()}><ArrowLeft /></button>}
              <div>
                <p className="eyebrow">SHARED WITH YOU</p>
                <h1>{history.at(-1)?.name ?? share.name}</h1>
                <p>{share.type === "folder" ? share.access === "readwrite" ? "파일 업로드와 삭제가 가능한 공유 폴더입니다." : "원본 폴더의 읽기 전용 공유 항목입니다." : "변형되지 않은 원본 파일입니다."}</p>
              </div>
            </div>
            {share.type === "file" && share.file ? (
              <article className="public-file">
                <div className="public-file-icon"><File /></div>
                <div><strong>{share.file.name}</strong><span>{formatBytes(share.file.sizeBytes)} · {share.file.mimeType}</span><code>SHA-256 {share.file.sha256}</code></div>
                <div className="public-file-actions">
                  <button className="secondary" onClick={() => setPreviewFile(share.file!)}><Eye />미리보기</button>
                  <a className="primary" href={api.publicShareDownloadUrl(token, share.file.id)}><Download />원본 다운로드</a>
                </div>
              </article>
            ) : (
              <>
                <div className="public-toolbar">
                  <ListingControls itemCount={folders.length + files.length} sortField={sortField} sortDirection={sortDirection} viewMode={viewMode} onSortFieldChange={setSortField} onSortDirectionChange={() => setSortDirection((current) => current === "asc" ? "desc" : "asc")} onViewModeChange={setViewMode} />
                  {selections.length > 0 && <span className="public-selection-count">{selections.length}개 선택됨</span>}
                  <button className="secondary compact" disabled={archiveBusy} onClick={() => void downloadAll()}><Package />전체 ZIP 다운로드</button>
                  <button className="secondary compact" disabled={!selections.length || archiveBusy} onClick={() => void downloadSelected()}><Download />선택 항목 ZIP</button>
                  {canWrite && <>
                    <button className="secondary compact" disabled={uploadBusy} onClick={() => pickerRef.current?.click()}><Upload />{uploadBusy ? "처리 중" : "파일 업로드"}</button>
                    <button className="secondary compact danger-compact" disabled={!selections.length || uploadBusy} onClick={() => void deleteSelected()}><Trash2 />선택 삭제</button>
                    <input ref={pickerRef} type="file" multiple hidden onChange={(event) => void uploadFiles(event.target.files)} />
                  </>}
                </div>
                <div
                  ref={gridRef}
                  className={`public-grid view-${viewMode} ${marqueeSelecting ? "marquee-selecting" : ""}`}
                  onContextMenu={(event) => {
                    if ((event.target as HTMLElement).closest("button, a, input")) return;
                    event.preventDefault();
                    setContextMenu({ x: event.clientX, y: event.clientY });
                  }}
                >
                  {sortedFolders.map((folder) => {
                    const key = itemKey("folder", folder.id);
                    const selected = selectedKeys.has(key);
                    return <article data-public-select-key={key} className={`public-item ${selected ? "selected" : ""}`} key={folder.id} onClick={(event) => handleCardClick(key, event)} onDoubleClick={() => void openFolder(folder)} onContextMenu={(event) => showItemMenu(event, { type: "folder", item: folder })}>
                      {viewMode === "preview" ? <div className="file-preview-thumb folder-thumb" aria-hidden="true"><Folder /></div> : <Folder />}<span><strong>{folder.name}</strong><small>폴더 열기</small></span>
                      <div className="public-item-actions"><button aria-label={`${folder.name} 열기`} title="폴더 열기" onClick={(event) => { event.stopPropagation(); void openFolder(folder); }}><ArrowLeft className="public-open-folder" /></button><button aria-label={`${folder.name} 메뉴`} title="메뉴" onClick={(event) => { event.stopPropagation(); setContextMenu({ x: event.clientX, y: event.clientY, item: { type: "folder", item: folder } }); }}><MoreHorizontal /></button></div>
                    </article>;
                  })}
                  {sortedFiles.map((file) => {
                    const key = itemKey("file", file.id);
                    const selected = selectedKeys.has(key);
                    const Icon = file.kind === "image" ? FileImage : file.kind === "video" ? FileVideo : File;
                    return <article data-public-select-key={key} className={`public-item ${selected ? "selected" : ""}`} key={file.id} onClick={(event) => handleCardClick(key, event)} onDoubleClick={() => setPreviewFile(file)} onContextMenu={(event) => showItemMenu(event, { type: "file", item: file })}>
                      {viewMode === "preview" ? <LazyFileThumbnail fileId={file.id} version={file.sha256} kind={file.kind === "image" ? "image" : file.kind === "video" ? "video" : "unsupported"} source="public" shareToken={token} fallback={Icon} /> : <Icon />}<span><strong>{file.name}</strong><small>{formatBytes(file.sizeBytes)}</small></span>
                      <div className="public-item-actions"><button aria-label={`${file.name} 미리보기`} title="미리보기" onClick={(event) => { event.stopPropagation(); setPreviewFile(file); }}><Eye /></button><a aria-label={`${file.name} 원본 다운로드`} title="원본 다운로드" href={api.publicShareDownloadUrl(token, file.id)} onClick={(event) => event.stopPropagation()}><Download /></a><button aria-label={`${file.name} 메뉴`} title="메뉴" onClick={(event) => { event.stopPropagation(); setContextMenu({ x: event.clientX, y: event.clientY, item: { type: "file", item: file } }); }}><MoreHorizontal /></button></div>
                    </article>;
                  })}
                  {!folders.length && !files.length && <div className="public-empty">이 폴더는 비어 있습니다.</div>}
                </div>
              </>
            )}
          </>
        ) : null}
      </section>
      <footer>이 링크를 가진 사람만 접근할 수 있습니다. 공유 소유자가 언제든 접근을 중지할 수 있습니다.</footer>
      {contextMenu && <div ref={contextMenuRef} className="item-context-menu public-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onPointerDown={(event) => event.stopPropagation()}>
        {contextMenu.item?.type === "file" && <>
          <button role="menuitem" onClick={() => { setContextMenu(undefined); setPreviewFile(contextMenu.item!.item as PublicShareFile); }}><Eye />미리보기</button>
          <button role="menuitem" onClick={() => { const item = contextMenu.item!; setContextMenu(undefined); void openDetail(item); }}><Info />상세정보 보기</button>
          <a role="menuitem" href={api.publicShareDownloadUrl(token, contextMenu.item.item.id)}><Download />원본 다운로드</a>
          <div className="context-menu-divider" />
        </>}
        {contextMenu.item?.type === "folder" && <>
          <button role="menuitem" onClick={() => { const item = contextMenu.item!; setContextMenu(undefined); void openDetail(item); }}><Info />상세정보 보기</button>
          <div className="context-menu-divider" />
        </>}
        <button role="menuitem" disabled={!selections.length || archiveBusy} onClick={() => { setContextMenu(undefined); void downloadSelected(); }}><Download />선택 항목 ZIP 다운로드</button>
        <button role="menuitem" disabled={archiveBusy} onClick={() => { setContextMenu(undefined); void downloadAll(); }}><Package />전체 ZIP 다운로드</button>
      </div>}
      {detailTarget && <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailTarget(undefined); }}>
        <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="public-detail-title">
          <header><div><p className="eyebrow">SHARED ITEM DETAILS</p><h2 id="public-detail-title">{detailTarget.item.name}</h2></div><button className="icon-btn" aria-label="상세정보 닫기" onClick={() => setDetailTarget(undefined)}><X /></button></header>
          {detailLoading || !detail ? <div className="drawer-loading">상세정보를 불러오는 중입니다.</div> : <dl className="facts">
            {"mimeType" in detail && <><div><dt>파일 형식</dt><dd>{detail.mimeType}</dd></div><div><dt>크기</dt><dd>{formatBytes(detail.sizeBytes)}</dd></div><div className="hash"><dt>SHA-256</dt><dd>{detail.sha256}</dd></div><div><dt>원본 수정 일시</dt><dd>{date(detail.clientLastModified)}</dd></div></>}
            {"fileCount" in detail && <><div><dt>전체 크기</dt><dd>{formatBytes(detail.sizeBytes)}</dd></div><div><dt>포함 파일</dt><dd>{detail.fileCount.toLocaleString("ko-KR")}개</dd></div><div><dt>하위 폴더</dt><dd>{detail.folderCount.toLocaleString("ko-KR")}개</dd></div><div><dt>바로 아래 항목</dt><dd>파일 {detail.directFileCount.toLocaleString("ko-KR")}개 · 폴더 {detail.directFolderCount.toLocaleString("ko-KR")}개</dd></div></>}
            <div><dt>생성 일시</dt><dd>{date(detail.createdAt)}</dd></div><div><dt>최근 변경 일시</dt><dd>{date(detail.modifiedAt)}</dd></div>
          </dl>}
        </aside>
      </div>}
      {previewFile && <PublicPreviewViewer token={token} file={previewFile} files={currentFiles} onNavigate={setPreviewFile} onClose={() => setPreviewFile(undefined)} onDownload={(file) => { const anchor = document.createElement("a"); anchor.href = api.publicShareDownloadUrl(token, file.id); anchor.download = file.name; document.body.append(anchor); anchor.click(); anchor.remove(); }} />}
    </main>
  );
}
