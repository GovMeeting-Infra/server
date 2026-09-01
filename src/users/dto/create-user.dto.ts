import { IsEmail, IsOptional, IsString, Matches } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  name: string;

  @IsString()
  jobTitle: string;

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

  /**
   * Which ministry the new user belongs to. Only the ministry-less platform
   * roles may set it — everyone else creates within their own ministry and the
   * field is ignored.
   *
   * Required for a super admin creating anything other than another
   * SUPER_ADMIN, because a super admin has no ministry of its own to fall back
   * on. The field was missing entirely before, and since main.ts sets
   * forbidNonWhitelisted, the web form that already sent it got a 400.
   */
  @IsOptional()
  @IsString()
  ministryId?: string;
}
