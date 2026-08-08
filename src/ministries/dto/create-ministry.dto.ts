import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
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

  /**
   * GPS tolerance in metres for every geofence check in this ministry.
   * Bounded: below ~10m no ordinary phone can produce a fix good enough to
   * check in, and above 1km the geofence stops meaning anything.
   */
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(1000)
  compoundMaxGpsAccuracy?: number;

  @IsOptional()
  @IsString()
  logoUrl?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => FirstAdminDto)
  firstAdmin?: FirstAdminDto;
}
