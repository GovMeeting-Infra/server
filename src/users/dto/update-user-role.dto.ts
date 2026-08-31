import { IsString, Matches } from 'class-validator';

export class UpdateUserRoleDto {
  /**
   * The owner role is absent on purpose. The platform has exactly one, held
   * outside this API: it cannot be granted here, and no existing account can be
   * promoted into it. Provisioning another is a deliberate act against the
   * database, not something a session can do.
   *
   * PLATFORM_ADMIN is listed, but passing it is not the same as being allowed
   * it — assertCanAssignRole admits only the owner. This regex keeps the shape
   * of the payload honest; the rule about who may use it lives in one place.
   */
  @IsString()
  @Matches(/^(PLATFORM_ADMIN|MINISTER|MINISTRY_ADMIN|STAFF)$/, {
    message:
      'systemRole must be PLATFORM_ADMIN, MINISTER, MINISTRY_ADMIN or STAFF',
  })
  systemRole: string;
}
