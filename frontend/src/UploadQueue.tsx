import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  CircleCheck,
  CircleX,
  File,
  Folder,
  Info,
  LoaderCircle,
  Pause,
  Play,
  RefreshCw,
  Trash2,
  Upload,
  X,
} from "lucide-react";

export type UploadStatus =
  "preparing" | "queued" | "uploading" | "paused" | "completed" | "failed";
export interface UploadTask {
  id: string;
  file?: File;
  fileName: string;
  sizeBytes: number;
  lastModified: number;
  mimeType: string;
  fingerprint: string;
  contentSha256?: string;
  relativeDirectory: string;
  destinationFolderId?: string;
  destinationLabel: string;
  sessionId?: string;
  uploadedBytes: number;
  status: UploadStatus;
  progress: number;
  error?: string;
}

type Filter = "all" | UploadStatus;
const filterLabels: Record<Filter, string> = {
  all: "전체",
  preparing: "검증중",
  completed: "완료",
  uploading: "진행중",
  queued: "대기중",
  paused: "재선택 필요",
  failed: "실패",
};
const statusLabels: Record<UploadStatus, string> = {
  preparing: "검증중",
  completed: "완료",
  uploading: "진행중",
  queued: "대기중",
  paused: "일시중단",
  failed: "실패",
};

const taskProgressBytes = (task: UploadTask) =>
  task.status === "completed" ? task.sizeBytes : task.uploadedBytes;
const groupStatus = (tasks: UploadTask[]): UploadStatus =>
  tasks.some((task) => task.status === "uploading")
    ? "uploading"
    : tasks.some((task) => task.status === "preparing")
      ? "preparing"
      : tasks.some((task) => task.status === "failed")
        ? "failed"
        : tasks.some((task) => task.status === "paused")
          ? "paused"
          : tasks.some((task) => task.status === "queued")
            ? "queued"
            : "completed";

export function UploadQueue({
  tasks,
  batch,
  onRemove,
  onRetry,
  onClearCompleted,
  onPauseAll,
  onResumeAll,
  onCancelAll,
}: {
  tasks: UploadTask[];
  batch: number;
  onRemove: (ids: string[]) => void;
  onRetry: (id: string) => void;
  onClearCompleted: () => void;
  onPauseAll: () => void;
  onResumeAll: () => void;
  onCancelAll: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState(true);
  const [hidden, setHidden] = useState(false);
  const [errorTaskId, setErrorTaskId] = useState<string>();
  const previousFailedCount = useRef(0);
  useEffect(() => {
    if (batch) {
      setCollapsed(true);
      setHidden(false);
    }
  }, [batch]);
  const counts = useMemo(
    () => ({
      preparing: tasks.filter((task) => task.status === "preparing").length,
      completed: tasks.filter((task) => task.status === "completed").length,
      uploading: tasks.filter((task) => task.status === "uploading").length,
      queued: tasks.filter((task) => task.status === "queued").length,
      paused: tasks.filter((task) => task.status === "paused").length,
      failed: tasks.filter((task) => task.status === "failed").length,
    }),
    [tasks],
  );
  const errorTask = tasks.find((task) => task.id === errorTaskId);
  useEffect(() => {
    if (counts.failed > previousFailedCount.current) {
      setCollapsed(false);
      setHidden(false);
      setFilter("failed");
    }
    previousFailedCount.current = counts.failed;
  }, [counts.failed]);
  useEffect(() => {
    if (!errorTaskId) return;
    if (!errorTask) {
      setErrorTaskId(undefined);
      return;
    }
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setErrorTaskId(undefined);
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [errorTask, errorTaskId]);
  const totalBytes = tasks.reduce((sum, task) => sum + task.sizeBytes, 0);
  const completedBytes = tasks.reduce(
    (sum, task) => sum + taskProgressBytes(task),
    0,
  );
  const overallProgress = totalBytes
    ? Math.round((completedBytes / totalBytes) * 100)
    : tasks.length
      ? Math.round((counts.completed / tasks.length) * 100)
      : 0;
  const visible =
    filter === "all" ? tasks : tasks.filter((task) => task.status === filter);
  const groups = useMemo(() => {
    const result = new Map<string, UploadTask[]>();
    for (const task of visible) {
      const key = `${task.destinationFolderId ?? "root"}\u0000${task.relativeDirectory || "__files__"}`;
      result.set(key, [...(result.get(key) ?? []), task]);
    }
    return [...result.entries()];
  }, [visible]);
  const folderCount = new Set(
    tasks
      .filter((task) => task.relativeDirectory)
      .map(
        (task) =>
          `${task.destinationFolderId ?? "root"}\u0000${task.relativeDirectory}`,
      ),
  ).size;
  const activeCount = counts.preparing + counts.queued + counts.uploading;
  const resumablePausedCount = tasks.filter(
    (task) => task.status === "paused" && task.file,
  ).length;
  const canCancel = activeCount + counts.paused + counts.failed > 0;

  if (!tasks.length) return null;
  if (hidden)
    return (
      <button className="upload-panel-launcher" onClick={() => setHidden(false)}>
        <Upload />
        업로드 {activeCount ? `${activeCount}개 진행` : `${tasks.length}개`}
      </button>
    );
  return (
    <>
    <section className={`upload-panel ${collapsed ? "collapsed" : ""}`} role="dialog" aria-label="업로드 상태">
      <div className="upload-panel-head">
        <div>
          <p className="eyebrow">UPLOAD QUEUE</p>
          <h2>업로드 작업</h2>
          <span>
            {folderCount}개 폴더 · {tasks.length}개 파일
          </span>
        </div>
        <div className="upload-total">
          <strong>{overallProgress}%</strong>
          <span>
            {counts.completed}/{tasks.length} 완료
          </span>
        </div>
        <div className="upload-panel-controls">
          <button
            className="upload-panel-toggle"
            aria-label={collapsed ? "업로드 상태 열기" : "업로드 상태 접기"}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <ChevronUp /> : <ChevronDown />}
          </button>
          <button className="upload-panel-toggle" aria-label="업로드 상태 숨기기" onClick={() => { setErrorTaskId(undefined); setHidden(true); }}>
            <X />
          </button>
        </div>
      </div>
      {!collapsed && (
        <>
          <div className="overall-track">
            <span style={{ width: `${overallProgress}%` }} />
          </div>
          <div className="upload-summary">
            {counts.preparing > 0 && (
              <span className="summary-preparing">
                <LoaderCircle />
                {counts.preparing} SHA-256 검증중
              </span>
            )}
            <span className="summary-uploading">
              <LoaderCircle />
              {counts.uploading} 진행중
            </span>
            <span>{counts.queued} 대기중</span>
            <span>{counts.completed} 완료</span>
            {counts.paused > 0 && (
              <span className="summary-paused">{counts.paused} 일시중단</span>
            )}
            {counts.failed > 0 && (
              <span className="summary-failed">{counts.failed} 실패</span>
            )}
          </div>
          <div className="queue-toolbar">
            <div className="queue-filters">
              {(Object.keys(filterLabels) as Filter[]).map((value) => (
                <button
                  key={value}
                  className={filter === value ? "active" : ""}
                  onClick={() => setFilter(value)}
                >
                  {filterLabels[value]}
                  {value !== "all" && <small>{counts[value]}</small>}
                </button>
              ))}
            </div>
            <div className="queue-bulk-actions">
              {activeCount > 0 && (
                <button onClick={onPauseAll}><Pause />일괄 중지</button>
              )}
              {resumablePausedCount > 0 && (
                <button onClick={onResumeAll}><Play />일괄 재개</button>
              )}
              {canCancel && (
                <button className="danger" onClick={onCancelAll}><Trash2 />일괄 취소</button>
              )}
              {counts.completed > 0 && (
                <button className="clear-completed" onClick={onClearCompleted}>
                  완료 지우기
                </button>
              )}
            </div>
          </div>
          <div className="queue-list">
            {!visible.length && (
              <div className="queue-empty">이 상태의 항목이 없습니다.</div>
            )}
            {groups.map(([groupKey, groupTasks]) => {
              const firstTask = groupTasks[0]!;
              const isLooseFiles = !firstTask.relativeDirectory;
              const status = groupStatus(groupTasks);
              const groupBytes = groupTasks.reduce(
                (sum, task) => sum + task.sizeBytes,
                0,
              );
              const progress = groupBytes
                ? Math.round(
                    (groupTasks.reduce(
                      (sum, task) => sum + taskProgressBytes(task),
                      0,
                    ) /
                      groupBytes) *
                      100,
                  )
                : Math.round(
                    (groupTasks.filter((task) => task.status === "completed")
                      .length /
                      groupTasks.length) *
                      100,
                  );
              return (
                <div className="upload-group" key={groupKey}>
                  <div className="upload-group-head">
                    <div className="queue-kind">
                      {isLooseFiles ? <File /> : <Folder />}
                    </div>
                    <div>
                      <strong>
                        {isLooseFiles
                          ? `${firstTask.destinationLabel} · 선택한 파일`
                          : firstTask.destinationLabel}
                      </strong>
                      <small>
                        {
                          groupTasks.filter((task) => task.status === "completed")
                            .length
                        }
                        /{groupTasks.length} 처리 · {progress}%
                      </small>
                    </div>
                    <span className={`status-badge ${status}`}>
                      {statusLabels[status]}
                    </span>
                    <button
                      className="queue-remove"
                      title="이 그룹을 업로드 목록에서 삭제"
                      onClick={() => onRemove(groupTasks.map((task) => task.id))}
                    >
                      <Trash2 />
                    </button>
                  </div>
                  {groupTasks.map((task) => (
                    <div className="upload-row" key={task.id}>
                      <div className={`task-state ${task.status}`}>
                        {task.status === "completed" ? (
                          <CircleCheck />
                        ) : task.status === "failed" ? (
                          <CircleX />
                        ) : task.status === "uploading" ||
                          task.status === "preparing" ? (
                          <LoaderCircle />
                        ) : (
                          <Upload />
                        )}
                      </div>
                      <div className="task-info">
                        <strong title={task.fileName}>{task.fileName}</strong>
                        <small title={task.error}>
                          {task.status === "preparing"
                            ? "이어받기 무결성을 위해 파일 SHA-256을 계산하고 있습니다."
                            : task.status === "paused"
                              ? task.file
                                ? "업로드가 일시중단되었습니다. 일괄 재개할 수 있습니다."
                                : "이어서 업로드하려면 동일한 파일 또는 폴더를 다시 선택하세요."
                              : task.destinationLabel}
                          {task.error ? ` · ${task.error}` : ""}
                        </small>
                        <div className="task-track">
                          <span style={{ width: `${task.progress}%` }} />
                        </div>
                      </div>
                      <span className="task-percent">
                        {task.status === "queued"
                          ? "대기"
                          : task.status === "paused"
                            ? "중단"
                            : task.status === "preparing"
                              ? `검증 ${task.progress}%`
                               : `${task.progress}%`}
                      </span>
                      <div className="task-actions">
                        {task.status === "failed" && (<>
                          <button
                            className="queue-error-detail"
                            onClick={() => setErrorTaskId(task.id)}
                          >
                            <Info />오류 보기
                          </button>
                          <button
                            className="queue-retry"
                            onClick={() => onRetry(task.id)}
                          >
                            <RefreshCw />재업로드
                          </button>
                        </>)}
                        <button
                          className="queue-remove"
                          title={
                            task.status === "uploading"
                              ? "업로드 취소"
                              : "목록에서 삭제"
                          }
                          onClick={() => onRemove([task.id])}
                        >
                          <Trash2 />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
    {errorTask && (
      <div
        className="modal-backdrop upload-error-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setErrorTaskId(undefined);
        }}
      >
        <section
          className="move-dialog upload-error-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="upload-error-title"
          aria-describedby="upload-error-message"
        >
          <header>
            <div className="modal-icon upload-error-icon"><CircleX /></div>
            <div>
              <p className="eyebrow">UPLOAD FAILED</p>
              <h2 id="upload-error-title">업로드 오류</h2>
            </div>
            <button className="icon-btn" aria-label="오류 닫기" onClick={() => setErrorTaskId(undefined)}><X /></button>
          </header>
          <div className="upload-error-file">
            <strong>{errorTask.fileName}</strong>
            <span>{errorTask.destinationLabel}</span>
          </div>
          <pre id="upload-error-message">{errorTask.error ?? "알 수 없는 업로드 오류가 발생했습니다."}</pre>
          <footer>
            <button className="secondary" onClick={() => setErrorTaskId(undefined)}>닫기</button>
            <button className="primary" onClick={() => { setErrorTaskId(undefined); onRetry(errorTask.id); }}><RefreshCw />재업로드</button>
          </footer>
        </section>
      </div>
    )}
    </>
  );
}
