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
  let cache: any;
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
        // No sitting minister unless a test says otherwise.
        findFirst: jest.fn().mockResolvedValue(null),
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
    cache = { invalidateAnalyticsFor: jest.fn() };
    service = new UsersService(prisma, audit, invites, cache);
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

  it('refuses to create a second SUPER_ADMIN, even for a super admin', async () => {
    // The platform has exactly one, provisioned directly against the database.
    // Nothing reachable over HTTP can mint another, including the account that
    // already holds the role.
    await expect(
      asSuperAdmin(dto({ systemRole: 'SUPER_ADMIN', email: 'root@gov.sl' })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses a MINISTER from anyone below a super admin', async () => {
    await expect(
      service.create(
        dto({ systemRole: 'MINISTER' }),
        'actor-ma',
        MOH.id,
        'MINISTRY_ADMIN',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lets a super admin appoint a MINISTER', async () => {
    await asSuperAdmin(dto({ systemRole: 'MINISTER', ministryId: MOH.id }));

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          systemRole: 'MINISTER',
          ministryId: MOH.id,
        }),
      }),
    );
  });

  it('refuses a second minister, and names the one already there', async () => {
    // The role dialog has been telling administrators this rule for a while.
    // Nothing enforced it, so a second minister could be appointed silently.
    prisma.user.findFirst.mockResolvedValue({ name: 'Fatmata Sesay' });

    await expect(
      asSuperAdmin(dto({ systemRole: 'MINISTER', ministryId: MOH.id })),
    ).rejects.toThrow(/Fatmata Sesay/);

    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('lets a minister add a ministry admin in their own ministry', async () => {
    // A minister is the super admin of their own ministry.
    await service.create(
      dto({ systemRole: 'MINISTRY_ADMIN' }),
      'actor-minister',
      MOH.id,
      'MINISTER',
    );

    expect(prisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          systemRole: 'MINISTRY_ADMIN',
          ministryId: MOH.id,
        }),
      }),
    );
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

/**
 * The audit log is the platform's whole compliance story, and it was silently
 * dropping every action a super admin took: the code passed the literal string
 * 'SYSTEM' as ministryId, no Ministry row has that id, the insert violated the
 * foreign key, and AuditService swallows failures by design so nothing ever
 * surfaced.
 */
describe('UsersService — audit entries for an actor with no ministry', () => {
  let prisma: any;
  let audit: any;
  let cache: any;
  let service: UsersService;

  beforeEach(() => {
    prisma = {
      user: {
        create: jest
          .fn()
          .mockImplementation(({ data }: any) => ({ id: 'new-user', ...data })),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      userPreferences: { create: jest.fn().mockResolvedValue({}) },
      ministry: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'min-moh',
          name: 'Ministry of Health',
          emailDomain: 'moh.gov.sl',
          active: true,
        }),
      },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    cache = { invalidateAnalyticsFor: jest.fn() };
    service = new UsersService(
      prisma,
      audit,
      { issue: jest.fn().mockResolvedValue({ link: 'x' }) } as any,
      cache,
    );
  });

  it('records ministryId as undefined, never the string SYSTEM', async () => {
    await service.create(
      {
        email: 'a@moh.gov.sl',
        name: 'A',
        jobTitle: 'J',
        systemRole: 'STAFF',
        ministryId: 'min-moh',
      },
      'actor-super',
      undefined, // a super admin has no ministry
      'SUPER_ADMIN',
    );

    const entry = audit.log.mock.calls[0][0];
    expect(entry.ministryId).toBeUndefined();
    expect(entry.ministryId).not.toBe('SYSTEM');
  });
});
