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
  let pushQueue: any;
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
      user: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    // Assignment now queues an email as well as writing in-app. enqueueEmail
    // swallows failures, so without a real double the suite would pass while
    // silently exercising nothing.
    queue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
    };
    pushQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      addBulk: jest.fn().mockResolvedValue(undefined),
    };
    service = new NotificationsService(prisma, queue, pushQueue);
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

    // This used to assert that preferences were never read at all, which was a
    // proxy for the real rule: an in-app row is written for everyone. Push
    // reads preferences again — it is the one channel that interrupts somebody,
    // so it has to be asked for — and the proxy stopped tracking the rule. The
    // rule itself is asserted directly instead.
    it('writes in-app rows without consulting preferences', async () => {
      prefRows = [prefs('u1', { pushNotifications: false })];
      await service.notifyMany([{ userId: 'u1', ministryId: 'm1' }], {
        type: 'MINUTES_PUBLISHED',
        title: 't',
        body: 'b',
      });
      const written = prisma.notification.createMany.mock.calls[0][0].data;
      expect(written.map((d: any) => d.userId)).toEqual(['u1']);
      // ...and the push preference being off changed only the push.
      expect(pushQueue.addBulk).not.toHaveBeenCalled();
    });

    describe('push', () => {
      it('queues a push only for recipients who turned it on', async () => {
        prefRows = [
          prefs('u1', { pushNotifications: true }),
          prefs('u2', { pushNotifications: false }),
        ];
        await service.notifyMany(
          [
            { userId: 'u1', ministryId: 'm1' },
            { userId: 'u2', ministryId: 'm1' },
          ],
          { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
        );
        expect(pushQueue.addBulk).toHaveBeenCalledTimes(1);
        const queued = pushQueue.addBulk.mock.calls[0][0];
        expect(queued.map((j: any) => j.data.userId)).toEqual(['u1']);
      });

      // The master switch defaults to FALSE, unlike the others. A missing row
      // must not be read as consent: push needs the browser's permission too,
      // and nobody is subscribed until they have asked to be.
      it('does not push to someone with no preferences row', async () => {
        prefRows = [];
        await service.notifyMany([{ userId: 'u1', ministryId: 'm1' }], {
          type: 'MINUTES_PUBLISHED',
          title: 't',
          body: 'b',
        });
        expect(pushQueue.addBulk).not.toHaveBeenCalled();
      });

      // The category toggle still applies on top of the channel switch, the
      // same way it does for email.
      it('respects the category toggle even when push is on', async () => {
        prefRows = [
          prefs('u1', { pushNotifications: true, minutesNotifications: false }),
        ];
        await service.notifyMany([{ userId: 'u1', ministryId: 'm1' }], {
          type: 'MINUTES_PUBLISHED',
          title: 't',
          body: 'b',
        });
        expect(pushQueue.addBulk).not.toHaveBeenCalled();
      });

      it('collapses repeats with a stable tag and job id', async () => {
        prefRows = [prefs('u1', { pushNotifications: true })];
        await service.notifyMany([{ userId: 'u1', ministryId: 'm1' }], {
          type: 'MEETING_REMINDER',
          title: 't',
          body: 'b',
          entityId: 'e1',
        });
        const [job] = pushQueue.addBulk.mock.calls[0][0];
        expect(job.data.tag).toBe('MEETING_REMINDER:e1');
        expect(job.opts.jobId).toBe('push:MEETING_REMINDER:e1:u1');
      });

      // Redis being unreachable must not fail the thing that raised the
      // notification — the same contract the email path has.
      it('still writes in-app rows when the push queue is down', async () => {
        prefRows = [prefs('u1', { pushNotifications: true })];
        pushQueue.addBulk.mockRejectedValue(new Error('redis is gone'));
        const result = await service.notifyMany(
          [{ userId: 'u1', ministryId: 'm1' }],
          { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
        );
        expect(result).toEqual([true]);
        expect(prisma.notification.createMany).toHaveBeenCalled();
      });
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

  // Nothing told a person they had been made a co-organizer; they found out by
  // noticing an Edit button on a meeting nobody had said they were running.
  describe('notifyCoOrganizerAdded', () => {
    beforeEach(() => {
      prisma.event.findUnique.mockResolvedValue({
        title: 'Budget review',
        startAt: new Date('2026-09-18T09:00:00Z'),
        venueName: 'Room 4',
        ministryId: 'm1',
      });
      prisma.user.findMany.mockResolvedValue([
        { id: 'u2', name: 'Fatmata Sesay', email: 'fatmata@gov.sl' },
      ]);
      prisma.user.findUnique.mockResolvedValue({ name: 'Aminata Kamara' });
    });

    it('writes an in-app notification and queues an email for each new co-organizer', async () => {
      await service.notifyCoOrganizerAdded('e1', ['u2'], 'u1');

      expect(prisma.notification.createMany).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            userId: 'u2',
            type: 'COORGANIZER_ADDED',
            link: '/administrative/events/e1',
          }),
        ],
      });
      expect(queue.addBulk).toHaveBeenCalledWith([
        expect.objectContaining({
          name: 'send-coorganizer-added',
          data: {
            eventId: 'e1',
            email: 'fatmata@gov.sl',
            name: 'Fatmata Sesay',
            addedByName: 'Aminata Kamara',
          },
        }),
      ]);
    });

    it('does not tell the person who did the adding', async () => {
      await service.notifyCoOrganizerAdded('e1', ['u1'], 'u1');

      expect(prisma.event.findUnique).not.toHaveBeenCalled();
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
      expect(queue.addBulk).not.toHaveBeenCalled();
    });

    // The co-organizer is already saved by the time this runs, so a failed
    // announcement must not surface as an error on the request that saved it.
    it('does not throw when the lookup fails', async () => {
      prisma.event.findUnique.mockRejectedValue(new Error('db down'));

      await expect(
        service.notifyCoOrganizerAdded('e1', ['u2'], 'u1'),
      ).resolves.toBeUndefined();
    });
  });
});
