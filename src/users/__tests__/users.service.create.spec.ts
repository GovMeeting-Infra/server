// better-auth ships ESM that this jest setup cannot parse, and it arrives here
// only because UsersService takes InvitesService in its constructor. The double
// below stands in for the real InvitesService anyway, so nothing is lost.
jest.mock('better-auth/crypto', () => ({
  hashPassword: jest.fn(),
  verifyPassword: jest.fn(),
}));

import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { UsersService } from '../users.service';

/**
 * A super admin holds no ministry of its own, and creation used to resolve the
 * target as `user.ministryId || ''` — so the only role that is supposed to
 * administer the whole platform could not create a single user. These cover the
 * resolution rules rather than the happy path alone, because every one of them
 * failed silently or with a foreign key error before.
 */
describe('UsersService.create — which ministry the user lands in', () => {
  let prisma: any;
  let audit: any;
  let invites: any;
  let service: UsersService;

  const MOH = {
    id: 'min-moh',
    name: 'Ministry of Health',
    emailDomain: 'moh.gov.sl',
    active: true,
  };

  beforeEach(() => {
    prisma = {
      user: {
        create: jest.fn().mockImplementation(({ data }: any) => ({
          id: 'new-user',
          ...data,
        })),
      },
      userPreferences: { create: jest.fn().mockResolvedValue({}) },
      ministry: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: any) =>
            where.id === MOH.id ? MOH : null,
          ),
      },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    invites = {
      issue: jest.fn().mockResolvedValue({ link: 'https://x/invite' }),
    };
    service = new UsersService(prisma, audit, invites);
  });

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      email: 'aminata@moh.gov.sl',
      name: 'Aminata Kamara',
      jobTitle: 'Director',
      systemRole: 'STAFF',
      ...over,
    }) as any;

  const asSuperAdmin = (d: any) =>
    service.create(d, 'actor-super', undefined, 'SUPER_ADMIN');

  it('places the user in the ministry a super admin picked', async () => {
    await asSuperAdmin(dto({ ministryId: MOH.id }));

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ministryId: MOH.id }),
      }),
    );
  });

  it('refuses when a super admin names no ministry', async () => {
    // The old code wrote '' here and left Prisma to fail on the foreign key.
    await expect(asSuperAdmin(dto())).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses an unknown ministry', async () => {
    await expect(
      asSuperAdmin(dto({ ministryId: 'does-not-exist' })),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses a deactivated ministry', async () => {
    prisma.ministry.findUnique.mockResolvedValue({ ...MOH, active: false });

    await expect(
      asSuperAdmin(dto({ ministryId: MOH.id })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('keeps a new SUPER_ADMIN out of every ministry', async () => {
    await asSuperAdmin(
      dto({ systemRole: 'SUPER_ADMIN', email: 'root@gov.sl' }),
    );

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ ministryId: null }),
      }),
    );
    // No ministry to check the address against, so none is looked up.
    expect(prisma.ministry.findUnique).not.toHaveBeenCalled();
  });

  describe('email domain', () => {
    it('rejects an address outside the target ministry', async () => {
      await expect(
        asSuperAdmin(dto({ ministryId: MOH.id, email: 'aminata@med.gov.sl' })),
      ).rejects.toThrow(/moh\.gov\.sl/);
    });

    it('rejects a domain that merely ends with the ministry domain', async () => {
      // "notmoh.gov.sl" ends with "moh.gov.sl" as a plain string.
      await expect(
        asSuperAdmin(dto({ ministryId: MOH.id, email: 'x@notmoh.gov.sl' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts a subdomain of the ministry domain', async () => {
      await asSuperAdmin(
        dto({ ministryId: MOH.id, email: 'x@clinic.moh.gov.sl' }),
      );

      expect(prisma.user.create).toHaveBeenCalled();
    });
  });

  describe('ministry admins', () => {
    const asMinistryAdmin = (d: any) =>
      service.create(d, 'actor-ma', MOH.id, 'MINISTRY_ADMIN');

    it('creates in their own ministry without naming it', async () => {
      await asMinistryAdmin(dto());

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ministryId: MOH.id }),
        }),
      );
    });

    it('cannot reach into another ministry', async () => {
      await expect(
        asMinistryAdmin(dto({ ministryId: 'min-other' })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.user.create).not.toHaveBeenCalled();
    });
  });
});
