import { applyDecorators } from '@nestjs/common';
import { IsOptional, IsString, Matches } from 'class-validator';

/**
 * The shape a client-minted primary key must have.
 *
 * Deliberately not pinned to one flavour of cuid. Prisma 7 bundles the original
 * cuid package for `@default(cuid())` — 'c' followed by 24 lowercase
 * alphanumerics — but `cuid(2)` is a one-word schema change away, and cuid2 ids
 * are a different length and do not all start with 'c'. A regex written to
 * today's exact format would turn that migration into a wave of 400s from
 * devices whose queued work was minted by the new code.
 *
 * So this checks the properties that actually matter for a value going into a
 * TEXT primary key: opaque, bounded, and nothing but lowercase alphanumerics —
 * no path separators, no control characters, no room for a value that reads as
 * something else further down. Both cuid flavours pass, and so would ulid
 * lowercased.
 *
 * What this is NOT is a security control. Anyone can mint an id in this shape.
 * What stops a client claiming another ministry's record is the primary-key
 * conflict and the authorisation re-check in idempotent-create.util.ts; this
 * only keeps obvious nonsense out of the column.
 */
export const CLIENT_ID_PATTERN = /^[a-z][a-z0-9]{19,31}$/;

export function IsClientId() {
  return applyDecorators(
    IsOptional(),
    IsString(),
    Matches(CLIENT_ID_PATTERN, {
      message:
        'id must be a client-generated identifier (20-32 lowercase alphanumeric characters, starting with a letter)',
    }),
  );
}
