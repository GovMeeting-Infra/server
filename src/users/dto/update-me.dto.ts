import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Self-editable fields only. systemRole, ministryId and active are absent by
 * design — they are administered via /admin/users, and accepting them here
 * would be a privilege-escalation path.
 */
export class UpdateMeDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  jobTitle?: string;

  /** Avatar URL. */
  @IsOptional()
  @IsString()
  image?: string;
}
