import { IsString, IsOptional, IsNumber, IsBoolean } from 'class-validator';

export class CheckInDto {
  @IsString()
  signedName: string;

  @IsString()
  signature: string;

  @IsOptional()
  @IsNumber()
  lat?: number;

  @IsOptional()
  @IsNumber()
  lng?: number;

  @IsOptional()
  @IsNumber()
  gpsAccuracy?: number;

  @IsOptional()
  @IsBoolean()
  withinGeofence?: boolean;
}
