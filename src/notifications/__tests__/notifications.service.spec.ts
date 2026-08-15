import { NotificationsService } from '../notifications.service';

/**
 * Notifications are not opt-out-able any more, so what has to be exactly right
 * is the opposite of what it was: nobody is filtered out. The toggles that
 * used to gate this were removed from Settings rather than left as switches
 * that saved and did nothing, and the weekly summary — the one thing anyone
 * can turn off — is suppressed by address in UnsubscribeController, not here.
 */
describe('NotificationsService', () => {
  let prisma: any;
  let queue: any;
  let service: NotificationsService;
  let prefRows: any[];

  beforeEach(() => {
    prefRows = [];
    prisma = {
      userPreferences: {
        findMany: jest.fn().mockImplementation(() => prefRows),
      },
      notification: { createMany: jest.fn().mockResolvedValue({ count: 0 }) },
      event: { findUnique: jest.fn() },
      actionItem: { findUnique: jest.fn() },
    };
    // Assignment now queues an email as well as writing in-app. enqueueEmail
    // swallows failures, so without a real double the suite would pass while
    // silently exercising nothing.
    queue = { add: jest.fn().mockResolvedValue(undefined) };
    service = new NotificationsService(prisma, queue);
  });

  const prefs = (userId: string, overrides: Record<string, boolean> = {}) => ({
    userId,
    emailNotifications: true,
    minutesNotifications: true,
    actionItemNotifications: true,
    meetingReminders: true,
    ...overrides,
  });

  describe('who gets written', () => {
    it('notifies everyone passed in', async () => {
      prefRows = [prefs('u1')];
      const result = await service.notifyMany(
        [{ userId: 'u1', ministryId: 'm1' }],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      expect(result).toEqual([true]);
      expect(prisma.notification.createMany).toHaveBeenCalled();
    });

    // The toggles are gone from Settings; a stale row must not still mute
    // somebody who has no way left to unmute themselves.
    it('ignores a preference row left over from when toggles existed', async () => {
      prefRows = [
        prefs('u1', {
          minutesNotifications: false,
          emailNotifications: false,
        }),
      ];
      const result = await service.notifyMany(
        [{ userId: 'u1', ministryId: 'm1' }],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      expect(result).toEqual([true]);
    });

    // A super admin belongs to no ministry. The column was required and the
    // filter dropped anyone without one, so they received no in-app
    // notification of anything for as long as the table has existed.
    it('notifies a recipient with no ministry', async () => {
      prefRows = [];
      const result = await service.notifyMany(
        [{ userId: 'u1', ministryId: null }],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      expect(result).toEqual([true]);
      expect(prisma.notification.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({ userId: 'u1', ministryId: null })],
      });
    });

    it('writes one row per recipient in a single query', async () => {
      const result = await service.notifyMany(
        [
          { userId: 'u1', ministryId: 'm1' },
          { userId: 'u2', ministryId: 'm1' },
          { userId: 'u3', ministryId: 'm1' },
        ],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      expect(result).toEqual([true, true, true]);
      expect(prisma.notification.createMany).toHaveBeenCalledTimes(1);
      const written = prisma.notification.createMany.mock.calls[0][0].data;
      expect(written.map((d: any) => d.userId)).toEqual(['u1', 'u2', 'u3']);
    });

    it('no longer reads preferences at all', async () => {
      await service.notifyMany([{ userId: 'u1', ministryId: 'm1' }], {
        type: 'MINUTES_PUBLISHED',
        title: 't',
        body: 'b',
      });
      expect(prisma.userPreferences.findMany).not.toHaveBeenCalled();
    });

    it('does nothing for an empty recipient list', async () => {
      expect(
        await service.notifyMany([], {
          type: 'MINUTES_PUBLISHED',
          title: 't',
          body: 'b',
        }),
      ).toEqual([]);
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });
  });

  describe('failure handling', () => {
    it('never throws when the write fails, so the triggering action survives', async () => {
      prefRows = [prefs('u1')];
      prisma.notification.createMany.mockRejectedValue(new Error('db down'));
      await expect(
        service.notifyMany([{ userId: 'u1', ministryId: 'm1' }], {
          type: 'MINUTES_PUBLISHED',
          title: 't',
          body: 'b',
        }),
      ).resolves.toEqual([false]);
    });
  });

  describe('producers', () => {
    it('writes a link and entity reference for published minutes', async () => {
      prefRows = [prefs('u1')];
      prisma.event.findUnique.mockResolvedValue({
        id: 'e1',
        title: 'Cabinet',
        ministryId: 'm1',
        attendees: [{ userId: 'u1' }, { userId: null }],
      });

      await service.notifyMinutesPublished('e1');

      const written = prisma.notification.createMany.mock.calls[0][0].data;
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        userId: 'u1',
        ministryId: 'm1',
        type: 'MINUTES_PUBLISHED',
        link: '/administrative/events/e1/minutes',
        entityType: 'Event',
        entityId: 'e1',
      });
    });

    it('does nothing for an action item with no owner', async () => {
      prisma.actionItem.findUnique.mockResolvedValue({
        id: 'a1',
        title: 'x',
        ownerId: null,
        owner: null,
      });
      await service.notifyActionItemAssigned('a1');
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('does nothing when invited with an empty user list', async () => {
      await service.notifyMeetingInvitation('e1', []);
      expect(prisma.event.findUnique).not.toHaveBeenCalled();
    });
  });
});
