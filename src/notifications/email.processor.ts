import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from './notifications.service';
import {
  actionItemAssignedEmail,
  actionItemCompletedEmail,
  actionItemDigestEmail,
  actionItemOverdueEmail,
  actionItemReminderEmail,
  actionItemUnassignedEmail,
  meetingChangedEmail,
  meetingInvitationEmail,
  meetingReminderEmail,
  minutesPublishedEmail,
} from '../mail/templates';
import { digestUnsubscribeUrl } from './unsubscribe.util';

interface MeetingInvitationPayload {
  eventId: string;
  /** The EventAttendee row to stamp once the email is actually delivered. */
  attendeeId: string;
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
  items: {
    title: string;
    dueDate: string;
    eventTitle: string | null;
    overdue?: boolean;
    assisting?: boolean;
  }[];
  /** Completed last week on meetings this person was invited to. */
  closed?: {
    title: string;
    ownerName: string | null;
    eventTitle: string | null;
  }[];
}

interface MeetingReminderPayload {
  eventId: string;
  userId: string;
}

/** One person, already resolved by the producer. */
interface PersonPayload {
  email: string;
  name: string;
}

interface ActionItemCompletedPayload extends PersonPayload {
  itemId: string;
}

interface ActionItemOverduePayload {
  itemId: string;
}

interface ActionItemUnassignedPayload extends PersonPayload {
  itemId: string;
  newOwnerName: string | null;
}

interface MeetingChangedPayload extends PersonPayload {
  eventId: string;
  cancelled: boolean;
  previousStartAt: string | null;
  previousVenueName: string | null;
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

/** The points of one kind, already ordered by the query, as plain text. */
function textOf(points: any[], type: string): string[] {
  return (points ?? [])
    .filter((p: any) => p.type === type)
    .map((p: any) => p.text);
}

/**
 * Concurrency and a rate limit, together.
 *
 * The worker defaulted to one job at a time, which was the platform's
 * accidental rate limiter: a distribution to every attendee drained one
 * round trip to Resend at a time. Raising concurrency alone would have run
 * straight into Resend's 10 requests per second, so the limiter is what makes
 * it safe — eight per second leaves headroom for the direct sends (invites,
 * password resets) that bypass this queue entirely.
 *
 * The two poll intervals below are about Upstash's bill, not throughput. On
 * BullMQ's defaults an idle worker costs ~1.14M Redis commands a month —
 * a BZPOPMIN and a moveToActive every 5s, plus a stalled sweep every 30s —
 * which is roughly three quarters of everything this platform sends Redis,
 * spent polling an empty queue.
 *
 * drainDelay does not delay delivery. Enqueuing writes the marker key that
 * the blocked BZPOPMIN is parked on, so a waiting worker wakes the moment a
 * job lands; the timeout only bounds how long it blocks with nothing to do.
 *
 * stalledInterval is a real trade: it sets how long a job orphaned by a
 * crashed worker waits before another picks it up, so recovery goes from 30s
 * to 5 minutes. For email that is worth the ~90% cut in idle commands.
 */
@Processor('email-queue', {
  concurrency: 5,
  limiter: { max: 8, duration: 1_000 },
  drainDelay: 30,
  stalledInterval: 300_000,
})
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
      case 'send-action-item-completed':
        return this.sendActionItemCompleted(job);
      case 'send-action-item-overdue':
        return this.sendActionItemOverdue(job);
      case 'send-action-item-unassigned':
        return this.sendActionItemUnassigned(job);
      case 'send-meeting-changed':
        return this.sendMeetingChanged(job);
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
    const { eventId, attendeeId, userId, email, name, rsvpUrl } = job.data;

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

      // Stamped on delivery, not on enqueue. A job that fails permanently
      // leaves this null, so the next sweep picks the person up again rather
      // than recording an invitation that never arrived.
      if (result.sent && attendeeId) {
        await (this.prisma as any).eventAttendee.update({
          where: { id: attendeeId },
          data: { lastInvitedAt: new Date() },
        });
      }

      return result.sent ? { sent: 1 } : { sent: 0, error: result.error };
    } catch (error) {
      this.logger.error('Error sending meeting invitation', error);
      throw error;
    }
  }

  /**
   * A task closed. One job per recipient, so a bad address costs only that
   * person their copy.
   */
  private async sendActionItemCompleted(job: Job<ActionItemCompletedPayload>) {
    const { itemId, email, name } = job.data;

    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: itemId },
      select: {
        title: true,
        owner: { select: { name: true } },
        ownerName: true,
        minutes: { select: { event: { select: { title: true } } } },
      },
    });

    if (!item) return { sent: 0, error: 'Action item not found' };

    const result = await this.mail.send(
      email,
      actionItemCompletedEmail({
        name,
        title: item.title,
        completedByName: item.owner?.name ?? item.ownerName ?? null,
        eventTitle: item.minutes?.event?.title ?? null,
      }),
    );

    if (!result.sent) throw new Error(result.error ?? 'Send failed');
    return { sent: 1 };
  }

  /**
   * A deadline passed. Resolves its own recipients — the owner and whoever
   * raised it — because both are on the row already.
   */
  private async sendActionItemOverdue(job: Job<ActionItemOverduePayload>) {
    const { itemId } = job.data;

    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: itemId },
      select: {
        title: true,
        dueDate: true,
        ownerName: true,
        ownerEmail: true,
        owner: { select: { id: true, name: true, email: true } },
        assignedBy: { select: { id: true, name: true, email: true } },
        minutes: { select: { event: { select: { title: true } } } },
      },
    });

    if (!item) return { sent: 0, error: 'Action item not found' };

    const ownerEmail = item.owner?.email ?? item.ownerEmail;
    const ownerName = item.owner?.name ?? item.ownerName ?? 'Colleague';
    const eventTitle = item.minutes?.event?.title ?? null;

    const recipients: { email: string; name: string; isOwner: boolean }[] = [];
    if (ownerEmail) {
      recipients.push({ email: ownerEmail, name: ownerName, isOwner: true });
    }
    // The raiser hears about it too — they asked for the work, and until now
    // nothing told them it had stalled.
    if (
      item.assignedBy?.email &&
      item.assignedBy.email.toLowerCase() !== ownerEmail?.toLowerCase()
    ) {
      recipients.push({
        email: item.assignedBy.email,
        name: item.assignedBy.name,
        isOwner: false,
      });
    }

    let sent = 0;
    for (const r of recipients) {
      const result = await this.mail.send(
        r.email,
        actionItemOverdueEmail({
          name: r.name,
          title: item.title,
          dueDate: item.dueDate,
          eventTitle,
          ownerName,
          isOwner: r.isOwner,
        }),
      );
      if (result.sent) sent++;
    }

    // Stamped only once somebody was actually told, so a total failure is
    // picked up by tomorrow's sweep rather than being silently written off.
    if (sent > 0) {
      await (this.prisma as any).actionItem.update({
        where: { id: itemId },
        data: { overdueNotifiedAt: new Date() },
      });
    }

    return { sent };
  }

  /** Told to the person a task was taken from. */
  private async sendActionItemUnassigned(
    job: Job<ActionItemUnassignedPayload>,
  ) {
    const { itemId, email, name, newOwnerName } = job.data;

    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: itemId },
      select: {
        title: true,
        minutes: { select: { event: { select: { title: true } } } },
      },
    });

    if (!item) return { sent: 0, error: 'Action item not found' };

    const result = await this.mail.send(
      email,
      actionItemUnassignedEmail({
        name,
        title: item.title,
        newOwnerName,
        eventTitle: item.minutes?.event?.title ?? null,
      }),
    );

    if (!result.sent) throw new Error(result.error ?? 'Send failed');
    return { sent: 1 };
  }

  /** A meeting was called off or moved. */
  private async sendMeetingChanged(job: Job<MeetingChangedPayload>) {
    const {
      eventId,
      email,
      name,
      cancelled,
      previousStartAt,
      previousVenueName,
    } = job.data;

    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: { title: true, startAt: true, venueName: true },
    });

    if (!event) return { sent: 0, error: 'Event not found' };

    const result = await this.mail.send(
      email,
      meetingChangedEmail({
        name,
        eventTitle: event.title,
        cancelled,
        startAt: event.startAt,
        previousStartAt,
        venueName: event.venueName,
        previousVenueName,
      }),
    );

    if (!result.sent) throw new Error(result.error ?? 'Send failed');
    return { sent: 1 };
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
    const { email, name, items, closed = [] } = job.data;

    try {
      // Nothing owed and nothing closed is not worth a message.
      if (items.length === 0 && closed.length === 0) return { sent: 0 };

      const result = await this.mail.send(
        email,
        actionItemDigestEmail({
          name,
          items,
          closed,
          unsubscribeUrl: digestUnsubscribeUrl(email),
        }),
        // The header Gmail and Yahoo actually read. The visible link alone is
        // not what keeps a weekly bulk send out of the spam folder.
        { listUnsubscribe: digestUnsubscribeUrl(email) },
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

      const result = await this.mail.send(
        actionItem.owner.email,
        actionItemReminderEmail({
          name: actionItem.owner.name,
          title: actionItem.title,
          dueDate: actionItem.dueDate,
          eventTitle: actionItem.minutes?.event?.title ?? null,
        }),
      );

      // Stamped here, after a send, rather than by the cron before the job
      // ran. The old order meant a Resend outage at 08:00 lost that day's
      // reminders for good: the row was already marked, so the next sweep
      // skipped it and the job had nowhere to retry into.
      if (result.sent) {
        // The in-app half, written after the send rather than before it.
        //
        // It used to run first, above mail.send. A failed send throws (see
        // below) into a queue configured with attempts: 3, and every retry
        // re-ran this line — so one Resend blip left the owner with up to three
        // identical "due today" rows for a single action item. Writing it here
        // costs the in-app notice on a total send failure, but reminderSentAt
        // is also left unstamped in that case, so tomorrow's sweep picks the
        // item up again and both halves arrive together.
        await this.notifications.notifyActionItemDueSoon(itemId);

        await (this.prisma as any).actionItem.update({
          where: { id: itemId },
          data: { reminderSentAt: new Date() },
        });
        return { sent: 1 };
      }

      // Thrown, not returned: with attempts configured this now retries, and
      // an unstamped row is picked up by tomorrow's sweep if it never lands.
      throw new Error(result.error ?? 'Reminder could not be sent');
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
          points: { orderBy: [{ type: 'asc' }, { order: 'asc' }] },
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
          decisions: textOf(minutes.points, 'DECISION'),
          nextSteps: textOf(minutes.points, 'NEXT_STEP'),
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
