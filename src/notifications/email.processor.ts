import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { NotificationsService } from './notifications.service';
import {
  actionItemReminderEmail,
  meetingReminderEmail,
} from '../mail/templates';

interface MeetingInvitationPayload {
  eventId: string;
  userIds: string[];
}

interface ActionItemReminderPayload {
  itemId: string;
}

interface MeetingReminderPayload {
  eventId: string;
  userId: string;
}

interface MinutesPublishedPayload {
  eventId: string;
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
      case 'send-action-item-reminder':
        return this.sendActionItemReminder(job);
      case 'send-meeting-reminder':
        return this.sendMeetingReminder(job);
      case 'send-minutes-published':
        return this.sendMinutesPublished(job);
      default:
        throw new Error(`Unknown job type: ${job.name}`);
    }
  }

  private async sendMeetingInvitation(job: Job<MeetingInvitationPayload>) {
    const { eventId, userIds } = job.data;

    try {
      const event = await (this.prisma as any).event.findUnique({
        where: { id: eventId },
      });

      if (!event) {
        this.logger.warn(`Event ${eventId} not found for invitation`);
        return { sent: 0, error: 'Event not found' };
      }

      const users = await (this.prisma as any).user.findMany({
        where: { id: { in: userIds } },
      });

      let sentCount = 0;

      for (const user of users) {
        try {
          this.logger.log(
            `Sending invitation to ${user.email} for event: ${event.title}`,
          );
          sentCount++;
        } catch (error) {
          this.logger.error(
            `Failed to send invitation to ${user.email}`,
            error,
          );
        }
      }

      return { sent: sentCount };
    } catch (error) {
      this.logger.error('Error sending meeting invitations', error);
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
      return result.sent
        ? { sent: 1 }
        : { sent: 0, error: result.error };
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

      return result.sent
        ? { sent: 1 }
        : { sent: 0, error: result.error };
    } catch (error) {
      this.logger.error('Error sending meeting reminder', error);
      throw error;
    }
  }

  private async sendMinutesPublished(job: Job<MinutesPublishedPayload>) {
    const { eventId } = job.data;

    try {
      const event = await (this.prisma as any).event.findUnique({
        where: { id: eventId },
        include: {
          attendees: {
            include: { user: true },
          },
        },
      });

      if (!event) {
        this.logger.warn(
          `Event ${eventId} not found for minutes published notification`,
        );
        return { sent: 0, error: 'Event not found' };
      }

      let sentCount = 0;

      for (const attendee of event.attendees) {
        if (attendee.user) {
          try {
            this.logger.log(
              `Notifying ${attendee.user.email} about published minutes for: ${event.title}`,
            );
            sentCount++;
          } catch (error) {
            this.logger.error(
              `Failed to notify ${attendee.user.email}`,
              error,
            );
          }
        }
      }

      return { sent: sentCount };
    } catch (error) {
      this.logger.error('Error sending minutes published notification', error);
      throw error;
    }
  }
}
