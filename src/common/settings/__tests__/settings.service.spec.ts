import { BadRequestException } from '@nestjs/common';
import { SettingsService, SETTINGS } from '../settings.service';

/**
 * The point of the fallback chain is that an empty table changes nothing: until
 * a super admin edits something, every read returns the environment value the
 * code used before this service existed.
 */
describe('SettingsService', () => {
  let prisma: any;
  let audit: any;
  let service: SettingsService;
  let rows: Array<{ key: string; value: string }>;

  beforeEach(() => {
    rows = [];
    prisma = {
      platformSetting: {
        findMany: jest.fn().mockImplementation(() => Promise.resolve(rows)),
        upsert: jest.fn().mockImplementation(({ create }: any) => {
          rows = [
            ...rows.filter((r) => r.key !== create.key),
            { key: create.key, value: create.value },
          ];
          return Promise.resolve(create);
        }),
      },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new SettingsService(prisma, audit);
    delete process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS;
    delete process.env.GOVERNMENT_EMAIL_DOMAIN;
  });

  describe('fallback', () => {
    it('uses the built-in default when there is no row and no env var', async () => {
      await expect(service.get(SETTINGS.SESSION_TIMEOUT_SECONDS)).resolves.toBe(
        '43200',
      );
    });

    it('prefers the environment over the default', async () => {
      process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS = '900';
      await expect(service.get(SETTINGS.SESSION_TIMEOUT_SECONDS)).resolves.toBe(
        '900',
      );
    });

    it('prefers a stored override over the environment', async () => {
      process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS = '900';
      await service.set(SETTINGS.SESSION_TIMEOUT_SECONDS, '1800', 'actor');

      await expect(service.get(SETTINGS.SESSION_TIMEOUT_SECONDS)).resolves.toBe(
        '1800',
      );
    });

    it('keeps serving the environment value when the table cannot be read', async () => {
      // Authentication reads this on every request; a failed query here must
      // not take sign-in down with it.
      prisma.platformSetting.findMany.mockRejectedValue(new Error('no table'));
      process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS = '900';

      await expect(service.get(SETTINGS.SESSION_TIMEOUT_SECONDS)).resolves.toBe(
        '900',
      );
    });
  });

  describe('validation', () => {
    it('rejects a timeout below five minutes', async () => {
      await expect(
        service.set(SETTINGS.SESSION_TIMEOUT_SECONDS, '60', 'actor'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a timeout beyond a week', async () => {
      await expect(
        service.set(SETTINGS.SESSION_TIMEOUT_SECONDS, '999999999', 'actor'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a single-label domain, which would admit most of the internet', async () => {
      await expect(
        service.set(SETTINGS.GOVERNMENT_EMAIL_DOMAIN, 'sl', 'actor'),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('normalises a domain given without its leading dot', async () => {
      await service.set(SETTINGS.GOVERNMENT_EMAIL_DOMAIN, 'GOV.SL', 'actor');

      await expect(service.get(SETTINGS.GOVERNMENT_EMAIL_DOMAIN)).resolves.toBe(
        '.gov.sl',
      );
    });
  });

  it('records the before and after of a change', async () => {
    process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS = '43200';
    await service.set(SETTINGS.SESSION_TIMEOUT_SECONDS, '1800', 'actor-1');

    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'PLATFORM_SETTING_UPDATED',
        changes: { from: '43200', to: '1800' },
      }),
    );
  });
});
