// better-auth ships ESM this jest setup cannot parse; it arrives only because
// UsersService takes InvitesService in its constructor.
jest.mock('better-auth/crypto', () => ({
  hashPassword: jest.fn(),
  verifyPassword: jest.fn(),
}));

import { ForbiddenException } from '@nestjs/common';
import { UsersService } from '../users.service';

/**
 * The split the role exists for: platform admins provision, the owner appoints.
 *
 * They stand up ministries and staff them, up to and including naming a
 * ministry's minister. What they cannot do is appoint another of themselves —
 * the set of people who can reach across every ministry only grows by the
 * owner's hand, or the role would propagate itself.
 */
describe('UsersService — who may appoint whom', () => {
  let prisma: any;
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
        create: jest.fn().mockImplementation(({ data }: any) => ({ id: 'u', ...data })),
        findFirst: jest.fn().mockResolvedValue(null),
      },
      userPreferences: { create: jest.fn().mockResolvedValue({}) },
      ministry: {
        findUnique: jest
          .fn()
          .mockImplementation(({ where }: any) => (where.id === MOH.id ? MOH : null)),
      },
    };
    service = new UsersService(
      prisma,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { issue: jest.fn().mockResolvedValue({ link: 'https://x/invite' }) } as any,
      { invalidateAnalyticsFor: jest.fn() } as any,
      { get: jest.fn().mockResolvedValue('.gov.sl') } as any,
    );
  });

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      email: 'aminata@moh.gov.sl',
      name: 'Aminata Kamara',
      jobTitle: 'Director',
      systemRole: 'STAFF',
      ministryId: MOH.id,
      ...over,
    }) as any;

  const create = (d: any, role: string, ministryId?: string) =>
    service.create(d, 'actor', ministryId, role);

  describe('a platform admin', () => {
    it.each(['STAFF', 'MINISTRY_ADMIN', 'MINISTER'])(
      'can create a %s in any ministry',
      async (systemRole) => {
        await expect(
          create(dto({ systemRole }), 'PLATFORM_ADMIN'),
        ).resolves.toBeDefined();
      },
    );

    it('cannot appoint another platform admin', async () => {
      await expect(
        create(dto({ systemRole: 'PLATFORM_ADMIN' }), 'PLATFORM_ADMIN'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('cannot create the owner role', async () => {
      await expect(
        create(dto({ systemRole: 'SUPER_ADMIN' }), 'PLATFORM_ADMIN'),
      ).rejects.toThrow(ForbiddenException);
    });

    it('must name a ministry, having none of its own to default to', async () => {
      await expect(
        create(dto({ ministryId: undefined }), 'PLATFORM_ADMIN'),
      ).rejects.toThrow(/ministry/i);
    });

    it('still honours the one-minister-per-ministry rule', async () => {
      prisma.user.findFirst.mockResolvedValue({ id: 'sitting', name: 'A Minister' });

      await expect(
        create(dto({ systemRole: 'MINISTER' }), 'PLATFORM_ADMIN'),
      ).rejects.toThrow(/already the minister/i);
    });
  });

  describe('the owner appointing a platform admin', () => {
    it('can do it', async () => {
      await expect(
        create(dto({ systemRole: 'PLATFORM_ADMIN' }), 'SUPER_ADMIN'),
      ).resolves.toBeDefined();
    });

    it('files them under no ministry, whatever ministry was named', async () => {
      // The role reaches across every ministry, so belonging to one would be
      // both meaningless and — through ministryScope — quietly narrowing.
      await create(
        dto({ systemRole: 'PLATFORM_ADMIN', ministryId: MOH.id }),
        'SUPER_ADMIN',
      );

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ ministryId: null }),
        }),
      );
    });

    it('needs no ministry named at all', async () => {
      await expect(
        create(dto({ systemRole: 'PLATFORM_ADMIN', ministryId: undefined }), 'SUPER_ADMIN'),
      ).resolves.toBeDefined();
    });

    it('checks the address against the platform domain, not a ministry one', async () => {
      // moh.gov.sl would satisfy a ministry check; the point is that this
      // account has no ministry, so .gov.sl is the whole of the rule.
      await expect(
        create(
          dto({ systemRole: 'PLATFORM_ADMIN', email: 'eng@example.com' }),
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(/government address/i);

      await expect(
        create(
          dto({ systemRole: 'PLATFORM_ADMIN', email: 'eng@mocti.gov.sl' }),
          'SUPER_ADMIN',
        ),
      ).resolves.toBeDefined();
    });

    it('refuses a lookalike domain', async () => {
      await expect(
        create(
          dto({ systemRole: 'PLATFORM_ADMIN', email: 'eng@evilgov.sl' }),
          'SUPER_ADMIN',
        ),
      ).rejects.toThrow(/government address/i);
    });
  });

  describe('a ministry admin', () => {
    it('cannot appoint a platform admin', async () => {
      await expect(
        create(dto({ systemRole: 'PLATFORM_ADMIN' }), 'MINISTRY_ADMIN', MOH.id),
      ).rejects.toThrow(ForbiddenException);
    });

    it('cannot appoint a minister', async () => {
      await expect(
        create(dto({ systemRole: 'MINISTER' }), 'MINISTRY_ADMIN', MOH.id),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('error messages', () => {
    it('never name the owner role', async () => {
      // Naming it in a refusal would tell a ministry admin that it exists.
      const roles = ['SUPER_ADMIN', 'PLATFORM_ADMIN', 'MINISTER'];
      const messages: string[] = [];

      for (const systemRole of roles) {
        try {
          await create(dto({ systemRole }), 'MINISTRY_ADMIN', MOH.id);
          throw new Error(`expected ${systemRole} to be refused`);
        } catch (error) {
          messages.push((error as Error).message);
        }
      }

      expect(messages).toHaveLength(3);
      for (const message of messages) {
        expect(message).not.toMatch(/super[ _-]?admin/i);
      }
    });
  });
});
