import type { NextFunction, Request, Response } from 'express';

type RateLimitOptions = {
  windowMs: number;
  max: number;
  key?: (req: Request) => string;
};

type RateLimitEntry = { count: number; resetAt: number };

const MAX_TRACKED_KEYS = 50_000;

export function createRateLimiter(options: RateLimitOptions) {
  const entries = new Map<string, RateLimitEntry>();
  const keyFor = options.key ?? ((req: Request) => req.ip);

  return (req: Request, res: Response, next: NextFunction): void => {
    const now = Date.now();
    const key = keyFor(req) || 'unknown';
    let entry = entries.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + options.windowMs };
      entries.set(key, entry);
    }
    entry.count += 1;

    if (entries.size > MAX_TRACKED_KEYS) {
      for (const [trackedKey, trackedEntry] of entries) {
        if (trackedEntry.resetAt <= now) entries.delete(trackedKey);
        if (entries.size <= MAX_TRACKED_KEYS) break;
      }
    }

    const remaining = Math.max(0, options.max - entry.count);
    const retryAfter = Math.max(1, Math.ceil((entry.resetAt - now) / 1_000));
    res.setHeader('RateLimit-Limit', String(options.max));
    res.setHeader('RateLimit-Remaining', String(remaining));
    res.setHeader('RateLimit-Reset', String(Math.ceil(entry.resetAt / 1_000)));
    if (entry.count > options.max) {
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }
    next();
  };
}
