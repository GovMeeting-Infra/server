import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
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

  constructor(
    private prisma: PrismaService,
    @InjectQueue('email-queue') private emailQueue: Queue,
  ) {}

  /**
   * Queue an email, swallowing failures.
   *
   * A notification is a side effect of doing something else — assigning work,
   * publishing minutes — and Redis being unreachable must not fail that action.
   */
  private async enqueueEmail(name: string, data: any, jobId: string) {
    try {
      await this.emailQueue.add(name, data, {
        // A stable id, so the same assignment queued twice sends once.
        jobId,
        removeOnComplete: { age: 2 * 60 * 60 },
        removeOnFail: { age: 2 * 60 * 60 },
      });
    } catch (error) {
      this.logger.error(`Failed to queue ${name}`, error);
    }
  }

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

  /**
   * Tell the owner an item is theirs, in-app and by email.
   *
   * Previously this returned early whenever ownerId was null and never sent
   * mail at all, so an item assigned to someone without an account reached
   * nobody by any route. An owner recorded only as a name and email has no
   * inbox in the app, so email is the whole channel for them.
   */
  async notifyActionItemAssigned(actionItemId: string) {
    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      select: {
        id: true,
        title: true,
        ownerId: true,
        ownerEmail: true,
        owner: { select: { ministryId: true } },
      },
    });

    if (!item) return;
    if (!item.ownerId && !item.ownerEmail) return;

    if (item.ownerId) {
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

    await this.enqueueEmail(
      'send-action-item-assigned',
      { itemId: actionItemId },
      `action-item-assigned:${actionItemId}:${item.ownerId ?? item.ownerEmail}`,
    );
  }

  /** The in-app half of the due-soon reminder; the email half is the cron's. */
  async notifyActionItemDueSoon(actionItemId: string) {
    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      select: {
        id: true,
        title: true,
        dueDate: true,
        ownerId: true,
        owner: { select: { ministryId: true } },
      },
    });

    if (!item?.ownerId) return;

    await this.notify({
      userId: item.ownerId,
      ministryId: item.owner?.ministryId ?? undefined,
      type: 'ACTION_ITEM_DUE_SOON',
      title: 'Action item due soon',
      body: `"${item.title}" is due ${item.dueDate.toLocaleDateString('en-GB', {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      })}.`,
      link: '/administrative/action-items',
      entityType: 'ActionItem',
      entityId: actionItemId,
    });
  }

  /** One Monday summary per person, however many items they owe. */
  async notifyActionItemWeeklyDigest(
    userId: string,
    ministryId: string | null,
    openCount: number,
  ) {
    await this.notify({
      userId,
      ministryId: ministryId ?? (undefined as any),
      type: 'ACTION_ITEM_WEEKLY_DIGEST',
      title: 'Your open action items',
      body:
        openCount === 1
          ? 'You have 1 action item still open.'
          : `You have ${openCount} action items still open.`,
      link: '/administrative/action-items',
    });
  }

  /**
   * Tell one named person an item moved, whoever owns it.
   *
   * notifyActionItemStatusChanged only ever targets the owner, which is no use
   * when the owner is an external guest with no account — the people who need
   * telling are the ones inside the ministry watching the work.
   */
  async notifyActionItemStatusChangedFor(actionItemId: string, userId: string) {
    const [item, user] = await Promise.all([
      (this.prisma as any).actionItem.findUnique({
        where: { id: actionItemId },
        select: { title: true, status: true, ownerName: true },
      }),
      (this.prisma as any).user.findUnique({
        where: { id: userId },
        select: { ministryId: true },
      }),
    ]);

    if (!item || !user) return;

    const who = item.ownerName ? `${item.ownerName} ` : '';
    await this.notify({
      userId,
      ministryId: user.ministryId ?? (undefined as any),
      type: 'ACTION_ITEM_STATUS_CHANGED',
      title: 'Action item updated',
      body: `${who}marked "${item.title}" as ${item.status
        .replace('_', ' ')
        .toLowerCase()}.`,
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

  /**
   * Scoped to the owner, not just the id.
   *
   * These took a bare id and updated it, so any signed-in user could mark or
   * delete anyone else's notifications by guessing or reading an id. The
   * ownership test lives in the where clause rather than a separate read, so
   * there is no window between checking and writing.
   *
   * A row belonging to someone else raises the same NotFoundException as one
   * that does not exist — the distinction is not the caller's to learn.
   */
  async markAsRead(notificationId: string, userId: string) {
    const { count } = await (this.prisma as any).notification.updateMany({
      where: { id: notificationId, userId },
      data: { read: true, readAt: new Date() },
    });

    if (count === 0) {
      throw new NotFoundException('Notification not found');
    }

    return { success: true };
  }

  async markAllAsRead(userId: string) {
    return (this.prisma as any).notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    });
  }

  /** Owner-scoped, for the same reason as markAsRead. */
  async deleteNotification(notificationId: string, userId: string) {
    const { count } = await (this.prisma as any).notification.deleteMany({
      where: { id: notificationId, userId },
    });

    if (count === 0) {
      throw new NotFoundException('Notification not found');
    }

    return { success: true };
  }

  async deleteAllUserNotifications(userId: string) {
    return (this.prisma as any).notification.deleteMany({ where: { userId } });
  }
}
