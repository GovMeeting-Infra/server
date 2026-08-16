// better-auth ships ESM this jest setup cannot parse, and MeService imports its
// hashing helpers directly. The doubles below are what the tests assert against.
jest.mock('better-auth/crypto', () => ({
  hashPassword: jest.fn().mockResolvedValue('new-hash'),
  verifyPassword: jest.fn(),
}));

import { UnauthorizedException } from '@nestjs/common';
import { verifyPassword } from 'better-auth/crypto';
import { MeService } from '../me.service';

/**
 * The two things a self-service account route can get quietly wrong: leaving
 * someone else's session alive after a password change, and writing personal
 * data into a log that cannot be erased.
 */
describe('MeService', () => {
  let prisma: any;
  let audit: any;
  let service: MeService;

  beforeEach(() => {
    prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({ ministryId: 'min-moh' }),
        update: jest.fn().mockImplementation(({ data }: any) => ({
          id: 'u1',
          name: 'Aminata Kamara',
          ministryId: 'min-moh',
          ...data,
        })),
      },
      account: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ id: 'acc1', password: 'old-hash' }),
        update: jest.fn().mockResolvedValue({}),
      },
      session: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new MeService(prisma, audit);
    (verifyPassword as jest.Mock).mockResolvedValue(true);
  });

  describe('changePassword — what happens to the other devices', () => {
    it('revokes every session except the one making the change', async () => {
      prisma.session.deleteMany.mockResolvedValue({ count: 2 });

      const result = await service.changePassword(
        'u1',
        { currentPassword: 'old', newPassword: 'a-long-enough-one' } as any,
        'current-token',
      );

      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', NOT: { token: 'current-token' } },
      });
      expect(result.otherSessionsSignedOut).toBe(2);
    });

    it('revokes everything when it cannot tell which session is current', async () => {
      // Better to sign someone out of their own tab than to leave a session
      // they came here to kill.
      await service.changePassword(
        'u1',
        { currentPassword: 'old', newPassword: 'a-long-enough-one' } as any,
        null,
      );

      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
      });
    });

    it('leaves sessions alone when the current password is wrong', async () => {
      (verifyPassword as jest.Mock).mockResolvedValue(false);

      await expect(
        service.changePassword(
          'u1',
          { currentPassword: 'wrong', newPassword: 'a-long-enough-one' } as any,
          'current-token',
        ),
      ).rejects.toBeInstanceOf(UnauthorizedException);

      expect(prisma.session.deleteMany).not.toHaveBeenCalled();
      expect(prisma.account.update).not.toHaveBeenCalled();
    });
  });

  describe('updateProfile — what reaches the audit log', () => {
    it('records that a phone was set without recording the number', async () => {
      await service.updateProfile('u1', { phone: '+232 76 123456' } as any);

      const { changes } = audit.log.mock.calls[0][0];
      expect(changes.phone).toBe('[set]');
      expect(JSON.stringify(changes)).not.toContain('123456');
    });

    it('distinguishes clearing a phone from setting one', async () => {
      await service.updateProfile('u1', { phone: '  ' } as any);

      expect(audit.log.mock.calls[0][0].changes.phone).toBe('[cleared]');
    });

    it('still records the fields that are safe to keep', async () => {
      await service.updateProfile('u1', {
        name: 'Aminata Kamara',
        jobTitle: 'Permanent Secretary',
      } as any);

      expect(audit.log.mock.calls[0][0].changes).toEqual({
        name: 'Aminata Kamara',
        jobTitle: 'Permanent Secretary',
      });
    });

    it('writes a blank phone to the column as null, not an empty string', async () => {
      await service.updateProfile('u1', { phone: '   ' } as any);

      expect(prisma.user.update.mock.calls[0][0].data.phone).toBeNull();
    });
  });
});
