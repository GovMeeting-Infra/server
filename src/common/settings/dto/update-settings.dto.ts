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

  /**
   * Was missing from this whitelist while being a fully implemented setting:
   * the service has held a spec and an address validator for it all along, and
   * every session response carries it to the help page. But main.ts sets
   * forbidNonWhitelisted, so a super admin who sent it got a 400 and the only
   * way to change it was a redeploy. Blank is a valid value — it sends people
   * to their ministry administrator instead.
   */
  @IsOptional()
  @IsString()
  SUPPORT_EMAIL?: string;
}
