import { ReportsService } from '../reports.service';

/**
 * A ministry admin reading the reports page must not learn from a headcount
 * tile that a super admin exists. The scope filter already excludes those
 * accounts, because they hold no ministryId — but that is a property of how the
 * accounts happen to be shaped, not a rule, so this pins the rule.
 */
describe('ReportsService — usersByRole', () => {
  const ROWS = [
    { systemRole: 'SUPER_ADMIN', _count: 1 },
    { systemRole: 'PLATFORM_ADMIN', _count: 2 },
    { systemRole: 'MINISTER', _count: 1 },
    { systemRole: 'MINISTRY_ADMIN', _count: 2 },
    { systemRole: 'STAFF', _count: 5 },
  ];

  function serviceReturning(rows: any[]) {
    const prisma: any = {
      user: {
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue(rows),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    return new ReportsService(prisma, {
      get: jest.fn(),
      set: jest.fn(),
    } as any);
  }

  const stats = (scope: Record<string, unknown>, role: string) =>
    (serviceReturning(ROWS) as any).getUserStats(scope, role);

  it('hides the ministry-less roles from a ministry-scoped viewer', async () => {
    // Even when the query hands them back — which it would if one of those
    // accounts were ever given a ministry.
    const result = await stats({ ministryId: 'min-moh' }, 'MINISTRY_ADMIN');

    expect(result.usersByRole.map((r: any) => r.role)).toEqual([
      'MINISTER',
      'MINISTRY_ADMIN',
      'STAFF',
    ]);
  });

  it('shows every role to the owner', async () => {
    const result = await stats({}, 'SUPER_ADMIN');
    const roles = result.usersByRole.map((r: any) => r.role);

    expect(roles).toContain('SUPER_ADMIN');
    expect(roles).toContain('PLATFORM_ADMIN');
  });

  it('hides them from a platform admin, whose scope is empty too', async () => {
    // The trap this closes: keying the filter on an empty scope would have put
    // a "Super Admin: 1" tile in front of the one role that must not see it.
    const result = await stats({}, 'PLATFORM_ADMIN');
    const roles = result.usersByRole.map((r: any) => r.role);

    expect(roles).not.toContain('SUPER_ADMIN');
    expect(roles).not.toContain('PLATFORM_ADMIN');
    expect(roles).toEqual(['MINISTER', 'MINISTRY_ADMIN', 'STAFF']);
  });

  it('keeps the counts it does return intact', async () => {
    const result = await stats({ ministryId: 'min-moh' }, 'MINISTRY_ADMIN');

    expect(result.usersByRole).toEqual([
      { role: 'MINISTER', count: 1 },
      { role: 'MINISTRY_ADMIN', count: 2 },
      { role: 'STAFF', count: 5 },
    ]);
  });
});

/**
 * The dashboard's "Active users" tile has to agree with the Users page, whose
 * Active status means: not deactivated, not erased, a password set, and not
 * currently locked. It showed the signed-in-this-month figure instead, which an
 * administrator reasonably read as wrong.
 */
describe('ReportsService — activeAccounts', () => {
  it('counts what the Users page calls Active, separately from recent sign-ins', async () => {
    const count = jest
      .fn()
      .mockResolvedValueOnce(40) // totalUsers
      .mockResolvedValueOnce(9) // activeUsers: signed in within 30 days
      .mockResolvedValueOnce(31); // activeAccounts
    const prisma: any = {
      user: {
        count,
        groupBy: jest.fn().mockResolvedValue([]),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new ReportsService(prisma, {} as any);

    const result = await (service as any).getUserStats(
      { ministryId: 'min-moh' },
      'MINISTRY_ADMIN',
    );

    expect(result).toMatchObject({
      totalUsers: 40,
      activeUsers: 9,
      activeAccounts: 31,
    });

    const where = count.mock.calls[2][0].where;
    expect(where).toMatchObject({
      ministryId: 'min-moh',
      deletedAt: null,
      active: true,
      accounts: { some: { providerId: 'credential' } },
    });
    // Not limited to recent sign-ins: that is the other figure's job.
    expect(where.lastLoginAt).toBeUndefined();
    // A current lock reads "Locked" on the Users page, so it is left out.
    expect(where.OR).toEqual([
      { lockedUntil: null },
      { lockedUntil: { lte: expect.any(Date) } },
    ]);
  });
});
