import path from 'node:path';
import { isIP } from 'node:net';

export function isSupportedPublicUrlProtocol(url: URL): boolean {
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return url.protocol === 'https:'
    || (url.protocol === 'http:' && isIP(hostname) !== 0);
}

function parseOrigin(value: string, setting: string): string {
  const url = URL.parse(value);
  if (!url || !isSupportedPublicUrlProtocol(url) || url.hostname.includes('*')
      || !/^https?:\/\/[^/?#@,\\\s]+\/?$/i.test(value)) {
    throw new Error(`${setting}: expected an HTTPS origin, or HTTP with a literal IP address (scheme://host[:port]), without wildcards, credentials, path, query, or fragment`);
  }
  return url.origin;
}

export function parseOriginConfig(publicUrl = '', additionalOrigins = '') {
  const primary = publicUrl ? parseOrigin(publicUrl.trim(), 'PUBLIC_URL') : '';
  const allowed = new Set<string>();
  if (primary) allowed.add(primary);
  for (const entry of additionalOrigins.split(',')) {
    const value = entry.trim();
    if (value) allowed.add(parseOrigin(value, 'CORS_ALLOWED_ORIGINS'));
  }
  return { publicUrl: primary, corsAllowedOrigins: [...allowed] };
}

export const config = {
  port: 4000,
  postgresHost: 'postgres',
  postgresPort: 5432,
  postgresDatabase: process.env.POSTGRES_DB ?? '',
  postgresUser: process.env.POSTGRES_USER ?? '',
  postgresPassword: process.env.POSTGRES_PASSWORD ?? '',
  jwtSecret: process.env.JWT_SECRET ?? 'development-only-secret-change-me',
  shareSecret: process.env.SHARE_SECRET ?? '',
  legacyShareSecret: process.env.LEGACY_SHARE_SECRET ?? '',
  ...parseOriginConfig(process.env.PUBLIC_URL, process.env.CORS_ALLOWED_ORIGINS),
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
