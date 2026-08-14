import {
  IsString,
  IsOptional,
  IsDateString,
  IsBoolean,
  IsNumber,
  IsEnum,
  IsArray,
  IsEmail,
  IsUrl,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ExternalAttendeeDto } from './add-attendees.dto';

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

  /**
   * Whether people without an account may check in with name, email and
   * signature. Defaults to true at the database level.
   */
  @IsOptional()
  @IsBoolean()
  allowGuestCheckIn?: boolean;

  @IsOptional()
  @IsString()
  colorCategory?: string;

  /** Banner image URL. Stored as a string; no upload pipeline here. */
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

  /** Users to attach as co-organizers at creation time. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  coOrganizerIds?: string[];

  /** Ministries invited to a public activity. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  invitedMinistryIds?: string[];

  /** Invite people as part of creation, instead of a second round trip. */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  inviteeUserIds?: string[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ExternalAttendeeDto)
  inviteeExternals?: ExternalAttendeeDto[];

  /** Super-admins only; everyone else creates within their own ministry. */
  @IsOptional()
  @IsString()
  ministryId?: string;
}
