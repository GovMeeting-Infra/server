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
    return new ReportsService(prisma, { get: jest.fn(), set: jest.fn() } as any);
  }

  const stats = (scope: Record<string, unknown>) =>
    (serviceReturning(ROWS) as any).getUserStats(scope);

  it('hides the ministry-less roles from a ministry-scoped viewer', async () => {
    // Even when the query hands them back — which it would if one of those
    // accounts were ever given a ministry.
    const result = await stats({ ministryId: 'min-moh' });

    expect(result.usersByRole.map((r: any) => r.role)).toEqual([
      'MINISTER',
      'MINISTRY_ADMIN',
      'STAFF',
    ]);
  });

  it('shows every role to the platform-wide viewer', async () => {
    const result = await stats({});
    const roles = result.usersByRole.map((r: any) => r.role);

    expect(roles).toContain('SUPER_ADMIN');
    expect(roles).toContain('PLATFORM_ADMIN');
  });

  it('keeps the counts it does return intact', async () => {
    const result = await stats({ ministryId: 'min-moh' });

    expect(result.usersByRole).toEqual([
      { role: 'MINISTER', count: 1 },
      { role: 'MINISTRY_ADMIN', count: 2 },
      { role: 'STAFF', count: 5 },
    ]);
  });
});
