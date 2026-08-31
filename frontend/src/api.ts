/// <reference types="vite/client" />
const API_URL = import.meta.env.VITE_API_URL ?? "/api";
const apiResourceUrl = (path: string) =>
  `${API_URL}${path.replace(/^\/api/, "")}`;

export interface Folder {
  id: string;
  name: string;
  parentId: string | null;
  relativePath: string;
  createdAt: string;
  originalCreatedAt?: string | null;
  originalModifiedAt?: string | null;
}
export interface FolderDetail extends Folder {
  modifiedAt: string;
  directFileCount: number;
  directFolderCount: number;
  fileCount: number;
  folderCount: number;
  sizeBytes: string;
}
export interface VaultFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  originalCreatedAt?: string | null;
  originalModifiedAt?: string | null;
  createdAt: string;
}
export interface FileDetail extends VaultFile {
  storedName: string;
  relativePath: string;
  metadata: Record<string, unknown>;
  modifiedAt?: string | null;
}
export type PreviewKind =
  | "text"
  | "subtitle"
  | "image"
  | "video"
  | "audio"
  | "pdf"
  | "unsupported";
export interface PreviewSibling extends VaultFile {
  kind: PreviewKind;
}
export interface PreviewFile extends FileDetail {
  kind: PreviewKind;
  encoding?: string;
  hasBom?: boolean;
  streamUrl?: string;
}
export type SavedPreviewFile = Omit<PreviewFile, "kind" | "streamUrl">;
export interface FilePreview {
  file: PreviewFile;
  siblings: PreviewSibling[];
  subtitles: PreviewSibling[];
  encodings: string[];
}
export interface TextFileContent {
  text: string;
  encoding: string;
  hasBom: boolean;
  etag: string;
}
export interface UploadResult {
  id: string;
  sha256: string;
}
export interface BulkSelection {
  type: "file" | "folder";
  id: string;
}
export type CollisionChoice = "overwrite" | "rename" | "cancel";
export interface NameCollision {
  source: BulkSelection;
  existing: BulkSelection;
  name: string;
}
export interface BulkManifestFile {
  id: string;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  downloadUrl: string;
}
export interface UploadSession {
  id?: string;
  uploadUrl?: string;
  offset?: number;
  sizeBytes?: number;
  complete: boolean;
  file?: { id: string; name: string; sizeBytes: string; sha256: string };
}
export interface StorageUsage {
  usedBytes: string;
  activeBytes: string;
  trashBytes: string;
  reservedBytes: string;
  quotaBytes: string | null;
}
export interface ServerStorage {
  totalBytes: string;
  availableBytes: string;
}
export interface UserProfile {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  storageQuotaBytes: string | null;
  trashEnabled: boolean;
  showHiddenFiles: boolean;
}
export interface ProfileResponse {
  user: UserProfile;
  storage: StorageUsage;
  serverStorage?: ServerStorage | null;
}
export interface TrashItem {
  id: string;
  type: "file" | "folder";
  name: string;
  originalCreatedAt?: string | null;
  originalModifiedAt?: string | null;
  trashedAt: string;
  expiresAt: string;
  fileCount: number;
  folderCount: number;
  sizeBytes: string;
}
export interface TrashFolder {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  originalCreatedAt?: string | null;
  originalModifiedAt?: string | null;
  modifiedAt: string;
  trashedAt: string;
}
export interface TrashFolderContents {
  folder: Pick<TrashFolder, "id" | "name" | "parentId">;
  folders: TrashFolder[];
  files: VaultFile[];
}
export interface ShareEvent {
  id: string;
  action: "view" | "download" | "denied";
  ip: string;
  userAgent: string | null;
  targetFileId: string | null;
  bytesSent: string | null;
  createdAt: string;
}
export interface ShareSummary {
  id: string;
  type: "file" | "folder";
  name: string;
  fileId: string | null;
  folderId: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  pausedAt: string | null;
  access: "read" | "readwrite";
  includeHidden: boolean;
  hasPassword: boolean;
  status: "active" | "paused" | "expired" | "revoked" | "unavailable";
  targetAvailable: boolean;
  url: string;
  accessCount: number;
  viewCount: number;
  downloadCount: number;
  visitorCount: number;
  lastAccessAt: string | null;
}
export interface ShareDetail extends ShareSummary {
  events: ShareEvent[];
}
export interface WebdavToken {
  id: string;
  name: string;
  folderId?: string | null;
  folderName: string;
  access: "read" | "readwrite";
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
}
export interface WebdavTokenList {
  url: string;
  username: string;
  tokens: WebdavToken[];
}
export interface WebdavCredential {
  id: string;
  name: string;
  folderId?: string | null;
  access: "read" | "readwrite";
  url: string;
  username: string;
  token: string;
}
export interface AdminUser {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  disabled: boolean;
  createdAt: string;
  storageQuotaBytes: string | null;
  usedBytes: string;
  reservedBytes: string;
}
export interface AdminSettings {
  registrationEnabled: boolean;
  updatedAt: string;
}
export interface PublicShareFile {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  originalCreatedAt?: string | null;
  createdAt: string;
  modifiedAt: string;
  clientLastModified: string | null;
  kind: PreviewKind;
}
export interface PublicShareFolder {
  id: string;
  name: string;
  originalCreatedAt?: string | null;
  originalModifiedAt?: string | null;
  createdAt: string;
  modifiedAt: string;
}
export interface PublicShareFolderDetail extends PublicShareFolder {
  directFileCount: number;
  directFolderCount: number;
  fileCount: number;
  folderCount: number;
  sizeBytes: string;
}
export interface PublicShare {
  id: string;
  type: "file" | "folder";
  name: string;
  access: "read" | "readwrite";
  rootFolderId?: string;
  currentFolder?: { id: string; name: string; parentId: string | null };
  folders?: PublicShareFolder[];
  files?: PublicShareFile[];
  file?: PublicShareFile;
}

let token = localStorage.getItem("originvault.token") ?? "";
const sessionListeners = new Set<(value: string) => void>();
export const session = {
  get token() {
    return token;
  },
  set(value: string) {
    if (token === value) return;
    token = value;
    value
      ? localStorage.setItem("originvault.token", value)
      : localStorage.removeItem("originvault.token");
    for (const listener of sessionListeners) listener(value);
  },
  subscribe(listener: (value: string) => void) {
    sessionListeners.add(listener);
    return () => {
      sessionListeners.delete(listener);
    };
  },
};

const handleResponseStatus = (status: number) => {
  if (status === 401 && token) session.set("");
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });
  handleResponseStatus(response.status);
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw Object.assign(new Error(body.error ?? "Request failed"), {
      status: response.status,
      passwordRequired: Boolean(body.passwordRequired),
    });
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

async function publicRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body instanceof FormData
        ? {}
        : { "Content-Type": "application/json" }),
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response
      .json()
      .catch(() => ({ error: response.statusText }));
    throw Object.assign(new Error(body.error ?? "Request failed"), {
      status: response.status,
      passwordRequired: Boolean(body.passwordRequired),
    });
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export const api = {
  registrationStatus: () =>
    request<{ registrationEnabled: boolean; bootstrapRequired: boolean }>(
      "/auth/registration-status",
    ),
  auth: (mode: "login" | "register", username: string, password: string) =>
    request<{ token: string; user: UserProfile }>(`/auth/${mode}`, {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  me: () => request<ProfileResponse>("/me"),
  updateProfile: (displayName: string) =>
    request<ProfileResponse>("/me/profile", {
      method: "PATCH",
      body: JSON.stringify({ displayName }),
    }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ token: string; user: UserProfile }>("/me/password", {
      method: "PUT",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  updateTrashEnabled: (trashEnabled: boolean) =>
    request<ProfileResponse>("/me/trash", {
      method: "PATCH",
      body: JSON.stringify({ trashEnabled }),
    }),
  updateShowHiddenFiles: (showHiddenFiles: boolean) =>
    request<ProfileResponse>("/me/hidden-files", {
      method: "PATCH",
      body: JSON.stringify({ showHiddenFiles }),
    }),
  items: (folderId?: string) =>
    request<{ folders: Folder[]; files: VaultFile[] }>(
      `/items${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ""}`,
    ),
  folderTree: () => request<{ folders: Folder[] }>("/folders/tree"),
  folder: (id: string) => request<FolderDetail>(`/folders/${id}`),
  createFolder: (name: string, parentId?: string) =>
    request<Folder>("/folders", {
      method: "POST",
      body: JSON.stringify({ name, parentId }),
    }),
  renameFolder: (id: string, name: string) =>
    request<Folder>(`/folders/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),
  deleteFolder: (id: string) =>
    request<void>(`/folders/${id}`, { method: "DELETE" }),
  deleteFile: (id: string) =>
    request<void>(`/files/${id}`, { method: "DELETE" }),
  trash: () => request<{ items: TrashItem[]; retentionDays: number }>("/trash"),
  trashFolder: (id: string) =>
    request<TrashFolderContents>(`/trash/folders/${encodeURIComponent(id)}`),
  trashRestoreCollision: (type: TrashItem["type"], id: string) =>
    request<{ conflict: boolean }>(
      `/trash/${type}/${encodeURIComponent(id)}/restore-collision`,
    ),
  restoreTrash: (
    type: TrashItem["type"],
    id: string,
    collision?: Exclude<CollisionChoice, "cancel">,
  ) =>
    request<{ restored: { files: number; folders: number } }>(
      `/trash/${type}/${encodeURIComponent(id)}/restore`,
      { method: "POST", body: JSON.stringify(collision ? { collision } : {}) },
    ),
  permanentlyDeleteTrash: (type: TrashItem["type"], id: string) =>
    request<void>(`/trash/${type}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  permanentlyDeleteTrashSelections: (selections: BulkSelection[]) =>
    request<{ deleted: number }>("/trash/delete", {
      method: "POST",
      body: JSON.stringify({ selections }),
    }),
  permanentlyDeleteAllTrash: () =>
    request<{ deleted: number }>("/trash", { method: "DELETE" }),
  bulkManifest: (selections: BulkSelection[]) =>
    request<{
      files: BulkManifestFile[];
      count: number;
      totalSizeBytes: string;
    }>("/bulk/manifest", {
      method: "POST",
      body: JSON.stringify({ selections }),
    }),
  bulkMove: (selections: BulkSelection[], destinationFolderId?: string) =>
    request<{ moved: { files: number; folders: number }; skipped: number }>(
      "/bulk/move",
      {
        method: "POST",
        body: JSON.stringify({
          selections,
          destinationFolderId: destinationFolderId || null,
        }),
      },
    ),
  bulkCollisions: (
    mode: "move" | "copy",
    selections: BulkSelection[],
    destinationFolderId?: string,
  ) =>
    request<{ conflicts: NameCollision[] }>("/bulk/collisions", {
      method: "POST",
      body: JSON.stringify({
        mode,
        selections,
        destinationFolderId: destinationFolderId || null,
      }),
    }),
  uploadCollisions: (
    entries: Array<{
      key: string;
      originalName: string;
      folderId?: string;
      relativeDirectory: string;
    }>,
  ) =>
    request<{
      conflicts: Array<{
        key: string;
        existing: BulkSelection;
        name: string;
      }>;
    }>("/upload-sessions/collisions", {
      method: "POST",
      body: JSON.stringify({ entries }),
    }),
  bulkCopy: (selections: BulkSelection[], destinationFolderId?: string) =>
    request<{
      copied: { files: number; folders: number };
      topLevelItems: Array<{
        id: string;
        type: "file" | "folder";
        name: string;
        relativePath: string;
      }>;
      cleanupPending: boolean;
    }>("/bulk/copy", {
      method: "POST",
      body: JSON.stringify({
        selections,
        destinationFolderId: destinationFolderId || null,
      }),
    }),
  bulkDelete: (selections: BulkSelection[]) =>
    request<{
      deleted: { files: number; folders: number };
      cleanupPending: boolean;
    }>("/bulk/delete", {
      method: "POST",
      body: JSON.stringify({ selections }),
    }),
  shares: () => request<{ shares: ShareSummary[] }>("/shares"),
  share: (id: string) =>
    request<ShareDetail>(`/shares/${encodeURIComponent(id)}`),
  createShare: (
    type: "file" | "folder",
    id: string,
    input: {
      expiresAt?: string;
      password?: string;
      access?: "read" | "readwrite";
      includeHidden?: boolean;
    } = {},
  ) =>
    request<ShareSummary>("/shares", {
      method: "POST",
      body: JSON.stringify({
        type,
        id,
        expiresAt: input.expiresAt || null,
        password: input.password || null,
        access: input.access ?? "read",
        includeHidden: input.includeHidden ?? false,
      }),
    }),
  revokeShare: (id: string) =>
    request<void>(`/shares/${encodeURIComponent(id)}`, { method: "DELETE" }),
  hideShare: (id: string) =>
    request<void>(`/shares/${encodeURIComponent(id)}/history`, {
      method: "DELETE",
    }),
  rotateShare: (id: string) =>
    request<ShareSummary>(`/shares/${encodeURIComponent(id)}/rotate`, {
      method: "POST",
      body: "{}",
    }),
  updateShare: (
    id: string,
    input: Partial<{ password: string | null; access: "read" | "readwrite"; includeHidden: boolean }>,
  ) =>
    request<ShareSummary>(`/shares/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  pauseShare: (id: string) =>
    request<ShareSummary>(`/shares/${encodeURIComponent(id)}/pause`, {
      method: "POST",
      body: "{}",
    }),
  resumeShare: (id: string) =>
    request<ShareSummary>(`/shares/${encodeURIComponent(id)}/resume`, {
      method: "POST",
      body: "{}",
    }),
  webdavTokens: () => request<WebdavTokenList>("/webdav/tokens"),
  createWebdavToken: (input: {
    name: string;
    folderId?: string;
    access: "read" | "readwrite";
  }) =>
    request<WebdavCredential>("/webdav/tokens", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeWebdavToken: (id: string) =>
    request<void>(`/webdav/tokens/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  reissueWebdavToken: (id: string) =>
    request<WebdavCredential>(
      `/webdav/tokens/${encodeURIComponent(id)}/reissue`,
      { method: "POST", body: "{}" },
    ),
  adminSettings: () => request<AdminSettings>("/admin/settings"),
  updateAdminSettings: (registrationEnabled: boolean) =>
    request<AdminSettings>("/admin/settings", {
      method: "PATCH",
      body: JSON.stringify({ registrationEnabled }),
    }),
  adminUsers: () => request<{ users: AdminUser[] }>("/admin/users"),
  createAdminUser: (input: {
    username: string;
    displayName: string;
    password: string;
    isAdmin: boolean;
    storageQuotaBytes: string | null;
  }) =>
    request<AdminUser>("/admin/users", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAdminUser: (
    id: string,
    input: Partial<{
      username: string;
      displayName: string;
      password: string;
      isAdmin: boolean;
      disabled: boolean;
      storageQuotaBytes: string | null;
    }>,
  ) =>
    request<AdminUser>(`/admin/users/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteAdminUser: (id: string) =>
    request<void>(`/admin/users/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),
  publicShare: (token: string, folderId?: string) =>
    publicRequest<PublicShare>(
      `/public/shares/${encodeURIComponent(token)}${folderId ? `?folderId=${encodeURIComponent(folderId)}` : ""}`,
    ),
  unlockPublicShare: (token: string, password: string) =>
    publicRequest<{ access: "read" | "readwrite"; passwordProtected: boolean }>(
      `/public/shares/${encodeURIComponent(token)}/access`,
      { method: "POST", body: JSON.stringify({ password }) },
    ),
  publicShareDownloadUrl: (token: string, fileId: string) =>
    `${API_URL}/public/shares/${encodeURIComponent(token)}/files/${encodeURIComponent(fileId)}/download`,
  publicSharePreviewUrl: (token: string, fileId: string) =>
    `${API_URL}/public/shares/${encodeURIComponent(token)}/files/${encodeURIComponent(fileId)}/preview`,
  publicShareFile: (token: string, fileId: string) =>
    publicRequest<PublicShareFile>(
      `/public/shares/${encodeURIComponent(token)}/files/${encodeURIComponent(fileId)}/details`,
    ),
  publicShareFolder: (token: string, folderId: string) =>
    publicRequest<PublicShareFolderDetail>(
      `/public/shares/${encodeURIComponent(token)}/folders/${encodeURIComponent(folderId)}/details`,
    ),
  publicShareText: async (
    token: string,
    fileId: string,
    encoding = "auto",
  ): Promise<TextFileContent> => {
    const response = await fetch(
      `${API_URL}/public/shares/${encodeURIComponent(token)}/files/${encodeURIComponent(fileId)}/text?encoding=${encodeURIComponent(encoding)}`,
      { credentials: "include" },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.error ?? "Text file could not be opened"), {
        status: response.status,
        passwordRequired: Boolean(body.passwordRequired),
      });
    }
    return {
      text: await response.text(),
      encoding: response.headers.get("X-Source-Encoding") ?? encoding,
      hasBom: response.headers.get("X-Source-BOM") === "present",
      etag: response.headers.get("ETag") ?? "",
    };
  },
  publicShareUpload: (token: string, folderId: string, file: File) => {
    const body = new FormData();
    body.append("file", file, file.name);
    return publicRequest<{ id: string; name: string; sizeBytes: string; sha256: string }>(
      `/public/shares/${encodeURIComponent(token)}/upload?folderId=${encodeURIComponent(folderId)}`,
      { method: "POST", body },
    );
  },
  publicShareDelete: (token: string, selections: BulkSelection[]) =>
    publicRequest<{ deleted: { files: number; folders: number } }>(
      `/public/shares/${encodeURIComponent(token)}/items`,
      { method: "DELETE", body: JSON.stringify({ selections }) },
    ),
  publicShareArchive: async (
    token: string,
    input: { mode: "all" } | { mode: "selection"; selections: BulkSelection[] },
  ) => {
    const response = await fetch(
      `${API_URL}/public/shares/${encodeURIComponent(token)}/archive`,
      {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.error ?? "Archive download failed"), {
        status: response.status,
        passwordRequired: Boolean(body.passwordRequired),
      });
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "originvault-shared-items.zip";
    anchor.rel = "noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
  downloadArchive: async (selections: BulkSelection[]) => {
    const response = await fetch(`${API_URL}/bulk/download`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ selections }),
    });
    handleResponseStatus(response.status);
    if (!response.ok) {
      const result = await response.json().catch(() => ({}));
      throw new Error(result.error ?? "Archive download failed");
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `originvault-${new Date().toISOString().slice(0, 10)}.zip`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  },
  file: (id: string) => request<FileDetail>(`/files/${id}`),
  filePreview: async (id: string) => {
    const result = await request<FilePreview>(
      `/files/${encodeURIComponent(id)}/preview`,
    );
    if (result.file.streamUrl)
      result.file.streamUrl = apiResourceUrl(result.file.streamUrl);
    return result;
  },
  trashFilePreview: async (id: string) => {
    const result = await request<FilePreview>(
      `/trash/files/${encodeURIComponent(id)}/preview`,
    );
    if (result.file.streamUrl)
      result.file.streamUrl = apiResourceUrl(result.file.streamUrl);
    return result;
  },
  fileText: async (id: string, encoding = "auto"): Promise<TextFileContent> => {
    const response = await fetch(
      `${API_URL}/files/${encodeURIComponent(id)}/text?encoding=${encodeURIComponent(encoding)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    handleResponseStatus(response.status);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? "Text file could not be opened");
    }
    return {
      text: await response.text(),
      encoding: response.headers.get("X-Source-Encoding") ?? encoding,
      hasBom: response.headers.get("X-Source-BOM") === "present",
      etag: response.headers.get("ETag") ?? "",
    };
  },
  trashFileText: async (id: string, encoding = "auto"): Promise<TextFileContent> => {
    const response = await fetch(
      `${API_URL}/trash/files/${encodeURIComponent(id)}/text?encoding=${encodeURIComponent(encoding)}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    );
    handleResponseStatus(response.status);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? "Text file could not be opened");
    }
    return {
      text: await response.text(),
      encoding: response.headers.get("X-Source-Encoding") ?? encoding,
      hasBom: response.headers.get("X-Source-BOM") === "present",
      etag: response.headers.get("ETag") ?? "",
    };
  },
  saveFileText: async (
    id: string,
    text: string,
    encoding: string,
    hasBom: boolean,
    etag: string,
  ) => {
    const query = new URLSearchParams({
      encoding,
      bom: String(hasBom),
    });
    const response = await fetch(
      `${API_URL}/files/${encodeURIComponent(id)}/text?${query}`,
      {
        method: "PUT",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "If-Match": etag,
        },
        body: text,
      },
    );
    handleResponseStatus(response.status);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? "Text file could not be saved");
    }
    return {
      file: (await response.json()) as SavedPreviewFile,
      etag: response.headers.get("ETag") ?? "",
    };
  },
  upload: (file: File, folderId?: string, relativeDirectory = "") => {
    const body = new FormData();
    if (folderId) body.append("folderId", folderId);
    body.append("lastModified", String(file.lastModified));
    body.append("file", file, file.name);
    const query = new URLSearchParams();
    if (folderId) query.set("folderId", folderId);
    if (relativeDirectory) query.set("relativeDirectory", relativeDirectory);
    return request<{ id: string; sha256: string }>(
      `/files/upload${query.size ? `?${query}` : ""}`,
      { method: "POST", body },
    );
  },
  uploadWithProgress: (
    file: File,
    folderId: string | undefined,
    relativeDirectory: string,
    onProgress: (percent: number) => void,
  ) => {
    const body = new FormData();
    if (folderId) body.append("folderId", folderId);
    body.append("lastModified", String(file.lastModified));
    body.append("file", file, file.name);
    const query = new URLSearchParams();
    if (folderId) query.set("folderId", folderId);
    if (relativeDirectory) query.set("relativeDirectory", relativeDirectory);
    const xhr = new XMLHttpRequest();
    const promise = new Promise<UploadResult>((resolve, reject) => {
      xhr.open(
        "POST",
        `${API_URL}/files/upload${query.size ? `?${query}` : ""}`,
      );
      if (token) xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.upload.addEventListener("progress", (event) => {
        if (event.lengthComputable)
          onProgress(
            Math.min(99, Math.round((event.loaded / event.total) * 100)),
          );
      });
      xhr.addEventListener("load", () => {
        handleResponseStatus(xhr.status);
        let result: Record<string, unknown> = {};
        try {
          result = JSON.parse(xhr.responseText || "{}");
        } catch {
          /* handled below */
        }
        if (xhr.status >= 200 && xhr.status < 300)
          resolve(result as unknown as UploadResult);
        else
          reject(
            new Error(String(result.error ?? `Upload failed (${xhr.status})`)),
          );
      });
      xhr.addEventListener("error", () =>
        reject(new Error("Network error during upload")),
      );
      xhr.addEventListener("abort", () =>
        reject(new DOMException("Upload cancelled", "AbortError")),
      );
      xhr.send(body);
    });
    return { promise, abort: () => xhr.abort() };
  },
  createUploadSession: (metadata: {
    fingerprint: string;
    originalName: string;
    sizeBytes: number;
    mimeType: string;
    lastModified: number;
    folderId?: string;
    relativeDirectory: string;
  }) =>
    request<UploadSession>("/upload-sessions", {
      method: "POST",
      body: JSON.stringify(metadata),
    }),
  uploadChunk: (
    sessionId: string,
    chunk: Blob,
    offset: number,
    onProgress: (loadedBytes: number) => void,
  ) => {
    const xhr = new XMLHttpRequest();
    const promise = new Promise<{
      offset: number;
      complete: boolean;
      file?: { id: string; name: string; sizeBytes: string; sha256: string };
    }>((resolve, reject) => {
      xhr.open(
        "PATCH",
        `${API_URL}/upload-sessions/${encodeURIComponent(sessionId)}`,
      );
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
      xhr.setRequestHeader("Content-Type", "application/offset+octet-stream");
      xhr.setRequestHeader("Upload-Offset", String(offset));
      xhr.upload.addEventListener("progress", (event) =>
        onProgress(event.loaded),
      );
      xhr.addEventListener("load", () => {
        handleResponseStatus(xhr.status);
        let result: Record<string, unknown> = {};
        try {
          result = JSON.parse(xhr.responseText || "{}");
        } catch {
          /* 204 has no body */
        }
        const nextOffset = Number(
          xhr.getResponseHeader("Upload-Offset") ??
            result.offset ??
            offset + chunk.size,
        );
        if (xhr.status >= 200 && xhr.status < 300)
          resolve({
            offset: nextOffset,
            complete: Boolean(result.complete),
            file: result.file as
              | { id: string; name: string; sizeBytes: string; sha256: string }
              | undefined,
          });
        else
          reject(
            Object.assign(
              new Error(
                String(result.error ?? `Chunk upload failed (${xhr.status})`),
              ),
              { serverOffset: Number(xhr.getResponseHeader("Upload-Offset")) },
            ),
          );
      });
      xhr.addEventListener("error", () =>
        reject(new Error("Network error during chunk upload")),
      );
      xhr.addEventListener("abort", () =>
        reject(new DOMException("Upload paused", "AbortError")),
      );
      xhr.send(chunk);
    });
    return { promise, abort: () => xhr.abort() };
  },
  cancelUploadSession: (sessionId: string) =>
    request<void>(`/upload-sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    }),
  download: async (file: Pick<VaultFile, "id" | "name">) => {
    const ticket = await request<{ url: string }>(
      `/files/${encodeURIComponent(file.id)}/download-ticket`,
      { method: "POST", body: "{}" },
    );
    const resourceUrl = apiResourceUrl(ticket.url);
    const available = await fetch(resourceUrl, { method: "HEAD" });
    if (!available.ok) throw new Error("다운로드 파일을 준비하지 못했습니다.");
    const anchor = document.createElement("a");
    anchor.href = resourceUrl;
    anchor.download = file.name;
    anchor.rel = "noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  },
  downloadTrash: async (file: Pick<VaultFile, "id" | "name">) => {
    const ticket = await request<{ url: string }>(
      `/trash/files/${encodeURIComponent(file.id)}/download-ticket`,
      { method: "POST", body: "{}" },
    );
    const resourceUrl = apiResourceUrl(ticket.url);
    const available = await fetch(resourceUrl, { method: "HEAD" });
    if (!available.ok) throw new Error("다운로드 파일을 준비하지 못했습니다.");
    const anchor = document.createElement("a");
    anchor.href = resourceUrl;
    anchor.download = file.name;
    anchor.rel = "noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  },
};
