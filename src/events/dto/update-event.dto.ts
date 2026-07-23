import { IsOptional, IsString, IsDateString, IsBoolean, IsNumber, IsEnum } from 'class-validator';
import { EventTypeEnum, EventScopeEnum, EventClassificationEnum } from './create-event.dto';

export class UpdateEventDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean;

  @IsOptional()
  @IsEnum(EventTypeEnum)
  type?: EventTypeEnum;

  @IsOptional()
  @IsEnum(EventScopeEnum)
  scope?: EventScopeEnum;

  @IsOptional()
  @IsEnum(EventClassificationEnum)
  classification?: EventClassificationEnum;

  @IsOptional()
  @IsDateString()
  startAt?: string;

  @IsOptional()
  @IsDateString()
  endAt?: string;

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
