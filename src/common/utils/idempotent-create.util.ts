import { ConflictException, Logger } from '@nestjs/common';

const logger = new Logger('IdempotentCreate');

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

interface PrismaKnownError {
  code?: string;
  meta?: { target?: unknown };
}

/**
 * True when this error is the record's own primary key colliding, rather than
 * some other unique index.
 *
 * The distinction matters. A primary-key collision on a client-minted id means
 * "this exact operation already landed", which is success arriving twice. A
 * collision on, say, Ministry.name means the caller sent something genuinely
 * conflicting, and quietly returning the existing row would be wrong.
 */
function isPrimaryKeyConflict(error: unknown): boolean {
  const known = error as PrismaKnownError;
  if (known?.code !== UNIQUE_VIOLATION) return false;

  const target = known.meta?.target;
  if (Array.isArray(target)) return target.length === 1 && target[0] === 'id';
  // Postgres reports the constraint name; a table's primary key is "<Table>_pkey".
  if (typeof target === 'string') {
    return target === 'id' || target.endsWith('_pkey');
  }
  return false;
}

export interface IdempotentCreateOptions<T> {
  /** The client-minted id, when the caller supplied one. */
  id?: string | null;
  /** Performs the insert, plus whatever must happen exactly once alongside it. */
  create: () => Promise<T>;
  /** Loads the row that already exists, for a replay. Null if it has since gone. */
  findExisting: (id: string) => Promise<T | null>;
  /**
   * Decides whether this caller is allowed the existing row.
   *
   * Not optional, and not a formality. Without it this helper is an IDOR: a
   * client that guesses another ministry's event id and POSTs to create it gets
   * a primary-key conflict, and would be handed that ministry's event back as
   * though it had just made it. The check must be the same one a read of that
   * record would apply.
   */
  canAccessExisting: (existing: T) => boolean;
  /** For the log line when a replay is detected. */
  label: string;
}

/**
 * Run a create so that running it twice is the same as running it once.
 *
 * Devices that write offline retry until they are sure, and "sure" is not
 * something a queue can ever be: a response can be lost after the row is
 * written. Without this, a recovering connection turns one action item into
 * three.
 *
 * There is no idempotency-key table behind this, deliberately. Because the
 * client mints the primary key, a replay is already an exact duplicate of a
 * value the database has a unique index on — so the constraint that exists
 * answers the question, for every model, including the ones with no natural key
 * of their own. A separate receipts table would add a row to write, a retention
 * policy to argue about, and nothing this does not already have.
 *
 * The caller's `create` is responsible for side effects that must not repeat —
 * invitations, notifications, audit. Those live inside it, so a replay never
 * reaches them: the insert throws first.
 */
export async function idempotentCreate<T>({
  id,
  create,
  findExisting,
  canAccessExisting,
  label,
}: IdempotentCreateOptions<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (!id || !isPrimaryKeyConflict(error)) throw error;

    const existing = await findExisting(id);

    // The row collided a moment ago and is gone now — deleted in between, or
    // the conflict was on a different index after all. Either way this is not
    // the replay it looked like, so surface the original failure.
    if (!existing) throw error;

    if (!canAccessExisting(existing)) {
      /*
       * Somebody else's record, under an id this caller supplied.
       *
       * Answered with a bare conflict and nothing else. Saying "that belongs to
       * another ministry" would confirm the id exists, which is precisely what
       * someone probing for ids is asking. The refusal has to read the same
       * whether the id was taken or invented.
       */
      logger.warn(
        `Refused ${label} replay for ${id}: caller cannot access the existing record`,
      );
      throw new ConflictException('That record could not be created');
    }

    logger.log(`Replayed ${label} for ${id}; returning the existing record`);
    return existing;
  }
}
