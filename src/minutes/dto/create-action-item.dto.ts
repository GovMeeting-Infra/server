import {
  IsString,
  IsOptional,
  IsDateString,
  IsEnum,
  IsEmail,
} from 'class-validator';
import { IsClientId } from '../../common/validators/is-client-id.decorator';

export enum PointTypeEnum {
  ACTION_POINT = 'ACTION_POINT',
  AGREED = 'AGREED',
  DECISION = 'DECISION',
}

export class CreateActionItemDto {
  /**
   * Optional, and only ever sent by a device replaying work it queued offline.
   *
   * An action item has no natural key — the same title, owner and due date is a
   * perfectly ordinary thing to record twice — so a retry that could not be
   * told apart from a new item would quietly triple someone's list. Letting the
   * client name the row makes the primary key answer that, using an index the
   * database already has.
   */
  @IsClientId()
  id?: string;

  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsString()
  ownerId?: string;

  @IsOptional()
  @IsString()
  ownerName?: string;

  /**
   * How to reach an owner who has no account. When it matches one, the item is
   * linked to that account instead and this becomes their address.
   */
  @IsOptional()
  @IsEmail()
  ownerEmail?: string;

  @IsDateString()
  dueDate: string;

  @IsOptional()
  @IsEnum(PointTypeEnum)
  point?: PointTypeEnum;
}
