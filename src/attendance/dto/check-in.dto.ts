import {
  IsString,
  IsOptional,
  IsNumber,
  Length,
  MaxLength,
  Min,
  Max,
} from 'class-validator';

/**
 * Signature is a PNG data URL from a 400x150 canvas. The cap keeps it under
 * Express's default 100kB JSON body limit, which would otherwise surface as an
 * opaque 413.
 */
export const MAX_SIGNATURE_LENGTH = 200_000;

export class CheckInDto {
  @IsString()
  @Length(2, 120)
  signedName: string;

  @IsString()
  @MaxLength(MAX_SIGNATURE_LENGTH)
  signature: string;

  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  gpsAccuracy?: number;

  // No `withinGeofence`. A client asserting whether it is inside the fence is
  // the vulnerability, not a convenience — the server recomputes it. With
  // forbidNonWhitelisted the field's absence is self-enforcing: anything still
  // sending it gets a 400.
}
