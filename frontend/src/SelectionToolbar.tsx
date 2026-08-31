import {
  CheckSquare,
  Download,
  FolderInput,
  Package,
  Share2,
  Trash2,
  X,
} from "lucide-react";

export function SelectionToolbar({
  selectedCount,
  totalCount,
  busy,
  onSelectAll,
  onClear,
  onDownloadOriginals,
  onDownloadZip,
  onShare,
  onMove,
  onDelete,
}: {
  selectedCount: number;
  totalCount: number;
  busy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  onDownloadOriginals: () => void;
  onDownloadZip: () => void;
  onShare: () => void;
  onMove: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className={`selection-toolbar ${selectedCount ? "has-selection" : ""}`}
    >
      <div className="selection-count">
        <CheckSquare />
        <strong>{selectedCount}</strong>
        <span>개 선택</span>
      </div>
      <div className="selection-controls">
        <button
          disabled={busy}
          onClick={
            selectedCount === totalCount && totalCount > 0
              ? onClear
              : onSelectAll
          }
        >
          {selectedCount === totalCount && totalCount > 0
            ? "전체 해제"
            : "전체 선택"}
        </button>
        {selectedCount > 0 && (
          <button disabled={busy} onClick={onClear}>
            <X />
            선택 해제
          </button>
        )}
      </div>
      <div className="bulk-actions">
        <button disabled={!selectedCount || busy} onClick={onDownloadOriginals}>
          <Download />
          개별 원본 다운로드
        </button>
        <button disabled={!selectedCount || busy} onClick={onDownloadZip}>
          <Package />
          ZIP 다운로드
        </button>
        <button disabled={selectedCount !== 1 || busy} onClick={onShare}>
          <Share2 />
          공유
        </button>
        <button disabled={!selectedCount || busy} onClick={onMove}>
          <FolderInput />
          이동
        </button>
        <button
          className="bulk-danger"
          disabled={!selectedCount || busy}
          onClick={onDelete}
        >
          <Trash2 />
          삭제
        </button>
      </div>
    </div>
  );
}
