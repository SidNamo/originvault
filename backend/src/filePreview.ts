import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import express, { type NextFunction, type Request, type Response } from 'express';
import iconv from 'iconv-lite';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import type { Pool, PoolClient } from 'pg';
import { requireAuth } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { logForRequest } from './logger.js';
import {
  fileSha256,
  mutationBackupPath,
  mutationEditPath,
  mutationStagingRoot,
  PREVIEW_MUTATION_STAGING,
  removeMutationJournal,
  writeMutationJournal,
} from './mutationJournal.js';
import { getStorageUsage, StorageQuotaError } from './quota.js';
import { extractMetadata, resolveInside, userFilesRoot } from './storage.js';

export type PreviewKind = 'text' | 'subtitle' | 'image' | 'video' | 'audio' | 'pdf' | 'unsupported';
type AccessMode = 'preview' | 'download';

function previewStagingRoot(): string {
  return mutationStagingRoot(PREVIEW_MUTATION_STAGING);
}

export class PreviewError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

const TEXT_EXTENSIONS = new Set([
  'txt', 'text', 'md', 'markdown', 'json', 'jsonc', 'json5', 'yaml', 'yml', 'toml',
  'xml', 'csv', 'tsv', 'log', 'ini', 'conf', 'config', 'cfg', 'env', 'properties',
  'sql', 'html', 'htm', 'css', 'scss', 'sass', 'less', 'js', 'mjs', 'cjs', 'jsx',
  'ts', 'mts', 'cts', 'tsx', 'vue', 'svelte', 'py', 'pyw', 'java', 'kt', 'kts',
  'c', 'cc', 'cpp', 'cxx', 'h', 'hh', 'hpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh',
  'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd', 'dockerfile', 'gradle', 'groovy',
  'swift', 'dart', 'lua', 'r', 'pl', 'pm', 'ex', 'exs', 'erl', 'hrl', 'clj', 'cljs',
  'scala', 'proto', 'graphql', 'gql', 'tex', 'rst', 'adoc', 'diff', 'patch', 'gitignore',
  'gitattributes', 'editorconfig', 'npmrc', 'prettierrc', 'eslintrc', 'lock', 'manifest',
]);
const TEXT_NAMES = new Set([
  'readme', 'license', 'licence', 'authors', 'contributors', 'changelog', 'changes',
  'notice', 'copying', 'makefile', 'dockerfile', 'composefile', 'gemfile', 'rakefile',
  'procfile', '.env', '.gitignore', '.gitattributes', '.editorconfig', '.npmrc',
]);
const SUBTITLE_EXTENSIONS = new Set(['vtt', 'srt', 'ass', 'ssa', 'lrc']);
const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', jpe: 'image/jpeg', png: 'image/png', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp', svg: 'image/svg+xml',
  ico: 'image/x-icon', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
};
const VIDEO_MIME: Record<string, string> = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
  mov: 'video/quicktime', mkv: 'video/x-matroska', avi: 'video/x-msvideo',
  wmv: 'video/x-ms-wmv', flv: 'video/x-flv', '3gp': 'video/3gpp', ts: 'video/mp2t',
};
const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg', wav: 'audio/wav', wave: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg',
  opus: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac',
  weba: 'audio/webm', wma: 'audio/x-ms-wma', aiff: 'audio/aiff', aif: 'audio/aiff',
};

export const SUPPORTED_TEXT_ENCODINGS = [
  'utf-8', 'utf-16le', 'utf-16be', 'euc-kr', 'cp949', 'shift_jis', 'euc-jp',
  'gb18030', 'big5', 'windows-1252', 'iso-8859-1',
] as const;

const ENCODING_ALIASES: Record<string, string> = {
  utf8: 'utf-8', 'utf-8': 'utf-8', utf16le: 'utf-16le', 'utf-16le': 'utf-16le',
  utf16be: 'utf-16be', 'utf-16be': 'utf-16be', 'euc-kr': 'euc-kr', euckr: 'euc-kr',
  cp949: 'cp949', 'windows-949': 'cp949', sjis: 'shift_jis', 'shift-jis': 'shift_jis',
  shift_jis: 'shift_jis', 'euc-jp': 'euc-jp', eucjp: 'euc-jp', gb18030: 'gb18030',
  big5: 'big5', 'windows-1252': 'windows-1252', cp1252: 'windows-1252',
  'iso-8859-1': 'iso-8859-1', latin1: 'iso-8859-1',
};

function extension(name: string): string {
  return path.extname(name).slice(1).toLowerCase();
}

export function isEditableTextFile(name: string, mimeType = ''): boolean {
  const ext = extension(name);
  const base = path.basename(name).toLowerCase();
  const mime = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (ext === 'ts' && mime === 'video/mp2t') return false;
  return SUBTITLE_EXTENSIONS.has(ext) || TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.has(base)
    || mime.startsWith('text/')
    || /^(application\/(json|xml|yaml|toml|javascript|sql|graphql))$/i.test(mime);
}

export function previewKind(name: string, mimeType = ''): PreviewKind {
  const ext = extension(name);
  const mime = mimeType.split(';', 1)[0]!.trim().toLowerCase();
  if (SUBTITLE_EXTENSIONS.has(ext)) return 'subtitle';
  if (ext === 'ts' && mime === 'video/mp2t') return 'video';
  if (isEditableTextFile(name, mimeType)) return 'text';
  if (IMAGE_MIME[ext] || mime.startsWith('image/')) return 'image';
  if (VIDEO_MIME[ext] || mime.startsWith('video/')) return 'video';
  if (AUDIO_MIME[ext] || mime.startsWith('audio/')) return 'audio';
  if (ext === 'pdf' || mime === 'application/pdf') return 'pdf';
  return 'unsupported';
}

export function isStreamPreviewKind(kind: PreviewKind): boolean {
  return kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'pdf';
}

export function normalizeEncoding(value: unknown): string {
  const normalized = ENCODING_ALIASES[String(value ?? '').trim().toLowerCase()];
  if (!normalized || !iconv.encodingExists(normalized)) throw new PreviewError(400, 'Unsupported text encoding');
  return normalized;
}

function bomFor(encoding: string): Buffer | null {
  if (encoding === 'utf-8') return Buffer.from([0xef, 0xbb, 0xbf]);
  if (encoding === 'utf-16le') return Buffer.from([0xff, 0xfe]);
  if (encoding === 'utf-16be') return Buffer.from([0xfe, 0xff]);
  return null;
}

export function detectBom(bytes: Buffer): { encoding?: string; hasBom: boolean } {
  if (bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) return { encoding: 'utf-8', hasBom: true };
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) return { encoding: 'utf-16le', hasBom: true };
  if (bytes.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) return { encoding: 'utf-16be', hasBom: true };
  return { hasBom: false };
}

export function detectTextEncodingFromBytes(bytes: Buffer, storedEncoding?: string | null, storedBom?: boolean | null) {
  const bom = detectBom(bytes);
  if (bom.encoding) return bom;
  if (storedEncoding) return { encoding: normalizeEncoding(storedEncoding), hasBom: storedBom ?? false };
  if (bytes.length >= 4) {
    let evenZero = 0;
    let oddZero = 0;
    for (let index = 0; index < bytes.length; index += 1) {
      if (bytes[index] === 0) index % 2 === 0 ? evenZero += 1 : oddZero += 1;
    }
    if (oddZero > bytes.length / 8 && evenZero < oddZero / 4) return { encoding: 'utf-16le', hasBom: false };
    if (evenZero > bytes.length / 8 && oddZero < evenZero / 4) return { encoding: 'utf-16be', hasBom: false };
  }
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: true });
    return { encoding: 'utf-8', hasBom: false };
  } catch {
    return { encoding: 'cp949', hasBom: false };
  }
}

export async function detectTextEncoding(filePath: string, storedEncoding?: string | null, storedBom?: boolean | null) {
  const handle = await open(filePath, 'r');
  try {
    const sample = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(sample, 0, sample.length, 0);
    return detectTextEncodingFromBytes(sample.subarray(0, bytesRead), storedEncoding, storedBom);
  } finally {
    await handle.close();
  }
}

export async function assertLosslessTextDecoding(filePath: string, encoding: string): Promise<void> {
  const sourceHash = createHash('sha256');
  const roundTripHash = createHash('sha256');
  await pipeline(
    createReadStream(filePath),
    new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        sourceHash.update(chunk);
        callback(null, chunk);
      },
    }),
    iconv.decodeStream(encoding, { stripBOM: false }) as NodeJS.ReadWriteStream,
    iconv.encodeStream(encoding, { addBOM: false }) as NodeJS.ReadWriteStream,
    new Writable({ write(chunk, _encoding, callback) { roundTripHash.update(chunk); callback(); } }),
  );
  if (sourceHash.digest('hex') !== roundTripHash.digest('hex'))
    throw new PreviewError(422, 'The selected encoding cannot decode this file without replacing bytes');
}

export function safeInlineMime(name: string, kind: PreviewKind, storedMime: string): string {
  const ext = extension(name);
  const mime = storedMime.split(';', 1)[0]!.trim().toLowerCase();
  if (kind === 'image') return IMAGE_MIME[ext] ?? (mime.startsWith('image/') ? mime : 'application/octet-stream');
  if (kind === 'video') return VIDEO_MIME[ext] ?? (mime.startsWith('video/') ? mime : 'application/octet-stream');
  if (kind === 'audio') return AUDIO_MIME[ext] ?? (mime.startsWith('audio/') ? mime : 'application/octet-stream');
  if (kind === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

export function inlineDisposition(name: string): string {
  const encoded = encodeURIComponent(path.basename(name)).replace(/['()]/g, (value) => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
  return `inline; filename*=UTF-8''${encoded}`;
}

export function etagMatches(value: string | undefined, etag: string, allowWeak: boolean): boolean {
  if (!value) return false;
  return value.split(',').some((candidate) => {
    const tag = candidate.trim();
    if (tag === '*') return true;
    if (!allowWeak && tag.startsWith('W/')) return false;
    return tag.replace(/^W\//, '') === etag;
  });
}

function previewToken(file: { id: string; userId: string; sha256: string; authVersion: number }, mode: AccessMode, trashed = false): string {
  return jwt.sign({ userId: file.userId, sha256: file.sha256, authVersion: file.authVersion, mode, trashed }, config.jwtSecret, {
    algorithm: 'HS256', subject: file.id, issuer: 'originvault-preview', audience: 'originvault-media', expiresIn: mode === 'preview' ? '12h' : '5m',
  });
}

function previewIdentity(token: string): { id: string; userId: string; sha256: string; authVersion: number; mode: AccessMode; trashed: boolean } {
  try {
    const payload = jwt.verify(token, config.jwtSecret, {
      algorithms: ['HS256'], issuer: 'originvault-preview', audience: 'originvault-media',
    }) as JwtPayload;
    if (!payload.sub || typeof payload.userId !== 'string' || typeof payload.sha256 !== 'string'
      || !Number.isInteger(payload.authVersion) || (payload.mode !== 'preview' && payload.mode !== 'download')) throw new Error('Invalid preview token');
    return { id: payload.sub, userId: payload.userId, sha256: payload.sha256, authVersion: payload.authVersion, mode: payload.mode, trashed: payload.trashed === true };
  } catch {
    throw new PreviewError(404, 'Preview not found');
  }
}

function normalizedStem(name: string): string {
  return path.basename(name, path.extname(name)).normalize('NFC').toLocaleLowerCase('en-US');
}

function subtitleMatches(mediaName: string, subtitleName: string): boolean {
  const media = normalizedStem(mediaName);
  const subtitle = normalizedStem(subtitleName);
  return subtitle === media || subtitle.startsWith(`${media}.`) || subtitle.startsWith(`${media} `)
    || subtitle.startsWith(`${media}-`) || subtitle.startsWith(`${media}_`);
}

async function ownedFile(fileId: string, userId: string, queryable: Pool | PoolClient = db, trashed = false) {
  const result = await queryable.query(`
    SELECT files.id,files.user_id AS "userId",files.folder_id AS "folderId",files.stored_name AS name,files.stored_name AS "storedName",
      files.relative_path AS "relativePath",files.mime_type AS "mimeType",files.size_bytes::text AS "sizeBytes",files.sha256,
      files.text_encoding AS "textEncoding",files.text_has_bom AS "textHasBom",files.original_created_at AS "originalCreatedAt",
      files.client_last_modified AS "originalModifiedAt",
      files.extracted_metadata AS metadata,files.created_at AS "createdAt",files.modified_at AS "modifiedAt",files.trashed_at AS "trashedAt",
      files.trash_root_id AS "trashRootId",COALESCE(trash_file_root.trash_storage_path,trash_folder_root.trash_storage_path) AS "trashStoragePath",
      COALESCE(trash_file_root.relative_path,trash_folder_root.relative_path) AS "trashRootRelativePath"
    FROM files
    LEFT JOIN files trash_file_root ON trash_file_root.id=files.trash_root_id
    LEFT JOIN folders trash_folder_root ON trash_folder_root.id=files.trash_root_id
    WHERE files.id=$1 AND files.user_id=$2 AND files.trashed_at ${trashed ? 'IS NOT NULL' : 'IS NULL'}
  `, [fileId, userId]);
  if (!result.rowCount) throw new PreviewError(404, 'File not found');
  return result.rows[0];
}

function storedFilePath(file: any, storageKey: string): string {
  const root = userFilesRoot(storageKey);
  if (!file.trashedAt) return resolveInside(root, file.relativePath);
  if (!file.trashStoragePath || !file.trashRootRelativePath)
    throw new PreviewError(409, 'Trashed file storage has not been isolated');
  const suffix = String(file.relativePath).slice(String(file.trashRootRelativePath).length);
  return resolveInside(root, `${file.trashStoragePath}${suffix}`);
}

async function withUserReadLock<T>(userId: string, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [`originvault:${userId}`]);
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => { handler(req, res).catch(next); };
}

async function sendFilePreview(req: Request, res: Response, trashed: boolean): Promise<void> {
  const { file, kind, siblingRows, text } = await withUserReadLock(req.user!.id, async (client) => {
    const file = await ownedFile(String(req.params.id), req.user!.id, client, trashed);
    const kind = previewKind(file.name, file.mimeType);
    const siblings = await client.query(`
      SELECT id,stored_name AS name,mime_type AS "mimeType",size_bytes::text AS "sizeBytes",sha256,created_at AS "createdAt"
      FROM files WHERE user_id=$1 AND folder_id IS NOT DISTINCT FROM $2 AND trashed_at ${trashed ? 'IS NOT NULL AND trash_root_id=$3' : 'IS NULL'}
      ORDER BY lower(original_name) COLLATE "C",id
    `, trashed ? [req.user!.id, file.folderId, file.trashRootId] : [req.user!.id, file.folderId]);
    const siblingRows = siblings.rows.map((entry) => ({ ...entry, kind: previewKind(entry.name, entry.mimeType) }));
    const text = kind === 'text' || kind === 'subtitle'
      ? await detectTextEncoding(storedFilePath(file, req.user!.storageKey), file.textEncoding, file.textHasBom)
      : undefined;
    return { file, kind, siblingRows, text };
  });
  const streamUrl = isStreamPreviewKind(kind)
    ? `/api/previews/${encodeURIComponent(previewToken({ id: file.id, userId: req.user!.id, sha256: file.sha256, authVersion: req.user!.authVersion }, 'preview', trashed))}`
    : undefined;
  const subtitles = kind === 'video' || kind === 'audio'
    ? siblingRows
      .filter((entry) => entry.kind === 'subtitle' && subtitleMatches(file.name, entry.name))
      .sort((left, right) => Number(normalizedStem(left.name) !== normalizedStem(file.name)) - Number(normalizedStem(right.name) !== normalizedStem(file.name)))
    : [];
  res.setHeader('Cache-Control', 'private, no-store');
  res.json({ file: { ...file, kind, encoding: text?.encoding, hasBom: text?.hasBom, streamUrl }, siblings: siblingRows, subtitles, encodings: SUPPORTED_TEXT_ENCODINGS });
}

async function sendPreviewTicket(req: Request, res: Response, trashed: boolean): Promise<void> {
  const file = await withUserReadLock(req.user!.id, async (client) => {
    const result = await client.query(`
      SELECT id,user_id AS "userId",stored_name AS name,mime_type AS "mimeType",sha256
      FROM files
      WHERE id=$1 AND user_id=$2 AND trashed_at ${trashed ? 'IS NOT NULL' : 'IS NULL'}
    `, [String(req.params.id), req.user!.id]);
    if (!result.rowCount) throw new PreviewError(404, 'File not found');
    return result.rows[0];
  });
  const kind = previewKind(file.name, file.mimeType);
  if (!isStreamPreviewKind(kind))
    throw new PreviewError(415, 'This file cannot be streamed inline');
  const url = `/api/previews/${encodeURIComponent(previewToken({
    id: file.id,
    userId: file.userId,
    sha256: file.sha256,
    authVersion: req.user!.authVersion,
  }, 'preview', trashed))}`;
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(201).json({ url });
}

async function sendFileText(req: Request, res: Response, trashed: boolean): Promise<void> {
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  let opened: { file: any; detected: { encoding?: string; hasBom: boolean }; encoding: string };
  try {
    opened = await withUserReadLock(req.user!.id, async (client) => {
      const file = await ownedFile(String(req.params.id), req.user!.id, client, trashed);
      if (!isEditableTextFile(file.name, file.mimeType)) throw new PreviewError(415, 'This file type cannot be opened as text');
      const absolutePath = storedFilePath(file, req.user!.storageKey);
      const detected = await detectTextEncoding(absolutePath, file.textEncoding, file.textHasBom);
      const encoding = req.query.encoding && req.query.encoding !== 'auto' ? normalizeEncoding(req.query.encoding) : detected.encoding!;
      await assertLosslessTextDecoding(absolutePath, encoding);
      fileHandle = await open(absolutePath, 'r');
      return { file, detected, encoding };
    });
  } catch (error) {
    await fileHandle?.close().catch(() => undefined);
    throw error;
  }
  const { file, detected, encoding } = opened;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('ETag', `"sha256-${file.sha256}"`);
  res.setHeader('X-Source-Encoding', encoding);
  res.setHeader('X-Source-BOM', detected.hasBom ? 'present' : 'absent');
  try {
    await pipeline(fileHandle!.createReadStream({ autoClose: false }), iconv.decodeStream(encoding, { stripBOM: true }) as NodeJS.ReadWriteStream, res);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (!req.destroyed && !res.destroyed && code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ECONNRESET') {
      logForRequest(req).error({ event: 'text_stream_failed', fileId: file.id, err: error }, 'Text stream failed');
      res.destroy(error instanceof Error ? error : undefined);
    }
  } finally {
    await fileHandle!.close().catch(() => undefined);
  }
}

export function createFilePreviewRouter(): express.Router {
  const router = express.Router();

  router.get('/api/files/:id/preview', requireAuth, asyncRoute((req, res) => sendFilePreview(req, res, false)));
  router.get('/api/trash/files/:id/preview', requireAuth, asyncRoute((req, res) => sendFilePreview(req, res, true)));
  router.post('/api/files/:id/preview-ticket', requireAuth, asyncRoute((req, res) => sendPreviewTicket(req, res, false)));
  router.post('/api/trash/files/:id/preview-ticket', requireAuth, asyncRoute((req, res) => sendPreviewTicket(req, res, true)));

  router.post('/api/files/:id/download-ticket', requireAuth, asyncRoute(async (req, res) => {
    const file = await withUserReadLock(req.user!.id, (client) => ownedFile(String(req.params.id), req.user!.id, client));
    const token = previewToken({ id: file.id, userId: req.user!.id, sha256: file.sha256, authVersion: req.user!.authVersion }, 'download');
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ url: `/api/previews/${encodeURIComponent(token)}` });
  }));
  router.post('/api/trash/files/:id/download-ticket', requireAuth, asyncRoute(async (req, res) => {
    const file = await withUserReadLock(req.user!.id, (client) => ownedFile(String(req.params.id), req.user!.id, client, true));
    const token = previewToken({ id: file.id, userId: req.user!.id, sha256: file.sha256, authVersion: req.user!.authVersion }, 'download', true);
    res.setHeader('Cache-Control', 'private, no-store');
    res.status(201).json({ url: `/api/previews/${encodeURIComponent(token)}` });
  }));

  router.get('/api/files/:id/text', requireAuth, asyncRoute((req, res) => sendFileText(req, res, false)));
  router.get('/api/trash/files/:id/text', requireAuth, asyncRoute((req, res) => sendFileText(req, res, true)));

  router.put('/api/files/:id/text', requireAuth, asyncRoute(async (req, res) => {
    const [mediaType, ...parameters] = String(req.header('content-type') ?? '').toLowerCase().split(';').map((value) => value.trim());
    const charset = parameters.find((value) => value.startsWith('charset='))?.slice('charset='.length).replace(/^"|"$/g, '');
    if (mediaType !== 'text/plain' || (charset && charset !== 'utf-8' && charset !== 'utf8')) throw new PreviewError(415, 'Text updates must use text/plain; charset=utf-8');
    const expected = req.header('if-match');
    if (!expected) throw new PreviewError(428, 'If-Match is required');
    if (typeof req.query.encoding !== 'string') throw new PreviewError(400, 'Text encoding is required');
    if (req.query.bom !== 'true' && req.query.bom !== 'false') throw new PreviewError(400, 'BOM selection is required');
    const encoding = normalizeEncoding(req.query.encoding);
    const requestedBom = req.query.bom === 'true';
    if (requestedBom && !bomFor(encoding)) throw new PreviewError(400, 'The selected encoding does not support a byte-order mark');
    const root = userFilesRoot(req.user!.storageKey);
    const stagingRoot = previewStagingRoot();
    await mkdir(stagingRoot, { recursive: true, mode: 0o700 });
    const operationId = randomUUID();
    const stagedPath = mutationEditPath(stagingRoot, operationId);
    const client = await db.connect();
    const lockKey = `originvault:${req.user!.id}`;
    let lockHeld = false;
    let transactionStarted = false;
    let targetPath = '';
    let backupPath = '';
    let installed = false;
    let committed = false;
    let restored = false;
    let stateKnown = false;
    let oldSha256 = '';
    let oldRowVersion = '';
    let sha256 = '';
    let size = 0n;
    let updatedRow: any;
    let routeError: unknown;
    let journalWritten = false;
    try {
      await client.query('SELECT pg_advisory_lock(hashtext($1))', [lockKey]);
      lockHeld = true;
      const initialResult = await client.query(`
        SELECT f.original_name,f.relative_path,f.mime_type,f.size_bytes::text AS size_bytes,f.sha256,
          f.text_encoding,f.text_has_bom,f.xmin::text AS row_version
        FROM files f JOIN users u ON u.id=f.user_id AND u.disabled_at IS NULL AND u.auth_version=$3
        WHERE f.id=$1 AND f.user_id=$2 AND f.trashed_at IS NULL
      `, [req.params.id, req.user!.id, req.user!.authVersion]);
      if (!initialResult.rowCount) throw new PreviewError(404, 'File not found or session is no longer valid');
      const initial = initialResult.rows[0];
      if (!isEditableTextFile(initial.original_name, initial.mime_type)) throw new PreviewError(415, 'This file type cannot be edited as text');
      if (expected !== `"sha256-${initial.sha256}"`) throw new PreviewError(412, 'The file changed after it was opened');
      const initialUsage = await getStorageUsage(req.user!.id, client);
      const oldSize = BigInt(initial.size_bytes);
      let maximumTargetBytes = BigInt(config.maxUploadBytes) > oldSize ? BigInt(config.maxUploadBytes) : oldSize;
      if (initialUsage.quotaBytes !== null) {
        const available = BigInt(initialUsage.quotaBytes) - (BigInt(initialUsage.usedBytes) - oldSize + BigInt(initialUsage.reservedBytes));
        const quotaMaximum = available > oldSize ? available : oldSize;
        if (quotaMaximum < maximumTargetBytes) maximumTargetBytes = quotaMaximum;
      }
      const targetHash = createHash('sha256');
      const inputHash = createHash('sha256');
      const inputMeter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          inputHash.update(chunk);
          callback(null, chunk);
        },
      });
      const outputMeter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += BigInt(chunk.length);
          if (size > maximumTargetBytes) {
            callback(new StorageQuotaError());
            return;
          }
          targetHash.update(chunk);
          callback(null, chunk);
        },
      });
      await pipeline(
        req,
        inputMeter,
        iconv.decodeStream('utf-8', { stripBOM: false }) as NodeJS.ReadWriteStream,
        iconv.encodeStream(encoding, { addBOM: requestedBom }) as NodeJS.ReadWriteStream,
        outputMeter,
        createWriteStream(stagedPath, { flags: 'wx', mode: 0o600 }),
      );
      if (size === 0n && requestedBom) {
        const bom = bomFor(encoding)!;
        if (BigInt(bom.length) > maximumTargetBytes) throw new StorageQuotaError();
        await writeFile(stagedPath, bom, { mode: 0o600 });
        size = BigInt(bom.length);
        targetHash.update(bom);
      }
      const sourceDigest = inputHash.digest('hex');
      const roundTripHash = createHash('sha256');
      await pipeline(
        createReadStream(stagedPath),
        iconv.decodeStream(encoding, { stripBOM: true }) as NodeJS.ReadWriteStream,
        new Writable({ write(chunk, _encoding, callback) { roundTripHash.update(chunk); callback(); } }),
      );
      if (sourceDigest !== roundTripHash.digest('hex')) throw new PreviewError(422, 'Some characters cannot be represented in the selected encoding');
      sha256 = targetHash.digest('hex');
      const metadata = await extractMetadata(stagedPath);
      const stagedHandle = await open(stagedPath, 'r');
      try { await stagedHandle.sync(); } finally { await stagedHandle.close(); }

      await client.query('BEGIN');
      transactionStarted = true;
      const currentResult = await client.query(`
        SELECT f.id,f.original_name,f.relative_path,f.mime_type,f.size_bytes::text AS size_bytes,f.sha256,
          f.xmin::text AS row_version
        FROM files f JOIN users u ON u.id=f.user_id AND u.disabled_at IS NULL AND u.auth_version=$3
        WHERE f.id=$1 AND f.user_id=$2 AND f.trashed_at IS NULL FOR UPDATE OF f
      `, [req.params.id, req.user!.id, req.user!.authVersion]);
      if (!currentResult.rowCount) throw new PreviewError(404, 'File not found');
      const current = currentResult.rows[0];
      if (!isEditableTextFile(current.original_name, current.mime_type)) throw new PreviewError(415, 'This file type cannot be edited as text');
      if (expected !== `"sha256-${current.sha256}"`) throw new PreviewError(412, 'The file changed after it was opened');
      oldSha256 = current.sha256;
      oldRowVersion = current.row_version;
      targetPath = resolveInside(root, current.relative_path);
      const targetStat = await stat(targetPath);
      if (!targetStat.isFile()) throw new PreviewError(409, 'Stored content is not a regular file');
      const usage = await getStorageUsage(req.user!.id, client);
      const projected = BigInt(usage.usedBytes) - BigInt(current.size_bytes) + size + BigInt(usage.reservedBytes);
      if (usage.quotaBytes !== null && size > BigInt(current.size_bytes) && projected > BigInt(usage.quotaBytes)) throw new StorageQuotaError();
      backupPath = mutationBackupPath(stagingRoot, operationId);
      await writeMutationJournal(stagingRoot, {
        version: 1,
        operationId,
        source: 'text-edit',
        kind: 'replace',
        userId: req.user!.id,
        fileId: current.id,
        relativePath: current.relative_path,
        oldSha256,
        oldRowVersion,
        newSha256: sha256,
        createdAt: new Date().toISOString(),
      });
      journalWritten = true;
      await link(targetPath, backupPath);
      if (await fileSha256(backupPath) !== oldSha256) throw new PreviewError(409, 'Stored content does not match its indexed hash');
      const durableBackupDirectory = await open(stagingRoot, 'r');
      try { await durableBackupDirectory.sync(); } finally { await durableBackupDirectory.close(); }
      await rename(stagedPath, targetPath);
      installed = true;
      const targetDirectory = await open(path.dirname(targetPath), 'r');
      try { await targetDirectory.sync(); } finally { await targetDirectory.close(); }
      const stagingDirectory = await open(stagingRoot, 'r');
      try { await stagingDirectory.sync(); } finally { await stagingDirectory.close(); }
      const mimeType = current.mime_type;
      const updated = await client.query(`
        UPDATE files SET mime_type=$1,size_bytes=$2,sha256=$3,upload_identity_hash=NULL,
          extracted_metadata=$4,modified_at=now(),text_encoding=$5,text_has_bom=$6
        WHERE id=$7 AND user_id=$8
          RETURNING id,stored_name AS name,stored_name AS "storedName",relative_path AS "relativePath",
           mime_type AS "mimeType",size_bytes::text AS "sizeBytes",sha256,text_encoding AS encoding,
           text_has_bom AS "hasBom",original_created_at AS "originalCreatedAt",
           client_last_modified AS "originalModifiedAt",modified_at AS "modifiedAt",
            extracted_metadata AS metadata,created_at AS "createdAt"
         `, [mimeType, size, sha256, metadata, encoding, requestedBom, req.params.id, req.user!.id]);
      updatedRow = updated.rows[0];
      await client.query('COMMIT');
      transactionStarted = false;
      committed = true;
    } catch (error) {
      routeError = error;
      if (transactionStarted) await client.query('ROLLBACK').catch(() => undefined);
      if (installed && backupPath) {
        try {
          const state = await client.query<{ sha256: string; rowVersion: string }>(
            'SELECT sha256,xmin::text AS "rowVersion" FROM files WHERE id=$1 AND user_id=$2',
            [req.params.id, req.user!.id],
          );
          if (state.rowCount) {
            stateKnown = true;
            const targetState = await fileSha256(targetPath);
            if (state.rows[0]!.sha256 === sha256 && state.rows[0]!.rowVersion !== oldRowVersion
              && targetState === sha256) committed = true;
            else if (state.rows[0]!.sha256 === oldSha256 && state.rows[0]!.rowVersion === oldRowVersion) {
              if (targetState === sha256 || targetState === null) {
                await rename(backupPath, targetPath);
                const targetDirectory = await open(path.dirname(targetPath), 'r');
                try { await targetDirectory.sync(); } finally { await targetDirectory.close(); }
                restored = true;
              } else if (targetState === oldSha256) restored = true;
            }
          }
        } catch (recoveryError) {
          logForRequest(req).error({ event: 'text_edit_recovery_failed', fileId: req.params.id, targetPath, backupPath, err: recoveryError }, 'Text edit recovery failed; backup retained for manual recovery');
        }
      }
    } finally {
      await rm(stagedPath, { force: true }).catch(() => undefined);
      if (backupPath && (committed || restored || !installed)) {
        const cleanup = journalWritten
          ? removeMutationJournal(stagingRoot, operationId, true)
          : rm(backupPath, { force: true });
        await cleanup.catch((error) =>
          logForRequest(req).error({ event: 'text_edit_backup_cleanup_failed', fileId: req.params.id, backupPath, operationId, err: error }, 'Text edit recovery artifact cleanup failed'),
        );
      } else if (backupPath && installed) {
        logForRequest(req).error({ event: 'text_edit_backup_retained', fileId: req.params.id, backupPath, stateKnown }, 'Text edit backup retained because database state could not be reconciled safely');
      }
      let lockReleaseError: Error | undefined;
      if (lockHeld) {
        try {
          const unlocked = await client.query<{ unlocked: boolean }>('SELECT pg_advisory_unlock(hashtext($1)) AS unlocked', [lockKey]);
          if (!unlocked.rows[0]?.unlocked) throw new Error('User mutation lock was not held by this connection');
        } catch (error) {
          lockReleaseError = error instanceof Error ? error : new Error('User mutation lock release failed');
        }
      }
      if (lockReleaseError)
        logForRequest(req).error({ event: 'text_edit_lock_release_failed', err: lockReleaseError }, 'Text edit mutation lock connection was discarded');
      client.release(lockReleaseError);
    }
    if (!committed) throw routeError ?? new Error('Text update failed');
    logForRequest(req).warn({ event: 'text_file_updated', fileId: req.params.id, encoding, hasBom: requestedBom, sizeBytes: size.toString(), sha256, recoveredCommit: Boolean(routeError) }, 'Text file content replaced with selected encoding');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('ETag', `"sha256-${sha256}"`);
    res.json(updatedRow);
  }));

  router.get('/api/previews/:token', asyncRoute(async (req, res) => {
    const identity = previewIdentity(String(req.params.token));
    const client = await db.connect();
    let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
    let file: any;
    let fileSize = 0;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock_shared(hashtext($1))', [`originvault:${identity.userId}`]);
      const result = await client.query(`
        SELECT f.id,f.stored_name AS name,f.relative_path AS "relativePath",f.mime_type AS "mimeType",
          f.size_bytes::text AS "sizeBytes",f.sha256,f.trashed_at AS "trashedAt",
          COALESCE(trash_file_root.trash_storage_path,trash_folder_root.trash_storage_path) AS "trashStoragePath",
          COALESCE(trash_file_root.relative_path,trash_folder_root.relative_path) AS "trashRootRelativePath",
          u.storage_key AS "storageKey"
          FROM files f JOIN users u ON u.id=f.user_id AND u.disabled_at IS NULL
        LEFT JOIN files trash_file_root ON trash_file_root.id=f.trash_root_id
        LEFT JOIN folders trash_folder_root ON trash_folder_root.id=f.trash_root_id
        WHERE f.id=$1 AND f.user_id=$2 AND f.sha256=$3 AND u.auth_version=$4
          AND (f.trashed_at IS NOT NULL)=$5
        FOR SHARE OF f,u
      `, [identity.id, identity.userId, identity.sha256, identity.authVersion, identity.trashed]);
      if (!result.rowCount) throw new PreviewError(404, 'Preview not found');
      file = result.rows[0];
      const absolutePath = storedFilePath(file, file.storageKey);
      fileHandle = await open(absolutePath, 'r');
      const fileStat = await fileHandle.stat();
      if (!fileStat.isFile() || BigInt(fileStat.size) !== BigInt(file.sizeBytes))
        throw new PreviewError(409, 'Stored content is inconsistent');
      fileSize = fileStat.size;
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      await fileHandle?.close().catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    const kind = previewKind(file.name, file.mimeType);
    if (identity.mode === 'preview' && !isStreamPreviewKind(kind)) {
      await fileHandle!.close();
      throw new PreviewError(415, 'This file cannot be streamed inline');
    }
    const responseMime = identity.mode === 'preview'
      ? safeInlineMime(file.name, kind, file.mimeType)
      : (/^[\w!#$&^_.+-]+\/[\w!#$&^_.+-]+$/.test(file.mimeType) ? file.mimeType : 'application/octet-stream');
    res.setHeader('Content-Type', responseMime);
    res.setHeader('Content-Disposition', identity.mode === 'preview' ? inlineDisposition(file.name) : `attachment; ${inlineDisposition(file.name).slice('inline; '.length)}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('ETag', `"sha256-${file.sha256}"`);
    res.setHeader('X-Content-SHA256', file.sha256);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (identity.mode === 'preview' && responseMime === 'image/svg+xml') res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
    const etag = `"sha256-${file.sha256}"`;
    if (req.header('if-match') && !etagMatches(req.header('if-match'), etag, false)) {
      await fileHandle!.close();
      res.status(412).end();
      return;
    }
    if (etagMatches(req.header('if-none-match'), etag, true)) {
      await fileHandle!.close();
      res.status(304).end();
      return;
    }
    let requestedRange = req.header('if-range') && req.header('if-range') !== etag
      ? undefined
      : req.header('range');
    if (requestedRange?.includes(',')) requestedRange = undefined;
    let start = 0;
    let end = Math.max(0, fileSize - 1);
    if (requestedRange) {
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
    res.setHeader('Content-Length', requestedRange ? end - start + 1 : fileSize);
    if (req.method === 'HEAD') {
      await fileHandle!.close();
      res.end();
      return;
    }
    if (fileSize === 0) {
      await fileHandle!.close();
      res.end();
      return;
    }
    try {
      await pipeline(fileHandle!.createReadStream({ start, end, autoClose: false }), res);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (!req.destroyed && !res.destroyed && code !== 'ERR_STREAM_PREMATURE_CLOSE' && code !== 'ECONNRESET') {
        logForRequest(req).error({ event: 'preview_stream_failed', fileId: identity.id, err: error }, 'Preview stream failed');
        res.destroy(error instanceof Error ? error : undefined);
      }
    } finally {
      await fileHandle!.close().catch(() => undefined);
    }
  }));

  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    const reportedStatus = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
    const statusCode = error instanceof PreviewError ? error.statusCode : error instanceof StorageQuotaError ? 507
      : reportedStatus && reportedStatus >= 400 && reportedStatus < 500 ? reportedStatus : 500;
    if (statusCode >= 500) logForRequest(req).error({ event: 'file_preview_request_failed', err: error }, 'File preview request failed');
    res.status(statusCode).json({ error: statusCode >= 500 && !(error instanceof StorageQuotaError) ? 'File preview request failed' : error instanceof Error ? error.message : 'File preview request failed' });
  });
  return router;
}

export const filePreviewRouter = createFilePreviewRouter();
