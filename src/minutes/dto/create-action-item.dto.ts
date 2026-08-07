import {
  IsString,
  IsOptional,
  IsDateString,
  IsEnum,
  IsEmail,
} from 'class-validator';

export enum PointTypeEnum {
  ACTION_POINT = 'ACTION_POINT',
  AGREED = 'AGREED',
  DECISION = 'DECISION',
}

export class CreateActionItemDto {
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
