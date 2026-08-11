import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Admin edit of another user. */
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

  /**
   * Moves the user to another ministry. SUPER_ADMIN only — a ministry admin
   * sending this is refused rather than ignored.
   *
   * Transfers happen, and the alternative was deleting the person and creating
   * them again, which orphans their attendance, action items and audit trail.
   */
  @IsOptional()
  @IsString()
  ministryId?: string;

  /**
   * SUPER_ADMIN only, and normally sent alongside `ministryId`: a user moving
   * to another ministry needs an address on its domain, and their old one no
   * longer qualifies. It is the login identity, so it is audited separately.
   */
  @IsOptional()
  @IsEmail()
  email?: string;
}
