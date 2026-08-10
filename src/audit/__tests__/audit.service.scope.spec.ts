import { AuditService } from '../audit.service';

/**
 * Who sees which ministry's activity. A super admin sees every ministry at once
 * and may narrow to one; a minister sees their own and cannot widen or move —
 * the last of those is the case worth a test, because the filter arrives on the
 * URL where anyone can edit it.
 */
describe('AuditService.list — ministry scoping', () => {
  let prisma: any;
  let service: AuditService;

  /** The `where` Prisma was actually asked for. */
  const whereUsed = () => prisma.auditLog.findMany.mock.calls[0][0].where;

  beforeEach(() => {
    prisma = {
      auditLog: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    service = new AuditService(prisma);
  });

  const superAdmin = { systemRole: 'SUPER_ADMIN', ministryId: null };
  const minister = { systemRole: 'MINISTER', ministryId: 'min-moh' };

  describe('super admin', () => {
    it('sees every ministry when none is chosen', async () => {
      await service.list(superAdmin);
      expect(whereUsed().ministryId).toBeUndefined();
    });

    it('narrows to the chosen ministry', async () => {
      await service.list(superAdmin, { ministryId: 'min-med' });
      expect(whereUsed().ministryId).toBe('min-med');
    });

    it("isolates entries that belong to no ministry with 'none'", async () => {
      // A failed sign-in for an unknown address has no ministry to file under.
      await service.list(superAdmin, { ministryId: 'none' });
      expect(whereUsed().ministryId).toBeNull();
    });

    it('reports the scope as platform-wide', async () => {
      const result = await service.list(superAdmin, { ministryId: 'min-med' });
      expect(result.scope).toBe('all');
    });
  });

  describe('minister', () => {
    it('sees only their own ministry', async () => {
      await service.list(minister);
      expect(whereUsed().ministryId).toBe('min-moh');
    });

    it('cannot read another ministry by putting it on the URL', async () => {
      await service.list(minister, { ministryId: 'min-med' });
      expect(whereUsed().ministryId).toBe('min-moh');
    });

    it("cannot reach the platform-level entries with 'none' either", async () => {
      await service.list(minister, { ministryId: 'none' });
      expect(whereUsed().ministryId).toBe('min-moh');
    });

    it('matches nothing when the minister somehow has no ministry', async () => {
      // null rather than undefined: Prisma drops an undefined filter, which
      // would quietly widen this to every ministry.
      await service.list({ systemRole: 'MINISTER', ministryId: null });
      expect(whereUsed().ministryId).toBeNull();
    });
  });

  describe('categories', () => {
    beforeEach(() => {
      prisma.auditLog.findMany.mockResolvedValue([]);
    });

    it('follows the ministry filter for a super admin', async () => {
      await service.categories(superAdmin, 'min-med');
      expect(whereUsed().ministryId).toBe('min-med');
    });

    it('stays pinned to their own ministry for a minister', async () => {
      await service.categories(minister, 'min-med');
      expect(whereUsed().ministryId).toBe('min-moh');
    });
  });
});
