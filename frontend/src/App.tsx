import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createSHA256 } from "hash-wasm";
import {
  Archive,
  ChevronRight,
  ClipboardPaste,
  Copy,
  CornerUpLeft,
  Download,
  Eye,
  File,
  FileImage,
  Files as FilesIcon,
  FileVideo,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderUp,
  Info,
  LogOut,
  MoreHorizontal,
  Package,
  Pencil,
  RefreshCw,
  Settings,
  Share2,
  ShieldCheck,
  Scissors,
  Trash2,
  Undo2,
  Upload,
  X,
} from "lucide-react";
import {
  api,
  type BulkSelection,
  type CollisionChoice,
  type FileDetail,
  type Folder as VaultFolder,
  type FolderDetail,
  type ServerStorage,
  type StorageUsage,
  type UserProfile,
  type VaultFile,
  session,
} from "./api";
import { FolderTree } from "./FolderTree";
import { formatBytes } from "./format";
import { PublicSharePage } from "./PublicSharePage";
import { SettingsPage } from "./SettingsPage";
import { SharesPage } from "./SharesPage";
import { TrashPage } from "./TrashPage";
import { UploadQueue, type UploadTask } from "./UploadQueue";
import { SelectionToolbar } from "./SelectionToolbar";
import { MoveDialog } from "./MoveDialog";
import { PreviewViewer } from "./PreviewViewer";
import { ShareDialog } from "./ShareDialog";
import { CollisionDialog } from "./CollisionDialog";
import { ListingControls, type ListingSortDirection, type ListingSortField, type ListingViewMode } from "./ListingControls";
import { beginClipboardCopy, copyText } from "./clipboard";
const UPLOAD_CHUNK_BYTES = 5 * 1024 * 1024;
const HASH_CHUNK_BYTES = 8 * 1024 * 1024;
const HASH_CONCURRENCY = 2;
let activeHashJobs = 0;
const hashWaiters: Array<() => void> = [];
const runHashLimited = async <T,>(work: () => Promise<T>): Promise<T> => {
  if (activeHashJobs >= HASH_CONCURRENCY)
    await new Promise<void>((resolve) => hashWaiters.push(resolve));
  activeHashJobs += 1;
  try {
    return await work();
  } finally {
    activeHashJobs -= 1;
    hashWaiters.shift()?.();
  }
};
const createClientId = () => {
  if (typeof globalThis.crypto?.randomUUID === "function")
    return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === "function")
    globalThis.crypto.getRandomValues(bytes);
  else
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const hashFile = async (
  file: File,
  isCancelled: () => boolean,
  onProgress: (progress: number) => void,
) => {
  const hasher = await createSHA256();
  for (let offset = 0; offset < file.size; offset += HASH_CHUNK_BYTES) {
    if (isCancelled())
      throw new DOMException("File verification cancelled", "AbortError");
    const end = Math.min(offset + HASH_CHUNK_BYTES, file.size);
    hasher.update(new Uint8Array(await file.slice(offset, end).arrayBuffer()));
    onProgress(file.size ? Math.round((end / file.size) * 100) : 100);
  }
  if (isCancelled())
    throw new DOMException("File verification cancelled", "AbortError");
  return hasher.digest("hex");
};
const uploadQueueKey = (username: string) =>
  `originvault.uploadQueue.${username}`;
const restoreUploadQueue = (username: string): UploadTask[] => {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(uploadQueueKey(username)) ?? "[]",
    ) as UploadTask[];
    return parsed.map((task) => ({
      ...task,
      file: undefined,
      status: task.status === "completed" ? "completed" : "paused",
      error: undefined,
    }));
  } catch {
    return [];
  }
};
const detailValue = (value: unknown) => {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};
const detailDate = (value?: string | null) => {
  if (!value) return "알 수 없음";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("ko-KR") : "알 수 없음";
};
const listDate = (value?: string | null) => {
  if (!value) return "알 수 없음";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString("ko-KR") : "알 수 없음";
};

type ItemMenuTarget =
  | {
      type: "folder";
      item: VaultFolder;
    }
  | {
      type: "file";
      item: VaultFile;
    };
type ItemContextMenu = (
  | ItemMenuTarget
  | {
      type: "background";
    }
) & {
  x: number;
  y: number;
  focusMenu?: boolean;
};
type FileClipboard = {
  mode: "copy" | "cut";
  selections: BulkSelection[];
};
type UploadCandidate = { file: File; relativeDirectory: string };
type CollisionPrompt = {
  operation: "업로드" | "복사" | "이동";
  conflicts: Array<{ key: string; name: string }>;
  index: number;
};
type LegacyFileEntry = {
  isFile: true;
  isDirectory: false;
  name: string;
  file: (success: (file: File) => void, failure: (error: DOMException) => void) => void;
};
type LegacyDirectoryEntry = {
  isFile: false;
  isDirectory: true;
  name: string;
  createReader: () => {
    readEntries: (
      success: (entries: LegacyFileSystemEntry[]) => void,
      failure: (error: DOMException) => void,
    ) => void;
  };
};
type LegacyFileSystemEntry = LegacyFileEntry | LegacyDirectoryEntry;
type DataTransferItemWithEntry = {
  webkitGetAsEntry?: () => LegacyFileSystemEntry | null;
};

const INTERNAL_DRAG_TYPE = "application/x-originvault-items";
const nameCollator = new Intl.Collator("ko", {
  numeric: true,
  sensitivity: "base",
});

const readLegacyDirectory = async (
  entry: LegacyDirectoryEntry,
): Promise<LegacyFileSystemEntry[]> => {
  const reader = entry.createReader();
  const entries: LegacyFileSystemEntry[] = [];
  while (true) {
    const batch = await new Promise<LegacyFileSystemEntry[]>((resolve, reject) =>
      reader.readEntries(resolve, reject),
    );
    if (!batch.length) return entries;
    entries.push(...batch);
  }
};

const droppedEntryFiles = async (
  entry: LegacyFileSystemEntry,
  directory = "",
): Promise<UploadCandidate[]> => {
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) =>
      entry.file(resolve, reject),
    );
    return [{ file, relativeDirectory: directory }];
  }
  const descendants = await readLegacyDirectory(entry);
  const nextDirectory = directory ? `${directory}/${entry.name}` : entry.name;
  return (
    await Promise.all(
      descendants.map((child) => droppedEntryFiles(child, nextDirectory)),
    )
  ).flat();
};

const droppedFiles = async (dataTransfer: DataTransfer): Promise<UploadCandidate[]> => {
  const items = Array.from(dataTransfer.items);
  if (!items.length)
    return Array.from(dataTransfer.files).map((file) => ({
      file,
      relativeDirectory: "",
    }));
  return (
    await Promise.all(
      items.map(async (item) => {
        if (item.kind !== "file") return [];
        const entry = (item as unknown as DataTransferItemWithEntry)
          .webkitGetAsEntry?.();
        if (entry) return droppedEntryFiles(entry);
        const file = item.getAsFile();
        return file ? [{ file, relativeDirectory: "" }] : [];
      }),
    )
  ).flat();
};

function FileThumbnail({
  file,
  fallback: Fallback,
}: {
  file: VaultFile;
  fallback: React.ComponentType<{ size?: number }>;
}) {
  const [previewUrl, setPreviewUrl] = useState("");
  const isImage = file.mimeType.startsWith("image/");
  const isVideo = file.mimeType.startsWith("video/");
  useEffect(() => {
    if (!isImage && !isVideo) return;
    let active = true;
    void api
      .filePreview(file.id)
      .then((result) => {
        if (active) setPreviewUrl(result.file.streamUrl ?? "");
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [file.id, isImage, isVideo]);

  return (
    <div className="file-preview-thumb" aria-hidden="true">
      {previewUrl && isImage ? (
        <img src={previewUrl} alt="" loading="lazy" />
      ) : previewUrl && isVideo ? (
        <video src={previewUrl} muted playsInline preload="metadata" />
      ) : (
        <Fallback size={36} />
      )}
    </div>
  );
}

function Auth({ onDone }: { onDone: (user: UserProfile) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [registration, setRegistration] = useState<{
    registrationEnabled: boolean;
    bootstrapRequired: boolean;
  }>({ registrationEnabled: false, bootstrapRequired: false });
  useEffect(() => {
    void api
      .registrationStatus()
      .then(setRegistration)
      .catch(() => undefined);
  }, []);
  const canRegister =
    registration.registrationEnabled || registration.bootstrapRequired;
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await api.auth(mode, username, password);
      session.set(result.token);
      onDone(result.user);
    } catch (e) {
      setError(e instanceof Error ? e.message : "요청에 실패했습니다.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-shell">
      <section className="auth-brand">
        <div className="logo">
          <Archive size={25} />
        </div>
        <span>ORIGINVAULT</span>
        <h1>
          원본은,
          <br />
          <em>원본 그대로.</em>
        </h1>
        <p>
          사진의 EXIF부터 파일의 마지막 바이트까지.
          <br />
          변형 없는 개인 파일 금고입니다.
        </p>
        <div className="promise">
          <ShieldCheck />
          <div>
            <strong>무손실 원본 보관</strong>
            <small>업로드와 다운로드의 SHA-256을 검증합니다.</small>
          </div>
        </div>
      </section>
      <form className="auth-card" onSubmit={submit}>
        <p className="eyebrow">PRIVATE BACKUP</p>
        <h2>
          {mode === "login" ? "다시 만나 반가워요" : "나만의 금고 만들기"}
        </h2>
        <p>
          {mode === "login"
            ? "보관한 원본 파일을 확인하세요."
            : "몇 초면 안전한 백업을 시작할 수 있어요."}
        </p>
        <label>
          아이디
          <input
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </label>
        <label>
          비밀번호
          <input
            autoComplete={
              mode === "login" ? "current-password" : "new-password"
            }
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>
          {busy ? "처리 중…" : mode === "login" ? "로그인" : "회원가입"}
        </button>
        {(canRegister || mode === "register") && (
          <button
            type="button"
            className="text-button"
            onClick={() => setMode(mode === "login" ? "register" : "login")}
          >
            {mode === "login"
              ? "처음이신가요? 회원가입"
              : "이미 계정이 있나요? 로그인"}
          </button>
        )}
        {!canRegister && mode === "login" && (
          <small className="registration-closed">
            관리자 설정에 의해 신규 회원가입이 닫혀 있습니다.
          </small>
        )}
      </form>
    </main>
  );
}

function Dashboard({
  user,
  storage,
  serverStorage,
  onUserChanged,
  onStorageChanged,
  onServerStorageChanged,
  onLogout,
}: {
  user: UserProfile;
  storage: StorageUsage;
  serverStorage: ServerStorage | null;
  onUserChanged: (user: UserProfile) => void;
  onStorageChanged: (storage: StorageUsage) => void;
  onServerStorageChanged: (storage: ServerStorage | null) => void;
  onLogout: () => void;
}) {
  const username = user.username;
  const [activeView, setActiveView] = useState<"files" | "shares" | "trash" | "settings">(
    "files",
  );
  const [items, setItems] = useState<{
    folders: VaultFolder[];
    files: VaultFile[];
  }>({ folders: [], files: [] });
  const [allFolders, setAllFolders] = useState<VaultFolder[]>([]);
  const [trail, setTrail] = useState<VaultFolder[]>([]);
  const [previewFile, setPreviewFile] = useState<VaultFile>();
  const [message, setMessage] = useState("");
  const [uploadTasks, setUploadTasks] = useState<UploadTask[]>(() =>
    restoreUploadQueue(username),
  );
  const [uploadBatch, setUploadBatch] = useState(0);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [selectionBox, setSelectionBox] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>();
  const [moveOpen, setMoveOpen] = useState(false);
  const [moveDestination, setMoveDestination] = useState("");
  const [shareDialogTarget, setShareDialogTarget] = useState<{
    type: "file" | "folder";
    id: string;
    name: string;
  }>();
  const [bulkBusy, setBulkBusy] = useState(false);
  const [treeRefreshing, setTreeRefreshing] = useState(false);
  const [filesRefreshing, setFilesRefreshing] = useState(false);
  const [mobileTreeOpen, setMobileTreeOpen] = useState(false);
  const [contextMenu, setContextMenu] = useState<ItemContextMenu>();
  const [collisionPrompt, setCollisionPrompt] = useState<CollisionPrompt>();
  const [detailTarget, setDetailTarget] = useState<VaultFile>();
  const [fileDetail, setFileDetail] = useState<FileDetail>();
  const [detailLoading, setDetailLoading] = useState(false);
  const [folderDetailTarget, setFolderDetailTarget] = useState<VaultFolder>();
  const [folderDetail, setFolderDetail] = useState<FolderDetail>();
  const [folderDetailLoading, setFolderDetailLoading] = useState(false);
  const [fileClipboard, setFileClipboard] = useState<FileClipboard>();
  const [sortField, setSortField] = useState<ListingSortField>(() => {
    const saved = localStorage.getItem("originvault.sortField.v3");
    return saved === "name" ||
      saved === "kind" ||
      saved === "size" ||
      saved === "originalCreated" ||
      saved === "originalModified"
      ? saved
      : "originalCreated";
  });
  const [sortDirection, setSortDirection] = useState<ListingSortDirection>(() =>
    localStorage.getItem("originvault.sortDirection.v3") === "asc"
      ? "asc"
      : "desc",
  );
  const [viewMode, setViewMode] = useState<ListingViewMode>(() => {
    const saved = localStorage.getItem("originvault.viewMode");
    return saved === "grid-2" || saved === "grid-3" || saved === "preview"
      ? saved
      : "details";
  });
  const [internalDragActive, setInternalDragActive] = useState(false);
  const [dropTarget, setDropTarget] = useState<string>();
  const [externalDropActive, setExternalDropActive] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const folderPicker = useRef<HTMLInputElement>(null);
  const runningUploads = useRef(new Set<string>());
  const uploadAborters = useRef(new Map<string, () => void>());
  const cancelledUploadTasks = useRef(new Set<string>());
  const pausedUploadTasks = useRef(new Set<string>());
  const hashingTasks = useRef(new Set<string>());
  const uploadRefreshPending = useRef(false);
  const listRequestSequence = useRef(0);
  const treeRequestSequence = useRef(0);
  const contentRef = useRef<HTMLElement>(null);
  const filesSection = useRef<HTMLElement>(null);
  const mobileTreeToggle = useRef<HTMLButtonElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const contextMenuAnchor = useRef<HTMLElement>(null);
  const detailRequestSequence = useRef(0);
  const folderDetailRequestSequence = useRef(0);
  const selectionAnchor = useRef<string | undefined>(undefined);
  const draggedSelections = useRef<BulkSelection[]>([]);
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
  const externalDragDepth = useRef(0);
  const suppressCardClick = useRef(false);
  const collisionDecisions = useRef(new Map<string, CollisionChoice>());
  const collisionResolver = useRef<
    ((decisions: Map<string, CollisionChoice>) => void) | undefined
  >(undefined);
  const folder = trail.at(-1);
  const parentFolder = trail.length > 1 ? trail.at(-2) : undefined;
  const setFolderPicker = (element: HTMLInputElement | null) => {
    folderPicker.current = element;
    if (!element) return;
    element.setAttribute("webkitdirectory", "");
    element.setAttribute("directory", "");
    (
      element as HTMLInputElement & {
        webkitdirectory?: boolean;
        directory?: boolean;
      }
    ).webkitdirectory = true;
  };
  const load = useCallback(async () => {
    const sequence = ++listRequestSequence.current;
    setItems({ folders: [], files: [] });
    try {
      const result = await api.items(folder?.id);
      if (sequence === listRequestSequence.current) setItems(result);
    } catch (e) {
      if (sequence === listRequestSequence.current)
        setMessage(e instanceof Error ? e.message : "목록 오류");
    }
  }, [folder?.id]);
  const loadTree = useCallback(async () => {
    const sequence = ++treeRequestSequence.current;
    setTreeRefreshing(true);
    try {
      const folders = (await api.folderTree()).folders;
      if (sequence !== treeRequestSequence.current) return;
      setAllFolders(folders);
      setTrail((previous) => {
        const selectedId = previous.at(-1)?.id;
        if (!selectedId) return previous;
        const byId = new Map(folders.map((entry) => [entry.id, entry]));
        const selected = byId.get(selectedId);
        if (!selected) return [];
        const next: VaultFolder[] = [];
        let current: VaultFolder | undefined = selected;
        while (current) {
          next.unshift(current);
          current = current.parentId ? byId.get(current.parentId) : undefined;
        }
        return next;
      });
    } catch (e) {
      if (sequence === treeRequestSequence.current)
        setMessage(e instanceof Error ? e.message : "폴더 트리 오류");
    } finally {
      if (sequence === treeRequestSequence.current) setTreeRefreshing(false);
    }
  }, []);
  const refreshStorage = useCallback(async () => {
    try {
      const profile = await api.me();
      onUserChanged(profile.user);
      onStorageChanged(profile.storage);
      onServerStorageChanged(profile.serverStorage ?? null);
    } catch {
      /* global 401 handling owns session expiry */
    }
  }, [onServerStorageChanged, onStorageChanged, onUserChanged]);
  const refreshFiles = useCallback(async () => {
    setFilesRefreshing(true);
    try {
      await Promise.all([load(), loadTree(), refreshStorage()]);
    } finally {
      setFilesRefreshing(false);
    }
  }, [load, loadTree, refreshStorage]);
  useEffect(() => {
    void loadTree();
  }, [loadTree]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    setSelectedKeys(new Set());
    selectionAnchor.current = undefined;
    setContextMenu(undefined);
    detailRequestSequence.current += 1;
    setDetailTarget(undefined);
    setFileDetail(undefined);
    setDetailLoading(false);
    folderDetailRequestSequence.current += 1;
    setFolderDetailTarget(undefined);
    setFolderDetail(undefined);
    setFolderDetailLoading(false);
  }, [folder?.id]);
  useEffect(() => {
    setContextMenu(undefined);
    if (activeView !== "files") {
      detailRequestSequence.current += 1;
      setDetailTarget(undefined);
      setFileDetail(undefined);
      setDetailLoading(false);
      folderDetailRequestSequence.current += 1;
      setFolderDetailTarget(undefined);
      setFolderDetail(undefined);
      setFolderDetailLoading(false);
    }
  }, [activeView, bulkBusy]);
  useEffect(() => {
    localStorage.setItem("originvault.sortField.v3", sortField);
    localStorage.setItem("originvault.sortDirection.v3", sortDirection);
    localStorage.setItem("originvault.viewMode", viewMode);
  }, [sortDirection, sortField, viewMode]);
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!contextMenu || !menu) return;
    const bounds = menu.getBoundingClientRect();
    const x = Math.max(
      8,
      Math.min(contextMenu.x, window.innerWidth - bounds.width - 8),
    );
    const y = Math.max(
      8,
      Math.min(contextMenu.y, window.innerHeight - bounds.height - 8),
    );
    if (x !== contextMenu.x || y !== contextMenu.y)
      setContextMenu({ ...contextMenu, x, y });
    else if (contextMenu.focusMenu)
      menu.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [contextMenu]);
  useEffect(() => {
    if (!contextMenu) return;
    const closeOutside = (event: PointerEvent) => {
      if (!contextMenuRef.current?.contains(event.target as Node))
        setContextMenu(undefined);
    };
    const closeOnKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(undefined);
        window.requestAnimationFrame(() => contextMenuAnchor.current?.focus());
      }
    };
    const close = () => setContextMenu(undefined);
    const closeOnScroll = (event: Event) => {
      if (
        event.target instanceof Node &&
        contextMenuRef.current?.contains(event.target)
      )
        return;
      close();
    };
    document.addEventListener("pointerdown", closeOutside, true);
    document.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside, true);
      document.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [contextMenu]);
  useEffect(() => {
    localStorage.setItem(
      uploadQueueKey(username),
      JSON.stringify(uploadTasks.map(({ file: _file, ...task }) => task)),
    );
  }, [uploadTasks, username]);
  useEffect(
    () => () => {
      for (const abort of uploadAborters.current.values()) abort();
      for (const id of hashingTasks.current)
        cancelledUploadTasks.current.add(id);
    },
    [],
  );

  const selectTreeFolder = useCallback(
    (selected?: VaultFolder) => {
      if (!selected) {
        setTrail([]);
        return;
      }
      const byId = new Map(allFolders.map((entry) => [entry.id, entry]));
      const nextTrail: VaultFolder[] = [];
      let current: VaultFolder | undefined = selected;
      while (current) {
        nextTrail.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      setTrail(nextTrail);
    },
    [allFolders],
  );

  const chooseCollision = (choice: CollisionChoice, applyToAll: boolean) => {
    const prompt = collisionPrompt;
    if (!prompt) return;
    const current = prompt.conflicts[prompt.index]!;
    collisionDecisions.current.set(current.key, choice);
    if (applyToAll) {
      for (const conflict of prompt.conflicts.slice(prompt.index + 1))
        collisionDecisions.current.set(conflict.key, choice);
    }
    const nextIndex = applyToAll ? prompt.conflicts.length : prompt.index + 1;
    if (nextIndex < prompt.conflicts.length) {
      setCollisionPrompt({ ...prompt, index: nextIndex });
      return;
    }
    const resolve = collisionResolver.current;
    collisionResolver.current = undefined;
    setCollisionPrompt(undefined);
    resolve?.(new Map(collisionDecisions.current));
  };
  const resolveCollisionChoices = (
    operation: CollisionPrompt["operation"],
    conflicts: Array<{ key: string; name: string }>,
  ) => {
    if (!conflicts.length) return Promise.resolve(new Map<string, CollisionChoice>());
    collisionDecisions.current = new Map();
    return new Promise<Map<string, CollisionChoice>>((resolve) => {
      collisionResolver.current = resolve;
      setCollisionPrompt({ operation, conflicts, index: 0 });
    });
  };

  const enqueueCandidates = async (
    candidates: UploadCandidate[],
    destination: VaultFolder | null | undefined = folder,
  ) => {
    if (!candidates.length) return;
    const destinationFolderId = destination?.id;
    const baseLabel = destination?.relativePath ?? "내 파일";
    const uploadCandidates = candidates.map((candidate) => ({
      ...candidate,
      key: createClientId(),
    }));
    const conflicts = await api.uploadCollisions(
      uploadCandidates.map((candidate) => ({
        key: candidate.key,
        originalName: candidate.file.name,
        folderId: destinationFolderId,
        relativeDirectory: candidate.relativeDirectory,
      })),
    );
    const decisions = await resolveCollisionChoices(
      "업로드",
      conflicts.conflicts.map((conflict) => ({ key: conflict.key, name: conflict.name })),
    );
    const overwriteTargets = new Map<string, BulkSelection>();
    const cancelled = new Set<string>();
    for (const conflict of conflicts.conflicts) {
      const choice = decisions.get(conflict.key);
      if (choice === "overwrite")
        overwriteTargets.set(`${conflict.existing.type}:${conflict.existing.id}`, conflict.existing);
      if (choice === "cancel") cancelled.add(conflict.key);
    }
    if (overwriteTargets.size) await api.bulkDelete([...overwriteTargets.values()]);
    if (uploadCandidates.some((candidate) => !cancelled.has(candidate.key)))
      setUploadBatch((current) => current + 1);
    for (const { key, file, relativeDirectory } of uploadCandidates) {
      if (cancelled.has(key)) continue;
      const id = createClientId();
      const task: UploadTask = {
        id,
        file,
        fileName: file.name,
        sizeBytes: file.size,
        lastModified: file.lastModified,
        mimeType: file.type || "application/octet-stream",
        fingerprint: createClientId(),
        relativeDirectory,
        destinationFolderId,
        destinationLabel: relativeDirectory
          ? `${baseLabel}/${relativeDirectory}`
          : baseLabel,
        uploadedBytes: 0,
        status: "preparing",
        progress: 0,
      };
      setUploadTasks((previous) => [...previous, task]);
      hashingTasks.current.add(id);
      void runHashLimited(() =>
        hashFile(
          file,
          () => cancelledUploadTasks.current.has(id),
          (progress) =>
            setUploadTasks((previous) =>
              previous.map((entry) =>
                entry.id === id ? { ...entry, progress } : entry,
              ),
            ),
        ),
      )
        .then((contentSha256) => {
          setUploadTasks((previous) => {
            if (!previous.some((entry) => entry.id === id)) return previous;
            const resumable = previous.find(
              (entry) =>
                entry.id !== id &&
                entry.status === "paused" &&
                !entry.file &&
                entry.contentSha256 === contentSha256 &&
                entry.fileName === file.name &&
                entry.sizeBytes === file.size &&
                entry.lastModified === file.lastModified &&
                entry.relativeDirectory === relativeDirectory &&
                entry.destinationFolderId === destinationFolderId,
            );
            if (resumable)
              return previous
                .filter((entry) => entry.id !== id)
                .map((entry) =>
                  entry.id === resumable.id
                    ? {
                        ...entry,
                        file,
                        status: "queued",
                        error: undefined,
                        progress: entry.sizeBytes
                          ? Math.round(
                              (entry.uploadedBytes / entry.sizeBytes) * 100,
                            )
                          : 0,
                      }
                    : entry,
                );
            const legacy = previous.find(
              (entry) =>
                entry.id !== id &&
                entry.status === "paused" &&
                !entry.file &&
                !entry.contentSha256 &&
                entry.fileName === file.name &&
                entry.sizeBytes === file.size &&
                entry.lastModified === file.lastModified &&
                entry.relativeDirectory === relativeDirectory &&
                entry.destinationFolderId === destinationFolderId,
            );
            if (legacy?.sessionId)
              void api
                .cancelUploadSession(legacy.sessionId)
                .catch(() => undefined);
            return previous
              .map<UploadTask>((entry) =>
                entry.id === id
                  ? {
                      ...entry,
                      contentSha256,
                      status: pausedUploadTasks.current.has(id)
                        ? "paused"
                        : "queued",
                      progress: 0,
                    }
                  : entry,
              )
              .filter((entry) => entry.id !== legacy?.id);
          });
        })
        .catch((error) => {
          if (error instanceof DOMException && error.name === "AbortError")
            return;
          setUploadTasks((previous) =>
            previous.map((entry) =>
              entry.id === id
                ? {
                    ...entry,
                    status: "failed",
                    error:
                      error instanceof Error ? error.message : "파일 검증 실패",
                  }
                : entry,
            ),
          );
        })
        .finally(() => hashingTasks.current.delete(id));
    }
    if (picker.current) picker.current.value = "";
    if (folderPicker.current) folderPicker.current.value = "";
  };
  const enqueue = (
    files: FileList | null,
    preserveFolders = false,
    destination: VaultFolder | null | undefined = folder,
  ) => {
    if (!files?.length) return;
    void enqueueCandidates(
      Array.from(files).map((file) => {
        const selectedPath = preserveFolders ? file.webkitRelativePath : "";
        const separator = selectedPath.lastIndexOf("/");
        return {
          file,
          relativeDirectory:
            separator >= 0 ? selectedPath.slice(0, separator) : "",
        };
      }),
      destination,
    ).catch((error) =>
      setMessage(error instanceof Error ? error.message : "업로드 충돌을 확인하지 못했습니다."),
    );
  };
  const enqueueDroppedFiles = async (
    dataTransfer: DataTransfer,
    destination: VaultFolder | null | undefined = folder,
  ) => {
    try {
      const candidates = await droppedFiles(dataTransfer);
      if (!candidates.length) {
        setMessage("선택한 폴더에 업로드할 파일이 없습니다.");
        return;
      }
      await enqueueCandidates(candidates, destination);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "폴더를 읽지 못했습니다.");
    }
  };
  const openFolderPicker = () => {
    const input = folderPicker.current;
    if (!input) return;
    if (!("webkitdirectory" in input)) {
      setMessage("이 브라우저는 폴더 선택 업로드를 지원하지 않습니다.");
      return;
    }
    input.click();
  };

  const startUpload = useCallback(
    (task: UploadTask) => {
      if (runningUploads.current.has(task.id) || pausedUploadTasks.current.has(task.id)) return;
      if (!task.file) {
        setUploadTasks((previous) =>
          previous.map((entry) =>
            entry.id === task.id ? { ...entry, status: "paused" } : entry,
          ),
        );
        return;
      }
      cancelledUploadTasks.current.delete(task.id);
      runningUploads.current.add(task.id);
      setUploadTasks((previous) =>
        previous.map((entry) =>
          entry.id === task.id
            ? { ...entry, status: "uploading", error: undefined }
            : entry,
        ),
      );
      void (async () => {
        try {
          const created = await api.createUploadSession({
            fingerprint: task.contentSha256
              ? `${task.fingerprint}:${task.contentSha256}`
              : task.fingerprint,
            originalName: task.fileName,
            sizeBytes: task.sizeBytes,
            mimeType: task.mimeType,
            lastModified: task.lastModified,
            folderId: task.destinationFolderId,
            relativeDirectory: task.relativeDirectory,
          });
          if (cancelledUploadTasks.current.has(task.id)) {
            if (created.id)
              await api.cancelUploadSession(created.id).catch(() => undefined);
            throw new DOMException("Upload cancelled", "AbortError");
          }
          if (created.complete) {
            if (
              task.contentSha256 &&
              created.file?.sha256 !== task.contentSha256
            )
              throw new Error(
                "서버에 저장된 파일의 SHA-256이 선택한 원본과 다릅니다.",
              );
            uploadRefreshPending.current = true;
            setUploadTasks((previous) =>
              previous.map((entry) =>
                entry.id === task.id
                  ? {
                          ...entry,
                          status: "completed",
                      progress: 100,
                      uploadedBytes: task.sizeBytes,
                      file: undefined,
                    }
                  : entry,
              ),
            );
            return;
          }
          if (!created.id || created.offset === undefined)
            throw new Error("업로드 세션 응답이 올바르지 않습니다.");
          const sessionId = created.id;
          let offset = created.offset;
          let completedSha256: string | undefined;
          setUploadTasks((previous) =>
            previous.map((entry) =>
              entry.id === task.id
                ? {
                    ...entry,
                    sessionId,
                    uploadedBytes: offset,
                    progress: task.sizeBytes
                      ? Math.round((offset / task.sizeBytes) * 100)
                      : 100,
                  }
                : entry,
            ),
          );
          while (offset < task.sizeBytes) {
            if (cancelledUploadTasks.current.has(task.id))
              throw new DOMException("Upload cancelled", "AbortError");
            const chunk = task.file!.slice(
              offset,
              Math.min(offset + UPLOAD_CHUNK_BYTES, task.sizeBytes),
            );
            const chunkStart = offset;
            const transfer = api.uploadChunk(
              sessionId,
              chunk,
              offset,
              (loaded) =>
                setUploadTasks((previous) =>
                  previous.map((entry) =>
                    entry.id === task.id
                      ? {
                          ...entry,
                          uploadedBytes: chunkStart + loaded,
                          progress: Math.min(
                            99,
                            Math.round(
                              ((chunkStart + loaded) / task.sizeBytes) * 100,
                            ),
                          ),
                        }
                      : entry,
                  ),
                ),
            );
            uploadAborters.current.set(task.id, transfer.abort);
            const result = await transfer.promise;
            offset = result.offset;
            if (result.file?.sha256) completedSha256 = result.file.sha256;
            setUploadTasks((previous) =>
              previous.map((entry) =>
                entry.id === task.id
                  ? {
                      ...entry,
                      uploadedBytes: offset,
                      progress: task.sizeBytes
                        ? Math.min(
                            99,
                            Math.round((offset / task.sizeBytes) * 100),
                          )
                        : 100,
                    }
                  : entry,
              ),
            );
          }
          if (task.contentSha256 && completedSha256 !== task.contentSha256)
            throw new Error(
              "서버에 저장된 파일의 SHA-256이 선택한 원본과 다릅니다.",
            );
          uploadRefreshPending.current = true;
          setUploadTasks((previous) =>
            previous.map((entry) =>
              entry.id === task.id
                ? {
                    ...entry,
                    status: "completed",
                    progress: 100,
                    uploadedBytes: task.sizeBytes,
                    file: undefined,
                  }
                : entry,
            ),
          );
        } catch (error) {
          if (error instanceof DOMException && error.name === "AbortError") {
            setUploadTasks((previous) =>
              previous.map((entry) =>
                entry.id === task.id
                  ? pausedUploadTasks.current.has(task.id)
                    ? { ...entry, status: "paused", error: undefined }
                    : { ...entry, status: "paused", file: undefined }
                  : entry,
              ),
            );
            return;
          }
          const serverOffset =
            typeof error === "object" && error && "serverOffset" in error
              ? Number((error as { serverOffset?: number }).serverOffset)
              : undefined;
          setUploadTasks((previous) =>
            previous.map((entry) =>
              entry.id === task.id
                ? {
                    ...entry,
                    status: "failed",
                    uploadedBytes: Number.isFinite(serverOffset)
                      ? serverOffset!
                      : entry.uploadedBytes,
                    error:
                      error instanceof Error ? error.message : "업로드 실패",
                  }
                : entry,
            ),
          );
        } finally {
          runningUploads.current.delete(task.id);
          uploadAborters.current.delete(task.id);
          setUploadTasks((previous) => [...previous]);
        }
      })();
    },
    [],
  );

  useEffect(() => {
    const capacity = 2 - runningUploads.current.size;
    if (capacity <= 0) return;
    uploadTasks
      .filter(
        (task) =>
          task.status === "queued" && !runningUploads.current.has(task.id),
      )
      .slice(0, capacity)
      .forEach(startUpload);
  }, [startUpload, uploadTasks]);

  const removeUploadTasks = (ids: string[]) => {
    const removeIds = new Set(ids);
    const sessions = uploadTasks
      .filter((task) => removeIds.has(task.id) && task.sessionId)
      .map((task) => task.sessionId!);
    for (const id of ids) {
      cancelledUploadTasks.current.add(id);
      pausedUploadTasks.current.delete(id);
      uploadAborters.current.get(id)?.();
    }
    for (const sessionId of sessions)
      void api.cancelUploadSession(sessionId).catch(() => undefined);
    setUploadTasks((previous) =>
      previous.filter((task) => !removeIds.has(task.id)),
    );
  };
  const retryUpload = (id: string) =>
    setUploadTasks((previous) =>
      previous.map((task) =>
        task.id === id
          ? {
              ...task,
              status: task.file ? "queued" : "paused",
              error: undefined,
            }
          : task,
      ),
    );
  const pauseAllUploads = () => {
    const active = uploadTasks.filter((task) =>
      task.status === "preparing" ||
      task.status === "queued" ||
      task.status === "uploading",
    );
    for (const task of active) {
      pausedUploadTasks.current.add(task.id);
      if (runningUploads.current.has(task.id)) {
        cancelledUploadTasks.current.add(task.id);
        uploadAborters.current.get(task.id)?.();
      }
    }
    if (!active.length) return;
    const ids = new Set(active.map((task) => task.id));
    setUploadTasks((previous) =>
      previous.map((task) =>
        ids.has(task.id)
          ? { ...task, status: "paused", error: undefined }
          : task,
      ),
    );
  };
  const resumeAllUploads = () => {
    const resumable = uploadTasks.filter(
      (task) => task.status === "paused" && task.file,
    );
    for (const task of resumable) {
      pausedUploadTasks.current.delete(task.id);
      cancelledUploadTasks.current.delete(task.id);
    }
    if (!resumable.length) return;
    const ids = new Set(resumable.map((task) => task.id));
    setUploadTasks((previous) =>
      previous.map((task) =>
        ids.has(task.id)
          ? {
              ...task,
              status: task.contentSha256 ? "queued" : "preparing",
              error: undefined,
            }
          : task,
      ),
    );
  };
  const cancelAllUploads = () =>
    removeUploadTasks(
      uploadTasks
        .filter((task) => task.status !== "completed")
        .map((task) => task.id),
    );
  const clearCompleted = () =>
    setUploadTasks((previous) =>
      previous.filter((task) => task.status !== "completed"),
    );
  const isUploading = uploadTasks.some(
    (task) =>
      task.status === "preparing" ||
      task.status === "uploading" ||
      task.status === "queued",
  );
  useEffect(() => {
    if (!uploadRefreshPending.current || isUploading) return;
    uploadRefreshPending.current = false;
    void refreshFiles();
  }, [isUploading, refreshFiles, uploadTasks]);

  const selectionKey = (type: "file" | "folder", id: string) => `${type}:${id}`;
  const executeBulkOperation = async (
    mode: "move" | "copy",
    selected: BulkSelection[],
    destinationFolderId?: string,
  ) => {
    const collisionResult = await api.bulkCollisions(mode, selected, destinationFolderId);
    const decisions = await resolveCollisionChoices(
      mode === "move" ? "이동" : "복사",
      collisionResult.conflicts.map((conflict) => ({
        key: selectionKey(conflict.source.type, conflict.source.id),
        name: conflict.name,
      })),
    );
    const cancelled = new Set<string>();
    const renamed = new Set<string>();
    const overwriteTargets = new Map<string, BulkSelection>();
    const selectedKeys = new Set(selected.map((item) => selectionKey(item.type, item.id)));
    for (const conflict of collisionResult.conflicts) {
      const sourceKey = selectionKey(conflict.source.type, conflict.source.id);
      const choice = decisions.get(sourceKey);
      if (choice === "cancel") cancelled.add(sourceKey);
      if (choice === "rename") renamed.add(sourceKey);
      if (choice === "overwrite") {
        const targetKey = selectionKey(conflict.existing.type, conflict.existing.id);
        if (mode === "copy" && selectedKeys.has(targetKey)) renamed.add(sourceKey);
        else overwriteTargets.set(targetKey, conflict.existing);
      }
    }
    const effective = selected.filter((item) => !cancelled.has(selectionKey(item.type, item.id)));
    if (!effective.length) return { files: 0, folders: 0, skipped: 0, executed: [] as BulkSelection[] };
    if (overwriteTargets.size) await api.bulkDelete([...overwriteTargets.values()]);
    if (mode === "copy") {
      const copied = await api.bulkCopy(effective, destinationFolderId);
      return {
        files: copied.copied.files,
        folders: copied.copied.folders,
        skipped: 0,
        executed: effective,
      };
    }
    const renamedSelections = effective.filter((item) => renamed.has(selectionKey(item.type, item.id)));
    const directSelections = effective.filter((item) => !renamed.has(selectionKey(item.type, item.id)));
    let files = 0;
    let folders = 0;
    let skipped = 0;
    if (directSelections.length) {
      const moved = await api.bulkMove(directSelections, destinationFolderId);
      files += moved.moved.files;
      folders += moved.moved.folders;
      skipped += moved.skipped;
    }
    if (renamedSelections.length) {
      const copied = await api.bulkCopy(renamedSelections, destinationFolderId);
      await api.bulkDelete(renamedSelections);
      files += copied.copied.files;
      folders += copied.copied.folders;
    }
    return { files, folders, skipped, executed: effective };
  };
  const directionFactor = sortDirection === "asc" ? 1 : -1;
  const compareOriginalTimes = (left?: string | null, right?: string | null) => {
    const leftTime = left ? new Date(left).getTime() : Number.NaN;
    const rightTime = right ? new Date(right).getTime() : Number.NaN;
    const leftKnown = Number.isFinite(leftTime);
    const rightKnown = Number.isFinite(rightTime);
    if (!leftKnown || !rightKnown) return leftKnown ? -1 : rightKnown ? 1 : 0;
    return (leftTime - rightTime) * directionFactor;
  };
  const sortedFolders = [...items.folders].sort((left, right) => {
    let compared = 0;
    if (sortField === "originalCreated")
      compared = compareOriginalTimes(left.originalCreatedAt, right.originalCreatedAt);
    else if (sortField === "originalModified")
      compared = compareOriginalTimes(left.originalModifiedAt, right.originalModifiedAt);
    if (!compared) compared = nameCollator.compare(left.name, right.name);
    return (sortField === "originalCreated" || sortField === "originalModified") && compared
      ? compared
      : compared * directionFactor;
  });
  const sortedFiles = [...items.files].sort((left, right) => {
    let compared = 0;
    if (sortField === "kind")
      compared = nameCollator.compare(left.mimeType, right.mimeType);
    else if (sortField === "size") {
      const leftSize = BigInt(left.sizeBytes);
      const rightSize = BigInt(right.sizeBytes);
      compared = leftSize === rightSize ? 0 : leftSize < rightSize ? -1 : 1;
    } else if (sortField === "originalCreated")
      compared = compareOriginalTimes(left.originalCreatedAt, right.originalCreatedAt);
    else if (sortField === "originalModified")
      compared = compareOriginalTimes(left.originalModifiedAt, right.originalModifiedAt);
    if (!compared) compared = nameCollator.compare(left.name, right.name);
    return (sortField === "originalCreated" || sortField === "originalModified") && compared
      ? compared
      : compared * directionFactor;
  });
  const currentKeys = [
    ...sortedFolders.map((item) => selectionKey("folder", item.id)),
    ...sortedFiles.map((item) => selectionKey("file", item.id)),
  ];
  const selectItem = (
    key: string,
    modifiers: { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean },
    checkbox = false,
  ) => {
    if (!checkbox && suppressCardClick.current) {
      suppressCardClick.current = false;
      return;
    }
    if (checkbox) {
      selectionAnchor.current = key;
      setSelectedKeys((previous) => {
        const next = new Set(previous);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
      });
      return;
    }

    const additive = Boolean(modifiers.ctrlKey || modifiers.metaKey);
    if (modifiers.shiftKey) {
      const anchor = selectionAnchor.current;
      const anchorIndex = anchor ? currentKeys.indexOf(anchor) : -1;
      const targetIndex = currentKeys.indexOf(key);
      if (anchorIndex >= 0 && targetIndex >= 0) {
        const range = currentKeys.slice(
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
    if (additive) {
      setSelectedKeys((previous) => {
        const next = new Set(previous);
        next.has(key) ? next.delete(key) : next.add(key);
        return next;
      });
    } else {
      setSelectedKeys(new Set([key]));
    }
  };
  const selections: BulkSelection[] = currentKeys
    .filter((key) => selectedKeys.has(key))
    .map((key) => {
      const [type, id] = key.split(":");
      return { type: type as "file" | "folder", id };
    });
  const destinationContainsSelection = (
    selected: BulkSelection[],
    destinationFolderId?: string,
  ) => {
    if (!destinationFolderId) return false;
    const selectedFolderIds = new Set(
      selected
        .filter((entry) => entry.type === "folder")
        .map((entry) => entry.id),
    );
    if (!selectedFolderIds.size) return false;
    const foldersById = new Map(allFolders.map((entry) => [entry.id, entry]));
    let current = foldersById.get(destinationFolderId);
    while (current) {
      if (selectedFolderIds.has(current.id)) return true;
      current = current.parentId
        ? foldersById.get(current.parentId)
        : undefined;
    }
    return false;
  };
  const invalidMoveDestinationIds = new Set(
    allFolders
      .filter((candidate) =>
        destinationContainsSelection(selections, candidate.id),
      )
      .map((candidate) => candidate.id),
  );
  const showItemMenu = (
    target: ItemMenuTarget,
    key: string,
    x: number,
    y: number,
    focusMenu = false,
  ) => {
    if (!selectedKeys.has(key)) {
      selectionAnchor.current = key;
      setSelectedKeys(new Set([key]));
    }
    setContextMenu({ ...target, x, y, focusMenu } as ItemContextMenu);
  };
  const handleItemContextMenu = (
    event: React.MouseEvent<HTMLDivElement>,
    target: ItemMenuTarget,
    key: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    contextMenuAnchor.current = event.currentTarget;
    const openedFromKeyboard =
      event.button === 0 && event.clientX === 0 && event.clientY === 0;
    const bounds = event.currentTarget.getBoundingClientRect();
    showItemMenu(
      target,
      key,
      openedFromKeyboard ? bounds.left + 32 : event.clientX,
      openedFromKeyboard ? bounds.top + 32 : event.clientY,
      openedFromKeyboard,
    );
  };
  const handleItemKeyDown = (
    event: React.KeyboardEvent<HTMLDivElement>,
    target: ItemMenuTarget,
    key: string,
  ) => {
    if (
      event.target === event.currentTarget &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      selectItem(key, event);
      return;
    }
    if (
      event.target === event.currentTarget &&
      (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))
    ) {
      event.preventDefault();
      contextMenuAnchor.current = event.currentTarget;
      const bounds = event.currentTarget.getBoundingClientRect();
      showItemMenu(target, key, bounds.left + 32, bounds.top + 32, true);
    }
  };
  const selectAll = () => {
    setSelectedKeys(new Set(currentKeys.slice(0, 1_000)));
    selectionAnchor.current = currentKeys[0];
    if (currentKeys.length > 1_000)
      setMessage("일괄 작업은 한 번에 최대 1,000개까지 선택할 수 있습니다.");
  };
  const clearSelection = () => {
    selectionAnchor.current = undefined;
    setSelectedKeys(new Set());
  };
  const storeFileClipboard = (
    mode: FileClipboard["mode"],
    selected: BulkSelection[] = selections,
  ) => {
    if (!selected.length || bulkBusy) return;
    setFileClipboard({
      mode,
      selections: selected.map((entry) => ({ ...entry })),
    });
    setMessage(
      `${selected.length}개 항목을 ${mode === "copy" ? "복사" : "잘라내기"}했습니다. 붙여넣을 폴더에서 Ctrl+V를 누르세요.`,
    );
  };
  const cancelCut = () => {
    if (fileClipboard?.mode !== "cut") return;
    setFileClipboard(undefined);
    setMessage("잘라내기를 취소했습니다.");
  };
  const removeFromCutClipboard = (completed: BulkSelection[]) => {
    const completedKeys = new Set(
      completed.map((entry) => selectionKey(entry.type, entry.id)),
    );
    setFileClipboard((current) => {
      if (current?.mode !== "cut") return current;
      const remaining = current.selections.filter(
        (entry) => !completedKeys.has(selectionKey(entry.type, entry.id)),
      );
      return remaining.length ? { ...current, selections: remaining } : undefined;
    });
  };
  const removeDeletedFromClipboard = (deleted: BulkSelection[]) => {
    const deletedKeys = new Set(
      deleted.map((entry) => selectionKey(entry.type, entry.id)),
    );
    const removedFolder = deleted.some((entry) => entry.type === "folder");
    setFileClipboard((current) => {
      if (!current) return current;
      if (removedFolder) return undefined;
      const remaining = current.selections.filter(
        (entry) => !deletedKeys.has(selectionKey(entry.type, entry.id)),
      );
      return remaining.length ? { ...current, selections: remaining } : undefined;
    });
  };
  const handleSelectionPointerDown = (
    event: React.PointerEvent<HTMLElement>,
  ) => {
    const target = event.target as HTMLElement;
    if (
      activeView !== "files" ||
      event.pointerType === "touch" ||
      event.button !== 0 ||
      target.closest(
        "button, a, input, select, textarea, label, [contenteditable='true'], [role='dialog'], .item-context-menu, .preview-backdrop, .drawer-backdrop",
      )
    )
      return;
    dragSelection.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      base: event.ctrlKey || event.metaKey ? new Set(selectedKeys) : new Set(),
      dragging: false,
    };
  };
  const handleSelectionPointerMove = (
    event: React.PointerEvent<HTMLElement>,
  ) => {
    const drag = dragSelection.current;
    const section = filesSection.current;
    if (!drag || drag.pointerId !== event.pointerId || !section) return;
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
    const left = Math.min(drag.startX, event.clientX),
      top = Math.min(drag.startY, event.clientY),
      right = Math.max(drag.startX, event.clientX),
      bottom = Math.max(drag.startY, event.clientY);
    setSelectionBox({
      left,
      top,
      width: right - left,
      height: bottom - top,
    });
    const hits = new Set(drag.base);
    section
      .querySelectorAll<HTMLElement>("[data-select-key]")
      .forEach((card) => {
        const rect = card.getBoundingClientRect();
        if (
          rect.left < right &&
          rect.right > left &&
          rect.top < bottom &&
          rect.bottom > top
        )
          hits.add(card.dataset.selectKey!);
      });
    setSelectedKeys(hits);
  };
  const handleSelectionPointerUp = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragSelection.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.dragging) {
      suppressCardClick.current = true;
      window.setTimeout(() => {
        suppressCardClick.current = false;
      }, 0);
    } else if (!(event.target as HTMLElement).closest("[data-select-key]"))
      clearSelection();
    setSelectionBox(undefined);
    dragSelection.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const handleSelectionPointerCancel = (
    event: React.PointerEvent<HTMLElement>,
  ) => {
    const drag = dragSelection.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setSelectionBox(undefined);
    dragSelection.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const downloadOriginals = async () => {
    try {
      setBulkBusy(true);
      const manifest = await api.bulkManifest(selections);
      for (const file of manifest.files) await api.download(file);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "원본 다운로드 실패");
    } finally {
      setBulkBusy(false);
    }
  };
  const downloadZip = async () => {
    try {
      setBulkBusy(true);
      await api.downloadArchive(selections);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "ZIP 다운로드 실패");
    } finally {
      setBulkBusy(false);
    }
  };
  const moveSelected = async () => {
    if (destinationContainsSelection(selections, moveDestination || undefined)) {
      setMessage("폴더를 자기 자신이나 하위 폴더로 이동할 수 없습니다.");
      return;
    }
    try {
      setBulkBusy(true);
      const result = await executeBulkOperation("move", selections, moveDestination || undefined);
      removeFromCutClipboard(result.executed);
      setMoveOpen(false);
      clearSelection();
      await refreshFiles();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "이동 실패");
    } finally {
      setBulkBusy(false);
    }
  };
  const pasteFileClipboard = async (destinationFolderId = folder?.id) => {
    const clipboard = fileClipboard;
    if (!clipboard || bulkBusy) return;
    if (
      destinationContainsSelection(clipboard.selections, destinationFolderId)
    ) {
      setMessage("폴더를 자기 자신이나 하위 폴더에 붙여넣을 수 없습니다.");
      return;
    }
    try {
      setBulkBusy(true);
      if (clipboard.mode === "copy") {
        const result = await executeBulkOperation(
          "copy",
          clipboard.selections,
          destinationFolderId,
        );
        const copied = result.files + result.folders;
        setMessage(
          copied ? `${copied}개 파일 및 폴더를 복사했습니다.` : "중복된 항목을 취소했습니다.",
        );
      } else {
        const result = await executeBulkOperation(
          "move",
          clipboard.selections,
          destinationFolderId,
        );
        const moved = result.files + result.folders;
        removeFromCutClipboard(result.executed);
        setMessage(
          result.skipped
            ? `${moved}개 항목을 이동했고 같은 위치의 ${result.skipped}개 항목은 건너뛰었습니다.`
            : `${moved}개 항목을 이동했습니다.`,
        );
      }
      clearSelection();
      await refreshFiles();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "붙여넣기에 실패했습니다.");
    } finally {
      setBulkBusy(false);
    }
  };
  const finishInternalDrag = () => {
    draggedSelections.current = [];
    setInternalDragActive(false);
    setDropTarget(undefined);
  };
  const moveDroppedSelections = async (
    selected: BulkSelection[],
    destination?: VaultFolder,
  ) => {
    if (!selected.length || bulkBusy) return;
    if (destinationContainsSelection(selected, destination?.id)) {
      setMessage("폴더를 자기 자신이나 하위 폴더로 이동할 수 없습니다.");
      finishInternalDrag();
      return;
    }

    try {
      setBulkBusy(true);
      const result = await executeBulkOperation("move", selected, destination?.id);
      const moved = result.files + result.folders;
      removeFromCutClipboard(result.executed);
      setMessage(
        result.skipped
          ? `${moved}개 항목을 이동했고 같은 위치의 ${result.skipped}개 항목은 건너뛰었습니다.`
          : `${moved}개 항목을 ${destination?.name ?? "내 파일"}(으)로 이동했습니다.`,
      );
      clearSelection();
      await refreshFiles();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "이동 실패");
    } finally {
      setBulkBusy(false);
      finishInternalDrag();
    }
  };
  const handleItemDragStart = (
    event: React.DragEvent<HTMLDivElement>,
    selection: BulkSelection,
    key: string,
  ) => {
    if (bulkBusy) {
      event.preventDefault();
      return;
    }
    const dragged =
      selectedKeys.has(key) && selections.length ? selections : [selection];
    if (!selectedKeys.has(key)) {
      selectionAnchor.current = key;
      setSelectedKeys(new Set([key]));
    }
    draggedSelections.current = dragged.map((entry) => ({ ...entry }));
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(INTERNAL_DRAG_TYPE, JSON.stringify(dragged));
    event.dataTransfer.setData("text/plain", "OriginVault items");
    setInternalDragActive(true);
    setContextMenu(undefined);
  };
  const canAcceptDrop = (dataTransfer: DataTransfer) =>
    internalDragActive ||
    dataTransfer.types.includes(INTERNAL_DRAG_TYPE) ||
    dataTransfer.types.includes("Files");
  const handleDropAt = (
    event: React.DragEvent<HTMLElement>,
    destination?: VaultFolder,
  ) => {
    if (!canAcceptDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    setDropTarget(undefined);
    let internalSelections = draggedSelections.current;
    if (
      !internalSelections.length &&
      event.dataTransfer.types.includes(INTERNAL_DRAG_TYPE)
    ) {
      try {
        const parsed: unknown = JSON.parse(
          event.dataTransfer.getData(INTERNAL_DRAG_TYPE),
        );
        if (Array.isArray(parsed))
          internalSelections = parsed.filter(
            (entry): entry is BulkSelection =>
              Boolean(
                entry &&
                  typeof entry === "object" &&
                  ((entry as BulkSelection).type === "file" ||
                    (entry as BulkSelection).type === "folder") &&
                  typeof (entry as BulkSelection).id === "string",
              ),
          );
      } catch {
        internalSelections = [];
      }
    }
    if (internalSelections.length) {
      draggedSelections.current = internalSelections;
      void moveDroppedSelections(internalSelections, destination);
      return;
    }
    void enqueueDroppedFiles(event.dataTransfer, destination ?? null);
    setExternalDropActive(false);
  };
  const markDropTarget = (
    event: React.DragEvent<HTMLElement>,
    target: string,
  ) => {
    if (!canAcceptDrop(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    const internal =
      draggedSelections.current.length > 0 ||
      event.dataTransfer.types.includes(INTERNAL_DRAG_TYPE);
    event.dataTransfer.dropEffect =
      internal ? "move" : "copy";
    if (target === "current" && internal) {
      setDropTarget((current) => (current === "current" ? undefined : current));
      return;
    }
    setDropTarget(target);
  };
  const clearDropTarget = (
    event: React.DragEvent<HTMLElement>,
    target: string,
  ) => {
    const related = event.relatedTarget;
    if (related instanceof Node && event.currentTarget.contains(related)) return;
    setDropTarget((current) => (current === target ? undefined : current));
  };
  const deleteSelected = async () => {
    if (
      !window.confirm(
        user.trashEnabled
          ? `선택한 ${selections.length}개 항목과 폴더 하위 내용을 휴지통으로 옮길까요? 30일 안에 복원할 수 있습니다.`
          : `선택한 ${selections.length}개 항목과 폴더 하위 내용을 완전히 삭제할까요?`,
      )
    )
      return;
    try {
      setBulkBusy(true);
      await api.bulkDelete(selections);
      removeDeletedFromClipboard(selections);
      clearSelection();
      await refreshFiles();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "일괄 삭제 실패");
    } finally {
      setBulkBusy(false);
    }
  };
  const openShareDialog = (selection = selections[0]) => {
    if (!selection) return;
    const item =
      selection.type === "folder"
        ? allFolders.find((entry) => entry.id === selection.id)
        : items.files.find((entry) => entry.id === selection.id);
    if (!item) {
      setMessage("공유할 항목을 찾지 못했습니다. 목록을 새로고침하세요.");
      return;
    }
    setShareDialogTarget({ type: selection.type, id: selection.id, name: item.name });
  };
  const createShare = async (input: {
    password?: string;
    access: "read" | "readwrite";
    includeHidden: boolean;
  }) => {
    const target = shareDialogTarget;
    if (!target) return;
    // Start this while the submit action is trusted, before waiting for the server URL.
    const pendingClipboardCopy = beginClipboardCopy();
    try {
      setBulkBusy(true);
      const shared = await api.createShare(target.type, target.id, input);
      try {
        if (pendingClipboardCopy) await pendingClipboardCopy.complete(shared.url);
        else await copyText(shared.url);
        setMessage("공유 링크를 만들고 클립보드에 복사했습니다.");
      } catch {
        try {
          await copyText(shared.url);
          setMessage("공유 링크를 만들고 클립보드에 복사했습니다.");
        } catch {
          setMessage("공유 링크를 만들었지만 클립보드에 복사하지 못했습니다.");
        }
      }
      clearSelection();
      setShareDialogTarget(undefined);
    } catch (e) {
      pendingClipboardCopy?.cancel();
      setMessage(e instanceof Error ? e.message : "공유 생성 실패");
    } finally {
      setBulkBusy(false);
    }
  };

  const createFolder = async () => {
    const name = window.prompt("새 폴더 이름");
    if (!name) return;
    try {
      await api.createFolder(name, folder?.id);
      await refreshFiles();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "폴더 생성 실패");
    }
  };
  const renameFolder = async (item: VaultFolder) => {
    const name = window.prompt("변경할 폴더 이름", item.name);
    if (!name || name === item.name) return;
    try {
      await api.renameFolder(item.id, name);
      await refreshFiles();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "폴더 이름 변경 실패");
    }
  };
  const deleteFolder = async (item: VaultFolder) => {
    if (
      !window.confirm(
        user.trashEnabled
          ? `“${item.name}” 폴더와 안의 모든 파일을 휴지통으로 옮길까요? 30일 안에 복원할 수 있습니다.`
          : `“${item.name}” 폴더와 안의 모든 파일을 삭제할까요? 이 작업은 되돌릴 수 없습니다.`,
      )
    )
      return;
    try {
      await api.deleteFolder(item.id);
      removeDeletedFromClipboard([{ type: "folder", id: item.id }]);
      if (folderDetailTarget?.id === item.id) {
        folderDetailRequestSequence.current += 1;
        setFolderDetailTarget(undefined);
        setFolderDetail(undefined);
      }
      setSelectedKeys((previous) => {
        const next = new Set(previous);
        next.delete(selectionKey("folder", item.id));
        return next;
      });
      await refreshFiles();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "폴더 삭제 실패");
    }
  };
  const deleteFile = async (item: VaultFile) => {
    if (!window.confirm(user.trashEnabled ? `“${item.name}” 파일을 휴지통으로 옮길까요? 30일 안에 복원할 수 있습니다.` : `“${item.name}” 파일을 완전히 삭제할까요?`)) return;
    try {
      await api.deleteFile(item.id);
      removeDeletedFromClipboard([{ type: "file", id: item.id }]);
      if (previewFile?.id === item.id) setPreviewFile(undefined);
      if (detailTarget?.id === item.id) {
        setDetailTarget(undefined);
        setFileDetail(undefined);
      }
      setSelectedKeys((previous) => {
        const next = new Set(previous);
        next.delete(selectionKey("file", item.id));
        return next;
      });
      await Promise.all([load(), refreshStorage()]);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "파일 삭제 실패");
    }
  };
  const openPreview = (file: VaultFile) => setPreviewFile(file);
  const closeFileDetails = () => {
    detailRequestSequence.current += 1;
    setDetailTarget(undefined);
    setFileDetail(undefined);
    setDetailLoading(false);
  };
  const openFileDetails = async (file: VaultFile) => {
    folderDetailRequestSequence.current += 1;
    setFolderDetailTarget(undefined);
    setFolderDetail(undefined);
    const sequence = ++detailRequestSequence.current;
    setDetailTarget(file);
    setFileDetail(undefined);
    setDetailLoading(true);
    try {
      const detail = await api.file(file.id);
      if (sequence === detailRequestSequence.current) setFileDetail(detail);
    } catch (error) {
      if (sequence !== detailRequestSequence.current) return;
      setMessage(
        error instanceof Error
          ? error.message
          : "파일 상세정보를 불러오지 못했습니다.",
      );
      closeFileDetails();
    } finally {
      if (sequence === detailRequestSequence.current) setDetailLoading(false);
    }
  };
  const closeFolderDetails = () => {
    folderDetailRequestSequence.current += 1;
    setFolderDetailTarget(undefined);
    setFolderDetail(undefined);
    setFolderDetailLoading(false);
  };
  const openFolderDetails = async (target: VaultFolder) => {
    detailRequestSequence.current += 1;
    setDetailTarget(undefined);
    setFileDetail(undefined);
    const sequence = ++folderDetailRequestSequence.current;
    setFolderDetailTarget(target);
    setFolderDetail(undefined);
    setFolderDetailLoading(true);
    try {
      const detail = await api.folder(target.id);
      if (sequence === folderDetailRequestSequence.current)
        setFolderDetail(detail);
    } catch (error) {
      if (sequence !== folderDetailRequestSequence.current) return;
      setMessage(
        error instanceof Error
          ? error.message
          : "폴더 상세정보를 불러오지 못했습니다.",
      );
      closeFolderDetails();
    } finally {
      if (sequence === folderDetailRequestSequence.current)
        setFolderDetailLoading(false);
    }
  };
  const downloadFile = async (file: Pick<VaultFile, "id" | "name">) => {
    try {
      await api.download(file);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "다운로드 실패");
    }
  };
  useEffect(() => {
    if (activeView !== "files") return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        event.altKey ||
        (!event.ctrlKey && !event.metaKey) ||
        previewFile ||
        detailTarget ||
        folderDetailTarget ||
        moveOpen ||
        contextMenu
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          "input, textarea, select, [contenteditable]:not([contenteditable='false'])",
        )
      )
        return;
      const key = event.key.toLowerCase();
      if ((key === "c" || key === "x") && selections.length && !bulkBusy) {
        event.preventDefault();
        storeFileClipboard(key === "c" ? "copy" : "cut");
      } else if (key === "v" && fileClipboard && !bulkBusy) {
        event.preventDefault();
        void pasteFileClipboard();
      }
    };
    document.addEventListener("keydown", handleShortcut);
    return () => document.removeEventListener("keydown", handleShortcut);
  }, [
    activeView,
    bulkBusy,
    contextMenu,
    detailTarget,
    folderDetailTarget,
    fileClipboard,
    folder?.id,
    moveOpen,
    previewFile,
    selections,
  ]);
  useEffect(() => {
    if (!detailTarget && !folderDetailTarget) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (detailTarget) closeFileDetails();
      if (folderDetailTarget) closeFolderDetails();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [detailTarget, folderDetailTarget]);
  useEffect(() => {
    if (activeView !== "files" || fileClipboard?.mode !== "cut") return;
    const cancelCutOnEscape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        contextMenu ||
        previewFile ||
        detailTarget ||
        folderDetailTarget ||
        moveOpen
      )
        return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest("input, textarea, select, [contenteditable='true']")
      )
        return;
      event.preventDefault();
      cancelCut();
    };
    document.addEventListener("keydown", cancelCutOnEscape);
    return () => document.removeEventListener("keydown", cancelCutOnEscape);
  }, [
    activeView,
    contextMenu,
    detailTarget,
    fileClipboard,
    folderDetailTarget,
    moveOpen,
    previewFile,
  ]);
  const usedBytes = BigInt(storage.usedBytes) + BigInt(storage.reservedBytes);
  const clipboardKeys = new Set(
    fileClipboard?.selections.map((entry) =>
      selectionKey(entry.type, entry.id),
    ) ?? [],
  );
  const contextSelectionCount =
    contextMenu && contextMenu.type !== "background" ? selections.length : 0;
  const contextIsBulk = contextSelectionCount > 1;
  const runContextAction = (action: () => void) => {
    setContextMenu(undefined);
    action();
  };
  return (
    <div
      className="app-shell"
      onDragEnter={(event) => {
        if (
          activeView !== "files" ||
          !event.dataTransfer.types.includes("Files") ||
          event.dataTransfer.types.includes(INTERNAL_DRAG_TYPE)
        )
          return;
        externalDragDepth.current += 1;
        setExternalDropActive(true);
      }}
      onDragOver={(event) => {
        if (
          activeView !== "files" ||
          !event.dataTransfer.types.includes("Files") ||
          event.dataTransfer.types.includes(INTERNAL_DRAG_TYPE)
        )
          return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setExternalDropActive(true);
      }}
      onDragLeave={(event) => {
        if (!externalDropActive) return;
        const related = event.relatedTarget;
        if (related instanceof Node && event.currentTarget.contains(related)) return;
        externalDragDepth.current = 0;
        setExternalDropActive(false);
      }}
      onDrop={(event) => {
        if (
          activeView !== "files" ||
          !event.dataTransfer.types.includes("Files") ||
          event.dataTransfer.types.includes(INTERNAL_DRAG_TYPE)
        )
          return;
        event.preventDefault();
        externalDragDepth.current = 0;
        setExternalDropActive(false);
        void enqueueDroppedFiles(event.dataTransfer, folder ?? null);
      }}
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("input, textarea, [contenteditable='true']")) return;
        event.preventDefault();
        if (
          target.closest(
            "[data-select-key], .item-context-menu, button, a, input, select, textarea, label, [contenteditable='true']",
          )
        )
          return;
        if (
          activeView === "files" &&
          target.closest(".files-section, .breadcrumbs")
        ) {
          setContextMenu({
            type: "background",
            x: event.clientX,
            y: event.clientY,
          });
          return;
        }
        setContextMenu(undefined);
      }}
    >
      <aside className="sidebar">
        <div className="brand">
          <div className="logo">
            <Archive />
          </div>
          <span>OriginVault</span>
          <button
            ref={mobileTreeToggle}
            className="mobile-tree-toggle"
            title={mobileTreeOpen ? "폴더 트리 닫기" : "폴더 트리 열기"}
            aria-controls="sidebar-folder-tree"
            aria-expanded={mobileTreeOpen}
            onClick={() => setMobileTreeOpen((value) => !value)}
          >
            <FolderOpen />
            <span>폴더</span>
            <ChevronRight className={mobileTreeOpen ? "expanded" : ""} />
          </button>
        </div>
        <nav className="primary-nav" aria-label="대메뉴">
          <button
            className={activeView === "files" ? "active" : ""}
            onClick={() => setActiveView("files")}
          >
            <FilesIcon />
            <span>내 파일</span>
          </button>
          <button
            className={activeView === "shares" ? "active" : ""}
            onClick={() => setActiveView("shares")}
          >
            <Share2 />
            <span>공유</span>
          </button>
          <button
            className={activeView === "trash" ? "active" : ""}
            onClick={() => setActiveView("trash")}
          >
            <Trash2 />
            <span>휴지통</span>
          </button>
          <button
            className={activeView === "settings" ? "active" : ""}
            onClick={() => setActiveView("settings")}
          >
            <Settings />
            <span>설정</span>
          </button>
        </nav>
        <div
          id="sidebar-folder-tree"
          className={`sidebar-tree-panel ${mobileTreeOpen ? "mobile-open" : ""}`}
        >
          <FolderTree
            folders={allFolders}
            selectedId={folder?.id}
            onSelect={(selected) => {
              selectTreeFolder(selected);
              setActiveView("files");
              setMobileTreeOpen(false);
              window.requestAnimationFrame(() => {
                if (mobileTreeToggle.current?.offsetParent)
                  mobileTreeToggle.current.focus();
              });
            }}
            onRefresh={() =>
              void (activeView === "files" ? refreshFiles() : loadTree())
            }
            refreshing={treeRefreshing}
            draggingItems={internalDragActive}
            onDropItems={(destination) =>
              void moveDroppedSelections(
                draggedSelections.current,
                destination,
              )
            }
            onDropFiles={(dataTransfer, destination) =>
              void enqueueDroppedFiles(dataTransfer, destination ?? null)
            }
          />
        </div>
        <div className="sidebar-storage">
          <span>STORAGE</span>
          <strong>{formatBytes(usedBytes)}</strong>
          <small>
            {storage.quotaBytes
              ? `${formatBytes(storage.quotaBytes)} 할당`
              : "할당량 제한 없음"}
          </small>
          {user.isAdmin && serverStorage && (
            <small>서버 내 남은 공간 {formatBytes(serverStorage.availableBytes)}</small>
          )}
        </div>
        <div className="sidebar-bottom">
          <div className="avatar">{user.displayName[0]?.toUpperCase()}</div>
          <div>
            <strong>{user.displayName}</strong>
            <small>{user.isAdmin ? "Administrator" : `@${username}`}</small>
          </div>
          <button className="icon-btn" title="로그아웃" onClick={onLogout}>
            <LogOut size={18} />
          </button>
        </div>
      </aside>
      <main
        ref={contentRef}
        className="content"
        onPointerDown={handleSelectionPointerDown}
        onPointerMove={handleSelectionPointerMove}
        onPointerUp={handleSelectionPointerUp}
        onPointerCancel={handleSelectionPointerCancel}
      >
        {message && (
          <div
            className="notice global-notice"
            role="status"
            onClick={() => setMessage("")}
          >
            {message}
            <X size={15} />
          </div>
        )}
        {activeView === "files" && (
          <>
            <header className="topbar">
              <div>
                <p className="eyebrow">MY PRIVATE SPACE</p>
                <h1>{folder?.name ?? "내 파일"}</h1>
              </div>
              <div className="actions">
                <button
                  className="secondary"
                  onClick={() => void refreshFiles()}
                  disabled={filesRefreshing}
                >
                  <RefreshCw className={filesRefreshing ? "spin" : ""} />
                  새로고침
                </button>
                <button className="secondary" onClick={createFolder}>
                  <FolderPlus />새 폴더
                </button>
                <button
                  className="secondary"
                  onClick={openFolderPicker}
                >
                  <FolderUp />
                  폴더 업로드
                </button>
                <button
                  className="primary"
                  onClick={() => picker.current?.click()}
                >
                  <Upload />
                  {isUploading ? "파일 추가" : "파일 업로드"}
                </button>
                <input
                  ref={picker}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => enqueue(e.target.files)}
                />
                <input
                  ref={setFolderPicker}
                  type="file"
                  multiple
                  hidden
                  onChange={(e) => enqueue(e.target.files, true)}
                />
              </div>
            </header>
            <div className="breadcrumbs">
              <button onClick={() => setTrail([])}>내 파일</button>
              {trail.map((part, i) => (
                <span key={part.id}>
                  <ChevronRight />
                  <button onClick={() => setTrail(trail.slice(0, i + 1))}>
                    {part.name}
                  </button>
                </span>
              ))}
            </div>
            <UploadQueue
              tasks={uploadTasks}
              batch={uploadBatch}
              onRemove={removeUploadTasks}
              onRetry={retryUpload}
              onClearCompleted={clearCompleted}
              onPauseAll={pauseAllUploads}
              onResumeAll={resumeAllUploads}
              onCancelAll={cancelAllUploads}
            />
            <SelectionToolbar
              selectedCount={selections.length}
              totalCount={currentKeys.length}
              busy={bulkBusy}
              onSelectAll={selectAll}
              onClear={clearSelection}
              onDownloadOriginals={() => void downloadOriginals()}
              onDownloadZip={() => void downloadZip()}
              onShare={openShareDialog}
              onMove={() => {
                setMoveDestination("");
                setMoveOpen(true);
              }}
              onDelete={() => void deleteSelected()}
            />
            <section
              ref={filesSection}
              className={`files-section ${bulkBusy ? "bulk-busy" : ""} ${dropTarget === "current" ? "drop-target" : ""}`}
              onDragOver={(event) => markDropTarget(event, "current")}
              onDragLeave={(event) => clearDropTarget(event, "current")}
              onDrop={(event) => handleDropAt(event, folder)}
            >
              <div className="section-heading">
                <div>
                  <h2>파일과 폴더</h2>
                    <small>
                      클릭·Ctrl·Shift로 선택 · 드래그로 범위 선택 · 항목 드래그로 이동
                    </small>
                </div>
                <ListingControls
                  itemCount={items.folders.length + items.files.length}
                  sortField={sortField}
                  sortDirection={sortDirection}
                  viewMode={viewMode}
                  onSortFieldChange={setSortField}
                  onSortDirectionChange={() => setSortDirection((current) => current === "asc" ? "desc" : "asc")}
                  onViewModeChange={setViewMode}
                />
              </div>
              {selectionBox && (
                <div className="selection-box main-selection-box" style={selectionBox} />
              )}{" "}
              {!items.folders.length && !items.files.length && !folder ? (
                <div
                  className={`empty ${dropTarget === "current" ? "drop-target" : ""}`}
                >
                  <div>
                    <Upload />
                  </div>
                  <h3>첫 번째 원본을 보관하세요</h3>
                  <p>파일을 여기로 끌어다 놓거나 업로드 버튼을 누르세요.</p>
                </div>
              ) : (
                <div className={`file-grid view-${viewMode}`}>
                  {folder && (
                    <button
                      type="button"
                      className={`parent-folder-card ${dropTarget === "parent" ? "drop-target" : ""}`}
                      onClick={() => setTrail(trail.slice(0, -1))}
                      onDragOver={(event) => markDropTarget(event, "parent")}
                      onDragLeave={(event) => clearDropTarget(event, "parent")}
                      onDrop={(event) => handleDropAt(event, parentFolder)}
                    >
                      <CornerUpLeft />
                      <span>
                        <strong>상위 폴더</strong>
                        <small>{parentFolder?.name ?? "내 파일"}(으)로 이동</small>
                      </span>
                    </button>
                  )}
                  {!items.folders.length && !items.files.length && (
                    <div className="empty empty-in-grid">
                      <div>
                        <FolderOpen />
                      </div>
                      <h3>이 폴더는 비어 있습니다</h3>
                      <p>파일을 업로드하거나 빈 곳을 우클릭해 붙여넣으세요.</p>
                    </div>
                  )}
                  {sortedFolders.map((item) => {
                    const key = selectionKey("folder", item.id),
                      selected = selectedKeys.has(key);
                    return (
                      <div
                        data-select-key={key}
                        className={`file-card folder-card ${selected ? "selected" : ""} ${fileClipboard?.mode === "cut" && clipboardKeys.has(key) ? "clipboard-cut" : ""} ${dropTarget === key ? "drop-target" : ""}`}
                        key={item.id}
                        role="checkbox"
                        aria-checked={selected}
                        tabIndex={0}
                        draggable={selected && !bulkBusy}
                        onClick={(event) => selectItem(key, event)}
                        onDragStart={(event) =>
                          handleItemDragStart(
                            event,
                            { type: "folder", id: item.id },
                            key,
                          )
                        }
                        onDragEnd={finishInternalDrag}
                        onDragOver={(event) => markDropTarget(event, key)}
                        onDragLeave={(event) => clearDropTarget(event, key)}
                        onDrop={(event) => handleDropAt(event, item)}
                        onDoubleClick={(event) => {
                          if ((event.target as HTMLElement).closest("button"))
                            return;
                          setTrail([...trail, item]);
                        }}
                        onContextMenu={(event) =>
                          handleItemContextMenu(
                            event,
                            { type: "folder", item },
                            key,
                          )
                        }
                        onKeyDown={(event) =>
                          handleItemKeyDown(
                            event,
                            { type: "folder", item },
                            key,
                          )
                        }
                      >
                        {viewMode === "preview" ? (
                          <div className="file-preview-thumb folder-thumb" aria-hidden="true">
                            <Folder />
                          </div>
                        ) : (
                          <div className="file-icon">
                            <Folder />
                          </div>
                        )}
                        <div className="file-meta">
                          <strong>{item.name}</strong>
                          <small>
                            폴더 · 생성 {listDate(item.originalCreatedAt)} · 수정 {listDate(item.originalModifiedAt)}
                          </small>
                        </div>
                        <div className="file-actions">
                          <button
                            title="폴더 상세정보 보기"
                            aria-label={`${item.name} 상세정보 보기`}
                            onClick={(event) => {
                              event.stopPropagation();
                              void openFolderDetails(item);
                            }}
                          >
                            <Info />
                          </button>
                          <button
                            className="item-menu-trigger"
                            title="폴더 메뉴"
                            aria-label={`${item.name} 메뉴 열기`}
                            aria-haspopup="menu"
                            onClick={(e) => {
                              e.stopPropagation();
                              contextMenuAnchor.current = e.currentTarget;
                              const bounds =
                                e.currentTarget.getBoundingClientRect();
                              showItemMenu(
                                { type: "folder", item },
                                key,
                                bounds.right,
                                bounds.bottom + 4,
                                e.detail === 0,
                              );
                            }}
                          >
                            <MoreHorizontal />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                  {sortedFiles.map((item) => {
                    const Icon = item.mimeType.startsWith("image/")
                        ? FileImage
                        : item.mimeType.startsWith("video/")
                          ? FileVideo
                          : File,
                      key = selectionKey("file", item.id),
                      selected = selectedKeys.has(key);
                    return (
                      <div
                        data-select-key={key}
                        className={`file-card ${selected ? "selected" : ""} ${fileClipboard?.mode === "cut" && clipboardKeys.has(key) ? "clipboard-cut" : ""}`}
                        key={item.id}
                        role="checkbox"
                        aria-checked={selected}
                        tabIndex={0}
                        draggable={selected && !bulkBusy}
                        onClick={(event) => selectItem(key, event)}
                        onDragStart={(event) =>
                          handleItemDragStart(
                            event,
                            { type: "file", id: item.id },
                            key,
                          )
                        }
                        onDragEnd={finishInternalDrag}
                        onDoubleClick={(event) => {
                          if ((event.target as HTMLElement).closest("button"))
                            return;
                          openPreview(item);
                        }}
                        onContextMenu={(event) =>
                          handleItemContextMenu(
                            event,
                            { type: "file", item },
                            key,
                          )
                        }
                        onKeyDown={(event) =>
                          handleItemKeyDown(event, { type: "file", item }, key)
                        }
                      >
                        {viewMode === "preview" ? (
                          <FileThumbnail file={item} fallback={Icon} />
                        ) : (
                          <div className="file-icon">
                            <Icon />
                          </div>
                        )}
                        <div className="file-meta">
                          <strong>{item.name}</strong>
                          <small>
                            {formatBytes(item.sizeBytes)} · 생성 {listDate(item.originalCreatedAt)} · 수정 {listDate(item.originalModifiedAt)}
                          </small>
                        </div>
                        <div className="file-actions">
                          <button
                            title="상세정보 보기"
                            aria-label={`${item.name} 상세정보 보기`}
                            onClick={(event) => {
                              event.stopPropagation();
                              void openFileDetails(item);
                            }}
                          >
                            <Info />
                          </button>
                          <button
                            className="item-menu-trigger"
                            title="파일 메뉴"
                            aria-label={`${item.name} 메뉴 열기`}
                            aria-haspopup="menu"
                            onClick={(e) => {
                              e.stopPropagation();
                              contextMenuAnchor.current = e.currentTarget;
                              const bounds =
                                e.currentTarget.getBoundingClientRect();
                              showItemMenu(
                                { type: "file", item },
                                key,
                                bounds.right,
                                bounds.bottom + 4,
                                e.detail === 0,
                              );
                            }}
                          >
                            <MoreHorizontal />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </>
        )}
        {activeView === "shares" && (
          <SharesPage folders={allFolders} onMessage={setMessage} />
        )}{" "}
        {activeView === "trash" && (
          <TrashPage onMessage={setMessage} onStorageChanged={onStorageChanged} />
        )}
        {activeView === "settings" && (
          <SettingsPage
            user={user}
            storage={storage}
            onUserChanged={onUserChanged}
            onStorageChanged={onStorageChanged}
            onHiddenFilesChanged={refreshFiles}
            onMessage={setMessage}
          />
        )}
      </main>
      {activeView === "files" && externalDropActive && (
        <div className="external-upload-overlay" aria-hidden="true">
          <Upload />
          <strong>이 폴더로 업로드</strong>
        </div>
      )}
      {activeView === "files" && contextMenu && (
        <div
          ref={contextMenuRef}
          className="item-context-menu"
          role="menu"
          aria-label="파일 작업 메뉴"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onContextMenu={(event) => event.preventDefault()}
          onKeyDown={(event) => {
            if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
            event.preventDefault();
            const buttons = Array.from(
              event.currentTarget.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              ),
            );
            const index = buttons.indexOf(
              document.activeElement as HTMLButtonElement,
            );
            const direction = event.key === "ArrowDown" ? 1 : -1;
            buttons[
              (index + direction + buttons.length) % buttons.length
            ]?.focus();
          }}
        >
          <div className="context-menu-heading">
            <strong>
              {contextMenu.type === "background"
                ? folder?.name ?? "내 파일"
                : contextIsBulk
                ? `${contextSelectionCount}개 항목`
                : contextMenu.item.name}
            </strong>
            <small>
              {contextMenu.type === "background"
                ? "현재 폴더"
                : contextIsBulk
                ? "선택 항목"
                : contextMenu.type === "folder"
                  ? "폴더"
                  : "파일"}
            </small>
          </div>
          {contextMenu.type === "background" ? (
            <button
              role="menuitem"
              disabled={!fileClipboard || bulkBusy}
              onClick={() =>
                runContextAction(() => void pasteFileClipboard(folder?.id))
              }
            >
              <ClipboardPaste />
              현재 폴더에 붙여넣기
              <kbd>Ctrl+V</kbd>
            </button>
          ) : contextIsBulk ? (
            <>
              <button
                role="menuitem"
                onClick={() => runContextAction(() => void downloadOriginals())}
              >
                <Download />
                개별 원본 다운로드
              </button>
              <button
                role="menuitem"
                onClick={() => runContextAction(() => void downloadZip())}
              >
                <Package />
                ZIP 다운로드
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => storeFileClipboard("copy"))
                }
              >
                <Copy />
                복사
                <kbd>Ctrl+C</kbd>
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => storeFileClipboard("cut"))
                }
              >
                <Scissors />
                잘라내기
                <kbd>Ctrl+X</kbd>
              </button>
              <button
                role="menuitem"
                disabled={!fileClipboard}
                onClick={() =>
                  runContextAction(() => void pasteFileClipboard(folder?.id))
                }
              >
                <ClipboardPaste />
                붙여넣기
                <kbd>Ctrl+V</kbd>
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => {
                    setMoveDestination("");
                    setMoveOpen(true);
                  })
                }
              >
                <FolderInput />
                이동
              </button>
              <div className="context-menu-divider" />
              <button
                className="danger"
                role="menuitem"
                onClick={() => runContextAction(() => void deleteSelected())}
              >
                <Trash2 />
                {contextSelectionCount}개 항목 삭제
              </button>
            </>
          ) : contextMenu.type === "folder" ? (
            <>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => setTrail([...trail, contextMenu.item]))
                }
              >
                <FolderOpen />
                열기
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => void openFolderDetails(contextMenu.item))
                }
              >
                <Info />
                상세정보 보기
              </button>
              <button
                role="menuitem"
                onClick={() => runContextAction(() => void downloadZip())}
              >
                <Package />
                ZIP 다운로드
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() =>
                    openShareDialog({ type: "folder", id: contextMenu.item.id }),
                  )
                }
              >
                <Share2 />
                공유 링크 만들기
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => storeFileClipboard("copy"))
                }
              >
                <Copy />
                복사
                <kbd>Ctrl+C</kbd>
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => storeFileClipboard("cut"))
                }
              >
                <Scissors />
                잘라내기
                <kbd>Ctrl+X</kbd>
              </button>
              <button
                role="menuitem"
                disabled={!fileClipboard}
                onClick={() =>
                  runContextAction(() =>
                    void pasteFileClipboard(contextMenu.item.id),
                  )
                }
              >
                <ClipboardPaste />
                이 폴더에 붙여넣기
                <kbd>Ctrl+V</kbd>
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => {
                    setMoveDestination("");
                    setMoveOpen(true);
                  })
                }
              >
                <FolderInput />
                이동
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => void renameFolder(contextMenu.item))
                }
              >
                <Pencil />
                이름 변경
              </button>
              <div className="context-menu-divider" />
              <button
                className="danger"
                role="menuitem"
                onClick={() =>
                  runContextAction(() => void deleteFolder(contextMenu.item))
                }
              >
                <Trash2 />
                삭제
              </button>
            </>
          ) : (
            <>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => openPreview(contextMenu.item))
                }
              >
                <Eye />
                미리보기
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => void openFileDetails(contextMenu.item))
                }
              >
                <Info />
                상세정보 보기
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => void downloadFile(contextMenu.item))
                }
              >
                <Download />
                원본 다운로드
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() =>
                    openShareDialog({ type: "file", id: contextMenu.item.id }),
                  )
                }
              >
                <Share2 />
                공유 링크 만들기
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => storeFileClipboard("copy"))
                }
              >
                <Copy />
                복사
                <kbd>Ctrl+C</kbd>
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => storeFileClipboard("cut"))
                }
              >
                <Scissors />
                잘라내기
                <kbd>Ctrl+X</kbd>
              </button>
              <button
                role="menuitem"
                disabled={!fileClipboard}
                onClick={() =>
                  runContextAction(() => void pasteFileClipboard(folder?.id))
                }
              >
                <ClipboardPaste />
                붙여넣기
                <kbd>Ctrl+V</kbd>
              </button>
              <button
                role="menuitem"
                onClick={() =>
                  runContextAction(() => {
                    setMoveDestination("");
                    setMoveOpen(true);
                  })
                }
              >
                <FolderInput />
                이동
              </button>
              <div className="context-menu-divider" />
              <button
                className="danger"
                role="menuitem"
                onClick={() =>
                  runContextAction(() => void deleteFile(contextMenu.item))
                }
              >
                <Trash2 />
                삭제
              </button>
            </>
          )}
          {fileClipboard?.mode === "cut" && (
            <>
              <div className="context-menu-divider" />
              <button
                role="menuitem"
                onClick={() => runContextAction(cancelCut)}
              >
                <Undo2 />
                잘라내기 취소
                <kbd>Esc</kbd>
              </button>
            </>
          )}
        </div>
      )}
      {activeView === "files" && detailTarget && (
        <div
          className="drawer-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeFileDetails();
          }}
        >
          <aside
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-detail-title"
          >
            <header>
              <div>
                <p className="eyebrow">FILE DETAILS</p>
                <h2 id="file-detail-title">{detailTarget.name}</h2>
              </div>
              <button
                className="icon-btn"
                aria-label="상세정보 닫기"
                autoFocus
                onClick={closeFileDetails}
              >
                <X />
              </button>
            </header>
            <div className="file-hero">
              <File />
              <span>{detailTarget.mimeType}</span>
            </div>
            {detailLoading || !fileDetail ? (
              <div className="drawer-loading" role="status">
                상세정보를 불러오는 중입니다.
              </div>
            ) : (
              <>
                <dl className="facts">
                  <div>
                    <dt>파일 형식</dt>
                    <dd>{fileDetail.mimeType}</dd>
                  </div>
                  <div>
                    <dt>크기</dt>
                    <dd>{formatBytes(fileDetail.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt>보관 경로</dt>
                    <dd>{fileDetail.relativePath}</dd>
                  </div>
                  <div>
                    <dt>저장 파일명</dt>
                    <dd>{fileDetail.storedName}</dd>
                  </div>
                  <div>
                    <dt>원본 생성 일시</dt>
                    <dd>{detailDate(fileDetail.originalCreatedAt)}</dd>
                  </div>
                  <div>
                    <dt>원본 수정 일시</dt>
                    <dd>{detailDate(fileDetail.originalModifiedAt)}</dd>
                  </div>
                  <div>
                    <dt>최근 변경 일시</dt>
                    <dd>{detailDate(fileDetail.modifiedAt)}</dd>
                  </div>
                  <div className="hash">
                    <dt>SHA-256</dt>
                    <dd>{fileDetail.sha256}</dd>
                  </div>
                </dl>
                <h3>추출된 메타데이터</h3>
                {Object.keys(fileDetail.metadata ?? {}).length ? (
                  <div className="metadata">
                    {Object.entries(fileDetail.metadata).map(([key, value]) => (
                      <div key={key}>
                        <span>{key}</span>
                        <strong>{detailValue(value)}</strong>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="drawer-empty-metadata">
                    추출된 메타데이터가 없습니다.
                  </div>
                )}
                <button
                  className="primary"
                  onClick={() => {
                    closeFileDetails();
                    openPreview(detailTarget);
                  }}
                >
                  <Eye />
                  미리보기 열기
                </button>
              </>
            )}
          </aside>
        </div>
      )}
      {activeView === "files" && folderDetailTarget && (
        <div
          className="drawer-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeFolderDetails();
          }}
        >
          <aside
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="folder-detail-title"
          >
            <header>
              <div>
                <p className="eyebrow">FOLDER DETAILS</p>
                <h2 id="folder-detail-title">{folderDetailTarget.name}</h2>
              </div>
              <button
                className="icon-btn"
                aria-label="폴더 상세정보 닫기"
                autoFocus
                onClick={closeFolderDetails}
              >
                <X />
              </button>
            </header>
            <div className="file-hero folder-hero">
              <Folder />
              <span>폴더와 모든 하위 항목</span>
            </div>
            {folderDetailLoading || !folderDetail ? (
              <div className="drawer-loading" role="status">
                폴더 통계를 계산하는 중입니다.
              </div>
            ) : (
              <>
                <dl className="facts">
                  <div>
                    <dt>전체 크기</dt>
                    <dd>{formatBytes(folderDetail.sizeBytes)}</dd>
                  </div>
                  <div>
                    <dt>전체 파일</dt>
                    <dd>{folderDetail.fileCount.toLocaleString("ko-KR")}개</dd>
                  </div>
                  <div>
                    <dt>하위 폴더</dt>
                    <dd>{folderDetail.folderCount.toLocaleString("ko-KR")}개</dd>
                  </div>
                  <div>
                    <dt>전체 항목</dt>
                    <dd>
                      {(
                        folderDetail.fileCount + folderDetail.folderCount
                      ).toLocaleString("ko-KR")}
                      개
                    </dd>
                  </div>
                  <div>
                    <dt>바로 아래 항목</dt>
                    <dd>
                      파일 {folderDetail.directFileCount.toLocaleString("ko-KR")}개 ·
                      폴더 {folderDetail.directFolderCount.toLocaleString("ko-KR")}개
                    </dd>
                  </div>
                  <div>
                    <dt>보관 경로</dt>
                    <dd>{folderDetail.relativePath}</dd>
                  </div>
                  <div>
                    <dt>원본 생성 일시</dt>
                    <dd>{detailDate(folderDetail.originalCreatedAt)}</dd>
                  </div>
                  <div>
                    <dt>원본 수정 일시</dt>
                    <dd>{detailDate(folderDetail.originalModifiedAt)}</dd>
                  </div>
                  <div>
                    <dt>최근 변경 일시</dt>
                    <dd>{detailDate(folderDetail.modifiedAt)}</dd>
                  </div>
                </dl>
                <button
                  className="primary"
                  onClick={() => {
                    closeFolderDetails();
                    setTrail([...trail, folderDetailTarget]);
                  }}
                >
                  <FolderOpen />
                  폴더 열기
                </button>
              </>
            )}
          </aside>
        </div>
      )}
      {activeView === "files" && previewFile && (
        <PreviewViewer
          file={previewFile}
          onNavigate={setPreviewFile}
          onClose={() => setPreviewFile(undefined)}
          onDownload={(file) => void downloadFile(file)}
          onChanged={refreshFiles}
          onMessage={setMessage}
        />
      )}{" "}
      {activeView === "files" && moveOpen && (
        <MoveDialog
          folders={allFolders}
          destinationId={moveDestination}
          busy={bulkBusy}
          disabledFolderIds={invalidMoveDestinationIds}
          onDestinationChange={setMoveDestination}
          onCancel={() => setMoveOpen(false)}
          onConfirm={() => void moveSelected()}
        />
      )}
      {collisionPrompt && (
        <CollisionDialog
          operation={collisionPrompt.operation}
          name={collisionPrompt.conflicts[collisionPrompt.index]!.name}
          current={collisionPrompt.index + 1}
          total={collisionPrompt.conflicts.length}
          onChoose={chooseCollision}
        />
      )}
      {activeView === "files" && shareDialogTarget && (
        <ShareDialog
          item={shareDialogTarget}
          busy={bulkBusy}
          onCancel={() => setShareDialogTarget(undefined)}
          onConfirm={(input) => void createShare(input)}
        />
      )}
    </div>
  );
}

function PrivateApp() {
  const [user, setUser] = useState<UserProfile>();
  const [storage, setStorage] = useState<StorageUsage>({
    usedBytes: "0",
    activeBytes: "0",
    trashBytes: "0",
    reservedBytes: "0",
    quotaBytes: null,
  });
  const [serverStorage, setServerStorage] = useState<ServerStorage | null>(null);
  const [checking, setChecking] = useState(Boolean(session.token));
  useEffect(() => {
    const unsubscribe = session.subscribe((value) => {
      if (!value) {
        setUser(undefined);
        setChecking(false);
      }
    });
    if (session.token)
      void api
        .me()
        .then((result) => {
          setUser(result.user);
          setStorage(result.storage);
          setServerStorage(result.serverStorage ?? null);
        })
        .finally(() => setChecking(false));
    return unsubscribe;
  }, []);
  const authenticated = async (nextUser: UserProfile) => {
    setUser(nextUser);
    try {
      const result = await api.me();
      setUser(result.user);
      setStorage(result.storage);
      setServerStorage(result.serverStorage ?? null);
    } finally {
      setChecking(false);
    }
  };
  if (checking)
    return (
      <main className="boot-screen">
        <div className="logo">
          <Archive />
        </div>
        <span>OriginVault를 여는 중입니다</span>
      </main>
    );
  return session.token && user ? (
    <Dashboard
      user={user}
      storage={storage}
      serverStorage={serverStorage}
      onUserChanged={setUser}
      onStorageChanged={setStorage}
      onServerStorageChanged={setServerStorage}
      onLogout={() => session.set("")}
    />
  ) : (
    <Auth onDone={(user) => void authenticated(user)} />
  );
}

export default function App() {
  useEffect(() => {
    const preventNativeContextMenu = (event: MouseEvent) => event.preventDefault();
    document.addEventListener("contextmenu", preventNativeContextMenu, true);
    return () =>
      document.removeEventListener("contextmenu", preventNativeContextMenu, true);
  }, []);
  const match = window.location.pathname.match(/^\/s\/([^/]+)\/?$/);
  return match ? (
    <PublicSharePage token={decodeURIComponent(match[1]!)} />
  ) : (
    <PrivateApp />
  );
}
