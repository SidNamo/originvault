import { createWriteStream, mkdirSync, readdirSync, unlinkSync, type WriteStream } from 'node:fs';
import { Writable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pino from 'pino';
import { config } from './config.js';

const LOG_FILE_PATTERN = /^originvault-(\d{4}-\d{2}-\d{2})\.log$/;
const VALID_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

export function utcDate(value = new Date()): string {
  return value.toISOString().slice(0, 10);
}

export function retentionCutoff(retentionDays: number, now = new Date()): string {
  const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  cutoff.setUTCDate(cutoff.getUTCDate() - Math.max(0, retentionDays - 1));
  return utcDate(cutoff);
}

export function expiredLogFiles(fileNames: string[], retentionDays: number, now = new Date()): string[] {
  const cutoff = retentionCutoff(retentionDays, now);
  return fileNames.filter((name) => {
    const match = LOG_FILE_PATTERN.exec(name);
    return Boolean(match?.[1] && match[1] < cutoff);
  });
}

class DailyLogStream extends Writable {
  private activeDate = '';
  private fileStream?: WriteStream;
  private fileLoggingDisabled = false;

  constructor(private readonly directory: string, private readonly retentionDays: number) {
    super();
    try {
      mkdirSync(directory, { recursive: true });
      this.rotateIfNeeded();
    } catch (error) {
      this.disableFileLogging(error);
    }
  }

  private disableFileLogging(error: unknown): void {
    if (this.fileLoggingDisabled) return;
    this.fileLoggingDisabled = true;
    this.fileStream = undefined;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${JSON.stringify({ level: 'ERROR', time: new Date().toISOString(), service: 'originvault-backend', event: 'log_file_write_disabled', error: message })}\n`);
  }

  private prune(): void {
    for (const fileName of expiredLogFiles(readdirSync(this.directory), this.retentionDays)) {
      try {
        unlinkSync(`${this.directory}/${fileName}`);
        process.stdout.write(`${JSON.stringify({ level: 'INFO', time: new Date().toISOString(), service: 'originvault-backend', event: 'expired_log_deleted', fileName })}\n`);
      } catch (error) {
        process.stderr.write(`${JSON.stringify({ level: 'ERROR', time: new Date().toISOString(), service: 'originvault-backend', event: 'expired_log_delete_failed', fileName, error: error instanceof Error ? error.message : String(error) })}\n`);
      }
    }
  }

  private rotateIfNeeded(): void {
    if (this.fileLoggingDisabled) return;
    const today = utcDate();
    if (today === this.activeDate && this.fileStream) return;
    this.fileStream?.end();
    this.activeDate = today;
    this.prune();
    const stream = createWriteStream(`${this.directory}/originvault-${today}.log`, { flags: 'a', mode: 0o640 });
    this.fileStream = stream;
    stream.on('error', (error) => {
      this.disableFileLogging(error);
    });
  }

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (this.fileLoggingDisabled) {
      callback();
      return;
    }
    try {
      this.rotateIfNeeded();
      const stream = this.fileStream;
      if (!stream) {
        callback();
        return;
      }
      stream.write(chunk, encoding, (error) => {
        if (error) this.disableFileLogging(error);
        callback();
      });
    } catch (error) {
      this.disableFileLogging(error);
      callback();
    }
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.fileStream) return callback();
    this.fileStream.end(callback);
  }
}

const configuredLevel = VALID_LEVELS.has(config.logLevel) ? config.logLevel : 'trace';
const fileStream = new DailyLogStream(config.logDir, config.logRetentionDays);

export const logger = pino({
  level: configuredLevel,
  base: { service: 'originvault-backend', pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: { level: (label) => ({ level: label.toUpperCase() }) },
  redact: {
    paths: ['password', '*.password', 'token', '*.token', 'authorization', '*.authorization', 'passwordHash', '*.passwordHash'],
    censor: '[REDACTED]',
  },
}, pino.multistream([
  { level: configuredLevel, stream: process.stdout },
  { level: configuredLevel, stream: fileStream },
]));

if (configuredLevel !== config.logLevel) {
  logger.warn({ event: 'invalid_log_level_defaulted', configuredValue: config.logLevel, effectiveValue: configuredLevel }, 'Invalid LOG_LEVEL; defaulted to trace');
}

declare global {
  namespace Express { interface Request { requestId?: string; requestStartedAt?: bigint } }
}

export function logForRequest(req: Request) {
  return logger.child({ requestId: req.requestId, userId: req.user?.id, username: req.user?.username });
}

export function logSafePath(value: string): string {
  return value
    .replace(/(\/api\/public\/shares\/)[^/]+/g, '$1[REDACTED]')
    .replace(/(\/api\/previews\/)[^/]+/g, '$1[REDACTED]');
}

export function requestLogging(req: Request, res: Response, next: NextFunction): void {
  const incomingId = req.header('x-request-id');
  req.requestId = incomingId && /^[a-zA-Z0-9._-]{1,100}$/.test(incomingId) ? incomingId : randomUUID();
  req.requestStartedAt = process.hrtime.bigint();
  res.setHeader('X-Request-ID', req.requestId);
  logger.trace({
    event: 'http_request_received', requestId: req.requestId, method: req.method,
    path: logSafePath(req.path), queryKeys: Object.keys(req.query), ip: req.ip,
    contentType: req.header('content-type'), contentLength: req.header('content-length'),
    userAgent: req.header('user-agent'),
  }, 'HTTP request received');

  let completed = false;
  res.on('finish', () => {
    completed = true;
    const durationMs = req.requestStartedAt ? Number(process.hrtime.bigint() - req.requestStartedAt) / 1_000_000 : undefined;
    const fields = { event: 'http_request_completed', requestId: req.requestId, userId: req.user?.id, username: req.user?.username, method: req.method, path: logSafePath(req.path), statusCode: res.statusCode, durationMs };
    if (res.statusCode >= 500) logger.error(fields, 'HTTP request completed with server error');
    else if (res.statusCode >= 400) logger.warn(fields, 'HTTP request completed with client error');
    else logger.info(fields, 'HTTP request completed');
  });
  res.on('close', () => {
    if (!completed) logger.warn({ event: 'http_request_aborted', requestId: req.requestId, method: req.method, path: logSafePath(req.path) }, 'HTTP connection closed before response completed');
  });
  next();
}
