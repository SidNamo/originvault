import { FolderInput, X } from "lucide-react";
import type { Folder } from "./api";

export function MoveDialog({
  folders,
  destinationId,
  busy,
  disabledFolderIds = new Set<string>(),
  onDestinationChange,
  onCancel,
  onConfirm,
}: {
  folders: Folder[];
  destinationId: string;
  busy: boolean;
  disabledFolderIds?: ReadonlySet<string>;
  onDestinationChange: (id: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <section
        className="move-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="move-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div className="modal-icon">
            <FolderInput />
          </div>
          <div>
            <p className="eyebrow">MOVE ITEMS</p>
            <h2 id="move-title">이동할 폴더 선택</h2>
          </div>
          <button className="icon-btn" onClick={onCancel}>
            <X />
          </button>
        </header>
        <label>
          대상 폴더
          <select
            value={destinationId}
            onChange={(event) => onDestinationChange(event.target.value)}
          >
            <option value="">내 파일 (최상위)</option>
            {folders.map((folder) => (
              <option
                key={folder.id}
                value={folder.id}
                disabled={disabledFolderIds.has(folder.id)}
              >
                {folder.relativePath}
              </option>
            ))}
          </select>
        </label>
        <p>
          선택한 파일과 폴더의 원본 경로가 변경됩니다. 폴더를 자기 자신이나 하위
          폴더로 이동할 수 없습니다.
        </p>
        <footer>
          <button className="secondary" onClick={onCancel}>
            취소
          </button>
          <button className="primary" disabled={busy} onClick={onConfirm}>
            {busy ? "이동 중…" : "이동"}
          </button>
        </footer>
      </section>
    </div>
  );
}
