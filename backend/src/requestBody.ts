import type { Request } from 'express';

/** Keep the HTTP socket alive when storage or validation rejects a body. Passing
 * IncomingMessage straight to pipeline (or its default async iterator) can destroy
 * it before the route has a chance to send an HTTP error response. */
export async function* requestBody(req: Request): AsyncGenerator<Buffer> {
  try {
    for await (const value of req.iterator({ destroyOnReturn: false })) {
      yield Buffer.isBuffer(value) ? value : Buffer.from(value);
    }
  } finally {
    if (!req.destroyed) req.resume();
  }
}
