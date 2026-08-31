import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { constants } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, rm, unlink } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import bcrypt from 'bcryptjs';
import Busboy from 'busboy';
import express, { type NextFunction, type Request, type Response } from 'express';
import iconv from 'iconv-lite';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { Pool, PoolClient } from 'pg';
import { config } from './config.js';
import { requireAuth } from './auth.js';
import { db } from './db.js';
import { assertStorageAvailable } from './quota.js';
import {
  detectTextEncodingFromBytes,
  etagMatches,
  inlineDisposition,
  isEditableTextFile,
  normalizeEncoding,
  PreviewError,
  previewKind,
  safeInlineMime,
} from './filePreview.js';
import { logForRequest } from './logger.js';
import { extractMetadata, isHiddenResource, originalCreatedAtFromMetadata, resolveInside, storeOriginal, userFilesRoot } from './storage.js';
import { pruneEmptyActiveFolders, removeEmptyActiveFolderPaths } from './folderCleanup.js';
import { moveSelectionsToTrash } from './trash.js';

export class ShareError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

type ShareAccess = 'read' | 'readwrite';

const SHARE_PASSWORD_MAX_BYTES = 72;
const SHARE_ACCESS_COOKIE_PREFIX = 'originvault_share_access_';
const SHARE_ACCESS_COOKIE_MAX_AGE_MS = 12 * 60 * 60 * 1_000;

function normalizeShareAccess(value: unknown, targetType: 'file' | 'folder'): ShareAccess {
  if (value === undefined || value === null || value === '') return 'read';
  if (value !== 'read' && value !== 'readwrite')
    throw new ShareError(400, 'Share access must be read or readwrite');
  if (targetType !== 'folder' && value !== 'read')
    throw new ShareError(400, 'Only folder shares can grant upload and delete access');
  return value;
}

function normalizeIncludeHidden(value: unknown, targetType: 'file' | 'folder'): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new ShareError(400, 'includeHidden must be boolean');
  return targetType === 'folder' && value;
}

function normalizeSharePassword(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw new ShareError(400, 'Share password must be text');
  if (Buffer.byteLength(value, 'utf8') > SHARE_PASSWORD_MAX_BYTES)
    throw new ShareError(400, `Share passwords must be at most ${SHARE_PASSWORD_MAX_BYTES} UTF-8 bytes`);
  return value;
}

function sharePasswordCookieName(shareId: string): string {
  return `${SHARE_ACCESS_COOKIE_PREFIX}${shareId.replace(/-/g, '')}`;
}

function cookieValue(req: Request, name: string): string | undefined {
  const cookies = req.header('cookie');
  if (!cookies) return undefined;
  for (const entry of cookies.split(';')) {
    const separator = entry.indexOf('=');
    if (separator < 0) continue;
    if (entry.slice(0, separator).trim() !== name) continue;
    try { return decodeURIComponent(entry.slice(separator + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

function sharePasswordSession(share: { id: string; passwordVersion: number }): string {
  return jwt.sign({ passwordVersion: share.passwordVersion }, config.shareSecret, {
    algorithm: 'HS256', subject: share.id, issuer: 'originvault-share-password',
    audience: 'originvault-public', expiresIn: '12h',
  });
}

function validSharePasswordSession(req: Request, share: { id: string; passwordVersion: number }): boolean {
  const token = cookieValue(req, sharePasswordCookieName(share.id));
  if (!token) return false;
  try {
    const payload = jwt.verify(token, config.shareSecret, {
      algorithms: ['HS256'], issuer: 'originvault-share-password', audience: 'originvault-public',
    }) as JwtPayload;
    return payload.sub === share.id && payload.passwordVersion === share.passwordVersion;
  } catch {
    return false;
  }
}

function setSharePasswordSessionCookie(res: Response, req: Request, token: string, share: { id: string }): void {
  res.cookie(sharePasswordCookieName(share.id), token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: req.secure,
    maxAge: SHARE_ACCESS_COOKIE_MAX_AGE_MS,
    path: `/api/public/shares/${encodeURIComponent(String(req.params.token))}`,
  });
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
type Queryable = Pool | PoolClient;
const asyncHandler = (handler: AsyncHandler) => (req: Request, res: Response, next: NextFunction): void => { handler(req, res, next).catch(next); };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const PUBLIC_SHARE_LIMITS = {
  textSourceBytes: 2 * 1024 * 1024,
  archiveSelections: 100,
  archiveEntries: 5_000,
  archiveSourceBytes: 10n * 1024n * 1024n * 1024n,
  archiveConcurrent: 2,
  archivePathBytes: 4_096,
} as const;

export type PublicArchiveSelection = { type: 'file' | 'folder'; id: string };
export type PublicArchiveRequest = { mode: 'all'; selections: [] } | { mode: 'selection'; selections: PublicArchiveSelection[] };

export function parsePublicArchiveRequest(value: unknown): PublicArchiveRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ShareError(400, 'Archive request must be a JSON object');
  const mode = (value as { mode?: unknown }).mode;
  const submitted = (value as { selections?: unknown }).selections;
  if (mode === 'all') {
    if (submitted !== undefined) throw new ShareError(400, 'All-mode archives must not include selections');
    return { mode, selections: [] };
  }
  if (mode !== 'selection') throw new ShareError(400, 'Archive mode must be all or selection');
  if (!Array.isArray(submitted) || submitted.length === 0) throw new ShareError(400, 'At least one file or folder must be selected');
  if (submitted.length > PUBLIC_SHARE_LIMITS.archiveSelections)
    throw new ShareError(413, `No more than ${PUBLIC_SHARE_LIMITS.archiveSelections} items may be selected`);
  const selections = new Map<string, PublicArchiveSelection>();
  for (const entry of submitted) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new ShareError(400, 'Invalid archive selection');
    const type = (entry as { type?: unknown }).type;
    const id = (entry as { id?: unknown }).id;
    if ((type !== 'file' && type !== 'folder') || typeof id !== 'string' || !UUID_PATTERN.test(id))
      throw new ShareError(400, 'Each selection must contain a valid file or folder id');
    const normalizedId = id.toLowerCase();
    selections.set(`${type}:${normalizedId}`, { type, id: normalizedId });
  }
  return { mode, selections: [...selections.values()] };
}

function truncateUtf8(value: string, maximumBytes: number): string {
  let result = '';
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character);
    if (bytes + characterBytes > maximumBytes) break;
    result += character;
    bytes += characterBytes;
  }
  return result;
}

export function safeArchiveSegment(value: string, kind: 'file' | 'folder' = 'file'): string {
  let clean = String(value).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!clean || clean === '.' || clean === '..') clean = kind === 'folder' ? 'folder' : 'file';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean)) clean = `_${clean}`;
  clean = truncateUtf8(clean, 255).replace(/[. ]+$/g, '');
  return clean || (kind === 'folder' ? 'folder' : 'file');
}

function archiveCollisionKey(value: string): string {
  return value.normalize('NFC').toLocaleLowerCase('en-US');
}

function archiveSegmentCandidate(base: string, index: number, kind: 'file' | 'folder'): string {
  if (index === 0) return base;
  const suffix = ` (${index})`;
  if (kind === 'folder') return `${truncateUtf8(base, 255 - Buffer.byteLength(suffix))}${suffix}`;
  const extension = path.posix.extname(base);
  const stem = extension ? base.slice(0, -extension.length) : base;
  const extensionBytes = Buffer.byteLength(extension);
  if (extensionBytes + Buffer.byteLength(suffix) >= 255)
    return `${truncateUtf8(base, 255 - Buffer.byteLength(suffix))}${suffix}`;
  return `${truncateUtf8(stem, 255 - extensionBytes - Buffer.byteLength(suffix))}${suffix}${extension}`;
}

function reserveArchiveSegment(value: string, kind: 'file' | 'folder', reserved: Set<string>): string {
  const base = safeArchiveSegment(value, kind);
  for (let index = 0; index < 100_000; index += 1) {
    const candidate = archiveSegmentCandidate(base, index, kind);
    const key = archiveCollisionKey(candidate);
    if (!reserved.has(key)) {
      reserved.add(key);
      return candidate;
    }
  }
  throw new ShareError(409, 'Archive item names cannot be made unique safely');
}

function archivePathKey(segments: readonly string[]): string {
  return JSON.stringify(segments);
}

function assertArchivePathLimit(value: string): void {
  if (Buffer.byteLength(value) > PUBLIC_SHARE_LIMITS.archivePathBytes)
    throw new ShareError(413, 'An archive path exceeds the anonymous archive limit');
}

export interface PublicArchivePathFile {
  id: string;
  name: string;
  directorySegments: readonly string[];
}

export interface PublicArchivePathPlan {
  directories: Array<{ sourceSegments: string[]; archivePath: string }>;
  files: Array<{ id: string; archivePath: string }>;
}

export function planPublicArchivePaths(
  rootName: string,
  directoryPaths: readonly (readonly string[])[],
  files: readonly PublicArchivePathFile[],
): PublicArchivePathPlan {
  const wantedDirectories = new Map<string, string[]>();
  wantedDirectories.set(archivePathKey([]), []);
  const addDirectory = (segments: readonly string[]) => {
    for (let length = 1; length <= segments.length; length += 1) {
      const prefix = [...segments.slice(0, length)];
      wantedDirectories.set(archivePathKey(prefix), prefix);
    }
  };
  for (const segments of directoryPaths) addDirectory(segments);
  for (const file of files) addDirectory(file.directorySegments);
  if (wantedDirectories.size + files.length > PUBLIC_SHARE_LIMITS.archiveEntries)
    throw new ShareError(413, 'The archive contains too many entries');

  const orderedDirectories = [...wantedDirectories.values()].sort((left, right) =>
    left.length - right.length || archivePathKey(left).localeCompare(archivePathKey(right), 'en-US'));
  const archivePathByKey = new Map<string, string>();
  const reservedByKey = new Map<string, Set<string>>();
  const rootArchivePath = safeArchiveSegment(rootName, 'folder');
  assertArchivePathLimit(rootArchivePath);
  archivePathByKey.set(archivePathKey([]), rootArchivePath);
  reservedByKey.set(archivePathKey([]), new Set());

  for (const segments of orderedDirectories.slice(1)) {
    const parentSegments = segments.slice(0, -1);
    const parentKey = archivePathKey(parentSegments);
    const parentArchivePath = archivePathByKey.get(parentKey);
    const parentReserved = reservedByKey.get(parentKey);
    if (!parentArchivePath || !parentReserved) throw new ShareError(409, 'Archive folder hierarchy is inconsistent');
    const segment = reserveArchiveSegment(segments[segments.length - 1]!, 'folder', parentReserved);
    const archivePath = `${parentArchivePath}/${segment}`;
    assertArchivePathLimit(archivePath);
    const key = archivePathKey(segments);
    archivePathByKey.set(key, archivePath);
    reservedByKey.set(key, new Set());
  }

  const seenFileIds = new Set<string>();
  const plannedFiles = [...files]
    .sort((left, right) => archivePathKey(left.directorySegments).localeCompare(archivePathKey(right.directorySegments), 'en-US') || left.id.localeCompare(right.id, 'en-US'))
    .map((file) => {
      if (seenFileIds.has(file.id)) throw new ShareError(409, 'Archive file expansion contains duplicates');
      seenFileIds.add(file.id);
      const directoryKey = archivePathKey(file.directorySegments);
      const directoryPath = archivePathByKey.get(directoryKey);
      const reserved = reservedByKey.get(directoryKey);
      if (!directoryPath || !reserved) throw new ShareError(409, 'Archive file hierarchy is inconsistent');
      const archivePath = `${directoryPath}/${reserveArchiveSegment(file.name, 'file', reserved)}`;
      assertArchivePathLimit(archivePath);
      return { id: file.id, archivePath };
    });
  return {
    directories: orderedDirectories.map((segments) => ({
      sourceSegments: [...segments],
      archivePath: archivePathByKey.get(archivePathKey(segments))!,
    })),
    files: plannedFiles,
  };
}

function storedPathSegments(value: string): string[] {
  if (!value || value.includes('\\') || path.posix.isAbsolute(value) || /^[a-z]:/i.test(value))
    throw new ShareError(409, 'Shared storage hierarchy is inconsistent');
  const segments = value.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\u0000-\u001f\u007f]/.test(segment)))
    throw new ShareError(409, 'Shared storage hierarchy is inconsistent');
  return segments;
}

export function rebaseArchiveSegments(rootRelativePath: string, candidateRelativePath: string): string[] {
  const root = storedPathSegments(rootRelativePath);
  const candidate = storedPathSegments(candidateRelativePath);
  if (candidate.length < root.length || root.some((segment, index) => candidate[index] !== segment))
    throw new ShareError(409, 'Archive source is outside the shared root');
  return candidate.slice(root.length);
}

export type PublicByteRange =
  | { kind: 'none' }
  | { kind: 'range'; start: number; end: number }
  | { kind: 'unsatisfiable' };

export function parsePublicByteRange(value: string | undefined, size: number): PublicByteRange {
  if (!value) return { kind: 'none' };
  if (!Number.isSafeInteger(size) || size < 0 || value.includes(',')) return { kind: 'unsatisfiable' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2]) || size === 0) return { kind: 'unsatisfiable' };
  let start: number;
  let end: number;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  } else {
    const suffixLength = Number(match[2]);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= size)
    return { kind: 'unsatisfiable' };
  return { kind: 'range', start, end };
}

export function ifRangePermitsRange(value: string | undefined, etag: string, modifiedAt?: Date | string | null): boolean {
  if (!value) return true;
  const candidate = value.trim();
  if (candidate.startsWith('W/')) return false;
  if (candidate.startsWith('"')) return candidate === etag;
  if (!modifiedAt) return false;
  const conditionTime = Date.parse(candidate);
  const resourceTime = new Date(modifiedAt).getTime();
  if (!Number.isFinite(conditionTime) || !Number.isFinite(resourceTime)) return false;
  return Math.floor(resourceTime / 1000) <= Math.floor(conditionTime / 1000);
}

export function publicFileRecord(file: any) {
  return {
    id: file.id,
    name: file.name,
    mimeType: file.mimeType,
    sizeBytes: file.sizeBytes,
    sha256: file.sha256,
    ...(file.originalCreatedAt !== undefined ? { originalCreatedAt: file.originalCreatedAt } : {}),
    createdAt: file.createdAt,
    modifiedAt: file.modifiedAt,
    clientLastModified: file.clientLastModified,
    kind: previewKind(file.name, file.mimeType),
  };
}

export function publicFolderRecord(folder: any) {
  return {
    id: folder.id,
    name: folder.name,
    ...(folder.originalCreatedAt !== undefined ? { originalCreatedAt: folder.originalCreatedAt } : {}),
    ...(folder.originalModifiedAt !== undefined ? { originalModifiedAt: folder.originalModifiedAt } : {}),
    createdAt: folder.createdAt,
    modifiedAt: folder.modifiedAt,
  };
}

function requestUuid(value: unknown, message: string): string {
  const id = String(value ?? '');
  if (!UUID_PATTERN.test(id)) throw new ShareError(404, message);
  return id;
}

function shareToken(id: string, version = 0): string {
  return jwt.sign(version > 0 ? { version } : {}, config.shareSecret, { algorithm: 'HS256', subject: id, issuer: 'originvault-share', audience: 'originvault-public', noTimestamp: true });
}

function shareIdentityFromToken(token: string): { id: string; version: number } {
  try {
    const payload = jwt.verify(token, config.shareSecret, { algorithms: ['HS256'], issuer: 'originvault-share', audience: 'originvault-public' }) as JwtPayload;
    if (!payload.sub || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(payload.sub)) throw new Error('Invalid subject');
    const version = payload.version ?? 0;
    if (!Number.isSafeInteger(version) || version < 0) throw new Error('Invalid version');
    return { id: payload.sub, version };
  } catch {
    throw new ShareError(404, 'Share not found');
  }
}

function baseUrl(req: Request): string {
  return config.publicUrl || `${req.protocol}://${req.get('host')}`;
}

function clientIp(req: Request): string {
  return String(req.ip || req.socket.remoteAddress || 'unknown').slice(0, 64);
}

function attachmentDisposition(name: string): string {
  const base = path.basename(name);
  const fallback = base.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(base).replace(/['()]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

async function recordEvent(req: Request, shareId: string, action: 'view' | 'download' | 'denied', targetFileId?: string, bytesSent?: string, queryable: Queryable = db): Promise<void> {
  await queryable.query(`
    INSERT INTO share_events(share_id,action,ip_address,user_agent,target_file_id,bytes_sent)
    VALUES($1,$2,$3,$4,(SELECT id FROM files WHERE id=$5::uuid),$6)
  `, [shareId, action, clientIp(req), req.header('user-agent')?.slice(0, 512) ?? null, targetFileId ?? null, bytesSent ?? null]);
}

async function ownerShares(ownerId: string, queryable: Queryable = db, shareId?: string) {
  const result = await queryable.query(`
    SELECT s.id,s.target_type AS type,
      COALESCE(fi.original_name,fo.name,s.target_name) AS name,s.file_id AS "fileId",s.folder_id AS "folderId",
      s.created_at AS "createdAt",s.expires_at AS "expiresAt",s.revoked_at AS "revokedAt",s.paused_at AS "pausedAt",
      s.token_version AS "tokenVersion",s.access,s.include_hidden AS "includeHidden",(s.password_hash IS NOT NULL) AS "hasPassword",
      (s.expires_at IS NOT NULL AND s.expires_at<=clock_timestamp()) AS expired,
      CASE WHEN s.target_type='file' THEN fi.id IS NOT NULL ELSE fo.id IS NOT NULL END AS "targetAvailable",
      COUNT(e.id)::int AS "accessCount",
      COUNT(e.id) FILTER(WHERE e.action='view')::int AS "viewCount",
      COUNT(e.id) FILTER(WHERE e.action='download')::int AS "downloadCount",
      COUNT(DISTINCT e.ip_address)::int AS "visitorCount",
      MAX(e.created_at) AS "lastAccessAt"
    FROM shares s
    LEFT JOIN files fi ON fi.id=s.file_id AND fi.user_id=s.owner_user_id AND fi.trashed_at IS NULL
    LEFT JOIN folders fo ON fo.id=s.folder_id AND fo.user_id=s.owner_user_id AND fo.trashed_at IS NULL
    LEFT JOIN share_events e ON e.share_id=s.id AND e.action IN ('view','download')
    WHERE s.owner_user_id=$1 AND s.hidden_at IS NULL AND ($2::uuid IS NULL OR s.id=$2)
    GROUP BY s.id,fi.id,fi.original_name,fo.id,fo.name
    ORDER BY s.created_at DESC,s.id DESC
  `, [ownerId, shareId ?? null]);
  return result.rows;
}

async function ownerShare(shareId: string, ownerId: string, queryable: Queryable = db) {
  const rows = await ownerShares(ownerId, queryable, shareId);
  const result = rows[0];
  if (!result) throw new ShareError(404, 'Share not found');
  return result;
}

function serializeOwnerShare(req: Request, row: any) {
  const status = !row.targetAvailable ? 'unavailable' : row.revokedAt ? 'revoked'
    : row.expired ? 'expired' : row.pausedAt ? 'paused' : 'active';
  const { tokenVersion, expired, ...share } = row;
  return { ...share, status, url: `${baseUrl(req)}/s/${shareToken(row.id, tokenVersion)}` };
}

async function activeShare(
  token: string,
  queryable: Queryable = db,
  lock = false,
  req?: Request,
  skipPasswordCheck = false,
) {
  const identity = shareIdentityFromToken(token);
  const result = await queryable.query(`
    SELECT s.id,s.owner_user_id AS "ownerUserId",s.file_id AS "fileId",s.folder_id AS "folderId",
      s.target_type AS "targetType",s.target_name AS "targetName",s.access,s.include_hidden AS "includeHidden",
      s.expires_at AS "expiresAt",s.revoked_at AS "revokedAt",s.paused_at AS "pausedAt",
      s.password_hash AS "passwordHash",s.password_version AS "passwordVersion",u.storage_key AS "storageKey",u.username,u.trash_enabled AS "trashEnabled",
      fi.original_name AS "fileName",fi.mime_type AS "fileMimeType",fi.size_bytes::text AS "fileSizeBytes",fi.sha256 AS "fileSha256",
      fo.name AS "folderName",fo.relative_path AS "folderRelativePath"
    FROM shares s
    JOIN users u ON u.id=s.owner_user_id AND u.disabled_at IS NULL
    LEFT JOIN files fi ON fi.id=s.file_id AND fi.user_id=s.owner_user_id AND fi.trashed_at IS NULL
    LEFT JOIN folders fo ON fo.id=s.folder_id AND fo.user_id=s.owner_user_id AND fo.trashed_at IS NULL
    WHERE s.id=$1 AND s.token_version=$2 AND s.hidden_at IS NULL AND s.revoked_at IS NULL AND s.paused_at IS NULL
      AND (s.expires_at IS NULL OR s.expires_at>clock_timestamp())
      AND ((s.target_type='file' AND fi.id IS NOT NULL) OR (s.target_type='folder' AND fo.id IS NOT NULL))
    ${lock ? 'FOR SHARE OF s,u' : ''}
  `, [identity.id, identity.version]);
  const share = result.rows[0];
  if (!share) throw new ShareError(404, 'Share not found');
  if (req && share.passwordHash && !skipPasswordCheck && !validSharePasswordSession(req, share))
    throw new ShareError(401, 'This share requires its password');
  return share;
}

async function sharedFile(share: any, fileId: string, queryable: Queryable = db) {
  if (share.fileId) {
    if (share.fileId !== fileId) throw new ShareError(404, 'File not found');
    const result = await queryable.query(`
      SELECT f.id,f.folder_id AS "folderId",f.stored_name AS name,f.relative_path AS "relativePath",
        parent.relative_path AS "folderRelativePath",f.mime_type AS "mimeType",f.size_bytes::text AS "sizeBytes",f.sha256,
        f.text_encoding AS "textEncoding",f.text_has_bom AS "textHasBom",f.original_created_at AS "originalCreatedAt",f.created_at AS "createdAt",
        f.modified_at AS "modifiedAt",f.client_last_modified AS "clientLastModified"
      FROM files f LEFT JOIN folders parent ON parent.id=f.folder_id AND parent.user_id=f.user_id AND parent.trashed_at IS NULL
      WHERE f.id=$1 AND f.user_id=$2 AND f.trashed_at IS NULL
      AND ($3::boolean OR NOT f.is_hidden)
    `, [fileId, share.ownerUserId, true]);
    if (!result.rowCount) throw new ShareError(404, 'File not found');
    return result.rows[0];
  }
  const result = await queryable.query(`
    WITH RECURSIVE tree AS (
      SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL AND ($4::boolean OR NOT is_hidden)
      UNION
      SELECT child.id FROM folders child JOIN tree parent ON child.parent_id=parent.id WHERE child.user_id=$2 AND child.trashed_at IS NULL AND ($4::boolean OR NOT child.is_hidden)
    )
    SELECT f.id,f.folder_id AS "folderId",f.stored_name AS name,f.relative_path AS "relativePath",
      parent.relative_path AS "folderRelativePath",f.mime_type AS "mimeType",f.size_bytes::text AS "sizeBytes",f.sha256,
      f.text_encoding AS "textEncoding",f.text_has_bom AS "textHasBom",f.original_created_at AS "originalCreatedAt",f.created_at AS "createdAt",
      f.modified_at AS "modifiedAt",f.client_last_modified AS "clientLastModified"
    FROM files f JOIN folders parent ON parent.id=f.folder_id AND parent.user_id=f.user_id AND parent.trashed_at IS NULL
    WHERE f.id=$3 AND f.user_id=$2 AND f.trashed_at IS NULL AND f.folder_id IN (SELECT id FROM tree)
      AND ($4::boolean OR NOT f.is_hidden)
  `, [share.folderId, share.ownerUserId, fileId, share.includeHidden]);
  if (!result.rowCount) throw new ShareError(404, 'File not found');
  return result.rows[0];
}

async function sharedFolderDetails(share: any, folderId: string, queryable: Queryable = db) {
  if (!share.folderId) throw new ShareError(404, 'Folder not found');
  const result = await queryable.query(`
    WITH RECURSIVE share_tree AS (
      SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL AND ($4::boolean OR NOT is_hidden)
      UNION
      SELECT child.id FROM folders child JOIN share_tree parent ON child.parent_id=parent.id WHERE child.user_id=$2 AND child.trashed_at IS NULL AND ($4::boolean OR NOT child.is_hidden)
    ), target_tree AS (
      SELECT id FROM folders WHERE id=$3 AND user_id=$2 AND trashed_at IS NULL AND id IN (SELECT id FROM share_tree) AND ($4::boolean OR NOT is_hidden)
      UNION
      SELECT child.id FROM folders child JOIN target_tree parent ON child.parent_id=parent.id WHERE child.user_id=$2 AND child.trashed_at IS NULL AND ($4::boolean OR NOT child.is_hidden)
    )
    SELECT root.id,root.name,root.created_at AS "createdAt",root.modified_at AS "modifiedAt",
      (SELECT COUNT(*)::integer FROM files WHERE user_id=$2 AND folder_id=root.id AND trashed_at IS NULL AND ($4::boolean OR NOT is_hidden)) AS "directFileCount",
      (SELECT COUNT(*)::integer FROM folders WHERE user_id=$2 AND parent_id=root.id AND trashed_at IS NULL AND ($4::boolean OR NOT is_hidden)) AS "directFolderCount",
      (SELECT COUNT(*)::integer FROM files WHERE user_id=$2 AND folder_id IN (SELECT id FROM target_tree) AND trashed_at IS NULL AND ($4::boolean OR NOT is_hidden)) AS "fileCount",
      (SELECT GREATEST(COUNT(*)-1,0)::integer FROM target_tree) AS "folderCount",
      COALESCE((SELECT SUM(size_bytes) FROM files WHERE user_id=$2 AND folder_id IN (SELECT id FROM target_tree) AND trashed_at IS NULL AND ($4::boolean OR NOT is_hidden)),0)::text AS "sizeBytes"
    FROM folders root WHERE root.id=$3 AND root.user_id=$2 AND root.trashed_at IS NULL AND root.id IN (SELECT id FROM share_tree)
    `, [share.folderId, share.ownerUserId, folderId, share.includeHidden]);
  if (!result.rowCount) throw new ShareError(404, 'Folder not found');
  return result.rows[0];
}

async function sharedFolder(share: any, folderId: string, queryable: Queryable = db) {
  if (!share.folderId) throw new ShareError(404, 'Folder not found');
  const result = await queryable.query(`
    WITH RECURSIVE tree AS (
      SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL AND ($4::boolean OR NOT is_hidden)
      UNION
      SELECT child.id FROM folders child JOIN tree parent ON child.parent_id=parent.id WHERE child.user_id=$2 AND child.trashed_at IS NULL AND ($4::boolean OR NOT child.is_hidden)
    )
    SELECT id,name,relative_path AS "relativePath"
    FROM folders WHERE id=$3 AND user_id=$2 AND trashed_at IS NULL AND id IN (SELECT id FROM tree) AND ($4::boolean OR NOT is_hidden)
  `, [share.folderId, share.ownerUserId, folderId, share.includeHidden]);
  if (!result.rowCount) throw new ShareError(404, 'Folder not found');
  return result.rows[0];
}

function assertShareWriteAccess(share: any): void {
  if (share.targetType !== 'folder' || share.access !== 'readwrite')
    throw new ShareError(403, 'This share does not allow uploads or deletions');
}

async function publicWriteSelectionRows(
  share: any,
  selections: PublicArchiveSelection[],
  queryable: Queryable,
): Promise<{
  files: Array<{ id: string; folderId: string | null; relativePath: string; sizeBytes: string }>;
  folders: Array<{ id: string; parentId: string | null; relativePath: string }>;
}> {
  await assertArchiveSelectionsInScope(share, selections, queryable);
  const fileIds = selections.filter((entry) => entry.type === 'file').map((entry) => entry.id);
  const folderIds = selections.filter((entry) => entry.type === 'folder').map((entry) => entry.id);
  if (folderIds.includes(share.folderId))
    throw new ShareError(409, 'The shared root folder cannot be deleted');
  const [files, folders] = await Promise.all([
    fileIds.length
      ? queryable.query(`SELECT id,folder_id AS "folderId",relative_path AS "relativePath",size_bytes::text AS "sizeBytes"
          FROM files WHERE user_id=$1 AND id=ANY($2::uuid[]) AND trashed_at IS NULL`, [share.ownerUserId, fileIds])
      : Promise.resolve({ rows: [] as Array<{ id: string; folderId: string | null; relativePath: string; sizeBytes: string }> }),
    folderIds.length
      ? queryable.query(`SELECT id,parent_id AS "parentId",relative_path AS "relativePath"
          FROM folders WHERE user_id=$1 AND id=ANY($2::uuid[]) AND trashed_at IS NULL`, [share.ownerUserId, folderIds])
      : Promise.resolve({ rows: [] as Array<{ id: string; parentId: string | null; relativePath: string }> }),
  ]);
  return { files: files.rows, folders: folders.rows };
}

async function withActiveShareReadLock<T>(req: Request, work: (share: any, client: PoolClient) => Promise<T>): Promise<T> {
  const token = String(req.params.token);
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const preliminary = await activeShare(token, client, false, req);
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [`originvault:${preliminary.ownerUserId}`]);
    const share = await activeShare(token, client, true, req);
    const result = await work(share, client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function realPathIsInside(rootRealPath: string, targetRealPath: string): boolean {
  const relation = path.relative(rootRealPath, targetRealPath);
  return relation === '' || (!relation.startsWith(`..${path.sep}`) && relation !== '..' && !path.isAbsolute(relation));
}

async function validateStoredEntry(
  root: string,
  rootRealPath: string,
  relativePath: string,
  expected: 'file' | 'folder',
  expectedSizeBytes?: string,
): Promise<string> {
  const absolutePath = resolveInside(root, relativePath);
  const [targetRealPath, stats] = await Promise.all([
    realpath(absolutePath),
    lstat(absolutePath, { bigint: true }),
  ]);
  if (!realPathIsInside(rootRealPath, targetRealPath) || stats.isSymbolicLink())
    throw new ShareError(409, 'Shared storage contains an unsafe link');
  if (expected === 'file') {
    let expectedSize: bigint;
    try { expectedSize = BigInt(expectedSizeBytes ?? ''); } catch { throw new ShareError(409, 'Shared file size is invalid'); }
    if (!stats.isFile() || expectedSize < 0n || stats.size !== expectedSize)
      throw new ShareError(409, 'Shared file storage is inconsistent');
  } else if (!stats.isDirectory()) {
    throw new ShareError(409, 'Shared folder storage is inconsistent');
  }
  return targetRealPath;
}

async function openSharedRegularFile(share: any, file: any) {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const root = userFilesRoot(share.storageKey);
    const rootRealPath = await realpath(root);
    const targetRealPath = await validateStoredEntry(root, rootRealPath, file.relativePath, 'file', file.sizeBytes);
    fileHandle = await open(targetRealPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await fileHandle.stat({ bigint: true });
    if (!stats.isFile() || stats.size !== BigInt(file.sizeBytes) || stats.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw new ShareError(409, 'Shared file storage is inconsistent');
    return { fileHandle, fileSize: Number(stats.size), targetRealPath };
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    if (error instanceof ShareError) throw error;
    throw new ShareError(409, 'Shared file storage is unavailable');
  }
}

async function openAuthorizedSharedFile(req: Request, fileId: string) {
  let opened: Awaited<ReturnType<typeof openSharedRegularFile>> | undefined;
  try {
    return await withActiveShareReadLock(req, async (share, client) => {
      const file = await sharedFile(share, fileId, client);
      opened = await openSharedRegularFile(share, file);
      return { share, file, ...opened };
    });
  } catch (error) {
    await opened?.fileHandle.close().catch(() => undefined);
    throw error;
  }
}

function setPublicResponseHeaders(res: Response): void {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
}

function setPublicFileHeaders(res: Response, file: any, disposition: string): string {
  const etag = `"sha256-${file.sha256}"`;
  setPublicResponseHeaders(res);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('ETag', etag);
  res.setHeader('X-Content-SHA256', file.sha256);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Referrer-Policy', 'no-referrer');
  const modifiedAt = file.modifiedAt ? new Date(file.modifiedAt) : undefined;
  if (modifiedAt && Number.isFinite(modifiedAt.getTime())) res.setHeader('Last-Modified', modifiedAt.toUTCString());
  return etag;
}

function decodePublicText(file: any, bytes: Buffer, requestedEncoding: unknown) {
  if (!isEditableTextFile(file.name, file.mimeType)) throw new ShareError(415, 'This file type cannot be opened as text');
  let detected: ReturnType<typeof detectTextEncodingFromBytes>;
  let encoding: string;
  try {
    detected = detectTextEncodingFromBytes(bytes.subarray(0, 64 * 1024), file.textEncoding, file.textHasBom);
    encoding = requestedEncoding && requestedEncoding !== 'auto' ? normalizeEncoding(requestedEncoding) : detected.encoding!;
    const decodedWithBom = iconv.decode(bytes, encoding, { stripBOM: false });
    if (!iconv.encode(decodedWithBom, encoding, { addBOM: false }).equals(bytes))
      throw new PreviewError(422, 'The selected encoding cannot decode this file without replacing bytes');
    return { body: Buffer.from(iconv.decode(bytes, encoding, { stripBOM: true }), 'utf8'), encoding, hasBom: detected.hasBom };
  } catch (error) {
    if (error instanceof PreviewError) throw new ShareError(error.statusCode, error.message);
    throw error;
  }
}

let activePublicArchives = 0;

function acquirePublicArchiveSlot(): () => void {
  if (activePublicArchives >= PUBLIC_SHARE_LIMITS.archiveConcurrent)
    throw new ShareError(429, 'Too many anonymous archives are currently running');
  activePublicArchives += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activePublicArchives -= 1;
  };
}

interface PublicArchiveFolderRow {
  id: string;
  parentId: string | null;
  name: string;
  relativePath: string;
  createdAt: Date | string;
  modifiedAt: Date | string;
}

interface PublicArchiveFileRow {
  id: string;
  folderId: string | null;
  folderRelativePath: string | null;
  name: string;
  relativePath: string;
  mimeType: string;
  sizeBytes: string;
  sha256: string;
  clientLastModified: Date | string | null;
  createdAt: Date | string;
  modifiedAt: Date | string;
}

async function assertArchiveSelectionsInScope(
  share: any,
  selections: PublicArchiveSelection[],
  queryable: Queryable,
): Promise<void> {
  if (share.fileId) {
    if (selections.some((selection) => selection.type !== 'file' || selection.id !== share.fileId))
      throw new ShareError(404, 'One or more selected items were not found');
    return;
  }
  const folderIds = selections.filter((selection) => selection.type === 'folder').map((selection) => selection.id);
  const fileIds = selections.filter((selection) => selection.type === 'file').map((selection) => selection.id);
  const result = await queryable.query<{ type: 'file' | 'folder'; id: string }>(`
    WITH RECURSIVE scope AS (
      SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL AND ($5::boolean OR NOT is_hidden)
      UNION
      SELECT child.id FROM folders child JOIN scope parent ON child.parent_id=parent.id WHERE child.user_id=$2 AND child.trashed_at IS NULL AND ($5::boolean OR NOT child.is_hidden)
    )
    SELECT 'folder'::text AS type,id FROM scope WHERE id=ANY($3::uuid[])
    UNION ALL
    SELECT 'file'::text AS type,f.id FROM files f
    WHERE f.user_id=$2 AND f.trashed_at IS NULL AND f.id=ANY($4::uuid[]) AND f.folder_id IN (SELECT id FROM scope)
      AND ($5::boolean OR NOT f.is_hidden)
  `, [share.folderId, share.ownerUserId, folderIds, fileIds, share.includeHidden]);
  const found = new Set(result.rows.map((row) => `${row.type}:${row.id}`));
  if (selections.some((selection) => !found.has(`${selection.type}:${selection.id}`)))
    throw new ShareError(404, 'One or more selected items were not found');
}

async function expandPublicArchive(
  share: any,
  request: PublicArchiveRequest,
  queryable: Queryable,
): Promise<{ folders: PublicArchiveFolderRow[]; files: PublicArchiveFileRow[] }> {
  if (request.mode === 'selection') await assertArchiveSelectionsInScope(share, request.selections, queryable);
  if (share.fileId) {
    const file = await sharedFile(share, share.fileId, queryable);
    return { folders: [], files: [file] };
  }
  const selectedFolderIds = request.mode === 'all'
    ? [share.folderId]
    : request.selections.filter((selection) => selection.type === 'folder').map((selection) => selection.id);
  const selectedFileIds = request.mode === 'all'
    ? []
    : request.selections.filter((selection) => selection.type === 'file').map((selection) => selection.id);
  const resultLimit = PUBLIC_SHARE_LIMITS.archiveEntries + 1;
  const [folderResult, fileResult] = await Promise.all([
    queryable.query<PublicArchiveFolderRow>(`
      WITH RECURSIVE selected_tree AS (
        SELECT id,parent_id,name,relative_path,created_at,modified_at
        FROM folders WHERE user_id=$1 AND id=ANY($2::uuid[]) AND trashed_at IS NULL AND ($4::boolean OR NOT is_hidden)
        UNION
        SELECT child.id,child.parent_id,child.name,child.relative_path,child.created_at,child.modified_at
        FROM folders child JOIN selected_tree parent ON child.parent_id=parent.id WHERE child.user_id=$1 AND child.trashed_at IS NULL AND ($4::boolean OR NOT child.is_hidden)
      )
      SELECT id,parent_id AS "parentId",name,relative_path AS "relativePath",
        created_at AS "createdAt",modified_at AS "modifiedAt"
      FROM selected_tree ORDER BY relative_path COLLATE "C",id LIMIT $3
    `, [share.ownerUserId, selectedFolderIds, resultLimit, share.includeHidden]),
    queryable.query<PublicArchiveFileRow>(`
      WITH RECURSIVE selected_tree AS (
        SELECT id FROM folders WHERE user_id=$1 AND id=ANY($2::uuid[]) AND trashed_at IS NULL AND ($5::boolean OR NOT is_hidden)
        UNION
        SELECT child.id FROM folders child JOIN selected_tree parent ON child.parent_id=parent.id WHERE child.user_id=$1 AND child.trashed_at IS NULL AND ($5::boolean OR NOT child.is_hidden)
      )
      SELECT f.id,f.folder_id AS "folderId",parent.relative_path AS "folderRelativePath",
        f.stored_name AS name,f.relative_path AS "relativePath",f.mime_type AS "mimeType",
        f.size_bytes::text AS "sizeBytes",f.sha256,f.client_last_modified AS "clientLastModified",
        f.created_at AS "createdAt",f.modified_at AS "modifiedAt"
      FROM files f LEFT JOIN folders parent ON parent.id=f.folder_id AND parent.user_id=f.user_id AND parent.trashed_at IS NULL
       WHERE f.user_id=$1 AND f.trashed_at IS NULL AND (f.id=ANY($3::uuid[]) OR f.folder_id IN (SELECT id FROM selected_tree))
         AND ($5::boolean OR NOT f.is_hidden)
      ORDER BY f.relative_path COLLATE "C",f.id LIMIT $4
    `, [share.ownerUserId, selectedFolderIds, selectedFileIds, resultLimit, share.includeHidden]),
  ]);
  if (folderResult.rows.length >= resultLimit || fileResult.rows.length >= resultLimit)
    throw new ShareError(413, 'The archive contains too many entries');
  return { folders: folderResult.rows, files: fileResult.rows };
}

function totalArchiveSourceBytes(files: PublicArchiveFileRow[]): bigint {
  let total = 0n;
  for (const file of files) {
    let size: bigint;
    try { size = BigInt(file.sizeBytes); } catch { throw new ShareError(409, 'An archived file size is invalid'); }
    if (size < 0n) throw new ShareError(409, 'An archived file size is invalid');
    total += size;
    if (total > PUBLIC_SHARE_LIMITS.archiveSourceBytes)
      throw new ShareError(413, 'The archive exceeds the anonymous source-byte limit');
  }
  return total;
}

function publicArchivePathPlan(
  share: any,
  folders: PublicArchiveFolderRow[],
  files: PublicArchiveFileRow[],
): PublicArchivePathPlan {
  if (share.fileId) {
    const file = files[0];
    if (!file || file.id !== share.fileId) throw new ShareError(409, 'Archive file expansion is inconsistent');
    const archivePath = safeArchiveSegment(file.name, 'file');
    assertArchivePathLimit(archivePath);
    return { directories: [], files: [{ id: file.id, archivePath }] };
  }
  const directoryPaths = folders.map((folder) => rebaseArchiveSegments(share.folderRelativePath, folder.relativePath));
  const pathFiles = files.map((file) => {
    if (!file.folderRelativePath) throw new ShareError(409, 'Archive file hierarchy is inconsistent');
    return {
      id: file.id,
      name: file.name,
      directorySegments: rebaseArchiveSegments(share.folderRelativePath, file.folderRelativePath),
    };
  });
  return planPublicArchivePaths(share.folderName, directoryPaths, pathFiles);
}

async function validatePublicArchiveStorage(
  share: any,
  folders: PublicArchiveFolderRow[],
  files: PublicArchiveFileRow[],
): Promise<Map<string, string>> {
  const root = userFilesRoot(share.storageKey);
  let rootRealPath: string;
  try { rootRealPath = await realpath(root); } catch { throw new ShareError(409, 'Shared storage is unavailable'); }
  const entries = [
    ...folders.map((folder) => ({ key: `folder:${folder.id}`, relativePath: folder.relativePath, expected: 'folder' as const, sizeBytes: undefined })),
    ...files.map((file) => ({ key: `file:${file.id}`, relativePath: file.relativePath, expected: 'file' as const, sizeBytes: file.sizeBytes })),
  ];
  const paths = new Map<string, string>();
  try {
    for (let index = 0; index < entries.length; index += 32) {
      const chunk = entries.slice(index, index + 32);
      const validated = await Promise.all(chunk.map((entry) =>
        validateStoredEntry(root, rootRealPath, entry.relativePath, entry.expected, entry.sizeBytes)));
      chunk.forEach((entry, chunkIndex) => paths.set(entry.key, validated[chunkIndex]!));
    }
  } catch (error) {
    if (error instanceof ShareError) throw error;
    throw new ShareError(409, 'One or more archive sources are unavailable');
  }
  return paths;
}

export function createShareRouter(): express.Router {
  const router = express.Router();

  router.post('/api/shares', requireAuth, asyncHandler(async (req, res) => {
    const type = req.body?.type;
    if (type !== 'file' && type !== 'folder') throw new ShareError(400, 'A file or folder is required');
    const targetId = typeof req.body?.id === 'string' ? requestUuid(req.body.id, 'File or folder not found') : '';
    if (!targetId) throw new ShareError(400, 'A file or folder is required');
    const access = normalizeShareAccess(req.body?.access, type);
    const includeHidden = normalizeIncludeHidden(req.body?.includeHidden, type);
    const password = normalizeSharePassword(req.body?.password);
    const passwordHash = password ? await bcrypt.hash(password, 12) : null;
    let expiresAt: Date | null = null;
    if (req.body?.expiresAt) {
      expiresAt = new Date(req.body.expiresAt);
      if (!Number.isFinite(expiresAt.getTime())) throw new ShareError(400, 'Expiration must be a valid date');
    }
    const client = await db.connect();
    let share: any;
    try {
      await client.query('BEGIN');
      if (expiresAt) {
        const validExpiration = await client.query<{ valid: boolean }>('SELECT $1::timestamptz>clock_timestamp() AS valid', [expiresAt]);
        if (!validExpiration.rows[0]?.valid) throw new ShareError(400, 'Expiration must be in the future');
      }
      const target = await client.query<{ id: string; name: string }>(`
        SELECT id,${type === 'file' ? 'original_name' : 'name'} AS name
        FROM ${type === 'file' ? 'files' : 'folders'} WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL FOR KEY SHARE
      `, [targetId, req.user!.id]);
      if (!target.rowCount) throw new ShareError(404, 'File or folder not found');
      const created = await client.query<{ id: string }>(`
        INSERT INTO shares(owner_user_id,file_id,folder_id,target_type,target_name,expires_at,access,password_hash,include_hidden)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id
      `, [
        req.user!.id, type === 'file' ? targetId : null, type === 'folder' ? targetId : null,
        type, target.rows[0]!.name, expiresAt, access, passwordHash, includeHidden,
      ]);
      share = serializeOwnerShare(req, await ownerShare(created.rows[0]!.id, req.user!.id, client));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    logForRequest(req).info({ event: 'share_created', shareId: share.id, targetType: type, targetId, access, passwordProtected: Boolean(passwordHash) }, 'Public share created');
    res.status(201).json(share);
  }));

  router.get('/api/shares', requireAuth, asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const shares = (await ownerShares(req.user!.id)).map((row) => serializeOwnerShare(req, row));
    res.json({ shares });
  }));

  router.get('/api/shares/:id', requireAuth, asyncHandler(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    const client = await db.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const share = serializeOwnerShare(req, await ownerShare(requestUuid(req.params.id, 'Share not found'), req.user!.id, client));
      const events = await client.query(`
        SELECT id,action,ip_address AS ip,user_agent AS "userAgent",target_file_id AS "targetFileId",
          bytes_sent::text AS "bytesSent",created_at AS "createdAt"
        FROM share_events WHERE share_id=$1 ORDER BY created_at DESC LIMIT 200
      `, [share.id]);
      await client.query('COMMIT');
      res.json({ ...share, events: events.rows });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.delete('/api/shares/:id', requireAuth, asyncHandler(async (req, res) => {
    const shareId = requestUuid(req.params.id, 'Share not found');
    const result = await db.query('UPDATE shares SET revoked_at=COALESCE(revoked_at,clock_timestamp()) WHERE id=$1 AND owner_user_id=$2 RETURNING id', [shareId, req.user!.id]);
    if (!result.rowCount) throw new ShareError(404, 'Share not found');
    logForRequest(req).warn({ event: 'share_revoked', shareId: req.params.id }, 'Public share revoked');
    res.status(204).end();
  }));

  router.patch('/api/shares/:id', requireAuth, asyncHandler(async (req, res) => {
    const shareId = requestUuid(req.params.id, 'Share not found');
    const hasPasswordChange = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'password');
    const hasAccessChange = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'access');
    const hasIncludeHiddenChange = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'includeHidden');
    if (!hasPasswordChange && !hasAccessChange && !hasIncludeHiddenChange)
      throw new ShareError(400, 'A password, access, or hidden-file setting is required');
    const client = await db.connect();
    let share: any;
    try {
      await client.query('BEGIN');
      const current = await client.query<{ type: 'file' | 'folder'; access: ShareAccess; includeHidden: boolean }>(`
        SELECT target_type AS type,access,include_hidden AS "includeHidden" FROM shares
        WHERE id=$1 AND owner_user_id=$2 AND hidden_at IS NULL FOR UPDATE
      `, [shareId, req.user!.id]);
      if (!current.rowCount) throw new ShareError(404, 'Share not found');
      const targetType = current.rows[0]!.type;
      const access = hasAccessChange
        ? normalizeShareAccess(req.body.access, targetType)
        : current.rows[0]!.access;
      const includeHidden = hasIncludeHiddenChange
        ? normalizeIncludeHidden(req.body.includeHidden, targetType)
        : current.rows[0]!.includeHidden;
      const password = hasPasswordChange ? normalizeSharePassword(req.body.password) : undefined;
      const passwordHash = password === undefined
        ? undefined
        : password ? await bcrypt.hash(password, 12) : null;
      await client.query(`
        UPDATE shares
        SET access=$3,include_hidden=$4,
            password_hash=CASE WHEN $5::boolean THEN $6 ELSE password_hash END,
            password_version=CASE WHEN $5::boolean THEN password_version+1 ELSE password_version END
        WHERE id=$1 AND owner_user_id=$2
      `, [shareId, req.user!.id, access, includeHidden, hasPasswordChange, passwordHash ?? null]);
      share = serializeOwnerShare(req, await ownerShare(shareId, req.user!.id, client));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    res.setHeader('Cache-Control', 'private, no-store');
    logForRequest(req).warn({ event: 'share_settings_updated', shareId, access: share.access, passwordChanged: hasPasswordChange }, 'Public share settings updated');
    res.json(share);
  }));

  router.post('/api/shares/:id/pause', requireAuth, asyncHandler(async (req, res) => {
    const shareId = requestUuid(req.params.id, 'Share not found');
    const result = await db.query(`
      UPDATE shares SET paused_at=clock_timestamp(),password_version=password_version+1
      WHERE id=$1 AND owner_user_id=$2 AND hidden_at IS NULL AND revoked_at IS NULL
        AND paused_at IS NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
      RETURNING id
    `, [shareId, req.user!.id]);
    if (!result.rowCount) throw new ShareError(409, 'Only an active share can be paused');
    const share = serializeOwnerShare(req, await ownerShare(shareId, req.user!.id));
    res.setHeader('Cache-Control', 'private, no-store');
    logForRequest(req).warn({ event: 'share_paused', shareId }, 'Public share paused');
    res.json(share);
  }));

  router.post('/api/shares/:id/resume', requireAuth, asyncHandler(async (req, res) => {
    const shareId = requestUuid(req.params.id, 'Share not found');
    const result = await db.query(`
      UPDATE shares SET paused_at=NULL,password_version=password_version+1
      WHERE id=$1 AND owner_user_id=$2 AND hidden_at IS NULL AND revoked_at IS NULL
        AND paused_at IS NOT NULL AND (expires_at IS NULL OR expires_at>clock_timestamp())
        AND ((target_type='file' AND file_id IS NOT NULL) OR (target_type='folder' AND folder_id IS NOT NULL))
      RETURNING id
    `, [shareId, req.user!.id]);
    if (!result.rowCount) throw new ShareError(409, 'Only a stopped available share can be resumed');
    const share = serializeOwnerShare(req, await ownerShare(shareId, req.user!.id));
    res.setHeader('Cache-Control', 'private, no-store');
    logForRequest(req).warn({ event: 'share_resumed', shareId }, 'Public share resumed');
    res.json(share);
  }));

  router.delete('/api/shares/:id/history', requireAuth, asyncHandler(async (req, res) => {
    const shareId = requestUuid(req.params.id, 'Share not found');
    const result = await db.query(`
      UPDATE shares SET revoked_at=COALESCE(revoked_at,clock_timestamp()),hidden_at=COALESCE(hidden_at,clock_timestamp())
      WHERE id=$1 AND owner_user_id=$2 AND hidden_at IS NULL RETURNING id
    `, [shareId, req.user!.id]);
    if (!result.rowCount) throw new ShareError(404, 'Share not found');
    logForRequest(req).warn({ event: 'share_history_hidden', shareId: req.params.id }, 'Share history hidden and public access revoked');
    res.status(204).end();
  }));

  router.post('/api/shares/:id/rotate', requireAuth, asyncHandler(async (req, res) => {
    const shareId = requestUuid(req.params.id, 'Share not found');
    const client = await db.connect();
    let share: any;
    try {
      await client.query('BEGIN');
      const result = await client.query(`
        UPDATE shares SET token_version=token_version+1
        WHERE id=$1 AND owner_user_id=$2 AND hidden_at IS NULL AND revoked_at IS NULL
          AND (expires_at IS NULL OR expires_at>clock_timestamp())
          AND ((target_type='file' AND file_id IS NOT NULL) OR (target_type='folder' AND folder_id IS NOT NULL))
        RETURNING id
      `, [shareId, req.user!.id]);
      if (!result.rowCount) {
        const existing = await client.query('SELECT 1 FROM shares WHERE id=$1 AND owner_user_id=$2 AND hidden_at IS NULL', [shareId, req.user!.id]);
        if (!existing.rowCount) throw new ShareError(404, 'Share not found');
        throw new ShareError(409, 'Only an active share can change links');
      }
      share = serializeOwnerShare(req, await ownerShare(result.rows[0].id, req.user!.id, client));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    res.setHeader('Cache-Control', 'private, no-store');
    logForRequest(req).warn({ event: 'share_link_rotated', shareId: share.id }, 'Public share link changed and previous token invalidated');
    res.json(share);
  }));

  router.post('/api/public/shares/:token/access', asyncHandler(async (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const preliminary = await activeShare(String(req.params.token), client, false, undefined, true);
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [`originvault:${preliminary.ownerUserId}`]);
      const share = await activeShare(String(req.params.token), client, true, undefined, true);
      if (share.passwordHash && !(await bcrypt.compare(password, share.passwordHash))) {
        await recordEvent(req, share.id, 'denied', undefined, undefined, client);
        await client.query('COMMIT');
        throw new ShareError(401, 'The share password is incorrect');
      }
      await client.query('COMMIT');
      if (share.passwordHash)
        setSharePasswordSessionCookie(res, req, sharePasswordSession(share), share);
      setPublicResponseHeaders(res);
      res.json({ access: share.access, passwordProtected: Boolean(share.passwordHash) });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }));

  router.post('/api/public/shares/:token/upload', (req, res, next) => {
    const requestedFolderId = typeof req.query.folderId === 'string'
      ? requestUuid(req.query.folderId, 'Folder not found')
      : '';
    if (!requestedFolderId) {
      next(new ShareError(400, 'A destination folder is required'));
      return;
    }
    let uploadPromise: Promise<{ id: string; name: string; sizeBytes: string; sha256: string }> | undefined;
    let fileSeen = false;
    try {
      const busboy = Busboy({ headers: req.headers, limits: { fileSize: config.maxUploadBytes, files: 1, fields: 2 } });
      busboy.on('file', (_field, stream, info) => {
        if (fileSeen) {
          stream.resume();
          return;
        }
        fileSeen = true;
        const originalName = info.filename;
        const mimeType = info.mimeType || 'application/octet-stream';
        stream.on('limit', () => stream.destroy(Object.assign(new Error('File is too large'), { code: 'LIMIT_FILE_SIZE' })));
        uploadPromise = (async () => {
          const client = await db.connect();
          let stored: Awaited<ReturnType<typeof storeOriginal>> | undefined;
          let committed = false;
          try {
            await client.query('BEGIN');
            const preliminary = await activeShare(String(req.params.token), client, false, req);
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${preliminary.ownerUserId}`]);
            const share = await activeShare(String(req.params.token), client, true, req);
            assertShareWriteAccess(share);
            const destination = await sharedFolder(share, requestedFolderId, client);
            stored = await storeOriginal({
              storageKey: share.storageKey,
              username: share.username,
              folderPath: destination.relativePath,
              originalName,
              stream,
            });
            const metadata = await extractMetadata(stored.absolutePath);
            await assertStorageAvailable(share.ownerUserId, BigInt(stored.size), client);
            const inserted = await client.query(`
              INSERT INTO files(user_id,folder_id,original_name,stored_name,relative_path,mime_type,size_bytes,sha256,extracted_metadata,is_hidden,original_created_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
              RETURNING id
            `, [
              share.ownerUserId, destination.id, originalName, stored.storedName,
              stored.relativePath, mimeType, stored.size, stored.sha256, metadata, isHiddenResource(stored.storedName, metadata), originalCreatedAtFromMetadata(metadata) ?? null,
            ]);
            await client.query('COMMIT');
            committed = true;
            logForRequest(req).warn({ event: 'public_share_upload_completed', shareId: share.id, folderId: destination.id, fileId: inserted.rows[0]!.id, sizeBytes: stored.size }, 'Public share upload completed');
            return { id: inserted.rows[0]!.id, name: originalName, sizeBytes: String(stored.size), sha256: stored.sha256 };
          } catch (error) {
            await client.query('ROLLBACK').catch(() => undefined);
            if (stored && !committed) await unlink(stored.absolutePath).catch(() => undefined);
            throw error;
          } finally {
            client.release();
          }
        })().catch((error) => {
          stream.resume();
          throw error;
        });
        void uploadPromise.catch(() => undefined);
      });
      busboy.on('error', next);
      busboy.on('finish', async () => {
        try {
          if (!uploadPromise) throw new ShareError(400, 'A file is required');
          const result = await uploadPromise;
          setPublicResponseHeaders(res);
          res.status(201).json(result);
        } catch (error) {
          next(error);
        }
      });
      req.pipe(busboy);
    } catch (error) {
      next(error);
    }
  });

  router.delete('/api/public/shares/:token/items', asyncHandler(async (req, res) => {
    const parsed = parsePublicArchiveRequest({ mode: 'selection', selections: req.body?.selections });
    const client = await db.connect();
    const physicalMoves: Array<{ from: string; to: string }> = [];
    let stagingRoot = '';
    let committed = false;
    let prunedFolders: string[] = [];
    try {
      await client.query('BEGIN');
      const preliminary = await activeShare(String(req.params.token), client, false, req);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${preliminary.ownerUserId}`]);
      const share = await activeShare(String(req.params.token), client, true, req);
      assertShareWriteAccess(share);
      const selected = await publicWriteSelectionRows(share, parsed.selections, client);
      const topFolders = selected.folders.filter((candidate) => !selected.folders.some(
        (other) => other.id !== candidate.id && candidate.relativePath.startsWith(`${other.relativePath}/`),
      ));
      const topFiles = selected.files.filter((file) => !topFolders.some(
        (folder) => file.relativePath.startsWith(`${folder.relativePath}/`),
      ));
      if (share.trashEnabled) {
        const trashed = await moveSelectionsToTrash(client, share.ownerUserId, share.storageKey, [
          ...topFolders.map((folder) => ({ type: 'folder' as const, id: folder.id })),
          ...topFiles.map((file) => ({ type: 'file' as const, id: file.id })),
        ]);
        await client.query('COMMIT');
        committed = true;
        setPublicResponseHeaders(res);
        logForRequest(req).warn({ event: 'public_share_items_trashed', shareId: share.id, ...trashed }, 'Public share items moved to trash');
        res.json({ deleted: trashed });
        return;
      }
      const root = userFilesRoot(share.storageKey);
      const rootRealPath = await realpath(root).catch(() => {
        throw new ShareError(409, 'Shared storage is unavailable');
      });
      await Promise.all([
        ...topFolders.map((folder) => validateStoredEntry(root, rootRealPath, folder.relativePath, 'folder')),
        ...topFiles.map((file) => validateStoredEntry(root, rootRealPath, file.relativePath, 'file', file.sizeBytes)),
      ]);
      stagingRoot = resolveInside(root, `.originvault-public-delete-${randomUUID()}`);
      await mkdir(stagingRoot, { recursive: false, mode: 0o700 });
      for (const folder of topFolders) {
        const from = resolveInside(root, folder.relativePath);
        const to = resolveInside(stagingRoot, `folder-${folder.id}`);
        await rename(from, to);
        physicalMoves.push({ from, to });
      }
      for (const file of topFiles) {
        const from = resolveInside(root, file.relativePath);
        const to = resolveInside(stagingRoot, `file-${file.id}`);
        await rename(from, to);
        physicalMoves.push({ from, to });
      }
      const folderIds = topFolders.map((folder) => folder.id);
      const fileIds = topFiles.map((file) => file.id);
      if (folderIds.length) {
        await client.query(`
          WITH RECURSIVE tree AS (
            SELECT id FROM folders WHERE user_id=$1 AND id=ANY($2::uuid[])
            UNION
            SELECT child.id FROM folders child JOIN tree parent ON child.parent_id=parent.id WHERE child.user_id=$1
          )
          DELETE FROM files WHERE user_id=$1 AND (id=ANY($3::uuid[]) OR folder_id IN (SELECT id FROM tree))
        `, [share.ownerUserId, folderIds, fileIds]);
        await client.query('DELETE FROM folders WHERE user_id=$1 AND id=ANY($2::uuid[])', [share.ownerUserId, folderIds]);
      } else if (fileIds.length) {
        await client.query('DELETE FROM files WHERE user_id=$1 AND id=ANY($2::uuid[])', [share.ownerUserId, fileIds]);
      }
      const pruneStarts = [...topFiles.map((file) => file.folderId), ...topFolders.map((folder) => folder.parentId)];
      for (const folderId of new Set(pruneStarts.filter((id): id is string => Boolean(id))))
        prunedFolders.push(...await pruneEmptyActiveFolders(client, share.ownerUserId, folderId));
      await client.query('COMMIT');
      committed = true;
      await rm(stagingRoot, { recursive: true, force: true }).catch((error) =>
        logForRequest(req).error({ event: 'public_share_delete_cleanup_failed', shareId: share.id, stagingRoot, err: error }, 'Public share deletion cleanup failed'),
      );
      await removeEmptyActiveFolderPaths(share.storageKey, prunedFolders);
      setPublicResponseHeaders(res);
      logForRequest(req).warn({ event: 'public_share_delete_completed', shareId: share.id, deletedFileCount: topFiles.length, deletedFolderCount: topFolders.length }, 'Public share items deleted');
      res.json({ deleted: { files: topFiles.length, folders: topFolders.length } });
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (!committed) {
        for (const move of [...physicalMoves].reverse())
          await rename(move.to, move.from).catch((rollbackError) =>
            logForRequest(req).fatal({ event: 'public_share_delete_rollback_failed', from: move.to, to: move.from, err: rollbackError }, 'Public share deletion rollback failed'),
          );
        if (stagingRoot) await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
      }
      throw error;
    } finally {
      client.release();
    }
  }));

  router.get('/api/public/shares/:token/files/:fileId/download', asyncHandler(async (req, res) => {
    const { share, file, fileHandle, fileSize } = await openAuthorizedSharedFile(
      req,
      requestUuid(req.params.fileId, 'File not found'),
    );
    setPublicFileHeaders(res, file, attachmentDisposition(file.name));
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', /^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(file.mimeType) ? file.mimeType : 'application/octet-stream');
    const requestedRange = req.header('if-range') && req.header('if-range') !== `"sha256-${file.sha256}"`
      ? undefined
      : req.header('range');
    let start = 0;
    let end = Math.max(0, fileSize - 1);
    if (requestedRange && !requestedRange.includes(',')) {
      const match = requestedRange.match(/^bytes=(\d*)-(\d*)$/);
      if (!match || (!match[1] && !match[2]) || fileSize === 0) {
        await fileHandle!.close();
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        res.status(416).end();
        return;
      }
      if (match[1]) {
        start = Number(match[1]);
        end = match[2] ? Math.min(Number(match[2]), fileSize - 1) : fileSize - 1;
      } else {
        const suffixLength = Number(match[2]);
        start = Math.max(0, fileSize - suffixLength);
        end = fileSize - 1;
      }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || start >= fileSize) {
        await fileHandle!.close();
        res.setHeader('Content-Range', `bytes */${fileSize}`);
        res.status(416).end();
        return;
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    }
    const bytesSent = requestedRange && !requestedRange.includes(',') ? end - start + 1 : fileSize;
    res.setHeader('Content-Length', bytesSent);
    if (req.method === 'GET')
      res.once('finish', () => { void recordEvent(req, share.id, 'download', file.id, String(bytesSent)).catch(() => undefined); });
    if (req.method === 'HEAD' || fileSize === 0) {
      await fileHandle!.close();
      res.end();
      return;
    }
    try {
      await pipeline(fileHandle!.createReadStream({ start, end, autoClose: false }), res);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!req.destroyed && !res.destroyed && code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ECONNRESET') {
        logForRequest(req).error({ event: 'public_share_stream_failed', shareId: share.id, fileId: file.id, err: error }, 'Public share download stream failed');
        res.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      await fileHandle!.close().catch(() => undefined);
    }
  }));

  router.get('/api/public/shares/:token/files/:fileId/details', asyncHandler(async (req, res) => {
    const file = await withActiveShareReadLock(req, (share, client) =>
      sharedFile(share, requestUuid(req.params.fileId, 'File not found'), client));
    setPublicResponseHeaders(res);
    res.json(publicFileRecord(file));
  }));

  router.get('/api/public/shares/:token/folders/:folderId/details', asyncHandler(async (req, res) => {
    const folder = await withActiveShareReadLock(req, (share, client) =>
      sharedFolderDetails(share, requestUuid(req.params.folderId, 'Folder not found'), client));
    setPublicResponseHeaders(res);
    res.json(folder);
  }));

  const publicPreviewHandler = asyncHandler(async (req, res) => {
    const opened = await openAuthorizedSharedFile(
      req,
      requestUuid(req.params.fileId, 'File not found'),
    );
    const { file, fileHandle, fileSize } = opened;
    const kind = previewKind(file.name, file.mimeType);
    if (kind === 'unsupported') {
      await fileHandle.close();
      throw new ShareError(415, 'This file cannot be previewed inline');
    }

    if (kind === 'text' || kind === 'subtitle') {
      if (fileSize > PUBLIC_SHARE_LIMITS.textSourceBytes) {
        await fileHandle.close();
        throw new ShareError(413, 'This text file exceeds the anonymous preview limit');
      }
      let source: Buffer;
      try {
        source = await fileHandle.readFile();
      } finally {
        await fileHandle.close().catch(() => undefined);
      }
      if (source.length !== fileSize) throw new ShareError(409, 'Shared file storage changed while it was being read');
      const decoded = decodePublicText(file, source, 'auto');
      const etag = setPublicFileHeaders(res, file, inlineDisposition(file.name));
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
      res.setHeader('X-Source-Encoding', decoded.encoding);
      res.setHeader('X-Source-BOM', decoded.hasBom ? 'present' : 'absent');
      if (req.header('if-match') && !etagMatches(req.header('if-match'), etag, false)) {
        res.status(412).end();
        return;
      }
      if (etagMatches(req.header('if-none-match'), etag, true)) {
        res.status(304).end();
        return;
      }
      res.setHeader('Content-Length', decoded.body.length);
      if (req.method === 'HEAD') res.end();
      else res.end(decoded.body);
      return;
    }

    const responseMime = safeInlineMime(file.name, kind, file.mimeType);
    const etag = setPublicFileHeaders(res, file, inlineDisposition(file.name));
    res.setHeader('Content-Type', responseMime);
    res.setHeader('Accept-Ranges', 'bytes');
    if (responseMime === 'image/svg+xml')
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    if (req.header('if-match') && !etagMatches(req.header('if-match'), etag, false)) {
      await fileHandle.close();
      res.status(412).end();
      return;
    }
    if (etagMatches(req.header('if-none-match'), etag, true)) {
      await fileHandle.close();
      res.status(304).end();
      return;
    }
    const requestedRange = ifRangePermitsRange(req.header('if-range'), etag, file.modifiedAt)
      ? req.header('range')
      : undefined;
    const range = parsePublicByteRange(requestedRange, fileSize);
    if (range.kind === 'unsatisfiable') {
      await fileHandle.close();
      res.setHeader('Content-Range', `bytes */${fileSize}`);
      res.status(416).end();
      return;
    }
    const start = range.kind === 'range' ? range.start : 0;
    const end = range.kind === 'range' ? range.end : Math.max(0, fileSize - 1);
    const responseBytes = range.kind === 'range' ? end - start + 1 : fileSize;
    if (range.kind === 'range') {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${fileSize}`);
    }
    res.setHeader('Content-Length', responseBytes);
    if (req.method === 'HEAD' || fileSize === 0) {
      await fileHandle.close();
      res.end();
      return;
    }
    try {
      await pipeline(fileHandle.createReadStream({ start, end, autoClose: false }), res);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!req.destroyed && !res.destroyed && code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ECONNRESET') {
        logForRequest(req).error({ event: 'public_share_preview_stream_failed', shareId: opened.share.id, fileId: file.id, err: error }, 'Public share preview stream failed');
        res.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      await fileHandle.close().catch(() => undefined);
    }
  });
  router.route('/api/public/shares/:token/files/:fileId/preview')
    .head(publicPreviewHandler)
    .get(publicPreviewHandler);

  router.get('/api/public/shares/:token/files/:fileId/text', asyncHandler(async (req, res) => {
    if (req.query.encoding !== undefined && typeof req.query.encoding !== 'string')
      throw new ShareError(400, 'Text encoding must be a single supported value');
    const opened = await openAuthorizedSharedFile(
      req,
      requestUuid(req.params.fileId, 'File not found'),
    );
    const { file, fileHandle, fileSize } = opened;
    if (!isEditableTextFile(file.name, file.mimeType)) {
      await fileHandle.close();
      throw new ShareError(415, 'This file type cannot be opened as text');
    }
    if (fileSize > PUBLIC_SHARE_LIMITS.textSourceBytes) {
      await fileHandle.close();
      throw new ShareError(413, 'This text file exceeds the anonymous preview limit');
    }
    let source: Buffer;
    try {
      source = await fileHandle.readFile();
    } finally {
      await fileHandle.close().catch(() => undefined);
    }
    if (source.length !== fileSize) throw new ShareError(409, 'Shared file storage changed while it was being read');
    const decoded = decodePublicText(file, source, req.query.encoding ?? 'auto');
    const etag = setPublicFileHeaders(res, file, inlineDisposition(file.name));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    res.setHeader('X-Source-Encoding', decoded.encoding);
    res.setHeader('X-Source-BOM', decoded.hasBom ? 'present' : 'absent');
    if (req.header('if-match') && !etagMatches(req.header('if-match'), etag, false)) {
      res.status(412).end();
      return;
    }
    if (etagMatches(req.header('if-none-match'), etag, true)) {
      res.status(304).end();
      return;
    }
    res.setHeader('Content-Length', decoded.body.length);
    res.end(decoded.body);
  }));

  router.post('/api/public/shares/:token/archive', asyncHandler(async (req, res) => {
    const archiveRequest = parsePublicArchiveRequest(req.body);
    let releaseArchiveSlot: (() => void) | undefined;
    try {
      releaseArchiveSlot = acquirePublicArchiveSlot();
    } catch (error) {
      if (error instanceof ShareError && error.statusCode === 429) res.setHeader('Retry-After', '5');
      throw error;
    }
    let client: PoolClient | undefined;
    let transactionStarted = false;
    let archive: ZipArchive | undefined;
    let streamCompleted = false;
    let share: any;
    let archiveFileCount = 0;
    let archiveFolderCount = 0;
    let totalSourceBytes = 0n;
    try {
      client = await db.connect();
      await client.query('BEGIN');
      transactionStarted = true;
      const preliminary = await activeShare(String(req.params.token), client, false, req);
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [`originvault:${preliminary.ownerUserId}`]);
      share = await activeShare(String(req.params.token), client, true, req);
      const expanded = await expandPublicArchive(share, archiveRequest, client);
      totalSourceBytes = totalArchiveSourceBytes(expanded.files);
      const archivePlan = publicArchivePathPlan(share, expanded.folders, expanded.files);
      if (archivePlan.directories.length + archivePlan.files.length > PUBLIC_SHARE_LIMITS.archiveEntries)
        throw new ShareError(413, 'The archive contains too many entries');
      const absolutePaths = await validatePublicArchiveStorage(share, expanded.folders, expanded.files);
      const filesById = new Map(expanded.files.map((file) => [file.id, file]));
      archiveFileCount = archivePlan.files.length;
      archiveFolderCount = archivePlan.directories.length;

      archive = new ZipArchive({ zlib: { level: 6 } });
      const targetName = share.fileId ? expanded.files[0]!.name : share.folderName;
      const archiveName = `${safeArchiveSegment(targetName, 'folder')}.zip`;
      res.status(200);
      setPublicResponseHeaders(res);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', attachmentDisposition(archiveName));
      res.setHeader('X-Content-Type-Options', 'nosniff');

      let rejectResponse!: (error: Error) => void;
      const responseCompleted = new Promise<void>((resolve, reject) => {
        rejectResponse = reject;
        res.once('finish', resolve);
        res.once('close', () => {
          if (!res.writableFinished) reject(new Error('Archive recipient disconnected'));
        });
      });
      void responseCompleted.catch(() => undefined);
      let streamFailed = false;
      const failStream = (error: Error) => {
        if (streamFailed) return;
        streamFailed = true;
        rejectResponse(error);
        archive?.abort();
        if (!archive?.destroyed) archive?.destroy(error);
        if (!res.destroyed) res.destroy(error);
      };
      archive.on('warning', (error) => {
        logForRequest(req).warn({ event: 'public_share_archive_warning', shareId: share.id, code: error.code, err: error }, 'Public share archive source warning');
        failStream(error);
      });
      archive.on('error', (error) => {
        logForRequest(req).error({ event: 'public_share_archive_stream_failed', shareId: share.id, err: error }, 'Public share archive stream failed');
        failStream(error);
      });
      res.once('close', () => {
        if (!res.writableFinished) failStream(new Error('Archive recipient disconnected'));
      });
      archive.pipe(res);
      for (const directory of archivePlan.directories)
        archive.append('', { name: `${directory.archivePath}/`, mode: 0o700 });
      for (const planned of archivePlan.files) {
        const file = filesById.get(planned.id);
        const absolutePath = absolutePaths.get(`file:${planned.id}`);
        if (!file || !absolutePath) throw new ShareError(409, 'Archive file expansion is inconsistent');
        const date = file.clientLastModified ? new Date(file.clientLastModified) : new Date(file.modifiedAt);
        archive.file(absolutePath, {
          name: planned.archivePath,
          mode: 0o600,
          ...(Number.isFinite(date.getTime()) ? { date } : {}),
        });
      }
      logForRequest(req).info({
        event: 'public_share_archive_stream_started', shareId: share.id, mode: archiveRequest.mode,
        submittedSelectionCount: archiveRequest.selections.length, fileCount: archiveFileCount,
        folderCount: archiveFolderCount, totalSourceBytes: totalSourceBytes.toString(),
      }, 'Public share archive stream started');
      await archive.finalize();
      await responseCompleted;
      streamCompleted = true;
      await recordEvent(req, share.id, 'download', undefined, String(archive.pointer()), client);
      await client.query('COMMIT');
      transactionStarted = false;
      logForRequest(req).info({
        event: 'public_share_archive_stream_completed', shareId: share.id, fileCount: archiveFileCount,
        folderCount: archiveFolderCount, totalSourceBytes: totalSourceBytes.toString(), archiveBytes: archive.pointer(),
      }, 'Public share archive stream and aggregate download event completed');
    } catch (error) {
      if (archive && !streamCompleted) {
        archive.abort();
        if (!archive.destroyed) archive.destroy();
      }
      if (transactionStarted) await client?.query('ROLLBACK').catch(() => undefined);
      transactionStarted = false;
      if (res.headersSent) {
        const code = (error as NodeJS.ErrnoException)?.code;
        if (code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ECONNRESET')
          logForRequest(req).warn({ event: 'public_share_archive_aborted', shareId: share?.id, err: error }, 'Public share archive aborted after streaming began');
        if (!res.destroyed) res.destroy(error instanceof Error ? error : undefined);
        return;
      }
      throw error;
    } finally {
      client?.release();
      releaseArchiveSlot?.();
    }
  }));

  router.get('/api/public/shares/:token', asyncHandler(async (req, res) => {
    const payload = await withActiveShareReadLock(req, async (share, client) => {
      let responsePayload: any;
      if (share.fileId) {
        const file = await sharedFile(share, share.fileId, client);
        responsePayload = {
          id: share.id,
          type: 'file',
          name: share.fileName,
          access: 'read',
          file: publicFileRecord(file),
        };
      } else {
        const requestedFolderId = typeof req.query.folderId === 'string'
          ? requestUuid(req.query.folderId, 'Folder not found')
          : share.folderId;
        const allowed = await client.query(`
          WITH RECURSIVE tree AS (
            SELECT id FROM folders WHERE id=$1 AND user_id=$2 AND trashed_at IS NULL AND ($4::boolean OR NOT is_hidden)
            UNION SELECT child.id FROM folders child JOIN tree parent ON child.parent_id=parent.id WHERE child.user_id=$2 AND child.trashed_at IS NULL AND ($4::boolean OR NOT child.is_hidden)
          ) SELECT id,name,CASE WHEN id=$1 THEN NULL ELSE parent_id END AS "parentId",
            created_at AS "createdAt",modified_at AS "modifiedAt"
          FROM folders WHERE id=$3 AND user_id=$2 AND trashed_at IS NULL AND id IN (SELECT id FROM tree)
        `, [share.folderId, share.ownerUserId, requestedFolderId, share.includeHidden]);
        if (!allowed.rowCount) throw new ShareError(404, 'Folder not found');
        const [folders, files] = await Promise.all([
          client.query(`SELECT id,name,original_created_at AS "originalCreatedAt",original_modified_at AS "originalModifiedAt",created_at AS "createdAt",modified_at AS "modifiedAt"
            FROM folders WHERE user_id=$1 AND parent_id=$2 AND trashed_at IS NULL AND ($3::boolean OR NOT is_hidden) ORDER BY name`, [share.ownerUserId, requestedFolderId, share.includeHidden]),
            client.query(`SELECT id,stored_name AS name,mime_type AS "mimeType",size_bytes::text AS "sizeBytes",sha256,
            original_created_at AS "originalCreatedAt",created_at AS "createdAt",modified_at AS "modifiedAt",client_last_modified AS "clientLastModified"
            FROM files WHERE user_id=$1 AND folder_id=$2 AND trashed_at IS NULL AND ($3::boolean OR NOT is_hidden) ORDER BY original_name`, [share.ownerUserId, requestedFolderId, share.includeHidden]),
        ]);
        responsePayload = {
          id: share.id,
          type: 'folder',
          name: share.folderName,
          access: share.access,
          currentFolder: allowed.rows[0],
          rootFolderId: share.folderId,
          folders: folders.rows.map(publicFolderRecord),
          files: files.rows.map(publicFileRecord),
        };
      }
      await recordEvent(req, share.id, 'view', undefined, undefined, client);
      return responsePayload;
    });
    setPublicResponseHeaders(res);
    res.json(payload);
  }));

  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    const statusCode = error instanceof ShareError ? error.statusCode : 500;
    if (statusCode >= 500) logForRequest(req).error({ event: 'share_request_failed', err: error }, 'Share request failed');
    else logForRequest(req).warn({ event: 'share_request_rejected', statusCode }, 'Share request was rejected');
    res.status(statusCode).json({ error: statusCode >= 500 ? 'Share request failed' : error instanceof Error ? error.message : 'Share request failed' });
  });
  return router;
}

export const shareRouter = createShareRouter();
