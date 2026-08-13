import { SearchService } from '../search.service';

/**
 * What global search is allowed to surface.
 *
 * The case worth a test is archived minutes. archive.policy.ts makes them
 * leadership-only, and MinutesService.list keeps them out of everyday listings
 * even for leadership. Search ran a near-identical text query with no status
 * filter and then returned a 200-character snippet of the body — so the content
 * was disclosed in the results themselves, without the reader ever following
 * the link that would have refused them.
 */
describe('SearchService.search', () => {
  let prisma: any;
  let service: SearchService;

  /** The `where` each model was actually queried with. */
  const whereFor = (model: string) =>
    prisma[model].findMany.mock.calls[0][0].where;

  beforeEach(() => {
    prisma = {
      event: { findMany: jest.fn().mockResolvedValue([]) },
      minutes: { findMany: jest.fn().mockResolvedValue([]) },
      room: { findMany: jest.fn().mockResolvedValue([]) },
      user: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new SearchService(prisma);
  });

  const staff = { id: 'u1', systemRole: 'STAFF', ministryId: 'min-moh' };
  const minister = { id: 'u2', systemRole: 'MINISTER', ministryId: 'min-moh' };
  const superAdmin = { id: 'u3', systemRole: 'SUPER_ADMIN' };

  describe('archived minutes', () => {
    it('excludes them for staff', async () => {
      await service.search(staff, 'budget');
      expect(whereFor('minutes').status).toEqual({ not: 'ARCHIVED' });
    });

    it('excludes them for leadership too', async () => {
      // Not an oversight: archived records stay out of everyday listings for
      // everyone. There is no status filter in the search UI to ask for them
      // with, so there is nothing to gate on.
      await service.search(minister, 'budget');
      expect(whereFor('minutes').status).toEqual({ not: 'ARCHIVED' });
    });

    it('excludes them for a super admin', async () => {
      await service.search(superAdmin, 'budget');
      expect(whereFor('minutes').status).toEqual({ not: 'ARCHIVED' });
    });
  });

  describe('ministry scoping', () => {
    it('confines a ministry user to their own records', async () => {
      await service.search(staff, 'budget');

      expect(whereFor('minutes').event).toEqual({ ministryId: 'min-moh' });
      expect(whereFor('event').ministryId).toBe('min-moh');
      expect(whereFor('room').ministryId).toBe('min-moh');
    });

    it('confines the people search to the searcher own ministry', async () => {
      // Asserted with a minister rather than staff: the people query does not
      // run at all for staff, so a scoping assertion there would pass by
      // never executing.
      await service.search(minister, 'aminata');
      expect(whereFor('user').ministryId).toBe('min-moh');
    });

    it('lets a super admin reach every ministry', async () => {
      await service.search(superAdmin, 'budget');
      expect(whereFor('event').ministryId).toBeUndefined();
    });
  });

  describe('people', () => {
    it('are not searched for staff', async () => {
      await service.search(staff, 'aminata');
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('are searched for an admin role', async () => {
      await service.search(minister, 'aminata');
      expect(prisma.user.findMany).toHaveBeenCalled();
    });
  });

  describe('short queries', () => {
    it('are refused without touching the database', async () => {
      const result = await service.search(staff, 'a');

      expect(result.tooShort).toBe(true);
      expect(prisma.event.findMany).not.toHaveBeenCalled();
      expect(prisma.minutes.findMany).not.toHaveBeenCalled();
    });

    it('treat a whitespace-only query as empty', async () => {
      const result = await service.search(staff, '   ');
      expect(result.tooShort).toBe(true);
    });
  });
});
