import { IsEmail, IsOptional, IsString, Matches } from 'class-validator';

export class CreateUserDto {
  @IsEmail()
  email: string;

  @IsString()
  name: string;

  @IsString()
  jobTitle: string;

  @IsString()
  @Matches(/^(SUPER_ADMIN|MINISTER|MINISTRY_ADMIN|STAFF)$/)
  systemRole: string;

  /**
   * Which ministry the new user belongs to. Only a SUPER_ADMIN may set it —
   * everyone else creates within their own ministry and the field is ignored.
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
