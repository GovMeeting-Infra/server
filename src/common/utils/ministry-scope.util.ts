import { ForbiddenException } from '@nestjs/common';

interface UserWithMinistry {
  systemRole: string;
  ministryId?: string | null;
}

export function ministryScope(user: UserWithMinistry): Record<string, unknown> {
  return user.systemRole === 'SUPER_ADMIN'
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
