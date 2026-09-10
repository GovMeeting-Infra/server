import { ForbiddenException } from '@nestjs/common';

/** Roles that stand in for an organizer across their own ministry. */
const MINISTRY_ADMIN_ROLES = ['MINISTER', 'MINISTRY_ADMIN', 'SUPER_ADMIN'];

/**
 * Who may amend an event.
 *
 * Deliberately wider than deleting or cancelling it: a co-organizer exists so
 * that a meeting is not stranded when its organizer is unavailable, and a
 * ministry-level admin answers for everything held under their ministry.
 *
 * A plain function rather than a method, because two services need the same
 * answer and neither should have to inject the other. It was previously written
 * out inside updateEvent alone, and the recurrence service — which edits the
 * very same rows — grew its own organizer-only copy that did not admit
 * co-organizers, ministry admins, or even the super admin. Two rules for one
 * question is how that happens.
 *
 * The ministry boundary is a separate check: callers pair this with
 * assertSameMinistry, since this function knows nothing about tenancy.
 */
export function assertCanEditEvent(
  event: {
    organizerId: string | null;
    coOrganizers?: { userId: string }[] | null;
  },
  actorId: string,
  actorRole?: string,
): void {
  if (event.organizerId === actorId) return;
  if (event.coOrganizers?.some((c) => c.userId === actorId)) return;
  if (MINISTRY_ADMIN_ROLES.includes(actorRole ?? '')) return;

  throw new ForbiddenException(
    'Only the organizer, a co-organizer or a ministry admin can update this event',
  );
}
