import { IsInt, IsOptional, IsString } from 'class-validator';

/**
 * Keys match SETTINGS in settings.service.ts. The service validates ranges and
 * formats; this only keeps the whitelist honest, since main.ts sets
 * forbidNonWhitelisted and an unknown key should be refused rather than
 * silently stored.
 */
export class UpdateSettingsDto {
  @IsOptional()
  @IsInt()
  SESSION_TIMEOUT_SECONDS?: number;

  @IsOptional()
  @IsString()
  GOVERNMENT_EMAIL_DOMAIN?: string;
}
