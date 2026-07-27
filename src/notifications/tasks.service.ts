import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { archiveCutoff } from '../minutes/archive.policy';

@Injectable()
export class TasksService {
  private logger = new Logger('TasksService');

  constructor(
    private prisma: PrismaService,
    @InjectQueue('email-queue') private emailQueue: Queue,
  ) {}

  @Cron('0 8 * * *')
  async sendActionItemReminders() {
    this.logger.log('Starting action item reminders cron job...');

    try {
      const now = new Date();
      const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

      const dueItems = await (this.prisma as any).actionItem.findMany({
        where: {
          dueDate: { gte: now, lte: in24h },
          reminderSentAt: null,
          status: { in: ['TODO', 'IN_PROGRESS'] },
        },
      });

      this.logger.log(`Found ${dueItems.length} action items due in next 24 hours`);

      for (const item of dueItems) {
        await this.emailQueue.add('send-action-item-reminder', {
          itemId: item.id,
        });
      }

      if (dueItems.length > 0) {
        await (this.prisma as any).actionItem.updateMany({
          where: { id: { in: dueItems.map((i: any) => i.id) } },
          data: { reminderSentAt: now },
        });

        this.logger.log(`Queued ${dueItems.length} action item reminders`);
      }
    } catch (error) {
      this.logger.error('Error in action item reminders cron', error);
    }
  }

  @Cron('*/10 * * * *')
  async sendMeetingReminders() {
    this.logger.log('Starting meeting reminders cron job...');

    try {
      const now = new Date();
      const in1h = new Date(now.getTime() + 60 * 60 * 1000);

      const upcomingEvents = await (this.prisma as any).event.findMany({
        where: {
          startAt: { gte: now, lte: in1h },
          // Without this, drafts and cancelled meetings send reminders too.
          status: 'PUBLISHED',
        },
        include: {
          attendees: {
            // Someone who declined should not be chased. Everyone else,
            // including people who never answered, still gets the nudge.
            where: { status: { not: 'DECLINED' } },
            include: { user: true },
          },
        },
      });

      this.logger.log(
        `Found ${upcomingEvents.length} events starting in next hour`,
      );

      let queuedCount = 0;

      for (const event of upcomingEvents) {
        for (const attendee of event.attendees) {
          if (attendee.user) {
            // This cron runs every 10 minutes over a one-hour window, so the
            // same attendee matches roughly six times per meeting. A stable
            // jobId makes the repeats no-ops: BullMQ ignores an add for an id
            // it already holds. Retaining completed jobs for two hours keeps
            // the id alive across the whole window.
            await this.emailQueue.add(
              'send-meeting-reminder',
              { eventId: event.id, userId: attendee.user.id },
              {
                jobId: `meeting-reminder:${event.id}:${attendee.user.id}`,
                removeOnComplete: { age: 2 * 60 * 60 },
                removeOnFail: { age: 2 * 60 * 60 },
              },
            );
            queuedCount++;
          }
        }
      }

      if (queuedCount > 0) {
        this.logger.log(`Queued ${queuedCount} meeting reminders`);
      }
    } catch (error) {
      this.logger.error('Error in meeting reminders cron', error);
    }
  }

  /**
   * Archives published minutes once their meeting is old enough.
   *
   * Only PUBLISHED records are touched. A six-month-old draft is abandoned
   * work rather than a record, and archiving would freeze it read-only and
   * hide it from the person still meaning to finish it.
   */
  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async archiveOldMinutes() {
    this.logger.log('Starting minutes archiving cron job...');

    try {
      const cutoff = archiveCutoff();

      const result = await (this.prisma as any).minutes.updateMany({
        where: {
          status: 'PUBLISHED',
          // A record leadership deliberately restored stays out of the
          // archive; without this the job would put it straight back tonight.
          archiveExempt: false,
          event: { endAt: { lt: cutoff } },
        },
        data: { status: 'ARCHIVED', archivedAt: new Date() },
      });

      if (result.count > 0) {
        this.logger.log(
          `Archived ${result.count} minutes for meetings before ${cutoff.toISOString()}`,
        );
      }
    } catch (error) {
      this.logger.error('Error in minutes archiving cron', error);
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async cleanupOldNotifications() {
    this.logger.log('Starting notification cleanup cron job...');

    try {
      const thirtyDaysAgo = new Date(
        new Date().getTime() - 30 * 24 * 60 * 60 * 1000,
      );

      const deleted = await (this.prisma as any).notification.deleteMany({
        where: {
          createdAt: { lt: thirtyDaysAgo },
          read: true,
        },
      });

      this.logger.log(`Deleted ${deleted.count} old notifications`);
    } catch (error) {
      this.logger.error('Error in notification cleanup cron', error);
    }
  }
}
