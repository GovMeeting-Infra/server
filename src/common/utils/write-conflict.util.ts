/**
 * Reporting a write that landed on top of someone else's.
 *
 * The rule is last write wins — chosen deliberately, and not revisited here.
 * What this adds is that the loser finds out, and gets their words back.
 *
 * That second part is not a nicety. A minutes save replaces the whole list
 * rather than patching fields, so two co-organisers taking minutes on two
 * phones during the same outage is not a merge conflict, it is one of them
 * losing every line they wrote. A warning on its own tells someone their work
 * is gone; returning what was overwritten lets the page offer to put it back.
 */
export interface WriteConflict<T = unknown> {
  /** Always true when present. Lets a client test one field. */
  overwritten: true;
  /** When the copy this write replaced was last changed. */
  previousUpdatedAt: string;
  /** Who changed it, where the record knows. */
  previousActor: { id: string | null; name: string | null } | null;
  /** What the write replaced, in the same shape the client sent. */
  previousContent: T | null;
}

/**
 * Whether the record moved on since the client last read it.
 *
 * `base` absent means the client had no opinion — an ordinary online write, and
 * by far the common case. That is not the same as "no conflict", and it must
 * not be reported as one: claiming a write was clean when nobody checked would
 * be worse than saying nothing.
 *
 * Compared on milliseconds rather than by identity, because the client sends
 * the value back as an ISO string and gets a Date here.
 */
export function detectConflict(
  base: Date | null,
  currentUpdatedAt: Date | null | undefined,
): boolean {
  if (!base || !currentUpdatedAt) return false;
  return currentUpdatedAt.getTime() > base.getTime();
}

export function describeConflict<T>(
  previousUpdatedAt: Date,
  previousActor: { id: string | null; name: string | null } | null,
  previousContent: T | null,
): WriteConflict<T> {
  return {
    overwritten: true,
    previousUpdatedAt: previousUpdatedAt.toISOString(),
    previousActor,
    previousContent,
  };
}
