import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

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

  /** See CreateMinistryDto — metres, and bounded for the same reasons. */
  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(1000)
  compoundMaxGpsAccuracy?: number;

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
