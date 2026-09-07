import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Max,
  MaxLength,
  Min,
  ArrayMaxSize,
  ArrayMinSize,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { MAX_SIGNATURE_LENGTH } from './check-in.dto';
import { IsClientId } from '../../common/validators/is-client-id.decorator';

/**
 * One attendance record captured on an organizer's device during an outage.
 *
 * This is the desk register, not self-service check-in. During an outage the
 * attendee's own phone cannot load the check-in page at all — it would have to
 * reach the same server that is unreachable — so the organizer's device becomes
 * the book everyone signs.
 */
export class OfflineAttendanceRecordDto {
  /**
   * Minted on the device, so replaying the batch cannot double-record anyone.
   * The twin unique indexes on Attendance would catch most of it; this catches
   * the rest, including two guests who happen to share an email.
   */
  @IsClientId()
  id?: string;

  @IsString()
  @Length(2, 120)
  signedName: string;

  /**
   * Optional, exactly as it is for a desk-recorded walk-in today. A register
   * kept on a tablet that will not take a signature is still a register.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SIGNATURE_LENGTH)
  signature?: string;

  /** Present for someone with an account; the server still verifies it. */
  @IsOptional()
  @IsEmail()
  email?: string;

  @IsOptional()
  @IsString()
  @Length(2, 120)
  guestName?: string;

  @IsOptional()
  @IsEmail()
  guestEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  guestTitle?: string;

  @IsOptional()
  @IsString()
  @MaxLength(160)
  guestOrganisation?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  guestPhone?: string;

  /**
   * When the person actually signed, by the device's reckoning.
   *
   * Not trusted as given — the server clamps it into the meeting it belongs to
   * — but recorded, because the difference between when someone arrived and
   * when a connection returned is the entire point of the flag.
   */
  @IsDateString()
  capturedAt: string;

  /**
   * How far the device's clock appeared to be from the server's, in
   * milliseconds. Sent so a clamped time can be explained rather than argued
   * about: a power cut resets the clock on a cheap tablet, which is exactly the
   * outage this feature exists for.
   */
  @IsOptional()
  @IsInt()
  clockSkewMs?: number;

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

export class OfflineRegisterDto {
  /**
   * Batched rather than one request per person.
   *
   * A meeting yields dozens of rows, each carrying a signature image, and
   * draining them one request at a time over a connection that has just come
   * back is slow and fails in the middle. One request also produces one
   * meaningful audit event — "this device synced 42 offline check-ins" — rather
   * than forty-two indistinguishable ones.
   *
   * The size cap is the real limit here, not the rate limiter: RateLimitGuard
   * is Redis-backed and fails open, so it cannot be relied on to bound this.
   */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => OfflineAttendanceRecordDto)
  records: OfflineAttendanceRecordDto[];

  /**
   * The device's own fix when it opened the register.
   *
   * Used only if the meeting has no anchor yet — the outage began before anyone
   * generated a code — and then subject to the same accuracy gate as a live
   * anchor. Never overwrites an anchor that already exists, so the fence cannot
   * be moved after the fact by syncing.
   */
  @IsOptional()
  @IsNumber()
  @Min(-90)
  @Max(90)
  anchorLat?: number;

  @IsOptional()
  @IsNumber()
  @Min(-180)
  @Max(180)
  anchorLng?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  anchorAccuracy?: number;

  @IsOptional()
  @IsBoolean()
  capturedOffline?: boolean;
}
