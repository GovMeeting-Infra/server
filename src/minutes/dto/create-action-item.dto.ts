import { IsString, IsOptional, IsDateString, IsEnum } from 'class-validator';

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

  @IsDateString()
  dueDate: string;

  @IsOptional()
  @IsEnum(PointTypeEnum)
  point?: PointTypeEnum;
}
