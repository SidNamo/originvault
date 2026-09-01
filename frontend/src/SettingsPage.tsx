import { useEffect, useState } from "react";
import {
  BadgeCheck,
  Database,
  Eye,
  KeyRound,
  LockKeyhole,
  Plus,
  Save,
  Settings2,
  Shield,
  Trash2,
  UserCog,
  Users,
} from "lucide-react";
import {
  api,
  session,
  type AdminSettings,
  type AdminUser,
  type StorageUsage,
  type UserProfile,
} from "./api";
import { bytesToGigabytes, formatBytes, gigabytesToBytes } from "./format";

export function SettingsPage({
  user,
  storage,
  onUserChanged,
  onStorageChanged,
  onHiddenFilesChanged,
  onMessage,
}: {
  user: UserProfile;
  storage: StorageUsage;
  onUserChanged: (user: UserProfile) => void;
  onStorageChanged: (storage: StorageUsage) => void;
  onHiddenFilesChanged: () => Promise<void> | void;
  onMessage: (message: string) => void;
}) {
  const [tab, setTab] = useState<"user" | "admin">("user");
  const [displayName, setDisplayName] = useState(user.displayName);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [adminSettings, setAdminSettings] = useState<AdminSettings>();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [editing, setEditing] = useState<AdminUser>();
  const [showCreate, setShowCreate] = useState(false);
  const [newUser, setNewUser] = useState({
    username: "",
    displayName: "",
    password: "",
    isAdmin: false,
    quotaGb: "10",
  });
  const [busy, setBusy] = useState(false);

  const loadAdmin = async () => {
    if (!user.isAdmin) return;
    try {
      const [settingsResult, usersResult] = await Promise.all([
        api.adminSettings(),
        api.adminUsers(),
      ]);
      setAdminSettings(settingsResult);
      setUsers(usersResult.users);
    } catch (error) {
      onMessage(
        error instanceof Error
          ? error.message
          : "관리자 설정을 불러오지 못했습니다.",
      );
    }
  };
  useEffect(() => {
    void api
      .me()
      .then((result) => {
        onUserChanged(result.user);
        onStorageChanged(result.storage);
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    if (tab === "admin") void loadAdmin();
  }, [tab, user.isAdmin]);

  const updateName = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.updateProfile(displayName);
      onUserChanged(result.user);
      onStorageChanged(result.storage);
      onMessage("이름을 변경했습니다.");
    } catch (error) {
      onMessage(
        error instanceof Error ? error.message : "이름 변경에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  };
  const updatePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await api.changePassword(currentPassword, newPassword);
      session.set(result.token);
      onUserChanged(result.user);
      setCurrentPassword("");
      setNewPassword("");
      onMessage("비밀번호를 변경했습니다. 다른 로그인 세션은 만료되었습니다.");
    } catch (error) {
      onMessage(
        error instanceof Error
          ? error.message
          : "비밀번호 변경에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  };
  const toggleTrash = async () => {
    setBusy(true);
    try {
      const result = await api.updateTrashEnabled(!user.trashEnabled);
      onUserChanged(result.user);
      onStorageChanged(result.storage);
      onMessage(result.user.trashEnabled ? "삭제한 항목을 휴지통에 보관합니다." : "앞으로 삭제한 항목을 즉시 영구 삭제합니다.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "휴지통 설정 변경에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const toggleRegistration = async () => {
    if (!adminSettings) return;
    try {
      setAdminSettings(
        await api.updateAdminSettings(!adminSettings.registrationEnabled),
      );
    } catch (error) {
      onMessage(
        error instanceof Error
          ? error.message
          : "가입 설정 변경에 실패했습니다.",
      );
    }
  };
  const toggleHiddenFiles = async () => {
    setBusy(true);
    try {
      const result = await api.updateShowHiddenFiles(!user.showHiddenFiles);
      onUserChanged(result.user);
      onStorageChanged(result.storage);
      await onHiddenFilesChanged();
      onMessage(result.user.showHiddenFiles ? "숨김 파일을 표시합니다." : "숨김 파일을 숨깁니다.");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "숨김 파일 설정 변경에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };
  const createUser = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.createAdminUser({
        username: newUser.username,
        displayName: newUser.displayName || newUser.username,
        password: newUser.password,
        isAdmin: newUser.isAdmin,
        storageQuotaBytes: gigabytesToBytes(newUser.quotaGb),
      });
      setNewUser({
        username: "",
        displayName: "",
        password: "",
        isAdmin: false,
        quotaGb: "10",
      });
      setShowCreate(false);
      await loadAdmin();
      onMessage("사용자를 등록했습니다.");
    } catch (error) {
      onMessage(
        error instanceof Error ? error.message : "사용자 등록에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  };
  const saveUser = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await api.updateAdminUser(editing.id, {
        username: String(form.get("username")),
        displayName: String(form.get("displayName")),
        isAdmin: form.get("isAdmin") === "on",
        disabled: form.get("disabled") === "on",
        storageQuotaBytes: gigabytesToBytes(String(form.get("quotaGb") ?? "")),
        ...(String(form.get("password") ?? "")
          ? { password: String(form.get("password")) }
          : {}),
      });
      if (editing.id === user.id) {
        const profile = await api.me();
        onUserChanged(profile.user);
        onStorageChanged(profile.storage);
      }
      setEditing(undefined);
      await loadAdmin();
      onMessage("사용자 정보를 수정했습니다.");
    } catch (error) {
      onMessage(
        error instanceof Error ? error.message : "사용자 수정에 실패했습니다.",
      );
    } finally {
      setBusy(false);
    }
  };
  const deleteUser = async (target: AdminUser) => {
    if (
      !window.confirm(
        `“${target.username}” 사용자와 모든 저장 파일을 영구 삭제할까요?`,
      )
    )
      return;
    try {
      await api.deleteAdminUser(target.id);
      setEditing(undefined);
      await loadAdmin();
      onMessage("사용자를 탈퇴 처리했습니다.");
    } catch (error) {
      onMessage(
        error instanceof Error ? error.message : "사용자 삭제에 실패했습니다.",
      );
    }
  };
  const used = BigInt(storage.usedBytes) + BigInt(storage.reservedBytes);
  const quota = storage.quotaBytes ? BigInt(storage.quotaBytes) : null;
  const usagePercent =
    quota && quota > 0n ? Math.min(100, Number((used * 100n) / quota)) : 0;

  return (
    <section className="workspace-page settings-page">
      <header className="page-hero">
        <div>
          <p className="eyebrow">ACCOUNT & SYSTEM</p>
          <h1>설정</h1>
          <p>내 계정 보안과 OriginVault 운영 정책을 관리합니다.</p>
        </div>
        <div className="page-actions page-identity">
          <div className="identity-badge">
            <div>{user.displayName[0]?.toUpperCase()}</div>
            <span>
              <strong>{user.displayName}</strong>
              <small>{user.isAdmin ? "Administrator" : "Member"}</small>
            </span>
          </div>
        </div>
      </header>
      <div className="section-tabs">
        <button
          className={tab === "user" ? "active" : ""}
          onClick={() => setTab("user")}
        >
          <UserCog />
          사용자 설정
        </button>
        {user.isAdmin && (
          <button
            className={tab === "admin" ? "active" : ""}
            onClick={() => setTab("admin")}
          >
            <Shield />
            관리자 설정
          </button>
        )}
      </div>
      {tab === "user" ? (
        <div className="settings-grid">
          <div className="panel-card">
            <div className="panel-heading">
              <div>
                <span className="kicker">PROFILE</span>
                <h2>사용자 정보</h2>
              </div>
              <BadgeCheck />
            </div>
            <form className="settings-form" onSubmit={updateName}>
              <label>
                로그인 아이디
                <input value={user.username} disabled />
              </label>
              <label>
                표시 이름
                <input
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  maxLength={80}
                  required
                />
              </label>
              <button className="primary" disabled={busy}>
                <Save />
                이름 변경
              </button>
            </form>
          </div>
          <div className="panel-card">
            <div className="panel-heading">
              <div>
                <span className="kicker">SECURITY</span>
                <h2>비밀번호 변경</h2>
              </div>
              <LockKeyhole />
            </div>
            <form className="settings-form" onSubmit={updatePassword}>
              <label>
                현재 비밀번호
                <input
                  type="password"
                  autoComplete="current-password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  required
                />
              </label>
              <label>
                새 비밀번호
                <input
                  type="password"
                  autoComplete="new-password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  minLength={12}
                  required
                />
              </label>
              <button className="primary" disabled={busy}>
                <KeyRound />
                비밀번호 변경
              </button>
            </form>
          </div>
          <div className="panel-card storage-card">
            <div className="panel-heading">
              <div>
                <span className="kicker">STORAGE</span>
                <h2>스토리지 사용량</h2>
              </div>
              <Database />
            </div>
            <div className="storage-total">
              <strong>{formatBytes(used)}</strong>
              <span>{quota ? ` / ${formatBytes(quota)}` : " / 제한 없음"}</span>
            </div>
            {quota && (
              <div className="quota-track">
                <span style={{ width: `${usagePercent}%` }} />
              </div>
            )}
            <dl className="storage-facts">
              <div>
                <dt>활성 파일</dt>
                <dd>{formatBytes(storage.activeBytes)}</dd>
              </div>
              <div>
                <dt>휴지통 포함</dt>
                <dd>{formatBytes(storage.trashBytes)}</dd>
              </div>
              <div>
                <dt>업로드 예약</dt>
                <dd>{formatBytes(storage.reservedBytes)}</dd>
              </div>
              <div>
                <dt>내 할당량</dt>
                <dd>
                  {storage.quotaBytes
                    ? formatBytes(storage.quotaBytes)
                    : "무제한"}
                </dd>
              </div>
            </dl>
          </div>
          <div className="panel-card admin-policy trash-policy">
            <div>
              <span className="kicker">TRASH</span>
              <h2>휴지통</h2>
              <p>삭제한 파일과 폴더를 30일 동안 보관한 뒤 자동으로 영구 삭제합니다.</p>
            </div>
            <button
              className={`switch-control ${user.trashEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={user.trashEnabled}
              disabled={busy}
              onClick={() => void toggleTrash()}
            >
              <span />
              <strong>{user.trashEnabled ? "ON" : "OFF"}</strong>
            </button>
          </div>
          <div className="panel-card admin-policy">
            <div>
              <span className="kicker">FILE VISIBILITY</span>
              <h2>숨김 파일</h2>
              <p>점 파일과 업로드 메타데이터에서 숨김으로 표시된 항목을 목록에 표시합니다. 휴지통에서는 항상 표시됩니다.</p>
            </div>
            <button
              className={`switch-control ${user.showHiddenFiles ? "on" : ""}`}
              role="switch"
              aria-checked={user.showHiddenFiles}
              disabled={busy}
              onClick={() => void toggleHiddenFiles()}
            >
              <span />
              <Eye />
              <strong>{user.showHiddenFiles ? "ON" : "OFF"}</strong>
            </button>
          </div>
        </div>
      ) : (
        <div className="admin-stack">
          <div className="panel-card admin-policy">
            <div>
              <span className="kicker">REGISTRATION POLICY</span>
              <h2>회원가입</h2>
              <p>로그인 화면에서 신규 계정 생성을 허용할지 설정합니다.</p>
            </div>
            <button
              className={`switch-control ${adminSettings?.registrationEnabled ? "on" : ""}`}
              role="switch"
              aria-checked={adminSettings?.registrationEnabled ?? false}
              onClick={() => void toggleRegistration()}
            >
              <span />
              <strong>
                {adminSettings?.registrationEnabled ? "ON" : "OFF"}
              </strong>
            </button>
          </div>
          <div className="panel-card">
            <div className="panel-heading">
              <div>
                <span className="kicker">USER MANAGEMENT</span>
                <h2>사용자 관리</h2>
              </div>
              <button
                className="primary compact"
                onClick={() => setShowCreate((value) => !value)}
              >
                <Plus />
                사용자 등록
              </button>
            </div>
            {showCreate && (
              <form className="admin-create-form" onSubmit={createUser}>
                <label>
                  아이디
                  <input
                    value={newUser.username}
                    onChange={(event) =>
                      setNewUser({ ...newUser, username: event.target.value })
                    }
                    required
                  />
                </label>
                <label>
                  표시 이름
                  <input
                    value={newUser.displayName}
                    onChange={(event) =>
                      setNewUser({
                        ...newUser,
                        displayName: event.target.value,
                      })
                    }
                  />
                </label>
                <label>
                  초기 비밀번호
                  <input
                    type="password"
                    value={newUser.password}
                    onChange={(event) =>
                      setNewUser({ ...newUser, password: event.target.value })
                    }
                    minLength={12}
                    required
                  />
                </label>
                <label>
                  할당량 GB
                  <input
                    inputMode="decimal"
                    value={newUser.quotaGb}
                    onChange={(event) =>
                      setNewUser({ ...newUser, quotaGb: event.target.value })
                    }
                    placeholder="빈 값은 무제한"
                  />
                </label>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={newUser.isAdmin}
                    onChange={(event) =>
                      setNewUser({ ...newUser, isAdmin: event.target.checked })
                    }
                  />
                  관리자 권한
                </label>
                <button className="primary" disabled={busy}>
                  등록
                </button>
              </form>
            )}
            <div className="user-table">
              <div className="user-head">
                <span>사용자</span>
                <span>권한/상태</span>
                <span>스토리지</span>
                <span>할당량</span>
                <span />
              </div>
              {users.map((item) => {
                const itemUsed =
                  BigInt(item.usedBytes) + BigInt(item.reservedBytes);
                const itemQuota = item.storageQuotaBytes
                  ? BigInt(item.storageQuotaBytes)
                  : null;
                const percent =
                  itemQuota && itemQuota > 0n
                    ? Math.min(100, Number((itemUsed * 100n) / itemQuota))
                    : 0;
                return (
                  <div className="user-row" key={item.id}>
                    <div className="user-cell">
                      <span className="mini-avatar">
                        {item.displayName[0]?.toUpperCase()}
                      </span>
                      <span>
                        <strong>{item.displayName}</strong>
                        <small>@{item.username}</small>
                      </span>
                    </div>
                    <div>
                      <span
                        className={`state-chip ${item.disabled ? "revoked" : item.isAdmin ? "admin" : "active"}`}
                      >
                        {item.disabled
                          ? "비활성"
                          : item.isAdmin
                            ? "관리자"
                            : "사용자"}
                      </span>
                    </div>
                    <div className="usage-cell">
                      <strong>{formatBytes(itemUsed)}</strong>
                      {itemQuota && (
                        <div className="mini-track">
                          <span style={{ width: `${percent}%` }} />
                        </div>
                      )}
                    </div>
                    <div>
                      {item.storageQuotaBytes
                        ? formatBytes(item.storageQuotaBytes)
                        : "무제한"}
                    </div>
                    <button
                      className="secondary compact"
                      onClick={() => setEditing(item)}
                    >
                      <Settings2 />
                      관리
                    </button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
      {editing && (
        <div className="modal-backdrop" role="presentation">
          <form
            key={editing.id}
            className="modal-card user-edit-modal"
            role="dialog"
            aria-modal="true"
            aria-label={`${editing.displayName} 사용자 관리`}
            onSubmit={saveUser}
          >
            <div className="panel-heading">
              <div>
                <span className="kicker">EDIT USER</span>
                <h2>{editing.displayName}</h2>
              </div>
              <Users />
            </div>
            <div className="form-grid">
              <label>
                아이디
                <input
                  name="username"
                  defaultValue={editing.username}
                  autoFocus
                  required
                />
              </label>
              <label>
                표시 이름
                <input
                  name="displayName"
                  defaultValue={editing.displayName}
                  required
                />
              </label>
              <label>
                새 비밀번호
                <input
                  name="password"
                  type="password"
                  placeholder="변경하지 않으면 비워두기"
                />
              </label>
              <label>
                할당량 GB
                <input
                  name="quotaGb"
                  inputMode="decimal"
                  defaultValue={bytesToGigabytes(editing.storageQuotaBytes)}
                  placeholder="빈 값은 무제한"
                />
              </label>
            </div>
            <div className="modal-checks">
              <label className="check-label">
                <input
                  name="isAdmin"
                  type="checkbox"
                  defaultChecked={editing.isAdmin}
                />
                관리자 권한
              </label>
              <label className="check-label">
                <input
                  name="disabled"
                  type="checkbox"
                  defaultChecked={editing.disabled}
                />
                계정 비활성화
              </label>
            </div>
            <div className="modal-actions spread">
              <button
                type="button"
                className="danger-button"
                onClick={() => void deleteUser(editing)}
              >
                <Trash2 />
                회원 탈퇴
              </button>
              <span />
              <button
                type="button"
                className="secondary"
                onClick={() => setEditing(undefined)}
              >
                취소
              </button>
              <button className="primary" disabled={busy}>
                <Save />
                저장
              </button>
            </div>
          </form>
        </div>
      )}
    </section>
  );
}
