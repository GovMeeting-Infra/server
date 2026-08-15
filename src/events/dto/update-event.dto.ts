import {
  IsOptional,
  IsString,
  IsDateString,
  IsBoolean,
  IsNumber,
  IsEnum,
  IsEmail,
  IsUrl,
} from 'class-validator';
import {
  EventTypeEnum,
  EventScopeEnum,
  EventClassificationEnum,
} from './create-event.dto';

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
  @IsBoolean()
  allowGuestCheckIn?: boolean;

  /**
   * Refuse to mint a check-in code unless a geofence can actually be anchored.
   * Off by default: a poor fix at code-generation time used to mint an
   * ungeofenced code silently, so whether a meeting was fenced depended on the
   * organizer's handset rather than on anyone's decision.
   */
  @IsOptional()
  @IsBoolean()
  requireGeofence?: boolean;

  @IsOptional()
  @IsString()
  colorCategory?: string;

  @IsOptional()
  @IsString()
  bannerImage?: string;

  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsUrl()
  externalUrl?: string;
}
