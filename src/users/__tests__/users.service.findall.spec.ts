jest.mock('better-auth/crypto', () => ({
  hashPassword: jest.fn(),
  verifyPassword: jest.fn(),
}));

import { UsersService } from '../users.service';

/**
 * A user is created without a credential — they set their own password from the
 * invitation link — so the absence of that row is what "invited but not yet
 * accepted" means. The list reported them as active regardless, which told an
 * administrator someone was up and running when they could not sign in at all.
 */
describe('UsersService.findAll — invitation state', () => {
  let prisma: any;
  let service: UsersService;

  const row = (over: Record<string, unknown> = {}) => ({
    id: 'u1',
    email: 'aminata@moh.gov.sl',
    name: 'Aminata',
    jobTitle: 'Director',
    systemRole: 'STAFF',
    ministryId: 'min-moh',
    active: true,
    deletedAt: null,
    createdAt: new Date(),
    lockedUntil: null,
    accounts: [],
    ...over,
  });

  const viewer = { systemRole: 'SUPER_ADMIN', ministryId: undefined };

  beforeEach(() => {
    prisma = {
      user: { findMany: jest.fn() },
      verification: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new UsersService(
      prisma,
      { log: jest.fn() } as any,
      {} as any,
      { invalidateAnalyticsFor: jest.fn() } as any,
    );
  });

  it('reports a user with no credential as not yet accepted', async () => {
    prisma.user.findMany.mockResolvedValue([row()]);

    const [user] = await service.findAll(viewer);
    expect(user.hasCredential).toBe(false);
  });

  it('reports a user who has set a password as accepted', async () => {
    prisma.user.findMany.mockResolvedValue([row({ accounts: [{ id: 'a1' }] })]);

    const [user] = await service.findAll(viewer);
    expect(user.hasCredential).toBe(true);
  });

  it('never leaks the credential row itself', async () => {
    prisma.user.findMany.mockResolvedValue([row({ accounts: [{ id: 'a1' }] })]);

    const [user] = await service.findAll(viewer);
    expect(user).not.toHaveProperty('accounts');
  });

  it('carries the invitation expiry through, so the UI can flag a lapsed one', async () => {
    const expiresAt = new Date('2026-08-20T00:00:00Z');
    prisma.user.findMany.mockResolvedValue([row()]);
    prisma.verification.findMany.mockResolvedValue([
      { identifier: 'invite:u1', expiresAt },
    ]);

    const [user] = await service.findAll(viewer);
    expect(user.inviteExpiresAt).toEqual(expiresAt);
  });

  it('does not go looking for invitations when everyone has accepted', async () => {
    prisma.user.findMany.mockResolvedValue([row({ accounts: [{ id: 'a1' }] })]);

    await service.findAll(viewer);
    // One query for the page, and none at all when there is nothing to ask
    // about — not one per row.
    expect(prisma.verification.findMany).not.toHaveBeenCalled();
  });

  it('asks for every pending invitation in a single query', async () => {
    prisma.user.findMany.mockResolvedValue([
      row({ id: 'u1' }),
      row({ id: 'u2', email: 'b@moh.gov.sl' }),
    ]);

    await service.findAll(viewer);
    expect(prisma.verification.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.verification.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { identifier: { in: ['invite:u1', 'invite:u2'] } },
      }),
    );
  });
});
