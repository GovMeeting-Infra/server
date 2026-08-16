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

  /**
   * Work phone. Optional, and deliberately not pattern-matched: Sierra Leone
   * numbers get written +232, 00232, 0 and spaced a dozen different ways, and
   * a regex here would reject a number that reaches the person perfectly well.
   * An empty string clears it.
   */
  @IsOptional()
  @IsString()
  @MaxLength(32)
  phone?: string;

  /** Avatar URL. */
  @IsOptional()
  @IsString()
  image?: string;
}
