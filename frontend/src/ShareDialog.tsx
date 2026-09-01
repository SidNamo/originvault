import { Folder, Link2, LockKeyhole, X } from "lucide-react";
import { useState } from "react";

export function ShareDialog({
  item,
  busy,
  onCancel,
  onConfirm,
}: {
  item: { type: "file" | "folder"; id: string; name: string };
  busy: boolean;
  onCancel: () => void;
  onConfirm: (input: { password?: string; access: "read" | "readwrite"; includeHidden: boolean }) => void;
}) {
  const [password, setPassword] = useState("");
  const [access, setAccess] = useState<"read" | "readwrite">("read");
  const [includeHidden, setIncludeHidden] = useState(false);
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    onConfirm({ password: password || undefined, access, includeHidden });
  };
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="move-dialog share-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div className="modal-icon">
            {item.type === "folder" ? <Folder /> : <Link2 />}
          </div>
          <div>
            <p className="eyebrow">CREATE SHARE</p>
            <h2 id="share-dialog-title">공유 링크 만들기</h2>
          </div>
          <button type="button" className="icon-btn" aria-label="공유 만들기 닫기" onClick={onCancel}>
            <X />
          </button>
        </header>
        <p className="share-target-name">{item.name}</p>
        {item.type === "folder" && (
          <>
            <label>
              권한
              <select value={access} onChange={(event) => setAccess(event.target.value as "read" | "readwrite")}>
                <option value="read">보기</option>
                <option value="readwrite">보기 및 수정</option>
              </select>
            </label>
            <label className="check-label">
              <input type="checkbox" checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} />
              숨김 파일도 공유
            </label>
          </>
        )}
        <label>
          <span>
            <LockKeyhole />
            공유 비밀번호 (선택)
          </span>
          <input
            type="password"
            autoComplete="new-password"
            minLength={12}
            maxLength={72}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="설정하지 않으면 링크만으로 접근"
            autoFocus
          />
        </label>
        <p>비밀번호를 설정하면 공유받은 사람이 최초 접근 시 입력해야 합니다.</p>
        <footer>
          <button type="button" className="secondary" onClick={onCancel} disabled={busy}>
            취소
          </button>
          <button className="primary" disabled={busy}>
            {busy ? "링크 생성 중" : "공유 링크 만들기"}
          </button>
        </footer>
      </form>
    </div>
  );
}
