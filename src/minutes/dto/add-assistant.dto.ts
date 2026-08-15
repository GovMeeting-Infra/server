import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/**
 * An account id, not a name or an email.
 *
 * An owner may be an outside participant reachable only by address, but
 * helping means signing in to change something — so a helper without an
 * account could be named and could never actually help.
 */
export class AddAssistantDto {
  @ApiProperty({ description: 'The account being asked to help.' })
  @IsString()
  userId: string;
}
