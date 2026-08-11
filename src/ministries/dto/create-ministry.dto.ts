import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * The ministry's first administrator, created alongside it.
 *
 * Without this a new ministry has no one who can sign in, and the super admin
 * has to remember to go and add someone. No password is set here — the user
 * receives an invitation link, the same as any other account.
 */
export class FirstAdminDto {
  @IsEmail()
  email: string;

  @IsString()
  name: string;

  @IsString()
  jobTitle: string;
}

export class CreateMinistryDto {
  @IsString()
  name: string;

  @IsString()
  code: string;

  @IsString()
  @Matches(/^.+\.gov\.sl$/, {
    message: 'Email domain must end with .gov.sl',
  })
  emailDomain: string;

  // No GPS tolerance here. The geofence is platform-wide and lives in
  // attendance/geofence.constants.ts: attendees must be within 100m of wherever
  // the organizer generated the QR code. Ministry.compoundMaxGpsAccuracy is in
  // the schema and the PRD but no code has ever read it, so accepting it would
  // be offering a setting that does nothing.

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => FirstAdminDto)
  firstAdmin?: FirstAdminDto;
}
