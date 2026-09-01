import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { loadSessionUser, publicUser, requireAdmin, requireAuth, signToken } from './auth.js';
import { config } from './config.js';
import { db } from './db.js';
import { logForRequest } from './logger.js';
import { getStorageUsage } from './quota.js';
import { resolveInside, userFilesRoot } from './storage.js';

class AccountError extends Error {
  constructor(readonly statusCode: number, message: string) {
    super(message);
  }
}

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<void>;
const asyncHandler = (handler: AsyncHandler) => (req: Request, res: Response, next: NextFunction): void => { handler(req, res, next).catch(next); };

export function normalizeUsername(value: unknown): string {
  const username = typeof value === 'string' ? value.toLowerCase().trim() : '';
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new AccountError(400, 'Username must be 3-32 lowercase letters, numbers, dot, underscore, or hyphen');
  if (username === '.upload-sessions' || username === '.dav-staging' || username.startsWith('.originvault-')) throw new AccountError(400, 'This username is reserved by the storage system');
  return username;
}

export function normalizeDisplayName(value: unknown, fallback?: string): string {
  const displayName = typeof value === 'string' ? value.trim() : fallback ?? '';
  if (!displayName || displayName.length > 80 || /[\u0000-\u001f]/.test(displayName)) throw new AccountError(400, 'Name must be 1-80 characters');
  return displayName;
}

export function normalizePassword(value: unknown): string {
  const password = typeof value === 'string' ? value : '';
  if (password.length < 12) throw new AccountError(400, 'Password must be at least 12 characters');
  if (Buffer.byteLength(password, 'utf8') > 72) throw new AccountError(400, 'Password must be at most 72 UTF-8 bytes');
  return password;
}

function normalizeQuota(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^\d+$/.test(text)) throw new AccountError(400, 'Storage quota must be a non-negative integer or null');
  return BigInt(text).toString();
}

async function profileResponse(userId: string) {
  const user = await loadSessionUser(userId);
  if (!user) throw new AccountError(404, 'User not found');
  const storage = await getStorageUsage(userId);
  return { user: publicUser(user), storage };
}

async function adminUser(userId: string) {
  const result = await db.query(`
    SELECT u.id,u.username,u.display_name AS "displayName",u.is_admin AS "isAdmin",
      (u.disabled_at IS NOT NULL) AS disabled,u.created_at AS "createdAt",
      u.storage_quota_bytes::text AS "storageQuotaBytes",
      COALESCE((SELECT SUM(size_bytes) FROM files WHERE user_id=u.id),0)::text AS "usedBytes",
      COALESCE((SELECT SUM(size_bytes) FROM upload_sessions WHERE user_id=u.id),0)::text AS "reservedBytes"
    FROM users u WHERE u.id=$1
  `, [userId]);
  if (!result.rowCount) throw new AccountError(404, 'User not found');
  return result.rows[0];
}

export function createAccountRouter(): express.Router {
  const router = express.Router();

  router.get('/api/auth/registration-status', asyncHandler(async (_req, res) => {
    const result = await db.query(`
      SELECT s.registration_enabled AS "registrationEnabled",
        NOT EXISTS(SELECT 1 FROM users) AS "bootstrapRequired"
      FROM app_settings s WHERE s.id=1
    `);
    res.json(result.rows[0] ?? { registrationEnabled: true, bootstrapRequired: true });
  }));

  router.get('/api/me', requireAuth, asyncHandler(async (req, res) => {
    const profile = await profileResponse(req.user!.id);
    if (!profile.user.isAdmin) {
      res.json({ ...profile, serverStorage: null });
      return;
    }
    let serverStorage: { totalBytes: string; availableBytes: string } | null = null;
    try {
      const storage = await statfs(config.dataRoot, { bigint: true });
      serverStorage = {
        totalBytes: (storage.blocks * storage.bsize).toString(),
        availableBytes: (storage.bavail * storage.bsize).toString(),
      };
    } catch (error) {
      logForRequest(req).warn(
        { event: 'server_storage_stat_failed', dataRoot: config.dataRoot, err: error },
        'Server storage statistics could not be read',
      );
    }
    res.json({
      ...profile,
      serverStorage,
    });
  }));

  router.patch('/api/me/profile', requireAuth, asyncHandler(async (req, res) => {
    const displayName = normalizeDisplayName(req.body?.displayName);
    await db.query('UPDATE users SET display_name=$1,updated_at=now() WHERE id=$2', [displayName, req.user!.id]);
    logForRequest(req).info({ event: 'profile_name_changed', displayName }, 'User display name changed');
    res.json(await profileResponse(req.user!.id));
  }));

  router.put('/api/me/password', requireAuth, asyncHandler(async (req, res) => {
    const currentPassword = typeof req.body?.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = normalizePassword(req.body?.newPassword);
    const result = await db.query<{ password_hash: string }>('SELECT password_hash FROM users WHERE id=$1', [req.user!.id]);
    if (!result.rowCount || !(await bcrypt.compare(currentPassword, result.rows[0]!.password_hash))) throw new AccountError(400, 'Current password is incorrect');
    const passwordHash = await bcrypt.hash(newPassword, 12);
    await db.query('UPDATE users SET password_hash=$1,auth_version=auth_version+1,updated_at=now() WHERE id=$2', [passwordHash, req.user!.id]);
    const user = await loadSessionUser(req.user!.id);
    if (!user) throw new AccountError(404, 'User not found');
    logForRequest(req).warn({ event: 'password_changed' }, 'User password changed and prior sessions were invalidated');
    res.json({ token: signToken(user), user: publicUser(user) });
  }));

  router.patch('/api/me/trash', requireAuth, asyncHandler(async (req, res) => {
    if (typeof req.body?.trashEnabled !== 'boolean') throw new AccountError(400, 'trashEnabled must be boolean');
    await db.query('UPDATE users SET trash_enabled=$1,updated_at=now() WHERE id=$2', [req.body.trashEnabled, req.user!.id]);
    logForRequest(req).info({ event: 'trash_setting_changed', trashEnabled: req.body.trashEnabled }, 'Trash setting changed');
    res.json(await profileResponse(req.user!.id));
  }));
  router.patch('/api/me/hidden-files', requireAuth, asyncHandler(async (req, res) => {
    if (typeof req.body?.showHiddenFiles !== 'boolean') throw new AccountError(400, 'showHiddenFiles must be boolean');
    await db.query('UPDATE users SET show_hidden_files=$1,updated_at=now() WHERE id=$2', [req.body.showHiddenFiles, req.user!.id]);
    logForRequest(req).info({ event: 'hidden_files_setting_changed', showHiddenFiles: req.body.showHiddenFiles }, 'Hidden file visibility changed');
    res.json(await profileResponse(req.user!.id));
  }));

  router.get('/api/admin/settings', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
    const result = await db.query('SELECT registration_enabled AS "registrationEnabled",updated_at AS "updatedAt" FROM app_settings WHERE id=1');
    res.json(result.rows[0]);
  }));

  router.patch('/api/admin/settings', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    if (typeof req.body?.registrationEnabled !== 'boolean') throw new AccountError(400, 'registrationEnabled must be boolean');
    const result = await db.query(`
      UPDATE app_settings SET registration_enabled=$1,updated_at=now(),updated_by=$2 WHERE id=1
      RETURNING registration_enabled AS "registrationEnabled",updated_at AS "updatedAt"
    `, [req.body.registrationEnabled, req.user!.id]);
    logForRequest(req).warn({ event: 'registration_setting_changed', registrationEnabled: req.body.registrationEnabled }, 'Registration setting changed');
    res.json(result.rows[0]);
  }));

  router.get('/api/admin/users', requireAuth, requireAdmin, asyncHandler(async (_req, res) => {
    const result = await db.query(`
      SELECT u.id,u.username,u.display_name AS "displayName",u.is_admin AS "isAdmin",
        (u.disabled_at IS NOT NULL) AS disabled,u.created_at AS "createdAt",
        u.storage_quota_bytes::text AS "storageQuotaBytes",
        COALESCE((SELECT SUM(size_bytes) FROM files WHERE user_id=u.id),0)::text AS "usedBytes",
        COALESCE((SELECT SUM(size_bytes) FROM upload_sessions WHERE user_id=u.id),0)::text AS "reservedBytes"
      FROM users u ORDER BY u.created_at,u.id
    `);
    res.json({ users: result.rows });
  }));

  router.post('/api/admin/users', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const username = normalizeUsername(req.body?.username);
    const displayName = normalizeDisplayName(req.body?.displayName, username);
    const password = normalizePassword(req.body?.password);
    const quota = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'storageQuotaBytes')
      ? normalizeQuota(req.body.storageQuotaBytes)
      : config.defaultStorageQuotaBytes;
    const isAdmin = req.body?.isAdmin === true;
    const passwordHash = await bcrypt.hash(password, 12);
    const result = await db.query<{ id: string; storage_key: string }>(`
      INSERT INTO users(username,display_name,storage_key,password_hash,is_admin,storage_quota_bytes)
      VALUES($1,$2,$1,$3,$4,$5) RETURNING id,storage_key
    `, [username, displayName, passwordHash, isAdmin, quota]);
    try {
      await mkdir(userFilesRoot(result.rows[0]!.storage_key), { recursive: true });
    } catch (error) {
      await db.query('DELETE FROM users WHERE id=$1', [result.rows[0]!.id]);
      throw error;
    }
    logForRequest(req).warn({ event: 'administrator_user_created', targetUserId: result.rows[0]!.id, username, isAdmin, storageQuotaBytes: quota }, 'Administrator created a user');
    res.status(201).json(await adminUser(result.rows[0]!.id));
  }));

  router.patch('/api/admin/users/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    if (req.body?.isAdmin !== undefined && typeof req.body.isAdmin !== 'boolean') throw new AccountError(400, 'isAdmin must be boolean');
    if (req.body?.disabled !== undefined && typeof req.body.disabled !== 'boolean') throw new AccountError(400, 'disabled must be boolean');
    const nextPasswordHash = req.body?.password === undefined ? null : await bcrypt.hash(normalizePassword(req.body.password), 12);
    const client = await db.connect();
    let updatedId = '';
    let audit: { username: string; isAdmin: boolean; disabled: boolean; quota: string | null };
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['originvault:admin-users']);
      const currentResult = await client.query(`
        SELECT id,username,display_name,is_admin,disabled_at,storage_quota_bytes::text,password_hash
        FROM users WHERE id=$1 FOR UPDATE
      `, [req.params.id]);
      if (!currentResult.rowCount) throw new AccountError(404, 'User not found');
      const current = currentResult.rows[0];
      const username = req.body?.username === undefined ? current.username : normalizeUsername(req.body.username);
      const displayName = req.body?.displayName === undefined ? current.display_name : normalizeDisplayName(req.body.displayName);
      const isAdmin = req.body?.isAdmin === undefined ? current.is_admin : req.body.isAdmin;
      const disabled = req.body?.disabled === undefined ? Boolean(current.disabled_at) : req.body.disabled;
      const quota = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'storageQuotaBytes') ? normalizeQuota(req.body.storageQuotaBytes) : current.storage_quota_bytes;
      if (req.user!.id === current.id && (!isAdmin || disabled)) throw new AccountError(409, 'You cannot remove your own administrator access or disable your own account');
      if (current.is_admin && (!isAdmin || disabled)) {
        const another = await client.query('SELECT 1 FROM users WHERE is_admin=true AND disabled_at IS NULL AND id<>$1 LIMIT 1', [current.id]);
        if (!another.rowCount) throw new AccountError(409, 'At least one active administrator is required');
      }
      const invalidateSessions = username !== current.username || isAdmin !== current.is_admin || disabled !== Boolean(current.disabled_at) || nextPasswordHash !== null;
      await client.query(`
        UPDATE users SET username=$1,display_name=$2,is_admin=$3,disabled_at=CASE WHEN $4 THEN COALESCE(disabled_at,now()) ELSE NULL END,
          storage_quota_bytes=$5,password_hash=COALESCE($6,password_hash),auth_version=auth_version+$7,updated_at=now()
        WHERE id=$8
      `, [username, displayName, isAdmin, disabled, quota, nextPasswordHash, invalidateSessions ? 1 : 0, current.id]);
      await client.query('COMMIT');
      updatedId = current.id;
      audit = { username, isAdmin, disabled, quota };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
    logForRequest(req).warn({ event: 'administrator_user_updated', targetUserId: updatedId, username: audit!.username, isAdmin: audit!.isAdmin, disabled: audit!.disabled, storageQuotaBytes: audit!.quota }, 'Administrator updated a user');
    res.json(await adminUser(updatedId));
  }));

  router.delete('/api/admin/users/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    if (req.params.id === req.user!.id) throw new AccountError(409, 'You cannot delete your own account');
    const client = await db.connect();
    const staged: Array<{ from: string; to: string }> = [];
    let target: any;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['originvault:admin-users']);
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`originvault:${String(req.params.id)}`]);
      const result = await client.query('SELECT id,username,storage_key,is_admin,disabled_at FROM users WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!result.rowCount) throw new AccountError(404, 'User not found');
      target = result.rows[0];
      if (target.is_admin && !target.disabled_at) {
        const another = await client.query('SELECT 1 FROM users WHERE is_admin=true AND disabled_at IS NULL AND id<>$1 LIMIT 1', [target.id]);
        if (!another.rowCount) throw new AccountError(409, 'At least one active administrator is required');
      }
      if (target.storage_key === '.upload-sessions' || target.storage_key === '.dav-staging' || String(target.storage_key).startsWith('.originvault-')) throw new AccountError(409, 'This legacy account uses a reserved storage key and must be migrated manually');
      const candidates = [userFilesRoot(target.storage_key),resolveInside(config.dataRoot,path.join('.upload-sessions',target.storage_key))];
      for (const source of candidates) {
        const destination = resolveInside(config.dataRoot, `.originvault-user-delete-${randomUUID()}`);
        try { await rename(source, destination); staged.push({ from: source, to: destination }); }
        catch (error: any) { if (error?.code !== 'ENOENT') throw error; }
      }
      await client.query('DELETE FROM users WHERE id=$1', [target.id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      for (const entry of staged.reverse()) await rename(entry.to, entry.from).catch(() => undefined);
      throw error;
    } finally { client.release(); }
    for (const entry of staged) await rm(entry.to, { recursive: true, force: true }).catch(() => undefined);
    logForRequest(req).warn({ event: 'administrator_user_deleted', targetUserId: target.id, username: target.username }, 'Administrator deleted a user and their stored data');
    res.status(204).end();
  }));

  router.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) { next(error); return; }
    if ((error as { code?: string })?.code === '23505') {
      res.status(409).json({ error: 'Username already exists' });
      return;
    }
    const statusCode = error instanceof AccountError ? error.statusCode : 500;
    if (statusCode >= 500) logForRequest(req).error({ event: 'account_request_failed', err: error }, 'Account request failed');
    else logForRequest(req).warn({ event: 'account_request_rejected', statusCode, err: error }, 'Account request was rejected');
    res.status(statusCode).json({ error: error instanceof Error ? error.message : 'Account request failed' });
  });
  return router;
}

export const accountRouter = createAccountRouter();
