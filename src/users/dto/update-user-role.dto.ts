import { IsString, Matches } from 'class-validator';

export class UpdateUserRoleDto {
  /**
   * SUPER_ADMIN is absent on purpose. The platform has exactly one, held
   * outside this API: it cannot be granted here, and no existing account can be
   * promoted into it. Provisioning another is a deliberate act against the
   * database, not something a session can do.
   */
  @IsString()
  @Matches(/^(MINISTER|MINISTRY_ADMIN|STAFF)$/, {
    message: 'systemRole must be MINISTER, MINISTRY_ADMIN or STAFF',
  })
  systemRole: string;
}
