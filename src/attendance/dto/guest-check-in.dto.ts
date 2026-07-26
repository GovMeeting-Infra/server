import {
  IsString,
  IsEmail,
  IsOptional,
  IsNumber,
  Length,
  MaxLength,
  Min,
  Max,
} from 'class-validator';
import { MAX_SIGNATURE_LENGTH } from './check-in.dto';

/** Check-in by someone with no account, identified by name + email. */
export class GuestCheckInDto {
  @IsString()
  @Length(2, 120)
  guestName: string;

  @IsEmail()
  @MaxLength(255)
  guestEmail: string;

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
}
