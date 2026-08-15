import {
  IsString,
  IsNotEmpty,
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

  /**
   * Where the meeting is held. Required since room booking was withdrawn —
   * this is now the only way to say where an event is, and an event that does
   * not say is of little use to the people invited to it.
   *
   * Required on create only. Update leaves it optional, so an existing event
   * without one can still be edited rather than being unsaveable.
   */
  @IsString()
  @IsNotEmpty({ message: 'A location is required' })
  venueName: string;

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
