import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';

/**
 * Settings a super admin may change at runtime.
 *
 * Only values something actually reads belong here. GOVERNMENT_EMAIL_STRICT,
 * RATE_LIMIT_WINDOW_MS and RATE_LIMIT_MAX_REQUESTS sit in the .env templates and
 * are read by nothing — the rate-limit guard takes its numbers from
 * @RateLimit() metadata per route — so they are deliberately absent. Offering a
 * control that changes nothing is worse than offering none.
 */
export const SETTINGS = {
  SESSION_TIMEOUT_SECONDS: 'SESSION_TIMEOUT_SECONDS',
  GOVERNMENT_EMAIL_DOMAIN: 'GOVERNMENT_EMAIL_DOMAIN',
} as const;

export type SettingKey = (typeof SETTINGS)[keyof typeof SETTINGS];

interface SettingSpec {
  /** Environment variable used when no row exists. */
  envVar: string;
  fallback: string;
  parse: (raw: string) => string;
  describe: string;
}

const SPECS: Record<SettingKey, SettingSpec> = {
  [SETTINGS.SESSION_TIMEOUT_SECONDS]: {
    envVar: 'SESSION_INACTIVITY_TIMEOUT_SECONDS',
    fallback: '43200',
    describe: 'How long a session survives without activity, in seconds',
    parse: (raw) => {
      const n = Number(raw);
      // Five minutes to seven days. Below that people are signed out mid-form;
      // above it the inactivity limit stops being one.
      if (!Number.isInteger(n) || n < 300 || n > 604800) {
        throw new BadRequestException(
          'Session timeout must be a whole number of seconds between 300 (5 minutes) and 604800 (7 days)',
        );
      }
      return String(n);
    },
  },
  [SETTINGS.GOVERNMENT_EMAIL_DOMAIN]: {
    envVar: 'GOVERNMENT_EMAIL_DOMAIN',
    fallback: '.gov.sl',
    describe: 'Email suffix required to sign in',
    parse: (raw) => {
      // Accepts ".gov.sl" or "gov.sl" — the consumer strips the leading dot and
      // anchors the comparison itself, so both mean the same thing. Requiring
      // an internal dot rules out a single label like "sl", which would admit
      // most of the internet.
      const value = raw.trim().toLowerCase().replace(/^\./, '');
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(value)) {
        throw new BadRequestException(
          'The government email domain must look like gov.sl or .gov.sl',
        );
      }
      return `.${value}`;
    },
  },
};

@Injectable()
export class SettingsService {
  private logger = new Logger('SettingsService');

  /**
   * Cached because getSession consults the timeout on every request. Short,
   * because a super admin who changes a setting should not wonder whether it
   * took: 30 seconds is long enough to matter under load and short enough that
   * nobody reaches for a restart.
   */
  private cache = new Map<string, string>();
  private cacheExpiresAt = 0;
  private static readonly CACHE_TTL_MS = 30_000;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async get(key: SettingKey): Promise<string> {
    const spec = SPECS[key];
    await this.refreshIfStale();
    return this.cache.get(key) ?? process.env[spec.envVar] ?? spec.fallback;
  }

  async getNumber(key: SettingKey): Promise<number> {
    return Number(await this.get(key));
  }

  /** Every setting with its current value and where that value came from. */
  async getAll() {
    await this.refreshIfStale();

    return (Object.keys(SPECS) as SettingKey[]).map((key) => {
      const spec = SPECS[key];
      const override = this.cache.get(key);
      return {
        key,
        value: override ?? process.env[spec.envVar] ?? spec.fallback,
        describe: spec.describe,
        // So the page can say whether it is editing an override or showing the
        // deployed default.
        source: override
          ? 'database'
          : process.env[spec.envVar]
            ? 'environment'
            : 'default',
      };
    });
  }

  async set(
    key: SettingKey,
    rawValue: string,
    actorId: string,
    actorMinistryId?: string,
  ) {
    const spec = SPECS[key];
    if (!spec) {
      throw new BadRequestException(`Unknown setting: ${key}`);
    }

    const previous = await this.get(key);
    const value = spec.parse(rawValue);

    await (this.prisma as any).platformSetting.upsert({
      where: { key },
      create: { key, value, updatedById: actorId },
      update: { value, updatedById: actorId },
    });

    this.invalidate();

    await this.audit.log({
      action: 'PLATFORM_SETTING_UPDATED',
      actionCategory: 'SYSTEM',
      entityType: 'PlatformSetting',
      entityId: key,
      entityName: key,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description: `Changed ${key} from ${previous} to ${value}`,
      changes: { from: previous, to: value },
    });

    return { key, value };
  }

  /** Drops the cache so the next read hits the database. */
  invalidate(): void {
    this.cacheExpiresAt = 0;
  }

  private async refreshIfStale(): Promise<void> {
    if (Date.now() < this.cacheExpiresAt) {
      return;
    }

    try {
      const rows = await (this.prisma as any).platformSetting.findMany();
      this.cache = new Map(
        rows.map((r: { key: string; value: string }) => [r.key, r.value]),
      );
      this.cacheExpiresAt = Date.now() + SettingsService.CACHE_TTL_MS;
    } catch (error) {
      // A settings table that cannot be read must not take authentication with
      // it: callers fall back to the environment, which is what they used
      // before this existed. Retried on the next call rather than cached.
      this.logger.error('Could not read platform settings:', error);
    }
  }
}
