import type { NextFunction, Request, Response } from 'express';
import jwt, { type JwtPayload } from 'jsonwebtoken';
import { config } from './config.js';
import { db } from './db.js';
import { logForRequest, logger } from './logger.js';

export interface SessionUser {
  id: string;
  username: string;
  displayName: string;
  storageKey: string;
  isAdmin: boolean;
  authVersion: number;
  storageQuotaBytes: string | null;
  trashEnabled: boolean;
  showHiddenFiles: boolean;
}

declare global {
  namespace Express { interface Request { user?: SessionUser } }
}

const SESSION_USER_COLUMNS = `
  id,username,display_name AS "displayName",storage_key AS "storageKey",
  is_admin AS "isAdmin",auth_version AS "authVersion",
  storage_quota_bytes::text AS "storageQuotaBytes",trash_enabled AS "trashEnabled",show_hidden_files AS "showHiddenFiles"
`;

export async function loadSessionUser(id: string): Promise<SessionUser | null> {
  const result = await db.query<SessionUser>(`
    SELECT ${SESSION_USER_COLUMNS}
    FROM users WHERE id=$1 AND disabled_at IS NULL
  `, [id]);
  return result.rows[0] ?? null;
}

export function signToken(user: Pick<SessionUser, 'id' | 'username' | 'authVersion'>): string {
  logger.debug({ event: 'auth_token_issued', userId: user.id, username: user.username, expiresIn: '7d' }, 'Authentication token issued');
  return jwt.sign({ version: user.authVersion }, config.jwtSecret, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: '7d',
    issuer: 'originvault',
    audience: 'originvault-web',
  });
}

export function publicUser(user: SessionUser) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    isAdmin: user.isAdmin,
    storageQuotaBytes: user.storageQuotaBytes,
    trashEnabled: user.trashEnabled,
    showHiddenFiles: user.showHiddenFiles,
  };
}

export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const value = req.header('authorization');
  if (!value?.startsWith('Bearer ')) {
    logForRequest(req).warn({ event: 'authentication_missing' }, 'Authentication header missing');
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  try {
    const payload = jwt.verify(value.slice(7), config.jwtSecret, {
      algorithms: ['HS256'],
      issuer: 'originvault',
      audience: 'originvault-web',
    }) as JwtPayload;
    if (!payload.sub || !Number.isInteger(payload.version)) throw new Error('Invalid token payload');
    const user = await loadSessionUser(payload.sub);
    if (!user || user.authVersion !== payload.version) throw new Error('Session is no longer valid');
    req.user = user;
    logForRequest(req).debug({ event: 'authentication_succeeded', isAdmin: user.isAdmin }, 'Request authentication succeeded');
    next();
  } catch (error) {
    logForRequest(req).warn({ event: 'authentication_failed', reason: error instanceof Error ? error.name : 'unknown' }, 'Request authentication failed');
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.isAdmin) {
    logForRequest(req).warn({ event: 'administrator_access_denied' }, 'Administrator access was denied');
    res.status(403).json({ error: 'Administrator access required' });
    return;
  }
  next();
}
