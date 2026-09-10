import { createParamDecorator, ExecutionContext } from '@nestjs/common';

/**
 * What a queued write carries beyond its own content.
 *
 * Sent as headers rather than body fields on purpose. The global
 * ValidationPipe runs with `forbidNonWhitelisted`, so every new body key costs
 * a DTO change on every route that might receive it — and this is not domain
 * data. Nothing about a meeting record says when the device that wrote it last
 * saw the server.
 *
 * The one exception is the record's own id, which stays in the body: that is a
 * field of the thing being created, and Prisma wants it in `data`.
 */
export interface SyncMeta {
  /**
   * `updatedAt` of the copy the client was working from, if it said.
   *
   * Absent for an ordinary online write, which is the common case and means
   * "no opinion" rather than "no conflict".
   */
  baseUpdatedAt: Date | null;
  /** The queued operation's id, so one write can be traced to one device action. */
  clientOpId: string | null;
}

/** Header names, exported so the client and the tests cannot drift from them. */
export const SYNC_HEADERS = {
  baseUpdatedAt: 'x-base-updated-at',
  clientOpId: 'x-client-op-id',
} as const;

function parseDate(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw) return null;
  const parsed = new Date(raw);
  // An unparseable header is treated as absent rather than as an error. It
  // arrives alongside work someone typed in a meeting, and refusing the write
  // over a malformed timestamp would lose the content to protect a warning.
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function parseOpId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  // Bounded and opaque: this is written to an audit column, not interpreted.
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

export const Sync = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): SyncMeta => {
    const request = ctx.switchToHttp().getRequest();
    const headers = request?.headers ?? {};

    return {
      baseUpdatedAt: parseDate(headers[SYNC_HEADERS.baseUpdatedAt]),
      clientOpId: parseOpId(headers[SYNC_HEADERS.clientOpId]),
    };
  },
);
