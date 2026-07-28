import { NotificationsService } from '../notifications.service';

/**
 * The Settings toggles were stored and ignored before this existed, so the
 * gating is the part that must be exactly right — a notification that ignores
 * a mute is worse than no notification at all.
 */
describe('NotificationsService', () => {
  let prisma: any;
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
    service = new NotificationsService(prisma);
  });

  const prefs = (userId: string, overrides: Record<string, boolean> = {}) => ({
    userId,
    emailNotifications: true,
    minutesNotifications: true,
    actionItemNotifications: true,
    meetingReminders: true,
    ...overrides,
  });

  describe('preference gating', () => {
    it('notifies when the category is enabled', async () => {
      prefRows = [prefs('u1')];
      const result = await service.notifyMany(
        [{ userId: 'u1', ministryId: 'm1' }],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      expect(result).toEqual([true]);
      expect(prisma.notification.createMany).toHaveBeenCalled();
    });

    it('suppresses when the matching category is muted', async () => {
      prefRows = [prefs('u1', { minutesNotifications: false })];
      const result = await service.notifyMany(
        [{ userId: 'u1', ministryId: 'm1' }],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      expect(result).toEqual([false]);
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('ignores an unrelated category being muted', async () => {
      prefRows = [prefs('u1', { meetingReminders: false })];
      const result = await service.notifyMany(
        [{ userId: 'u1', ministryId: 'm1' }],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      expect(result).toEqual([true]);
    });

    it('defaults to notifying when the user has no preferences row', async () => {
      prefRows = [];
      const result = await service.notifyMany(
        [{ userId: 'u1', ministryId: 'm1' }],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      expect(result).toEqual([true]);
    });

    it('mixes muted and unmuted recipients correctly in one fan-out', async () => {
      prefRows = [prefs('u1'), prefs('u2', { minutesNotifications: false })];
      const result = await service.notifyMany(
        [
          { userId: 'u1', ministryId: 'm1' },
          { userId: 'u2', ministryId: 'm1' },
          { userId: 'u3', ministryId: 'm1' },
        ],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      // u3 has no row, so defaults to on.
      expect(result).toEqual([true, false, true]);
      const written = prisma.notification.createMany.mock.calls[0][0].data;
      expect(written.map((d: any) => d.userId)).toEqual(['u1', 'u3']);
    });

    it('reads preferences once regardless of recipient count', async () => {
      prefRows = [prefs('u1'), prefs('u2')];
      await service.notifyMany(
        [
          { userId: 'u1', ministryId: 'm1' },
          { userId: 'u2', ministryId: 'm1' },
        ],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      expect(prisma.userPreferences.findMany).toHaveBeenCalledTimes(1);
    });

    it('skips a recipient with no ministry, since the column is required', async () => {
      prefRows = [prefs('u1')];
      const result = await service.notifyMany(
        [{ userId: 'u1', ministryId: null }],
        { type: 'MINUTES_PUBLISHED', title: 't', body: 'b' },
      );
      expect(result).toEqual([false]);
      expect(prisma.notification.createMany).not.toHaveBeenCalled();
    });

    it('does nothing for an empty recipient list', async () => {
      expect(
        await service.notifyMany([], {
          type: 'MINUTES_PUBLISHED',
          title: 't',
          body: 'b',
        }),
      ).toEqual([]);
      expect(prisma.userPreferences.findMany).not.toHaveBeenCalled();
    });
  });

  describe('category mapping', () => {
    it.each([
      ['ACTION_ITEM_ASSIGNED', 'actionItemNotifications'],
      ['ACTION_ITEM_STATUS_CHANGED', 'actionItemNotifications'],
      ['MEETING_INVITATION', 'meetingReminders'],
      ['MEETING_REMINDER', 'meetingReminders'],
      ['MINUTES_PUBLISHED', 'minutesNotifications'],
    ])('%s is governed by %s', async (type, pref) => {
      prefRows = [prefs('u1', { [pref]: false })];
      const result = await service.notifyMany(
        [{ userId: 'u1', ministryId: 'm1' }],
        { type: type as any, title: 't', body: 'b' },
      );
      expect(result).toEqual([false]);
    });
  });

  describe('wantsEmail', () => {
    it('requires both the master email switch and the category', async () => {
      prefRows = [prefs('u1')];
      await expect(service.wantsEmail('u1', 'MEETING_REMINDER')).resolves.toBe(
        true,
      );
    });

    it('is false when email is off entirely, even if the category is on', async () => {
      prefRows = [prefs('u1', { emailNotifications: false })];
      await expect(service.wantsEmail('u1', 'MEETING_REMINDER')).resolves.toBe(
        false,
      );
    });

    it('is false when the category is off, even if email is on', async () => {
      prefRows = [prefs('u1', { meetingReminders: false })];
      await expect(service.wantsEmail('u1', 'MEETING_REMINDER')).resolves.toBe(
        false,
      );
    });

    it('leaves the in-app channel unaffected by the email master switch', async () => {
      prefRows = [prefs('u1', { emailNotifications: false })];
      await expect(service.wantsInApp('u1', 'MEETING_REMINDER')).resolves.toBe(
        true,
      );
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
