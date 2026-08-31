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
