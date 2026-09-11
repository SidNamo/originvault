import type { Readable } from 'node:stream';
import type { Request } from 'express';
import Busboy from 'busboy';

export class MultipartUploadError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}

/** The consumer must await parsed before committing: a complete file part can still
 * be followed by a malformed/truncated multipart envelope. Always settle its work
 * on parser errors and client disconnects so storage and transaction cleanup runs. */
export async function receiveMultipartFile<T>(
  req: Request,
  maximumBytes: number,
  consume: (file: { stream: Readable; name: string; mimeType: string }, fields: Record<string, string>, parsed: Promise<void>) => Promise<T>,
): Promise<T> {
  let parser: ReturnType<typeof Busboy>;
  try {
    parser = Busboy({
      headers: req.headers,
      defParamCharset: 'utf8',
      limits: { fileSize: maximumBytes + 1, files: 1, fields: 5, fieldSize: 4096 },
    });
  } catch {
    throw new MultipartUploadError(400, 'A valid multipart/form-data body is required');
  }
  const fields: Record<string, string> = Object.create(null);
  let fileStream: Readable | undefined;
  let work: Promise<T> | undefined;
  let failure: Error | undefined;
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const parsed = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    reject(error);
    fileStream?.destroy(error);
    req.unpipe(parser);
    // Busboy may still be inside its file callback. Destroy after it unwinds.
    queueMicrotask(() => parser.destroy(error));
    if (!req.destroyed) req.resume();
  };
  const aborted = () => fail(new MultipartUploadError(400, 'Upload was interrupted'));
  req.once('aborted', aborted);
  req.once('error', fail);
  parser.on('field', (name, value, info) => {
    if (info.nameTruncated || info.valueTruncated) fail(new MultipartUploadError(400, 'Upload field is too long'));
    else fields[name] = value;
  });
  parser.on('file', (_field, stream, info) => {
    fileStream = stream;
    stream.on('error', (error) => fail(/Unexpected end of (form|file)|Malformed part header/i.test(error.message)
      ? new MultipartUploadError(400, error.message)
      : error));
    stream.on('limit', () => fail(new MultipartUploadError(413, 'File is too large')));
    work = Promise.resolve().then(() => consume({ stream, name: info.filename, mimeType: info.mimeType }, fields, parsed));
    void work.catch(fail);
  });
  parser.on('filesLimit', () => fail(new MultipartUploadError(400, 'Only one file is allowed')));
  parser.on('fieldsLimit', () => fail(new MultipartUploadError(400, 'Too many upload fields')));
  parser.on('error', (error) => fail(new MultipartUploadError(400, error instanceof Error ? error.message : 'Invalid multipart body')));
  parser.on('finish', resolve);
  try {
    req.pipe(parser);
    if (req.aborted) aborted();
    await parsed;
    if (!work) throw new MultipartUploadError(400, 'A file is required');
    return await work;
  } catch (error) {
    fail(error instanceof Error ? error : new Error('Upload failed'));
    await work?.catch(() => undefined);
    throw failure;
  } finally {
    req.unpipe(parser);
    req.removeListener('aborted', aborted);
    req.removeListener('error', fail);
  }
}
