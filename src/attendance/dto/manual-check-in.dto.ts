import { IsString, Length, MaxLength } from 'class-validator';
import { MAX_SIGNATURE_LENGTH } from './check-in.dto';

/**
 * Staff-operated check-in on someone else's behalf.
 *
 * Previously the handler took an inline object literal, which the global
 * ValidationPipe cannot inspect — with no metatype it skips validation
 * entirely, so every field arrived unchecked.
 */
export class ManualCheckInDto {
  @IsString()
  @Length(1, 64)
  userId: string;

  @IsString()
  @Length(2, 120)
  signedName: string;

  @IsString()
  @MaxLength(MAX_SIGNATURE_LENGTH)
  signature: string;
}
