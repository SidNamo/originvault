import type { Pool, PoolClient } from 'pg';
import { db } from './db.js';

type Queryable = Pool | PoolClient;

export interface StorageUsage {
  usedBytes: string;
  activeBytes: string;
  trashBytes: string;
  reservedBytes: string;
  quotaBytes: string | null;
}

export class StorageQuotaError extends Error {
  readonly statusCode = 507;

  constructor(message = 'Storage quota exceeded') {
    super(message);
    this.name = 'StorageQuotaError';
  }
}

export async function getStorageUsage(userId: string, queryable: Queryable = db, excludeSessionId?: string): Promise<StorageUsage> {
  const result = await queryable.query<StorageUsage>(`
    SELECT
      COALESCE((SELECT SUM(size_bytes) FROM files WHERE user_id=u.id),0)::text AS "usedBytes",
      COALESCE((SELECT SUM(size_bytes) FROM files WHERE user_id=u.id AND trashed_at IS NULL),0)::text AS "activeBytes",
      COALESCE((SELECT SUM(size_bytes) FROM files WHERE user_id=u.id AND trashed_at IS NOT NULL),0)::text AS "trashBytes",
      COALESCE((SELECT SUM(size_bytes) FROM upload_sessions WHERE user_id=u.id AND ($2::uuid IS NULL OR id<>$2)),0)::text AS "reservedBytes",
      u.storage_quota_bytes::text AS "quotaBytes"
    FROM users u WHERE u.id=$1
  `, [userId, excludeSessionId ?? null]);
  if (!result.rowCount) throw new Error('User not found');
  return result.rows[0]!;
}

export async function assertStorageAvailable(userId: string, additionalBytes: bigint, queryable: Queryable = db, excludeSessionId?: string): Promise<StorageUsage> {
  if (additionalBytes < 0n) throw new Error('additionalBytes cannot be negative');
  const usage = await getStorageUsage(userId, queryable, excludeSessionId);
  if (usage.quotaBytes !== null) {
    const required = BigInt(usage.usedBytes) + BigInt(usage.reservedBytes) + additionalBytes;
    if (required > BigInt(usage.quotaBytes)) throw new StorageQuotaError();
  }
  return usage;
}
