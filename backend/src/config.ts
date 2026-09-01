import path from 'node:path';

function configuredOrigins(): string[] {
  const publicUrl = process.env.PUBLIC_URL || '';
  if (publicUrl) return [new URL(publicUrl).origin];
  if (process.env.NODE_ENV === 'production') return [];
  return ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:5173', 'http://127.0.0.1:5173'];
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://originvault:originvault@localhost:5432/originvault',
  jwtSecret: process.env.JWT_SECRET ?? 'development-only-secret-change-me',
  shareSecret: process.env.SHARE_SECRET ?? '',
  legacyShareSecret: process.env.LEGACY_SHARE_SECRET ?? '',
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/$/, ''),
  corsAllowedOrigins: configuredOrigins(),
  dataRoot: path.resolve(process.env.DATA_ROOT ?? path.join(process.cwd(), '..', 'DATA', 'files')),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024 * 1024),
  defaultStorageQuotaBytes: process.env.DEFAULT_STORAGE_QUOTA_BYTES ?? String(10 * 1024 * 1024 * 1024),
  logLevel: (process.env.LOG_LEVEL ?? 'info').toLowerCase(),
  logDir: path.resolve(process.env.LOG_DIR ?? path.join(process.cwd(), '..', 'DATA', 'logs')),
  logRetentionDays: (() => {
    const value = Number(process.env.LOG_RETENTION_DAYS ?? 7);
    return Number.isInteger(value) && value > 0 ? value : 7;
  })(),
};
