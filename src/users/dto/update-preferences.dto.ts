import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class UpdatePreferencesDto {
  @IsOptional()
  @IsBoolean()
  emailNotifications?: boolean;

  @IsOptional()
  @IsBoolean()
  minutesNotifications?: boolean;

  @IsOptional()
  @IsBoolean()
  meetingReminders?: boolean;

  @IsOptional()
  @IsBoolean()
  actionItemNotifications?: boolean;

  @IsOptional()
  @IsBoolean()
  compactMode?: boolean;

  /** Seconds. -1 means never expire. */
  @IsOptional()
  @IsInt()
  @Min(-1)
  @Max(86400)
  sessionTimeout?: number;

  /**
   * The guided tour version this user has finished or dismissed.
   *
   * Written by the tour itself rather than by a settings control. Bounded
   * because it is user-supplied and only ever holds something like "1".
   */
  @IsOptional()
  @IsString()
  @MaxLength(16)
  tourCompletedVersion?: string;
}
