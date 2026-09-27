import { ForbiddenException } from '@nestjs/common';

interface UserWithMinistry {
  systemRole: string;
  ministryId?: string | null;
}

/**
 * The roles that belong to no ministry and therefore see across all of them.
 *
 * Membership here grants breadth, not depth. A platform admin reaches every
 * ministry's *administrative* records — the user list, the ministry list —
 * because provisioning is their job. They reach none of the meeting content,
 * and nothing here is what stops them: RolesGuard is an allowlist, so minutes,
 * attendance, reports and search refuse them by never naming the role. Widening
 * this constant does not open those; adding the role to their @Roles would.
 */
export const PLATFORM_ROLES = ['SUPER_ADMIN', 'PLATFORM_ADMIN'];

export function ministryScope(user: UserWithMinistry): Record<string, unknown> {
  return PLATFORM_ROLES.includes(user.systemRole)
    ? {}
    : // Never `undefined`: Prisma drops an undefined filter key, which would
      // turn "a minister with no ministry" into "every ministry" — the exact
      // opposite of what this function exists to do, and silently, since no
      // error is raised and the query simply returns more than it should.
      // `null` matches nothing, which is the safe reading of "belongs to no
      // ministry". audit.service.ts:88-98 has always defended against this;
      // this shared helper had not.
      { ministryId: user.ministryId ?? null };
}

/**
 * Note the asymmetry with ministryScope: only the owner is exempt here.
 *
 * This guards writes to a specific record, and every caller of it sits on a
 * route a platform admin cannot reach. Leaving them subject to it means that if
 * one of those routes is ever widened by mistake, the write still fails rather
 * than succeeding across ministries. Provisioning does not go through here —
 * assertCanManage short-circuits for the platform roles before calling it.
 */
export function assertSameMinistry(
  user: UserWithMinistry,
  entityMinistryId: string,
): void {
  if (
    user.systemRole !== 'SUPER_ADMIN' &&
    user.ministryId !== entityMinistryId
  ) {
    throw new ForbiddenException('Cross-ministry access denied');
  }
}

/**
 * The roles that see every event in their reach, invited or not. Leadership
 * oversees the ministry's whole calendar and can already edit any of it; the
 * platform roles keep the cross-ministry overview ministryScope gives them.
 */
export const SEE_ALL_EVENTS_ROLES = [
  ...PLATFORM_ROLES,
  'MINISTER',
  'MINISTRY_ADMIN',
];

interface EventViewer {
  id?: string | null;
  systemRole: string;
}

/**
 * Narrows an event query to the events this user is part of: ones they run,
 * co-run or were invited to, plus public ones, which are on the open calendar
 * anyway. Everyone else in the ministry no longer sees them at all.
 *
 * This is a second filter, not a replacement — combine it with ministryScope
 * under AND. Both this and callers' own filters use OR, and spreading two
 * objects with an OR key keeps only the last one, silently widening the query.
 *
 * Without an id there is nobody to match against, so the filter matches
 * nothing rather than dropping out — the same reasoning as the null in
 * ministryScope.
 */
export function eventVisibilityScope(
  user: EventViewer,
): Record<string, unknown> {
  if (SEE_ALL_EVENTS_ROLES.includes(user.systemRole)) return {};
  if (!user.id) return { id: { in: [] } };
  return {
    OR: [
      { isPublic: true },
      { organizerId: user.id },
      { coOrganizers: { some: { userId: user.id } } },
      { attendees: { some: { userId: user.id } } },
    ],
  };
}

/**
 * eventVisibilityScope for a record already loaded, for routes that fetch one
 * event by id. Ministry is not checked here; that stays assertSameMinistry's
 * job.
 */
export function canSeeEvent(
  user: EventViewer,
  event: {
    isPublic?: boolean | null;
    organizerId?: string | null;
    coOrganizers?: { userId?: string | null }[] | null;
    attendees?: { userId?: string | null }[] | null;
  },
): boolean {
  if (SEE_ALL_EVENTS_ROLES.includes(user.systemRole)) return true;
  if (!user.id) return false;
  if (event.isPublic) return true;
  if (event.organizerId === user.id) return true;
  if (event.coOrganizers?.some((c) => c.userId === user.id)) return true;
  return !!event.attendees?.some((a) => a.userId === user.id);
}
