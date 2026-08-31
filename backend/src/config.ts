import path from 'node:path';

export const config = {
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://originvault:originvault@localhost:5432/originvault',
  jwtSecret: process.env.JWT_SECRET ?? 'development-only-secret-change-me',
  shareSecret: process.env.SHARE_SECRET || process.env.JWT_SECRET || 'development-only-secret-change-me',
  publicUrl: (process.env.PUBLIC_URL ?? '').replace(/\/$/, ''),
  dataRoot: path.resolve(process.env.DATA_ROOT ?? path.join(process.cwd(), '..', 'DATA', 'files')),
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 10 * 1024 * 1024 * 1024),
  logLevel: (process.env.LOG_LEVEL ?? 'trace').toLowerCase(),
  logDir: path.resolve(process.env.LOG_DIR ?? path.join(process.cwd(), '..', 'DATA', 'logs')),
  logRetentionDays: (() => {
    const value = Number(process.env.LOG_RETENTION_DAYS ?? 7);
    return Number.isInteger(value) && value > 0 ? value : 7;
  })(),
};
