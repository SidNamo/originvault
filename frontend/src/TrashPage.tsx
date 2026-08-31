import { useEffect, useRef, useState } from "react";
import { CheckSquare, ChevronLeft, File, Folder, FolderOpen, Info, MoreHorizontal, RefreshCw, RotateCcw, Trash2, X } from "lucide-react";
import { api, type FilePreview, type StorageUsage, type TrashFolder, type TrashFolderContents, type TrashItem, type VaultFile } from "./api";
import { CollisionDialog } from "./CollisionDialog";
import { formatBytes } from "./format";
import { PreviewViewer } from "./PreviewViewer";
import { ListingControls, type ListingSortDirection, type ListingSortField, type ListingViewMode } from "./ListingControls";

type TrashAction = { type: "file" | "folder"; id: string; name: string; root: boolean };
const date = (value: string) => new Date(value).toLocaleString("ko-KR");
const actionKey = (item: Pick<TrashAction, "type" | "id">) => `${item.type}:${item.id}`;

export function TrashPage({
  onMessage,
  onStorageChanged,
}: {
  onMessage: (message: string) => void;
  onStorageChanged: (storage: StorageUsage) => void;
}) {
  const [items, setItems] = useState<TrashItem[]>([]);
  const [retentionDays, setRetentionDays] = useState(30);
  const [contents, setContents] = useState<TrashFolderContents>();
  const [trail, setTrail] = useState<TrashFolder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [sortField, setSortField] = useState<ListingSortField>(() => {
    const saved = localStorage.getItem("originvault.sortField.v3");
    return saved === "name" || saved === "kind" || saved === "size" || saved === "originalCreated" || saved === "originalModified" ? saved : "originalCreated";
  });
  const [sortDirection, setSortDirection] = useState<ListingSortDirection>(() => localStorage.getItem("originvault.sortDirection.v3") === "asc" ? "asc" : "desc");
  const [viewMode, setViewMode] = useState<ListingViewMode>(() => {
    const saved = localStorage.getItem("originvault.viewMode");
    return saved === "details" || saved === "grid-2" || saved === "grid-3" || saved === "preview" ? saved : "details";
  });
  const [restoreConflict, setRestoreConflict] = useState<TrashAction>();
  const [previewFile, setPreviewFile] = useState<Pick<VaultFile, "id" | "name">>();
  const [detailTarget, setDetailTarget] = useState<Pick<VaultFile, "id" | "name">>();
  const [detail, setDetail] = useState<FilePreview>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; item: TrashAction }>();
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<{ left: number; top: number; width: number; height: number }>();
  const [marqueeSelecting, setMarqueeSelecting] = useState(false);
  const selectionAnchor = useRef<string | undefined>(undefined);
  const dragSelection = useRef<{ pointerId: number; startX: number; startY: number; base: Set<string>; dragging: boolean } | undefined>(undefined);
  const suppressCardClick = useRef(false);
  const selectedKeysRef = useRef(selectedKeys);
  selectedKeysRef.current = selectedKeys;

  const loadRoot = async () => {
    setLoading(true);
    try {
      const result = await api.trash();
      setItems(result.items);
      setRetentionDays(result.retentionDays);
      setSelectedKeys(new Set());
      selectionAnchor.current = undefined;
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "휴지통을 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };
  const loadFolder = async (folder: TrashFolder, nextTrail: TrashFolder[]) => {
    setLoading(true);
    try {
      const result = await api.trashFolder(folder.id);
      setContents(result);
      setTrail(nextTrail);
      setSelectedKeys(new Set());
      selectionAnchor.current = undefined;
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "휴지통 폴더를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  };
  const refreshCurrent = async () => {
    const current = trail.at(-1);
    if (!current) return loadRoot();
    return loadFolder(current, trail);
  };
  const refreshStorage = async () => {
    try {
      onStorageChanged((await api.me()).storage);
    } catch {
      /* session handling owns authentication errors */
    }
  };
  useEffect(() => {
    void loadRoot();
  }, []);
  useEffect(() => {
    localStorage.setItem("originvault.sortField.v3", sortField);
    localStorage.setItem("originvault.sortDirection.v3", sortDirection);
    localStorage.setItem("originvault.viewMode", viewMode);
  }, [sortDirection, sortField, viewMode]);
  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node)) setContextMenu(undefined);
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

  const openFolder = (folder: TrashFolder) => {
    void loadFolder(folder, [...trail, folder]);
  };
  const goToTrail = (index: number) => {
    if (index < 0) {
      setTrail([]);
      setContents(undefined);
      void loadRoot();
      return;
    }
    const nextTrail = trail.slice(0, index + 1);
    void loadFolder(nextTrail.at(-1)!, nextTrail);
  };
  const toAction = (item: Pick<TrashItem, "type" | "id" | "name">, root = false): TrashAction => ({ ...item, root });
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
  const sortedFolders = [...(contents?.folders ?? [])].sort((left, right) => compareItems({ name: left.name, kind: "folder", createdAt: left.originalCreatedAt ?? left.createdAt, modifiedAt: left.originalModifiedAt ?? left.modifiedAt }, { name: right.name, kind: "folder", createdAt: right.originalCreatedAt ?? right.createdAt, modifiedAt: right.originalModifiedAt ?? right.modifiedAt }));
  const sortedFiles = [...(contents?.files ?? [])].sort((left, right) => compareItems({ name: left.name, kind: left.mimeType, sizeBytes: left.sizeBytes, createdAt: left.originalCreatedAt ?? left.createdAt, modifiedAt: left.originalModifiedAt ?? left.createdAt }, { name: right.name, kind: right.mimeType, sizeBytes: right.sizeBytes, createdAt: right.originalCreatedAt ?? right.createdAt, modifiedAt: right.originalModifiedAt ?? right.createdAt }));
  const sortedRootItems = [...items].sort((left, right) => compareItems({ name: left.name, kind: left.type, sizeBytes: left.sizeBytes, createdAt: left.originalCreatedAt ?? left.trashedAt, modifiedAt: left.originalModifiedAt ?? left.trashedAt }, { name: right.name, kind: right.type, sizeBytes: right.sizeBytes, createdAt: right.originalCreatedAt ?? right.trashedAt, modifiedAt: right.originalModifiedAt ?? right.trashedAt }));
  const visibleItems: TrashAction[] = contents
    ? [...sortedFolders.map((item) => toAction({ type: "folder", id: item.id, name: item.name })), ...sortedFiles.map((item) => toAction({ type: "file", id: item.id, name: item.name }))]
    : sortedRootItems.map((item) => toAction(item, true));
  const selections = visibleItems.filter((item) => selectedKeys.has(actionKey(item)));
  const openPreview = (file: Pick<VaultFile, "id" | "name">) => setPreviewFile(file);
  const openDetails = async (file: Pick<VaultFile, "id" | "name">) => {
    setDetailTarget(file);
    setDetail(undefined);
    setDetailLoading(true);
    try {
      setDetail(await api.trashFilePreview(file.id));
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "상세정보를 불러오지 못했습니다.");
      setDetailTarget(undefined);
    } finally {
      setDetailLoading(false);
    }
  };
  const selectItem = (key: string, event: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }) => {
    const additive = Boolean(event.ctrlKey || event.metaKey);
    if (event.shiftKey) {
      const anchorIndex = selectionAnchor.current ? visibleItems.findIndex((item) => actionKey(item) === selectionAnchor.current) : -1;
      const targetIndex = visibleItems.findIndex((item) => actionKey(item) === key);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const range = visibleItems.slice(Math.min(anchorIndex, targetIndex), Math.max(anchorIndex, targetIndex) + 1).map(actionKey);
        setSelectedKeys((previous) => additive ? new Set([...previous, ...range]) : new Set(range));
        return;
      }
    }
    selectionAnchor.current = key;
    if (additive) setSelectedKeys((previous) => {
      const next = new Set(previous);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
    else setSelectedKeys(new Set([key]));
  };
  useEffect(() => {
    const surface = listRef.current?.closest<HTMLElement>("main");
    if (!surface) return;
    const pointerDown = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (event.pointerType === "touch" || event.button !== 0 || target.closest("button, a, input, select, textarea, label, [contenteditable='true'], [role='dialog'], .item-context-menu, .preview-backdrop, .drawer-backdrop")) return;
      dragSelection.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        base: event.ctrlKey || event.metaKey ? new Set(selectedKeysRef.current) : new Set(),
        dragging: false,
      };
      setMarqueeSelecting(true);
    };
    const pointerMove = (event: PointerEvent) => {
      const drag = dragSelection.current;
      const list = listRef.current;
      if (!drag || drag.pointerId !== event.pointerId || !list) return;
      if (!drag.dragging && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
      if (!drag.dragging) {
        drag.dragging = true;
        surface.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
      const left = Math.min(drag.startX, event.clientX);
      const top = Math.min(drag.startY, event.clientY);
      const right = Math.max(drag.startX, event.clientX);
      const bottom = Math.max(drag.startY, event.clientY);
      setSelectionBox({ left, top, width: right - left, height: bottom - top });
      const hits = new Set(drag.base);
      list.querySelectorAll<HTMLElement>("[data-trash-select-key]").forEach((card) => {
        const rect = card.getBoundingClientRect();
        if (rect.left < right && rect.right > left && rect.top < bottom && rect.bottom > top)
          hits.add(card.dataset.trashSelectKey!);
      });
      setSelectedKeys(hits);
    };
    const finish = (event: PointerEvent, cancelled = false) => {
      const drag = dragSelection.current;
      if (!drag || drag.pointerId !== event.pointerId) return;
      if (drag.dragging) {
        suppressCardClick.current = true;
        window.setTimeout(() => { suppressCardClick.current = false; }, 0);
      } else if (!cancelled && !(event.target as HTMLElement).closest("[data-trash-select-key]")) {
        setSelectedKeys(new Set());
        selectionAnchor.current = undefined;
      }
      setSelectionBox(undefined);
      setMarqueeSelecting(false);
      dragSelection.current = undefined;
      if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId);
    };
    const pointerUp = (event: PointerEvent) => finish(event);
    const pointerCancel = (event: PointerEvent) => finish(event, true);
    surface.addEventListener("pointerdown", pointerDown);
    surface.addEventListener("pointermove", pointerMove);
    surface.addEventListener("pointerup", pointerUp);
    surface.addEventListener("pointercancel", pointerCancel);
    return () => {
      surface.removeEventListener("pointerdown", pointerDown);
      surface.removeEventListener("pointermove", pointerMove);
      surface.removeEventListener("pointerup", pointerUp);
      surface.removeEventListener("pointercancel", pointerCancel);
    };
  }, []);
  const restoreItem = async (item: TrashAction, collision?: "overwrite" | "rename") => {
    setBusy(`restore:${item.id}`);
    try {
      await api.restoreTrash(item.type, item.id, collision);
      setTrail([]);
      setContents(undefined);
      await Promise.all([loadRoot(), refreshStorage()]);
      onMessage(collision === "rename" ? "이름을 변경해 복원했습니다." : "원래 위치로 복원했습니다.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "복원에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };
  const restore = async (item: TrashAction) => {
    setBusy(`restore:${item.id}`);
    try {
      if ((await api.trashRestoreCollision(item.type, item.id)).conflict) {
        setRestoreConflict(item);
        return;
      }
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "복원 가능 여부를 확인하지 못했습니다.");
      return;
    } finally {
      setBusy("");
    }
    await restoreItem(item);
  };
  const permanentlyDelete = async (item: TrashAction) => {
    if (!window.confirm(`“${item.name}” 항목을 즉시 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    setBusy(`delete:${item.id}`);
    try {
      await api.permanentlyDeleteTrash(item.type, item.id);
      setTrail([]);
      setContents(undefined);
      await Promise.all([loadRoot(), refreshStorage()]);
      onMessage("휴지통 항목을 영구 삭제했습니다.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "영구 삭제에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };
  const permanentlyDeleteSelected = async () => {
    if (!selections.length || !window.confirm(`선택한 ${selections.length}개 항목을 즉시 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.`)) return;
    setBusy("delete:selected");
    try {
      await api.permanentlyDeleteTrashSelections(selections);
      setTrail([]);
      setContents(undefined);
      await Promise.all([loadRoot(), refreshStorage()]);
      onMessage(`${selections.length}개 휴지통 항목을 영구 삭제했습니다.`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "선택 항목 영구 삭제에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };
  const permanentlyDeleteAll = async () => {
    if (!items.length || !window.confirm("휴지통의 모든 항목을 즉시 영구 삭제할까요? 이 작업은 되돌릴 수 없습니다.")) return;
    setBusy("delete:all");
    try {
      const result = await api.permanentlyDeleteAllTrash();
      setTrail([]);
      setContents(undefined);
      await Promise.all([loadRoot(), refreshStorage()]);
      onMessage(`${result.deleted}개 휴지통 항목을 영구 삭제했습니다.`);
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "전체 영구 삭제에 실패했습니다.");
    } finally {
      setBusy("");
    }
  };
  const showMenu = (event: React.MouseEvent<HTMLElement>, item: TrashAction) => {
    event.preventDefault();
    event.stopPropagation();
    const key = actionKey(item);
    if (!selectedKeys.has(key)) {
      selectionAnchor.current = key;
      setSelectedKeys(new Set([key]));
    }
    setContextMenu({ x: event.clientX, y: event.clientY, item });
  };
  const handleCardClick = (key: string, event: React.MouseEvent<HTMLElement>) => {
    if (!suppressCardClick.current) selectItem(key, event);
  };
  const folder = contents?.folder;
  return (
    <section className="workspace-page trash-page">
      <header className="page-hero">
        <div>
          <p className="eyebrow">RECOVERY</p>
          <h1>{folder?.name ?? "휴지통"}</h1>
          <p>삭제한 항목은 {retentionDays}일 동안 보관한 뒤 자동으로 영구 삭제됩니다.</p>
        </div>
        <div className="actions">
          <button className="secondary compact danger-compact" onClick={() => void permanentlyDeleteAll()} disabled={!items.length || Boolean(busy)}><Trash2 />전체 즉시 삭제</button>
          <button className="secondary compact" onClick={() => void refreshCurrent()} disabled={loading}>
            <RefreshCw className={loading ? "spin" : ""} />새로고침
          </button>
        </div>
      </header>
      {folder && (
        <nav className="trash-breadcrumb" aria-label="휴지통 경로">
          <button onClick={() => goToTrail(-1)}>휴지통</button>
          {trail.map((entry, index) => (
            <span key={entry.id}>
              <ChevronLeft />
              <button disabled={index === trail.length - 1} onClick={() => goToTrail(index)}>{entry.name}</button>
            </span>
          ))}
        </nav>
      )}
      <div className="trash-list-tools">
        <ListingControls itemCount={visibleItems.length} sortField={sortField} sortDirection={sortDirection} viewMode={viewMode} onSortFieldChange={setSortField} onSortDirectionChange={() => setSortDirection((current) => current === "asc" ? "desc" : "asc")} onViewModeChange={setViewMode} />
      </div>
      <div className={`selection-toolbar ${selections.length ? "has-selection" : ""}`}>
        <div className="selection-count"><CheckSquare /><strong>{selections.length}</strong><span>개 선택</span></div>
        <div className="selection-controls">
          <button disabled={Boolean(busy)} onClick={() => setSelectedKeys(selections.length === visibleItems.length && visibleItems.length ? new Set() : new Set(visibleItems.map(actionKey)))}>{selections.length === visibleItems.length && visibleItems.length ? "전체 해제" : "전체 선택"}</button>
          {!!selections.length && <button disabled={Boolean(busy)} onClick={() => { setSelectedKeys(new Set()); selectionAnchor.current = undefined; }}><X />선택 해제</button>}
        </div>
        <div className="bulk-actions"><button className="bulk-danger" disabled={!selections.length || Boolean(busy)} onClick={() => void permanentlyDeleteSelected()}><Trash2 />선택 즉시 삭제</button></div>
      </div>
      <div ref={listRef} className={`panel-card trash-list view-${viewMode} ${marqueeSelecting ? "marquee-selecting" : ""}`}>
        {selectionBox && <div className="selection-box main-selection-box" style={selectionBox} />}
        {loading ? <div className="trash-empty">휴지통을 불러오는 중입니다.</div> : folder ? (
          !contents?.folders.length && !contents?.files.length ? <div className="trash-empty">이 폴더는 비어 있습니다.</div> : <>
            {sortedFolders.map((item) => {
              const action = toAction({ type: "folder", id: item.id, name: item.name });
              const key = actionKey(action);
              return <article data-trash-select-key={key} className={`trash-item ${selectedKeys.has(key) ? "selected" : ""}`} key={`folder:${item.id}`} onClick={(event) => handleCardClick(key, event)} onDoubleClick={() => openFolder(item)} onContextMenu={(event) => showMenu(event, action)}>
                <div className="trash-kind"><Folder /></div>
                <div className="trash-item-main"><strong>{item.name}</strong><small>폴더 · 삭제 {date(item.trashedAt)}</small></div>
                <div className="trash-actions"><button className="secondary compact" onClick={(event) => { event.stopPropagation(); openFolder(item); }}><FolderOpen />열기</button><button className="icon-action" title="메뉴" onClick={(event) => showMenu(event, action)}><MoreHorizontal /></button></div>
              </article>;
            })}
            {sortedFiles.map((item) => {
              const action = toAction({ type: "file", id: item.id, name: item.name });
              const key = actionKey(action);
              return <article data-trash-select-key={key} className={`trash-item ${selectedKeys.has(key) ? "selected" : ""}`} key={`file:${item.id}`} onClick={(event) => handleCardClick(key, event)} onDoubleClick={() => openPreview(item)} onContextMenu={(event) => showMenu(event, action)}>
                <div className="trash-kind"><File /></div>
                <div className="trash-item-main"><strong>{item.name}</strong><small>{formatBytes(item.sizeBytes)} · 파일 미리보기</small></div>
                <button className="icon-action" title="메뉴" onClick={(event) => showMenu(event, action)}><MoreHorizontal /></button>
              </article>;
            })}
          </>
        ) : !items.length ? <div className="trash-empty">휴지통이 비어 있습니다.</div> : sortedRootItems.map((item) => {
          const action = toAction(item, true);
          const key = actionKey(action);
          return <article data-trash-select-key={key} className={`trash-item ${selectedKeys.has(key) ? "selected" : ""}`} key={`${item.type}:${item.id}`} onClick={(event) => handleCardClick(key, event)} onDoubleClick={() => item.type === "folder"
            ? openFolder({ id: item.id, name: item.name, parentId: null, createdAt: item.trashedAt, modifiedAt: item.trashedAt, trashedAt: item.trashedAt })
            : openPreview(item)} onContextMenu={(event) => showMenu(event, action)}>
            <div className="trash-kind">{item.type === "folder" ? <Folder /> : <File />}</div>
            <div className="trash-item-main">
              <strong>{item.name}</strong>
              <small>{item.type === "folder" ? `파일 ${item.fileCount.toLocaleString("ko-KR")}개 · 폴더 ${Math.max(0, item.folderCount - 1).toLocaleString("ko-KR")}개` : "파일"}{` · ${formatBytes(item.sizeBytes)}`}</small>
              <small>삭제 {date(item.trashedAt)} · 자동 삭제 {date(item.expiresAt)}</small>
            </div>
            <div className="trash-actions">
              <button className="icon-action" title="메뉴" onClick={(event) => showMenu(event, action)}><MoreHorizontal /></button>
            </div>
          </article>;
        })}
      </div>
      {contextMenu && <div ref={contextMenuRef} className="item-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={(event) => event.preventDefault()}>
        {contextMenu.item.type === "file" && <>
          <button role="menuitem" onClick={() => { const item = contextMenu.item; setContextMenu(undefined); openPreview(item); }}><File />미리보기</button>
          <button role="menuitem" onClick={() => { const item = contextMenu.item; setContextMenu(undefined); void openDetails(item); }}><Info />상세정보 보기</button>
          <div className="context-menu-divider" />
        </>}
        {contextMenu.item.type === "folder" && <button role="menuitem" onClick={() => {
          const item = contextMenu.item;
          setContextMenu(undefined);
          if (item.root) openFolder({ id: item.id, name: item.name, parentId: null, createdAt: "", modifiedAt: "", trashedAt: "" });
          else {
            const nested = contents?.folders.find((folder) => folder.id === item.id);
            if (nested) openFolder(nested);
          }
        }}><FolderOpen />열기</button>}
        {(contextMenu.item.type === "file" || contextMenu.item.root) && <>
          <button role="menuitem" disabled={Boolean(busy)} onClick={() => { const item = contextMenu.item; setContextMenu(undefined); void restore(item); }}><RotateCcw />복원</button>
          <button role="menuitem" className="danger" disabled={Boolean(busy)} onClick={() => { const item = contextMenu.item; setContextMenu(undefined); void permanentlyDelete(item); }}><Trash2 />완전 삭제</button>
        </>}
      </div>}
      {restoreConflict && <CollisionDialog operation="복원" name={restoreConflict.name} current={1} total={1} onChoose={(choice) => { const item = restoreConflict; setRestoreConflict(undefined); if (choice !== "cancel") void restoreItem(item, choice); }} />}
      {detailTarget && <div className="drawer-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setDetailTarget(undefined); }}>
        <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="trash-detail-title">
          <header><div><p className="eyebrow">TRASH ITEM DETAILS</p><h2 id="trash-detail-title">{detailTarget.name}</h2></div><button className="icon-btn" aria-label="상세정보 닫기" onClick={() => setDetailTarget(undefined)}><X /></button></header>
          {detailLoading || !detail ? <div className="drawer-loading">상세정보를 불러오는 중입니다.</div> : <dl className="facts">
            <div><dt>파일 형식</dt><dd>{detail.file.mimeType}</dd></div><div><dt>크기</dt><dd>{formatBytes(detail.file.sizeBytes)}</dd></div><div className="hash"><dt>SHA-256</dt><dd>{detail.file.sha256}</dd></div>
            <div><dt>원본 생성 일시</dt><dd>{detail.file.originalCreatedAt ? date(detail.file.originalCreatedAt) : "알 수 없음"}</dd></div><div><dt>원본 수정 일시</dt><dd>{detail.file.originalModifiedAt ? date(detail.file.originalModifiedAt) : "알 수 없음"}</dd></div><div><dt>최근 변경 일시</dt><dd>{detail.file.modifiedAt ? date(detail.file.modifiedAt) : "알 수 없음"}</dd></div>
          </dl>}
        </aside>
      </div>}
      {previewFile && <PreviewViewer file={previewFile} source="trash" onNavigate={setPreviewFile} onClose={() => setPreviewFile(undefined)} onDownload={(file) => void api.downloadTrash(file).catch((error) => onMessage(error instanceof Error ? error.message : "다운로드에 실패했습니다."))} onChanged={() => undefined} onMessage={onMessage} />}
    </section>
  );
}
