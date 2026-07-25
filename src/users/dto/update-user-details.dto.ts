import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** Admin edit of another user. Email is excluded: it is the login identity. */
export class UpdateUserDetailsDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  jobTitle?: string;
}
