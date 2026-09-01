import { useEffect, useRef, useState } from "react";
import {
  Activity,
  Ban,
  Copy,
  Download,
  Eye,
  Folder,
  Globe2,
  KeyRound,
  Link2,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Users,
} from "lucide-react";
import {
  api,
  type Folder as VaultFolder,
  type ShareDetail,
  type ShareSummary,
  type WebdavCredential,
  type WebdavTokenList,
} from "./api";
import { copyText } from "./clipboard";

const date = (value?: string | null) =>
  value ? new Date(value).toLocaleString("ko-KR") : "-";
const actionLabel: Record<string, string> = {
  view: "조회",
  download: "다운로드",
  denied: "차단",
};

export function SharesPage({
  folders,
  onMessage,
}: {
  folders: VaultFolder[];
  onMessage: (message: string) => void;
}) {
  const [tab, setTab] = useState<"links" | "webdav">("links");
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [selected, setSelected] = useState<ShareDetail>();
  const [dav, setDav] = useState<WebdavTokenList>();
  const [credential, setCredential] = useState<WebdavCredential>();
  const [loading, setLoading] = useState(false);
  const [actionBusy, setActionBusy] = useState("");
  const [davBusy, setDavBusy] = useState(false);
  const [davActionBusy, setDavActionBusy] = useState("");
  const [sharePassword, setSharePassword] = useState("");
  const listRequest = useRef(0);
  const detailRequest = useRef(0);
  const davRequest = useRef(0);
  const [tokenName, setTokenName] = useState("내 기기");
  const [folderId, setFolderId] = useState("");
  const [access, setAccess] = useState<"read" | "readwrite">("readwrite");

  const loadShares = async (preferredId?: string | null) => {
    const request = ++listRequest.current;
    const detailSequence = ++detailRequest.current;
    const selectedId =
      preferredId === undefined ? selected?.id : (preferredId ?? undefined);
    setLoading(true);
    try {
      const result = await api.shares();
      if (request !== listRequest.current) return false;
      setShares(result.shares);
      if (detailSequence !== detailRequest.current) return true;
      if (selectedId) {
        const match = result.shares.find((item) => item.id === selectedId);
        if (!match) {
          if (detailSequence === detailRequest.current) setSelected(undefined);
        } else {
          const detail = await api.share(selectedId);
          if (request !== listRequest.current) return false;
          setSelected(detail);
        }
      } else if (detailSequence === detailRequest.current)
        setSelected(undefined);
      return true;
    } catch (error) {
      if (request === listRequest.current)
        onMessage(
          error instanceof Error
            ? error.message
            : "공유 목록을 불러오지 못했습니다.",
        );
      return false;
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  };
  const loadDav = async () => {
    const request = ++davRequest.current;
    try {
      const result = await api.webdavTokens();
      if (request === davRequest.current) setDav(result);
    } catch (error) {
      if (request === davRequest.current)
        onMessage(
          error instanceof Error
            ? error.message
            : "WebDAV 설정을 불러오지 못했습니다.",
        );
    }
  };
  useEffect(() => {
    void loadShares();
    void loadDav();
  }, []);
  useEffect(() => {
    setSharePassword("");
  }, [selected?.id]);
  const openDetail = async (id: string) => {
    const request = ++detailRequest.current;
    try {
      const detail = await api.share(id);
      if (request === detailRequest.current) setSelected(detail);
    } catch (error) {
      if (request === detailRequest.current)
        onMessage(
          error instanceof Error
            ? error.message
            : "공유 상세를 불러오지 못했습니다.",
        );
    }
  };
  const copy = async (value: string) => {
    try {
      await copyText(value);
      onMessage("클립보드에 복사했습니다.");
    } catch {
      onMessage("클립보드에 복사하지 못했습니다. 브라우저 권한을 확인하세요.");
    }
  };
  const pause = async (item: ShareSummary) => {
    if (
      !window.confirm(
        `“${item.name}” 공유를 중지할까요? 기존 링크의 새 요청은 차단되며 나중에 같은 링크를 다시 시작할 수 있습니다.`,
      )
    )
      return;
    setActionBusy(`pause:${item.id}`);
    try {
      await api.pauseShare(item.id);
      const refreshed = await loadShares(item.id);
      onMessage(
        refreshed
          ? "공유를 중지했습니다."
          : "공유는 중지됐지만 목록을 새로고침하지 못했습니다.",
      );
    } catch (error) {
      onMessage(
        error instanceof Error ? error.message : "공유 중지에 실패했습니다.",
      );
    } finally {
      setActionBusy("");
    }
  };
  const resume = async (item: ShareSummary) => {
    if (!window.confirm(`“${item.name}” 공유를 다시 시작할까요?`)) return;
    setActionBusy(`resume:${item.id}`);
    try {
      await api.resumeShare(item.id);
      const refreshed = await loadShares(item.id);
      onMessage(
        refreshed
          ? "공유를 재개했습니다."
          : "공유는 재개됐지만 목록을 새로고침하지 못했습니다.",
      );
    } catch (error) {
      onMessage(
        error instanceof Error ? error.message : "공유 재개에 실패했습니다.",
      );
    } finally {
      setActionBusy("");
    }
  };
  const hide = async (item: ShareSummary) => {
    if (
      !window.confirm(
        item.status === "active"
          ? `“${item.name}” 공유 내역을 삭제할까요? 목록에서 숨겨지고 현재 링크의 새 요청도 차단됩니다. 진행 중인 다운로드는 완료될 수 있습니다.`
          : `“${item.name}” 공유 내역을 목록에서 삭제할까요? 통계 데이터는 내부에 보존됩니다.`,
      )
    )
      return;
    setActionBusy(`hide:${item.id}`);
    try {
      await api.hideShare(item.id);
      const refreshed = await loadShares(null);
      onMessage(
        refreshed
          ? "공유 내역을 목록에서 삭제했습니다."
          : "공유 내역은 삭제됐지만 목록을 새로고침하지 못했습니다.",
      );
    } catch (error) {
      onMessage(
        error instanceof Error
          ? error.message
          : "공유 내역 삭제에 실패했습니다.",
      );
    } finally {
      setActionBusy("");
    }
  };
  const rotate = async (item: ShareSummary) => {
    if (
      !window.confirm(
        `“${item.name}” 링크를 변경할까요? 기존 링크의 새 요청은 차단되며 진행 중인 다운로드는 완료될 수 있습니다.`,
      )
    )
      return;
    setActionBusy(`rotate:${item.id}`);
    try {
      const changed = await api.rotateShare(item.id);
      if (changed.status !== "active")
        throw new Error("변경된 공유 링크가 활성 상태가 아닙니다.");
      await copy(changed.url);
      const refreshed = await loadShares(changed.id);
      onMessage(
        refreshed
          ? "링크를 변경하고 새 주소를 복사했습니다."
          : "링크는 변경됐지만 목록을 새로고침하지 못했습니다.",
      );
    } catch (error) {
      onMessage(
        error instanceof Error ? error.message : "링크 변경에 실패했습니다.",
      );
    } finally {
      setActionBusy("");
    }
  };
  const updateShare = async (
    item: ShareSummary,
    input: Partial<{ password: string | null; access: "read" | "readwrite"; includeHidden: boolean }>,
  ) => {
    setActionBusy(`settings:${item.id}`);
    try {
      await api.updateShare(item.id, input);
      const refreshed = await loadShares(item.id);
      onMessage(
        refreshed
          ? "공유 설정을 저장했습니다."
          : "공유 설정은 저장됐지만 목록을 새로고침하지 못했습니다.",
      );
      setSharePassword("");
    } catch (error) {
      onMessage(
        error instanceof Error ? error.message : "공유 설정 저장에 실패했습니다.",
      );
    } finally {
      setActionBusy("");
    }
  };
  const createDav = async (event: React.FormEvent) => {
    event.preventDefault();
    if (davBusy || davActionBusy || credential) return;
    setDavBusy(true);
    try {
      const created = await api.createWebdavToken({
        name: tokenName,
        folderId: folderId || undefined,
        access,
      });
      setCredential(created);
      setTokenName("내 기기");
      await loadDav();
    } catch (error) {
      onMessage(
        error instanceof Error
          ? error.message
          : "WebDAV 토큰 생성에 실패했습니다.",
      );
    } finally {
      setDavBusy(false);
    }
  };
  const revokeDav = async (id: string) => {
    if (
      !window.confirm(
        "이 WebDAV 토큰을 폐기할까요? 이후 새 요청은 인증되지 않으며 이미 진행 중인 작업은 완료될 수 있습니다.",
      )
    )
      return;
    setDavActionBusy(`revoke:${id}`);
    try {
      await api.revokeWebdavToken(id);
      await loadDav();
      onMessage("WebDAV 토큰을 폐기했습니다.");
    } catch (error) {
      onMessage(
        error instanceof Error ? error.message : "토큰 폐기에 실패했습니다.",
      );
    } finally {
      setDavActionBusy("");
    }
  };
  const reissueDav = async (id: string) => {
    if (credential || davActionBusy) return;
    if (
      !window.confirm(
        "이 WebDAV 토큰을 재발행할까요? 기존 토큰은 즉시 사용할 수 없으며 새 토큰은 한 번만 표시됩니다.",
      )
    )
      return;
    setDavActionBusy(`reissue:${id}`);
    try {
      const reissued = await api.reissueWebdavToken(id);
      setCredential(reissued);
      await loadDav();
    } catch (error) {
      onMessage(
        error instanceof Error
          ? error.message
          : "토큰 재발행에 실패했습니다.",
      );
    } finally {
      setDavActionBusy("");
    }
  };

  return (
    <section className="workspace-page share-page">
      <header className="page-hero">
        <div>
          <p className="eyebrow">CONTROLLED ACCESS</p>
          <h1>공유</h1>
          <p>원본 링크와 WebDAV 기기 접근을 한 곳에서 관리합니다.</p>
        </div>
        <div className="page-actions">
          <button
            className="secondary"
            aria-label="새로고침"
            title="새로고침"
            onClick={() => void Promise.all([loadShares(), loadDav()])}
            disabled={loading}
          >
            <RefreshCw className={loading ? "spin" : ""} />
            <span>새로고침</span>
          </button>
        </div>
      </header>
      <div className="section-tabs">
        <button
          className={tab === "links" ? "active" : ""}
          onClick={() => setTab("links")}
        >
          <Link2 />
          공유 링크
        </button>
        <button
          className={tab === "webdav" ? "active" : ""}
          onClick={() => setTab("webdav")}
        >
          <Globe2 />
          WebDAV
        </button>
      </div>
      {tab === "links" ? (
        <div className="share-layout">
          <div className="panel-card">
            <div className="panel-heading">
              <div>
                <span className="kicker">SHARED ITEMS</span>
                <h2>공유 항목</h2>
              </div>
              <span className="count-pill">{shares.length}</span>
            </div>
            {!shares.length ? (
              <div className="panel-empty">
                <Link2 />
                <h3>아직 공유한 항목이 없습니다</h3>
                <p>
                  내 파일에서 하나의 파일 또는 폴더를 선택한 뒤 공유 버튼을
                  누르세요.
                </p>
              </div>
            ) : (
              <div className="share-list">
                {shares.map((item) => (
                  <article
                    className={`share-list-item ${selected?.id === item.id ? "selected" : ""}`}
                    key={item.id}
                  >
                    <button
                      className="share-open"
                      onClick={() => void openDetail(item.id)}
                    >
                      <div className="resource-mark">
                        {item.type === "folder" ? <Folder /> : <Link2 />}
                      </div>
                      <div className="share-main">
                        <strong>{item.name}</strong>
                        <small>
                          {date(item.createdAt)} 생성 · 최근{" "}
                          {date(item.lastAccessAt)}
                        </small>
                      </div>
                      <span className={`state-chip ${item.status}`}>
                        {item.status === "active"
                          ? "공유 중"
                          : item.status === "paused"
                            ? "중지됨"
                          : item.status === "unavailable"
                            ? "원본 삭제됨"
                            : item.status === "revoked"
                              ? "취소됨"
                              : "만료됨"}
                      </span>
                    </button>
                    <button
                      className="icon-action"
                      title="공유 URL 복사"
                      disabled={item.status !== "active" || !!actionBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void copy(item.url);
                      }}
                    >
                      <Copy />
                    </button>
                    <button
                      className="icon-action"
                      title={
                        item.status === "active"
                          ? "링크 변경"
                          : item.status === "paused"
                            ? "공유 재개"
                            : "사용할 수 없는 공유"
                      }
                      disabled={
                        (item.status !== "active" && item.status !== "paused") ||
                        !!actionBusy
                      }
                      onClick={(event) => {
                        event.stopPropagation();
                        void (item.status === "active"
                          ? rotate(item)
                          : resume(item));
                      }}
                    >
                      <RefreshCw />
                    </button>
                    <button
                      className="icon-action danger"
                      title="공유 중지"
                      disabled={item.status !== "active" || !!actionBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void pause(item);
                      }}
                    >
                      <Ban />
                    </button>
                    <button
                      className="icon-action danger"
                      title="공유 내역 삭제"
                      disabled={!!actionBusy}
                      onClick={(event) => {
                        event.stopPropagation();
                        void hide(item);
                      }}
                    >
                      <Trash2 />
                    </button>
                  </article>
                ))}
              </div>
            )}
          </div>
          <div className="panel-card share-detail">
            {selected ? (
              <>
                <div className="panel-heading">
                  <div>
                    <span className="kicker">SHARE DETAIL</span>
                    <h2>{selected.name}</h2>
                  </div>
                  <div className="detail-actions">
                    <button
                      className="secondary compact"
                      disabled={selected.status !== "active" || !!actionBusy}
                      onClick={() => void copy(selected.url)}
                    >
                      <Copy />
                      링크 복사
                    </button>
                    {selected.status === "active" ? (
                      <button
                        className="secondary compact"
                        disabled={!!actionBusy}
                        onClick={() => void rotate(selected)}
                      >
                        <RefreshCw />
                        링크 변경
                      </button>
                    ) : selected.status === "paused" ? (
                      <button
                        className="secondary compact"
                        disabled={!!actionBusy}
                        onClick={() => void resume(selected)}
                      >
                        <RefreshCw />
                        공유 재개
                      </button>
                    ) : null}
                    <button
                      className="secondary compact danger-compact"
                      disabled={selected.status !== "active" || !!actionBusy}
                      onClick={() => void pause(selected)}
                    >
                      <Ban />
                      공유 중지
                    </button>
                    <button
                      className="secondary compact danger-compact"
                      disabled={!!actionBusy}
                      onClick={() => void hide(selected)}
                    >
                      <Trash2 />
                      내역 삭제
                    </button>
                  </div>
                </div>
                <div className="metric-grid">
                  <div>
                    <Eye />
                    <span>열람</span>
                    <strong>{selected.viewCount}</strong>
                  </div>
                  <div>
                    <Download />
                    <span>다운로드</span>
                    <strong>{selected.downloadCount}</strong>
                  </div>
                  <div>
                    <Users />
                    <span>접속자 IP</span>
                    <strong>{selected.visitorCount}</strong>
                  </div>
                  <div>
                    <Activity />
                    <span>성공 액션</span>
                    <strong>{selected.accessCount}</strong>
                  </div>
                </div>
                <div className="share-url">
                  <span>공유 URL</span>
                  <code>{selected.url}</code>
                </div>
                <section className="share-settings-panel" aria-label="공유 설정">
                  <h3 className="subheading">접근 설정</h3>
                  {selected.type === "folder" && (
                    <>
                      <label>
                        권한
                        <select
                          value={selected.access}
                          disabled={!!actionBusy}
                          onChange={(event) =>
                            void updateShare(selected, {
                              access: event.target.value as "read" | "readwrite",
                            })
                          }
                        >
                          <option value="read">보기</option>
                          <option value="readwrite">보기 및 수정</option>
                        </select>
                      </label>
                      <label className="check-label">
                        <input
                          type="checkbox"
                          checked={selected.includeHidden}
                          disabled={!!actionBusy}
                          onChange={(event) => void updateShare(selected, { includeHidden: event.target.checked })}
                        />
                        숨김 파일도 공유
                      </label>
                    </>
                  )}
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void updateShare(selected, { password: sharePassword });
                    }}
                  >
                    <label>
                      공유 비밀번호
                      <input
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        maxLength={72}
                        value={sharePassword}
                        onChange={(event) => setSharePassword(event.target.value)}
                        placeholder={
                          selected.hasPassword
                            ? "새 비밀번호 입력"
                            : "선택사항"
                        }
                        required
                        disabled={!!actionBusy}
                      />
                    </label>
                    <button className="secondary compact" disabled={!!actionBusy}>
                      {selected.hasPassword ? "비밀번호 변경" : "비밀번호 설정"}
                    </button>
                    {selected.hasPassword && (
                      <button
                        type="button"
                        className="secondary compact"
                        disabled={!!actionBusy}
                        onClick={() => {
                          if (window.confirm("공유 비밀번호를 해제할까요?"))
                            void updateShare(selected, { password: null });
                        }}
                      >
                        비밀번호 해제
                      </button>
                    )}
                  </form>
                </section>
                <h3 className="subheading">최근 접속 기록</h3>
                {!selected.events.length ? (
                  <div className="inline-empty">아직 접속 기록이 없습니다.</div>
                ) : (
                  <div className="event-table">
                    <div className="event-head">
                      <span>액션</span>
                      <span>접속자 IP</span>
                      <span>일시</span>
                    </div>
                    {selected.events.map((event) => (
                      <div key={event.id}>
                        <span className={`event-action ${event.action}`}>
                          {actionLabel[event.action] ?? event.action}
                        </span>
                        <code>{event.ip}</code>
                        <time>{date(event.createdAt)}</time>
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="panel-empty detail-placeholder">
                <ShieldCheck />
                <h3>공유 상세</h3>
                <p>
                  왼쪽에서 공유 항목을 선택하면 접속자 수, 열람, 다운로드 및
                  IP별 액션을 확인할 수 있습니다.
                </p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="dav-layout">
          <div className="panel-card">
            <div className="panel-heading">
              <div>
                <span className="kicker">DEVICE CREDENTIAL</span>
                <h2>WebDAV 토큰 만들기</h2>
              </div>
              <KeyRound />
            </div>
            <p className="panel-copy">
              계정 비밀번호 대신 폐기 가능한 전용 토큰을 사용합니다. 토큰은 생성
              직후 한 번만 표시됩니다.
            </p>
            <form className="settings-form" onSubmit={createDav}>
              <label>
                토큰 이름
                <input
                  value={tokenName}
                  onChange={(event) => setTokenName(event.target.value)}
                  maxLength={80}
                  required
                  placeholder="예: 회사 노트북"
                />
              </label>
              <label>
                공유할 폴더
                <select
                  value={folderId}
                  onChange={(event) => setFolderId(event.target.value)}
                >
                  <option value="">내 파일 전체</option>
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.relativePath}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                권한
                <select
                  value={access}
                  onChange={(event) =>
                    setAccess(event.target.value as "read" | "readwrite")
                  }
                >
                  <option value="readwrite">읽기 및 쓰기</option>
                  <option value="read">읽기 전용</option>
                </select>
              </label>
              <button
                className="primary"
                disabled={davBusy || !!davActionBusy || !!credential}
              >
                <Plus />
                {davBusy ? "생성 중" : "토큰 생성"}
              </button>
            </form>
          </div>
          <div className="panel-card">
            <div className="panel-heading">
              <div>
                <span className="kicker">CONNECTION GUIDE</span>
                <h2>연결 안내</h2>
              </div>
              <Globe2 />
            </div>
            <div className="connection-field">
              <span>서버 URL</span>
              <code>{dav?.url ?? "/webdav/"}</code>
              <button
                onClick={() =>
                  void copy(dav?.url ?? `${location.origin}/webdav/`)
                }
              >
                <Copy />
              </button>
            </div>
            <div className="connection-field">
              <span>사용자 이름</span>
              <code>{dav?.username ?? "-"}</code>
              <button onClick={() => dav && void copy(dav.username)}>
                <Copy />
              </button>
            </div>
            <div className="guide-note">
              <strong>기본 경로는 /webdav/ 입니다.</strong>
              <p>
                Windows 네트워크 위치, macOS Finder의 서버 연결, Cyberduck 또는
                rclone에서 WebDAV 주소로 입력하세요. HTTP 환경에서는 일부
                운영체제가 Basic 인증을 차단하므로 외부 사용 시 HTTPS를
                권장합니다.
              </p>
            </div>
            <h3 className="subheading">발급된 토큰</h3>
            <div className="token-list">
              {dav?.tokens
                .filter((item) => !item.revokedAt)
                .map((item) => (
                  <div key={item.id}>
                    <div>
                      <strong>{item.name}</strong>
                      <small>
                        {item.folderName} ·{" "}
                        {item.access === "read" ? "읽기 전용" : "읽기/쓰기"} ·
                        최근 사용 {date(item.lastUsedAt)}
                      </small>
                    </div>
                    <div className="token-actions">
                      <button
                        onClick={() => void reissueDav(item.id)}
                        disabled={davBusy || !!davActionBusy || !!credential}
                      >
                        <RefreshCw
                          className={
                            davActionBusy === `reissue:${item.id}`
                              ? "spin"
                              : ""
                          }
                        />
                        재발행
                      </button>
                      <button
                        className="danger-text"
                        onClick={() => void revokeDav(item.id)}
                        disabled={davBusy || !!davActionBusy}
                      >
                        폐기
                      </button>
                    </div>
                  </div>
                ))}
              {!dav?.tokens.some((item) => !item.revokedAt) && (
                <div className="inline-empty">사용 중인 토큰이 없습니다.</div>
              )}
            </div>
          </div>
        </div>
      )}
      {credential && (
        <div className="modal-backdrop" role="presentation">
          <div
            className="modal-card credential-modal"
            role="dialog"
            aria-modal="true"
          >
            <div className="credential-icon">
              <KeyRound />
            </div>
            <p className="eyebrow">ONE-TIME SECRET</p>
            <h2>토큰을 지금 저장하세요</h2>
            <p>보안을 위해 이 값은 다시 확인할 수 없습니다.</p>
            <div className="secret-box">
              <code>{credential.token}</code>
              <button onClick={() => void copy(credential.token)}>
                <Copy />
              </button>
            </div>
            <dl>
              <div>
                <dt>URL</dt>
                <dd>{credential.url}</dd>
              </div>
              <div>
                <dt>사용자</dt>
                <dd>{credential.username}</dd>
              </div>
            </dl>
            <button
              className="primary"
              autoFocus
              onClick={() => setCredential(undefined)}
            >
              저장했습니다
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
