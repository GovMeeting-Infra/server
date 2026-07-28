import { IsOptional, IsNumber, IsBoolean, Min, Max } from 'class-validator';

/**
 * Body for generating a check-in code. The coordinates are the organizer's own
 * device location and become the centre of the check-in area.
 */
export class GenerateCheckInCodeDto {
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

  /**
   * Re-capture the check-in area from this request's coordinates. Without it a
   * request that carries coordinates for an already-anchored event is ignored,
   * so the fence cannot drift as tokens rotate.
   */
  @IsOptional()
  @IsBoolean()
  resetAnchor?: boolean;

  /** Mint a fresh token even though the current one is still valid. */
  @IsOptional()
  @IsBoolean()
  rotate?: boolean;
}
