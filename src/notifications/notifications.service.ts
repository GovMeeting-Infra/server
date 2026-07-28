import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  NotificationType,
  NotificationPreferences,
  PREFERENCE_FOR,
  DEFAULT_PREFERENCES,
} from './notification-types';

export interface NotificationInput {
  userId: string;
  ministryId: string;
  type: NotificationType;
  title: string;
  body: string;
  /** In-app destination, e.g. /administrative/events/abc. */
  link?: string;
  entityType?: string;
  entityId?: string;
}

interface Recipient {
  userId: string;
  ministryId: string | null;
}

@Injectable()
export class NotificationsService {
  private logger = new Logger('NotificationsService');

  constructor(private prisma: PrismaService) {}

  // ==========================================================================
  // Preferences
  // ==========================================================================

  /**
   * Preferences for a set of users, falling back to the schema defaults where
   * no row exists. One query regardless of recipient count, because publishing
   * minutes fans out across every attendee.
   */
  private async preferencesFor(userIds: string[]) {
    const rows = await (this.prisma as any).userPreferences.findMany({
      where: { userId: { in: userIds } },
      select: {
        userId: true,
        emailNotifications: true,
        minutesNotifications: true,
        actionItemNotifications: true,
        meetingReminders: true,
      },
    });

    const byUser = new Map<string, NotificationPreferences>(
      rows.map((r: any) => [r.userId, r]),
    );

    return (userId: string) => byUser.get(userId) ?? DEFAULT_PREFERENCES;
  }

  /** Whether this user wants an in-app notification of this kind. */
  async wantsInApp(userId: string, type: NotificationType): Promise<boolean> {
    const lookup = await this.preferencesFor([userId]);
    return lookup(userId)[PREFERENCE_FOR[type]] !== false;
  }

  /**
   * Whether this user wants an email of this kind.
   *
   * Two gates: emailNotifications is the master switch for email as a channel,
   * and the category toggle applies to the subject regardless of channel.
   */
  async wantsEmail(userId: string, type: NotificationType): Promise<boolean> {
    const lookup = await this.preferencesFor([userId]);
    const prefs = lookup(userId);
    return (
      prefs.emailNotifications !== false &&
      prefs[PREFERENCE_FOR[type]] !== false
    );
  }

  // ==========================================================================
  // Raising notifications
  // ==========================================================================

  /**
   * Writes one notification, honouring the recipient's preferences.
   *
   * Never throws: a notification is a side effect of some other action, and
   * failing to record one must not roll back publishing minutes or inviting
   * someone to a meeting.
   */
  async notify(input: NotificationInput): Promise<boolean> {
    const [created] = await this.notifyMany(
      [{ userId: input.userId, ministryId: input.ministryId }],
      input,
    );
    return created;
  }

  /**
   * Writes notifications for several recipients at once.
   *
   * Returns a boolean per recipient, in order, so callers can log how many were
   * suppressed by preference rather than lost.
   */
  async notifyMany(
    recipients: Recipient[],
    payload: Omit<NotificationInput, 'userId' | 'ministryId'>,
  ): Promise<boolean[]> {
    if (recipients.length === 0) return [];

    try {
      const lookup = await this.preferencesFor(recipients.map((r) => r.userId));
      const key = PREFERENCE_FOR[payload.type];

      const wanted = recipients.filter(
        // ministryId is required by the schema; a user with none (a super-admin)
        // has no ministry inbox to file this under.
        (r) => r.ministryId && lookup(r.userId)[key] !== false,
      );

      if (wanted.length > 0) {
        await (this.prisma as any).notification.createMany({
          data: wanted.map((r) => ({
            userId: r.userId,
            ministryId: r.ministryId as string,
            type: payload.type,
            title: payload.title,
            body: payload.body,
            link: payload.link ?? null,
            entityType: payload.entityType ?? null,
            entityId: payload.entityId ?? null,
          })),
        });
      }

      const suppressed = recipients.length - wanted.length;
      if (suppressed > 0) {
        this.logger.log(
          `${payload.type}: notified ${wanted.length}, suppressed ${suppressed} by preference`,
        );
      }

      const sent = new Set(wanted.map((r) => r.userId));
      return recipients.map((r) => sent.has(r.userId));
    } catch (error) {
      this.logger.error(`Failed writing ${payload.type} notifications`, error);
      return recipients.map(() => false);
    }
  }

  // ==========================================================================
  // Producers
  // ==========================================================================

  async notifyMinutesPublished(eventId: string) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        ministryId: true,
        attendees: { select: { userId: true } },
      },
    });

    if (!event) {
      this.logger.warn(`Event ${eventId} not found for minutes notification`);
      return;
    }

    const recipients: Recipient[] = event.attendees
      .filter((a: any) => a.userId)
      .map((a: any) => ({ userId: a.userId, ministryId: event.ministryId }));

    await this.notifyMany(recipients, {
      type: 'MINUTES_PUBLISHED',
      title: 'Minutes published',
      body: `Minutes for "${event.title}" have been published.`,
      link: `/administrative/events/${eventId}/minutes`,
      entityType: 'Event',
      entityId: eventId,
    });
  }

  async notifyActionItemAssigned(actionItemId: string) {
    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      select: {
        id: true,
        title: true,
        ownerId: true,
        owner: { select: { ministryId: true } },
      },
    });

    if (!item?.ownerId) return;

    await this.notify({
      userId: item.ownerId,
      ministryId: item.owner?.ministryId ?? undefined,
      type: 'ACTION_ITEM_ASSIGNED',
      title: 'Action item assigned to you',
      body: `You have been assigned: ${item.title}`,
      link: '/administrative/action-items',
      entityType: 'ActionItem',
      entityId: actionItemId,
    });
  }

  async notifyActionItemStatusChanged(actionItemId: string, newStatus: string) {
    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      select: {
        id: true,
        title: true,
        ownerId: true,
        owner: { select: { ministryId: true } },
      },
    });

    if (!item?.ownerId) return;

    await this.notify({
      userId: item.ownerId,
      ministryId: item.owner?.ministryId ?? undefined,
      type: 'ACTION_ITEM_STATUS_CHANGED',
      title: 'Action item updated',
      body: `"${item.title}" is now ${newStatus.replace('_', ' ').toLowerCase()}.`,
      link: '/administrative/action-items',
      entityType: 'ActionItem',
      entityId: actionItemId,
    });
  }

  async notifyMeetingInvitation(eventId: string, userIds: string[]) {
    if (userIds.length === 0) return;

    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: { id: true, title: true, startAt: true, ministryId: true },
    });

    if (!event) return;

    await this.notifyMany(
      userIds.map((userId) => ({ userId, ministryId: event.ministryId })),
      {
        type: 'MEETING_INVITATION',
        title: 'You have been invited to a meeting',
        body: `${event.title} on ${new Date(event.startAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}.`,
        link: `/administrative/events/${eventId}`,
        entityType: 'Event',
        entityId: eventId,
      },
    );
  }

  async notifyMeetingReminder(eventId: string, userId: string) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: { id: true, title: true, ministryId: true },
    });

    if (!event) return;

    await this.notify({
      userId,
      ministryId: event.ministryId,
      type: 'MEETING_REMINDER',
      title: 'Meeting starting soon',
      body: `${event.title} starts within the hour.`,
      link: `/administrative/events/${eventId}`,
      entityType: 'Event',
      entityId: eventId,
    });
  }

  // ==========================================================================
  // Reading
  // ==========================================================================

  async getUserNotifications(userId: string, limit = 20, includeRead = false) {
    const where: any = { userId };
    if (!includeRead) where.read = false;

    return (this.prisma as any).notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async markAsRead(notificationId: string) {
    return (this.prisma as any).notification.update({
      where: { id: notificationId },
      data: { read: true, readAt: new Date() },
    });
  }

  async markAllAsRead(userId: string) {
    return (this.prisma as any).notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    });
  }

  async deleteNotification(notificationId: string) {
    return (this.prisma as any).notification.delete({
      where: { id: notificationId },
    });
  }

  async deleteAllUserNotifications(userId: string) {
    return (this.prisma as any).notification.deleteMany({ where: { userId } });
  }
}
