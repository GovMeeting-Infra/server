import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';

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
}
