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

/**
 * How far an edit to a repeating activity reaches.
 *
 * Named applyTo rather than scope because UpdateEventDto already has a `scope`,
 * meaning OFFICIAL or TEAM. There is deliberately no ALL: retro-editing
 * occurrences that already carry signed attendance is a data-integrity problem,
 * not a convenience.
 */
export enum EditApplyTo {
  THIS = 'THIS',
  FUTURE = 'FUTURE',
}

export class UpdateEventDto {
  /**
   * Not a column — it says how far to reach, and updateEvent strips it before
   * the write. Absent means THIS, so every client that predates this field
   * keeps behaving exactly as it did.
   *
   * It has to be declared here all the same: the global pipe runs with
   * forbidNonWhitelisted, so an undeclared field is a 400 rather than a value
   * quietly ignored.
   */
  @IsOptional()
  @IsEnum(EditApplyTo)
  applyTo?: EditApplyTo;

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
