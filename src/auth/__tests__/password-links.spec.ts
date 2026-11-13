jest.mock('better-auth/crypto', () => ({
  hashPassword: jest.fn().mockResolvedValue('hashed'),
  verifyPassword: jest.fn(),
}));

import { PasswordResetService } from '../password-reset.service';
import { InvitesService } from '../../invites/invites.service';

/**
 * An invited person can set a password two ways: the invitation link, or
 * "forgot password", which also creates one. Each link is single-use, but
 * using one used to leave the other alive — so an invitation still sitting in
 * an inbox could replace a password set through a reset, without the current
 * one. Setting a password by either route now spends both.
 */
function prismaFor(userId: string) {
  return {
    account: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    verification: {
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    session: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }) },
    user: { update: jest.fn().mockResolvedValue({ id: userId }) },
  };
}

const audit = { log: jest.fn().mockResolvedValue(undefined) } as any;
const mail = { send: jest.fn() } as any;
const cache = {
  invalidateAnalyticsFor: jest.fn().mockResolvedValue(undefined),
} as any;

const deletedIdentifiers = (prisma: any) =>
  prisma.verification.deleteMany.mock.calls.map(
    (c: any[]) => c[0].where.identifier,
  );

describe('setting a password spends the other link', () => {
  it('a reset cancels an outstanding invitation', async () => {
    const prisma = prismaFor('u1');
    const service = new PasswordResetService(prisma as any, audit, mail);
    (service as any).findValid = jest.fn().mockResolvedValue({
      record: { id: 'v-reset' },
      user: { id: 'u1', email: 'a@moh.gov.sl', ministryId: 'm1', name: 'A' },
    });

    await service.reset('token', 'a-good-password');

    expect(prisma.account.create).toHaveBeenCalled();
    expect(deletedIdentifiers(prisma)).toContain('invite:u1');
  });

  it('accepting an invitation cancels an outstanding reset', async () => {
    const prisma = prismaFor('u1');
    const service = new InvitesService(prisma as any, audit, mail, cache);
    (service as any).findValid = jest.fn().mockResolvedValue({
      record: { id: 'v-invite' },
      user: { id: 'u1', email: 'a@moh.gov.sl', ministryId: 'm1', name: 'A' },
    });

    await service.setPassword('token', 'a-good-password');

    expect(deletedIdentifiers(prisma)).toContain('reset:u1');
  });
});
