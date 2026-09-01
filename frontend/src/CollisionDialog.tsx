import { AlertTriangle, Copy, X } from "lucide-react";
import type { CollisionChoice } from "./api";

export function CollisionDialog({
  operation,
  name,
  current,
  total,
  onChoose,
}: {
  operation: "업로드" | "복사" | "이동" | "복원";
  name: string;
  current: number;
  total: number;
  onChoose: (choice: CollisionChoice, applyToAll: boolean) => void;
}) {
  const submit = (choice: CollisionChoice, form: HTMLFormElement) => {
    onChoose(choice, new FormData(form).get("applyToAll") === "on");
  };
  return (
    <div className="modal-backdrop" role="presentation">
      <form
        className="move-dialog collision-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="collision-title"
        onSubmit={(event) => event.preventDefault()}
      >
        <header>
          <div className="modal-icon"><AlertTriangle /></div>
          <div>
            <p className="eyebrow">NAME CONFLICT</p>
            <h2 id="collision-title">같은 이름의 항목이 있습니다</h2>
          </div>
          <span className="collision-count">{current}/{total}</span>
        </header>
        <p><strong>{name}</strong> 이름이 대상 위치에 이미 있습니다.</p>
        <p className="collision-note">덮어쓰기는 기존 항목을 현재 휴지통 정책에 따라 삭제합니다.</p>
        {total > 1 && (
          <label className="check-label collision-apply">
            <input name="applyToAll" type="checkbox" />
            남은 중복 항목에도 같은 방식 적용
          </label>
        )}
        <footer className="collision-actions">
          <button type="button" className="secondary" onClick={(event) => submit("cancel", event.currentTarget.form!)}>
            <X />취소
          </button>
          <button type="button" className="secondary" onClick={(event) => submit("rename", event.currentTarget.form!)}>
            <Copy />이름 변경
          </button>
          <button type="button" className="danger-button" onClick={(event) => submit("overwrite", event.currentTarget.form!)}>
            덮어쓰기
          </button>
        </footer>
      </form>
    </div>
  );
}
