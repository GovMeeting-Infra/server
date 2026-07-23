import { IsString, IsOptional, IsDateString, IsBoolean, IsNumber, IsEnum } from 'class-validator';

export enum EventTypeEnum {
  MEETING = 'MEETING',
  CONFERENCE = 'CONFERENCE',
  APPOINTMENT = 'APPOINTMENT',
  TRAINING = 'TRAINING',
  WORKSHOP = 'WORKSHOP',
  LAUNCH = 'LAUNCH',
  OTHER = 'OTHER',
}

export enum EventScopeEnum {
  OFFICIAL = 'OFFICIAL',
  TEAM = 'TEAM',
}

export enum EventClassificationEnum {
  PUBLIC = 'PUBLIC',
  RESTRICTED = 'RESTRICTED',
}

export class CreateEventDto {
  @IsString()
  title: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsBoolean()
  isPublic: boolean;

  @IsOptional()
  @IsEnum(EventTypeEnum)
  type?: EventTypeEnum;

  @IsOptional()
  @IsEnum(EventScopeEnum)
  scope?: EventScopeEnum;

  @IsOptional()
  @IsEnum(EventClassificationEnum)
  classification?: EventClassificationEnum;

  @IsDateString()
  startAt: string;

  @IsDateString()
  endAt: string;

  @IsOptional()
  @IsString()
  venueName?: string;

  @IsOptional()
  @IsNumber()
  venueLat?: number;

  @IsOptional()
  @IsNumber()
  venueLng?: number;

  @IsOptional()
  @IsNumber()
  geofenceRadius?: number;

  @IsOptional()
  @IsString()
  roomId?: string;

  @IsOptional()
  @IsString()
  colorCategory?: string;
}
