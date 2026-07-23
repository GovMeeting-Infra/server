import { IsString, Matches } from 'class-validator';

export class UpdateUserRoleDto {
  @IsString()
  @Matches(/^(SUPER_ADMIN|MINISTER|MINISTRY_ADMIN|STAFF)$/)
  systemRole: string;
}
