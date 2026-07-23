import { ForbiddenException } from '@nestjs/common';

interface UserWithMinistry {
  systemRole: string;
  ministryId?: string | null;
}

export function ministryScope(user: UserWithMinistry): Record<string, unknown> {
  return user.systemRole === 'SUPER_ADMIN' ? {} : { ministryId: user.ministryId };
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
