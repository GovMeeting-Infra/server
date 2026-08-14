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

  /**
   * Who the guest is and who they came on behalf of. Required: a government
   * meeting's attendance record is a record of which organisations were in the
   * room, and "name and email" does not say that.
   *
   * Required here but nullable on the column — the desk walk-in path and staff
   * check-in do not collect them, and rows written before this existed have
   * none.
   */
  @IsString()
  @Length(2, 120)
  guestTitle: string;

  @IsString()
  @Length(2, 160)
  guestOrganisation: string;

  // Deliberately loose: phone formats vary and a government guest list is not
  // the place to argue with someone about the shape of their number. Length
  // alone keeps it sane.
  @IsString()
  @Length(4, 40)
  guestPhone: string;

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
