import { IsBoolean, IsOptional, IsString, Matches } from 'class-validator';

export class UpdateMinistryDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  @Matches(/^.+\.gov\.sl$/, {
    message: 'Email domain must end with .gov.sl',
  })
  emailDomain?: string;

  // No GPS tolerance — see CreateMinistryDto. The geofence is platform-wide.

  @IsOptional()
  @IsString()
  logoUrl?: string;

  /**
   * Deactivating a ministry stops every one of its users signing in, which is
   * the supported alternative to deleting one: ministries own events, rooms and
   * append-only audit logs that have to be retained.
   */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
