import { ForbiddenException } from '@nestjs/common';
import { SettingsController } from '../settings.controller';

/**
 * Two of the three settings are ordinary operational knobs. The third decides
 * who may sign in at all, so a wrong value there locks every user out of every
 * ministry — including whoever would have to put it back. That one stays with
 * the owner.
 */
describe('SettingsController.update', () => {
  let settings: any;
  let controller: SettingsController;

  const OWNER = { id: 'u1', systemRole: 'SUPER_ADMIN', ministryId: null };
  const PLATFORM_ADMIN = {
    id: 'u2',
    systemRole: 'PLATFORM_ADMIN',
    ministryId: null,
  };

  beforeEach(() => {
    settings = {
      set: jest
        .fn()
        .mockImplementation((key: string, value: string) => ({ key, value })),
      getAll: jest.fn().mockResolvedValue([]),
    };
    controller = new SettingsController(settings);
  });

  it('lets a platform admin change the timeout and the support address', async () => {
    const result = await controller.update(
      { SESSION_TIMEOUT_SECONDS: 3600, SUPPORT_EMAIL: 'info@mocti.gov.sl' },
      PLATFORM_ADMIN,
    );

    expect(result.updated).toHaveLength(2);
    expect(settings.set).toHaveBeenCalledTimes(2);
  });

  it('refuses the sign-in domain from a platform admin', async () => {
    await expect(
      controller.update({ GOVERNMENT_EMAIL_DOMAIN: '.gov.sl' }, PLATFORM_ADMIN),
    ).rejects.toThrow(ForbiddenException);
  });

  it('refuses it before writing anything else in the same request', async () => {
    // Otherwise a payload carrying both would half-apply, leaving the caller to
    // guess which half landed.
    await expect(
      controller.update(
        { SESSION_TIMEOUT_SECONDS: 3600, GOVERNMENT_EMAIL_DOMAIN: 'evil.sl' },
        PLATFORM_ADMIN,
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(settings.set).not.toHaveBeenCalled();
  });

  it('lets the owner change the domain', async () => {
    await expect(
      controller.update({ GOVERNMENT_EMAIL_DOMAIN: '.gov.sl' }, OWNER),
    ).resolves.toEqual({
      updated: [{ key: 'GOVERNMENT_EMAIL_DOMAIN', value: '.gov.sl' }],
    });
  });

  it('does not name the owner role when refusing', async () => {
    const error = await controller
      .update({ GOVERNMENT_EMAIL_DOMAIN: '.gov.sl' }, PLATFORM_ADMIN)
      .catch((e: Error) => e);

    expect((error as Error).message).not.toMatch(/super[ _-]?admin/i);
  });
});
