import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from './notifications.service';
import {
  actionItemAssignedEmail,
  actionItemDigestEmail,
  actionItemReminderEmail,
  meetingInvitationEmail,
  meetingReminderEmail,
  minutesPublishedEmail,
} from '../mail/templates';

interface MeetingInvitationPayload {
  eventId: string;
  /** Null for an external invitee, who has no account and no preferences. */
  userId: string | null;
  email: string;
  name: string;
  /** Null when the attendee row carries no RSVP token to build a link from. */
  rsvpUrl: string | null;
}

interface ActionItemReminderPayload {
  itemId: string;
}

interface ActionItemAssignedPayload {
  itemId: string;
}

interface ActionItemDigestPayload {
  /** Null for an owner with no account, who is reached by email alone. */
  userId: string | null;
  email: string;
  name: string;
  items: { title: string; dueDate: string; eventTitle: string | null }[];
}

interface MeetingReminderPayload {
  eventId: string;
  userId: string;
}

interface MinutesPublishedPayload {
  eventId: string;
  /** Null for a guest, who has no account and no session to open a page with. */
  userId: string | null;
  email: string;
  name: string;
  /** Only set for guests — staff get the in-app URL instead. */
  guestLink: string | null;
}

@Processor('email-queue')
export class EmailProcessor extends WorkerHost {
  private logger = new Logger('EmailProcessor');

  constructor(
    private prisma: PrismaService,
    private mail: MailService,
    private notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job<any>) {
    switch (job.name) {
      case 'send-meeting-invitation':
        return this.sendMeetingInvitation(job);
      case 'send-action-item-assigned':
        return this.sendActionItemAssigned(job);
      case 'send-action-item-reminder':
        return this.sendActionItemReminder(job);
      case 'send-action-item-digest':
        return this.sendActionItemDigest(job);
      case 'send-meeting-reminder':
        return this.sendMeetingReminder(job);
      case 'send-minutes-published':
        return this.sendMinutesPublished(job);
      default:
        throw new Error(`Unknown job type: ${job.name}`);
    }
  }

  /**
   * The invitation, to one attendee.
   *
   * This used to take a list of userIds, loop them and only call logger.log —
   * nothing was ever sent, and nothing enqueued the job in the first place. It
   * is now one job per recipient, prepared by EventsService, for the same
   * reasons as published minutes: a single bad address cannot cost everyone
   * else their invitation, and BullMQ retries only the one that failed.
   *
   * External invitees have no account, so they are reached by email alone —
   * they carry no preference row and no in-app inbox, and skipping them was
   * why a guest invited to a meeting was never told about it.
   */
  private async sendMeetingInvitation(job: Job<MeetingInvitationPayload>) {
    const { eventId, userId, email, name, rsvpUrl } = job.data;

    try {
      const event = await (this.prisma as any).event.findUnique({
        where: { id: eventId },
        include: { ministry: true, organizer: true },
      });

      if (!event) {
        this.logger.warn(`Event ${eventId} not found for invitation`);
        return { sent: 0, error: 'Event not found' };
      }

      // A cancelled event should not still be inviting people. The job may
      // have been queued before it was called off.
      if (event.status === 'CANCELLED') {
        return { sent: 0, error: 'Event cancelled' };
      }

      // Preferences only exist for people with accounts; a guest cannot have
      // muted anything. The in-app copy is raised by EventsService and applies
      // its own check, so muting email does not mute the inbox.
      if (
        userId &&
        !(await this.notifications.wantsEmail(userId, 'MEETING_INVITATION'))
      ) {
        return { sent: 0, error: 'Muted by preference' };
      }

      const result = await this.mail.send(
        email,
        meetingInvitationEmail({
          name,
          eventTitle: event.title,
          startAt: event.startAt,
          endAt: event.endAt,
          venueName: event.venueName,
          ministryName: event.ministry?.name ?? null,
          organizerName: event.organizer?.name ?? null,
          rsvpUrl,
        }),
      );

      return result.sent ? { sent: 1 } : { sent: 0, error: result.error };
    } catch (error) {
      this.logger.error('Error sending meeting invitation', error);
      throw error;
    }
  }

  /**
   * Assignment email. Reaches an owner with no account too, which is the whole
   * reason it exists — for them, email is the only channel there is.
   */
  private async sendActionItemAssigned(job: Job<ActionItemAssignedPayload>) {
    const { itemId } = job.data;

    try {
      const actionItem = await (this.prisma as any).actionItem.findUnique({
        where: { id: itemId },
        include: {
          owner: true,
          assignedBy: { select: { name: true } },
          minutes: { include: { event: true } },
        },
      });

      if (!actionItem) {
        this.logger.warn(`Action item ${itemId} not found for assignment`);
        return { sent: 0, error: 'Action item not found' };
      }

      const to = actionItem.owner?.email ?? actionItem.ownerEmail;
      if (!to) {
        return { sent: 0, error: 'No owner address' };
      }

      // Only consult preferences when there is an account to have them. An
      // external owner has no UserPreferences row, and running the check
      // against a missing user would mute the one channel they have.
      if (
        actionItem.owner &&
        !(await this.notifications.wantsEmail(
          actionItem.owner.id,
          'ACTION_ITEM_ASSIGNED',
        ))
      ) {
        return { sent: 0, error: 'Muted by preference' };
      }

      const result = await this.mail.send(
        to,
        actionItemAssignedEmail({
          name: actionItem.owner?.name ?? actionItem.ownerName ?? 'Colleague',
          title: actionItem.title,
          description: actionItem.description,
          dueDate: actionItem.dueDate,
          eventTitle: actionItem.minutes?.event?.title ?? null,
          assignedByName: actionItem.assignedBy?.name ?? null,
        }),
      );

      return result.sent ? { sent: 1 } : { sent: 0, error: result.error };
    } catch (error) {
      this.logger.error('Error sending action item assignment', error);
      throw error;
    }
  }

  /** The Monday summary. One message per person, prepared by the cron. */
  private async sendActionItemDigest(job: Job<ActionItemDigestPayload>) {
    const { userId, email, name, items } = job.data;

    try {
      if (items.length === 0) return { sent: 0 };

      if (
        userId &&
        !(await this.notifications.wantsEmail(
          userId,
          'ACTION_ITEM_WEEKLY_DIGEST',
        ))
      ) {
        return { sent: 0, error: 'Muted by preference' };
      }

      const result = await this.mail.send(
        email,
        actionItemDigestEmail({ name, items }),
      );

      return result.sent ? { sent: 1 } : { sent: 0, error: result.error };
    } catch (error) {
      this.logger.error('Error sending action item digest', error);
      throw error;
    }
  }

  private async sendActionItemReminder(job: Job<ActionItemReminderPayload>) {
    const { itemId } = job.data;

    try {
      const actionItem = await (this.prisma as any).actionItem.findUnique({
        where: { id: itemId },
        include: {
          owner: true,
          minutes: { include: { event: true } },
        },
      });

      if (!actionItem) {
        this.logger.warn(`Action item ${itemId} not found for reminder`);
        return { sent: 0, error: 'Action item not found' };
      }

      if (!actionItem.owner) {
        this.logger.warn(`Action item ${itemId} has no owner assigned`);
        return { sent: 0, error: 'No owner assigned' };
      }

      if (
        !(await this.notifications.wantsEmail(
          actionItem.owner.id,
          'ACTION_ITEM_ASSIGNED',
        ))
      ) {
        return { sent: 0, error: 'Muted by preference' };
      }

      // The in-app half. Written here rather than in the cron so it lands
      // only when the item genuinely reached the send stage.
      await this.notifications.notifyActionItemDueSoon(itemId);

      const result = await this.mail.send(
        actionItem.owner.email,
        actionItemReminderEmail({
          name: actionItem.owner.name,
          title: actionItem.title,
          dueDate: actionItem.dueDate,
          eventTitle: actionItem.minutes?.event?.title ?? null,
        }),
      );

      // The reminder is already marked sent by the cron before this runs, so
      // failing the job would retry an email the scheduler will not re-queue.
      // Report the outcome instead and let the logged error be the signal.
      return result.sent ? { sent: 1 } : { sent: 0, error: result.error };
    } catch (error) {
      this.logger.error('Error sending action item reminder', error);
      throw error;
    }
  }

  private async sendMeetingReminder(job: Job<MeetingReminderPayload>) {
    const { eventId, userId } = job.data;

    try {
      const [event, user] = await Promise.all([
        (this.prisma as any).event.findUnique({
          where: { id: eventId },
        }),
        (this.prisma as any).user.findUnique({
          where: { id: userId },
        }),
      ]);

      if (!event) {
        this.logger.warn(`Event ${eventId} not found for reminder`);
        return { sent: 0, error: 'Event not found' };
      }

      if (!user) {
        this.logger.warn(`User ${userId} not found for reminder`);
        return { sent: 0, error: 'User not found' };
      }

      // The in-app copy is written regardless of the email outcome and applies
      // its own preference check, so muting email does not mute the inbox.
      await this.notifications.notifyMeetingReminder(eventId, userId);

      if (!(await this.notifications.wantsEmail(userId, 'MEETING_REMINDER'))) {
        return { sent: 0, error: 'Muted by preference' };
      }

      const result = await this.mail.send(
        user.email,
        meetingReminderEmail({
          name: user.name,
          eventTitle: event.title,
          startAt: event.startAt,
          venueName: event.venueName,
        }),
      );

      return result.sent ? { sent: 1 } : { sent: 0, error: result.error };
    } catch (error) {
      this.logger.error('Error sending meeting reminder', error);
      throw error;
    }
  }

  /**
   * The published record, to one recipient.
   *
   * This used to loop attendees and only call logger.log — nothing was ever
   * sent, and nothing enqueued the job in the first place. It is now one job
   * per recipient, prepared by MinutesService.distribute, so a single bad
   * address cannot cost everyone else their copy.
   */
  private async sendMinutesPublished(job: Job<MinutesPublishedPayload>) {
    const { eventId, userId, email, name, guestLink } = job.data;

    try {
      const minutes = await (this.prisma as any).minutes.findUnique({
        where: { eventId },
        select: {
          summary: true,
          event: { select: { title: true, startAt: true, id: true } },
          actionItems: {
            select: { title: true, ownerName: true, dueDate: true },
            orderBy: { dueDate: 'asc' },
          },
        },
      });

      if (!minutes) {
        return { sent: 0, error: 'Minutes not found' };
      }

      // Preferences only exist for account holders. A guest has no row, and
      // checking one would mute the only channel they have.
      if (
        userId &&
        !(await this.notifications.wantsEmail(userId, 'MINUTES_PUBLISHED'))
      ) {
        return { sent: 0, error: 'Muted by preference' };
      }

      const base =
        process.env.WEB_URL ??
        process.env.NEXT_PUBLIC_WEB_URL ??
        'http://localhost:3000';

      const result = await this.mail.send(
        email,
        minutesPublishedEmail({
          name,
          eventTitle: minutes.event.title,
          eventDate: minutes.event.startAt,
          summary: minutes.summary,
          actionItems: minutes.actionItems,
          link: guestLink ?? `${base}/administrative/events/${eventId}/minutes`,
          isGuest: !userId,
        }),
      );

      return result.sent ? { sent: 1 } : { sent: 0, error: result.error };
    } catch (error) {
      this.logger.error('Error sending minutes published notification', error);
      throw error;
    }
  }
}
