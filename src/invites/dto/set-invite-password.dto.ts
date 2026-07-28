import { IsString, MinLength } from 'class-validator';

export class SetInvitePasswordDto {
  @IsString()
  @MinLength(8)
  password: string;
}
