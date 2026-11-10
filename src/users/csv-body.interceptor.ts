import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import type { Observable } from 'rxjs';

/** A staff export runs to about 70 bytes a person; 2 MB is ~30,000 of them. */
export const MAX_CSV_BYTES = 2 * 1024 * 1024;

/**
 * What a browser or curl labels a CSV with. application/vnd.ms-excel is what
 * Windows reports for a .csv once Excel is installed.
 */
const ACCEPTED = new Set([
  'text/csv',
  'text/plain',
  'application/csv',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

/**
 * Reads a raw CSV request body into `req.csvBody`, capped at MAX_CSV_BYTES.
 *
 * An interceptor rather than middleware or a body parser because interceptors
 * run after guards: a caller who is not signed in, or whose role may not
 * upload, is refused before a single byte of the file is buffered. A global
 * text parser would also have raised the size limit on every route at once.
 *
 * The global JSON and urlencoded parsers leave these content types alone, so
 * the request stream is still unread when this runs.
 */
@Injectable()
export class CsvBodyInterceptor implements NestInterceptor {
  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest();

    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    if (!ACCEPTED.has(type)) {
      req.resume();
      throw new UnsupportedMediaTypeException({
        message: 'Send the file as text/csv.',
        code: 'NOT_CSV',
      });
    }

    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_CSV_BYTES) {
      req.resume();
      throw tooLarge();
    }

    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > MAX_CSV_BYTES) {
        // Discard the rest so the connection can still carry the response.
        req.resume();
        throw tooLarge();
      }
      chunks.push(chunk);
    }

    req.csvBody = Buffer.concat(chunks);
    return next.handle();
  }
}

function tooLarge() {
  return new PayloadTooLargeException({
    message: `The file is larger than ${MAX_CSV_BYTES / 1024 / 1024} MB. Split it and upload each part.`,
    code: 'FILE_TOO_LARGE',
  });
}
