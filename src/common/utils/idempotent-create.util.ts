import { ConflictException, Logger } from '@nestjs/common';

const logger = new Logger('IdempotentCreate');

/** Prisma's code for a unique-constraint violation. */
const UNIQUE_VIOLATION = 'P2002';

interface PrismaKnownError {
  code?: string;
}

/**
 * Whether this error is a unique-constraint violation at all.
 *
 * Deliberately does NOT try to work out *which* constraint. The obvious version
 * of this read `meta.target` and asked whether it named the primary key — and
 * it silently never matched, because Prisma 7 with the pg driver adapter does
 * not populate `target`. The meta carries `modelName` and a driver error and
 * nothing else, so every replay fell through as an unhandled P2002 and came
 * back a 500. Unit tests missed it completely: they built the error object by
 * hand, from how an older Prisma behaved.
 *
 * Which constraint it was is answered below by looking, which needs no
 * cooperation from the client's error shape and cannot rot with the next
 * release.
 */
function isUniqueViolation(error: unknown): boolean {
  return (error as PrismaKnownError)?.code === UNIQUE_VIOLATION;
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
    if (!id || !isUniqueViolation(error)) throw error;

    /*
     * Ask the database which constraint it was, rather than the error object.
     *
     * If a row already exists under the id this caller supplied, the collision
     * was that row and this is a replay. If nothing is there, the violation was
     * some other unique index — a duplicate ministry name, say — which is a
     * real disagreement with the caller and must surface as one.
     *
     * This also covers the row having been deleted between the insert and now.
     */
    const existing = await findExisting(id);
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
