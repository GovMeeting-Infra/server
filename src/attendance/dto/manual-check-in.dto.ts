import { IsEmail, IsString, Length } from 'class-validator';

/**
 * Staff-operated check-in on someone else's behalf, taken at the desk.
 *
 * Name and email only. It used to demand the attendee's internal user id —
 * which nobody at a door knows — and a drawn signature, which meant handing the
 * tablet over. The signature belongs to self-service check-in, where the person
 * signing is the person attending; here an authorized organizer is vouching,
 * and the record says so by carrying no signature at all.
 *
 * The email is required, not decoration: it is what links the check-in to an
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
  email: string;
}
