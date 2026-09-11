import {
  IsEmail,
  IsOptional,
  IsString,
  Length,
  MaxLength,
} from 'class-validator';
import { MAX_SIGNATURE_LENGTH } from './check-in.dto';

/**
 * Staff-operated check-in on someone else's behalf, taken at the desk.
 *
 * It used to demand the attendee's internal user id — which nobody at a door
 * knows — and a drawn signature, which meant handing the tablet over. Then it
 * took a name and an email and nothing else, which meant a visitor recorded at
 * the desk left none of the record a visitor recorded by the QR code leaves:
 * no job title, no organisation, no number, no signature.
 *
 * Everything below is optional here and conditional in the service, because
 * whether a detail is required depends on something only the service knows —
 * whether the email belongs to an account. A colleague's title and ministry are
 * already on file, so asking an organizer to retype them at a desk with a queue
 * is friction for nothing. A visitor's are on file nowhere, and a government
 * meeting's attendance record is a record of which organisations were in the
 * room, so for them these are required. See assertGuestDetails.
 *
 * The email is required either way: it is what links the check-in to an
 * existing account, and what the (eventId, guestEmail) unique index uses to stop
 * the same guest being recorded twice.
 *
 * Previously the handler took an inline object literal, which the global
 * ValidationPipe cannot inspect — with no metatype it skips validation
 * entirely, so every field arrived unchecked.
 */
export class ManualCheckInDto {
  @IsString()
  @Length(2, 120)
  name: string;

  @IsEmail()
  @MaxLength(255)
  email: string;

  @IsOptional()
  @IsString()
  @Length(2, 120)
  guestTitle?: string;

  @IsOptional()
  @IsString()
  @Length(2, 160)
  guestOrganisation?: string;

  // Deliberately loose: phone formats vary and a government guest list is not
  // the place to argue with someone about the shape of their number.
  @IsOptional()
  @IsString()
  @Length(4, 40)
  guestPhone?: string;

  /**
   * Optional, and that is the substance of the desk path rather than an
   * oversight: an authorized organizer is vouching in person, and a record with
   * no signature says exactly that. Offered because somebody at the desk can
   * still be handed the screen, or type their name — the pad renders a typed
   * signature in italic serif so an auditor can tell the two apart.
   */
  @IsOptional()
  @IsString()
  @MaxLength(MAX_SIGNATURE_LENGTH)
  signature?: string;
}
