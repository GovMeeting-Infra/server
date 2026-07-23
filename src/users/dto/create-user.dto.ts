import { IsEmail, IsString, Matches } from 'class-validator';

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
}
