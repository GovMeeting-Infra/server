import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { MAX_SIGNATURE_LENGTH } from './check-in.dto';

/**
 * Correcting a check-in already on the register.
 *
 * There was no way to. A name mistyped at a desk with a queue behind it could
 * only be deleted and recorded again, which loses the arrival time and leaves
 * the audit trail reading as though somebody was removed from the meeting.
 *
 * What may be changed is who the person is; what may not is what the system
 * observed. `checkInAt`, `checkInMethod`, `withinGeofence`, `gpsAccuracy`,
 * `mockLocationFlag`, the IP and the user agent are all absent from this DTO
 * deliberately — they are the record of an event that happened at a moment,
 * not data entry, and a register that can be backdated is not evidence of
 * anything. Every field here is whitelisted by the global pipe, so anything
 * else in the body is a 400 rather than a silent write.
 *
 * The signature may be replaced, because somebody recorded at the desk can sign
 * afterwards and because one captured wrongly should be correctable. Every
 * change is written to the audit log with its before and after.
 */
export class UpdateCheckInDto {
  /** What they signed as, and what the register prints. */
  @IsOptional()
  @IsString()
  @Length(2, 120)
  signedName?: string;

  /**
   * Guest rows only. On a check-in filed against an account the name and email
   * belong to that account, and changing them here would file the attendance
   * against a different person without anybody saying so — the service refuses
   * it rather than quietly re-linking.
   */
  @IsOptional()
  @IsString()
  @Length(2, 120)
  guestName?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(255)
  guestEmail?: string;

  @IsOptional()
  @IsString()
  @Length(2, 120)
  guestTitle?: string;

  @IsOptional()
  @IsString()
  @Length(2, 160)
  guestOrganisation?: string;

  @IsOptional()
  @IsString()
  @Length(4, 40)
  guestPhone?: string;

  @IsOptional()
  @IsString()
  @MaxLength(MAX_SIGNATURE_LENGTH)
  signature?: string;
}
