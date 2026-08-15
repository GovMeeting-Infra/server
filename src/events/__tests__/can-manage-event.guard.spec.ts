import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CanManageEventGuard } from '../guards/can-manage-event.guard';
import { ALLOW_CO_ORGANIZERS } from '../decorators/allow-co-organizers.decorator';
import { ALLOW_MINISTRY_OVERSIGHT } from '../decorators/allow-ministry-oversight.decorator';

const EVENT_ID = 'event-1';
const MINISTRY = 'ministry-health';

/** An event owned by someone, so the organizer branch cannot carry a request. */
const ORGANIZED_EVENT = {
  organizerId: 'organizer-1',
  ministryId: MINISTRY,
  coOrganizers: [{ userId: 'co-1' }],
};

function contextFor(user: any) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user, params: { eventId: EVENT_ID } }),
    }),
    getHandler: () => 'handler',
  } as any;
}

describe('CanManageEventGuard', () => {
  let guard: CanManageEventGuard;
  let reflector: Reflector;
  const prisma = {
    event: { findUnique: jest.fn().mockResolvedValue(ORGANIZED_EVENT) },
  };

  /** Which opt-in decorators the route under test carries. */
  function withMetadata(keys: string[]) {
    jest
      .spyOn(reflector, 'get')
      .mockImplementation((key: any) => (keys.includes(key) ? true : undefined));
  }

  beforeEach(() => {
    reflector = new Reflector();
    guard = new CanManageEventGuard(prisma as any, reflector);
    prisma.event.findUnique.mockResolvedValue(ORGANIZED_EVENT);
  });

  it('lets the organizer through', async () => {
    withMetadata([]);
    await expect(
      guard.canActivate(contextFor({ id: 'organizer-1', systemRole: 'STAFF' })),
    ).resolves.toBe(true);
  });

  it('refuses a co-organizer unless the route opted in', async () => {
    withMetadata([]);
    await expect(
      guard.canActivate(contextFor({ id: 'co-1', systemRole: 'STAFF' })),
    ).rejects.toThrow(ForbiddenException);

    withMetadata([ALLOW_CO_ORGANIZERS]);
    await expect(
      guard.canActivate(contextFor({ id: 'co-1', systemRole: 'STAFF' })),
    ).resolves.toBe(true);
  });

  describe('ministry oversight', () => {
    const minister = {
      id: 'minister-1',
      systemRole: 'MINISTER',
      ministryId: MINISTRY,
    };

    it('lets a minister of the same ministry read an organized event', async () => {
      withMetadata([ALLOW_MINISTRY_OVERSIGHT]);
      await expect(guard.canActivate(contextFor(minister))).resolves.toBe(true);
    });

    // The whole point of the opt-in: publish, cancel and delete share this
    // guard and must not widen along with the reads.
    it('stays off for routes that did not opt in', async () => {
      withMetadata([]);
      await expect(guard.canActivate(contextFor(minister))).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses a minister of another ministry', async () => {
      withMetadata([ALLOW_MINISTRY_OVERSIGHT]);
      await expect(
        guard.canActivate(
          contextFor({ ...minister, ministryId: 'ministry-finance' }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    // Oversight is a minister's, not every ministry-level role's.
    it('refuses a ministry admin of the same ministry', async () => {
      withMetadata([ALLOW_MINISTRY_OVERSIGHT]);
      await expect(
        guard.canActivate(
          contextFor({ ...minister, systemRole: 'MINISTRY_ADMIN' }),
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('still lets ministry roles manage an event with no organizer', async () => {
      prisma.event.findUnique.mockResolvedValue({
        ...ORGANIZED_EVENT,
        organizerId: null,
      });
      withMetadata([]);
      await expect(
        guard.canActivate(
          contextFor({ ...minister, systemRole: 'MINISTRY_ADMIN' }),
        ),
      ).resolves.toBe(true);
    });
  });

  it('lets the super admin through anywhere', async () => {
    withMetadata([]);
    await expect(
      guard.canActivate(
        contextFor({
          id: 'root',
          systemRole: 'SUPER_ADMIN',
          ministryId: 'ministry-finance',
        }),
      ),
    ).resolves.toBe(true);
  });

  it('refuses an unrelated staff member', async () => {
    withMetadata([ALLOW_CO_ORGANIZERS, ALLOW_MINISTRY_OVERSIGHT]);
    await expect(
      guard.canActivate(
        contextFor({
          id: 'someone-else',
          systemRole: 'STAFF',
          ministryId: MINISTRY,
        }),
      ),
    ).rejects.toThrow(ForbiddenException);
  });
});
