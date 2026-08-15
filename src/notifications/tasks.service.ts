import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';
import { archiveCutoff } from '../minutes/archive.policy';

/**
 * Crons carry an explicit zone. Without one @Cron runs at the given hour in
 * whatever timezone the process happens to be in, so a container change would
 * silently move when people are emailed.
 */
const CRON_TZ = 'UTC';

/**
 * Midnight today and midnight tomorrow, in UTC.
 *
 * Due dates carry no time of day — they are written from a date-only control
 * and land on midnight UTC — so anything asking "is this due today" has to
 * compare against the day, not against a rolling window from now.
 */
function todayBounds(): [Date, Date] {
  const now = new Date();
  const start = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return [start, end];
}

@Injectable()
export class TasksService {
  private logger = new Logger('TasksService');

  constructor(
    private prisma: PrismaService,
    private notifications: NotificationsService,
    @InjectQueue('email-queue') private emailQueue: Queue,
  ) {}

  @Cron('0 8 * * *', { timeZone: CRON_TZ })
  async sendActionItemReminders() {
    this.logger.log('Starting action item reminders cron job...');

    try {
      const [startOfToday, startOfTomorrow] = todayBounds();

      // Due dates are set from a date-only control, so they land on midnight
      // UTC. Matching "the next 24 hours" from an 08:00 cron therefore never
      // caught an item due *today* — today's midnight was already eight hours
      // past — and every reminder actually arrived the day before. Matching
      // the calendar day is what makes this "the morning it is due".
      const dueItems = await (this.prisma as any).actionItem.findMany({
        where: {
          dueDate: { gte: startOfToday, lt: startOfTomorrow },
          reminderSentAt: null,
          // BLOCKED belongs here: a stalled task due today is precisely the
          // one somebody needs to look at. It was excluded from reminders
          // while being included in the weekly digest.
          status: { in: ['TODO', 'IN_PROGRESS', 'BLOCKED'] },
        },
        select: { id: true },
      });

      this.logger.log(`Found ${dueItems.length} action items due today`);

      if (dueItems.length > 0) {
        // The stamp is no longer written here. It used to be set before the
        // job ran, so a Resend outage at 08:00 permanently lost that day's
        // reminders — the cron would not re-queue them and the job could not
        // retry into a stamped row. The processor stamps it after a send.
        await this.emailQueue.addBulk(
          dueItems.map((item: any) => ({
            name: 'send-action-item-reminder',
            data: { itemId: item.id },
            opts: {
              jobId: `action-item-reminder:${item.id}:${startOfToday
                .toISOString()
                .slice(0, 10)}`,
              removeOnComplete: { age: 2 * 60 * 60 },
              removeOnFail: { age: 2 * 60 * 60 },
            },
          })),
        );

        this.logger.log(`Queued ${dueItems.length} action item reminders`);
      }

      await this.sendOverdueNotices(startOfToday);
    } catch (error) {
      this.logger.error('Error in action item reminders cron', error);
    }
  }

  /**
   * Items whose deadline has passed, told once.
   *
   * Once, not daily: a notification that arrives every morning about the same
   * thing becomes wallpaper, and the item is already flagged in each Monday
   * digest for as long as it stays open. The stamp is what makes it once, so
   * it is cleared whenever the due date moves — the same rule the reminder
   * stamp follows.
   */
  private async sendOverdueNotices(startOfToday: Date) {
    const overdue = await (this.prisma as any).actionItem.findMany({
      where: {
        dueDate: { lt: startOfToday },
        overdueNotifiedAt: null,
        status: { notIn: ['COMPLETED', 'CANCELLED'] },
      },
      select: { id: true },
    });

    if (overdue.length === 0) return;

    await this.emailQueue.addBulk(
      overdue.map((item: any) => ({
        name: 'send-action-item-overdue',
        data: { itemId: item.id },
        opts: {
          jobId: `action-item-overdue:${item.id}`,
          removeOnComplete: { age: 2 * 60 * 60 },
          removeOnFail: { age: 2 * 60 * 60 },
        },
      })),
    );

    this.logger.log(`Queued ${overdue.length} overdue notices`);
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

      // One addBulk rather than a round trip per attendee. This cron runs
      // every 10 minutes across a one-hour window, so roughly six sweeps see
      // the same people — most of these adds are dedup no-ops, and each one
      // still cost a Redis command on a per-command bill.
      const jobs = upcomingEvents.flatMap((event: any) =>
        event.attendees
          .filter((a: any) => a.user)
          .map((a: any) => ({
            name: 'send-meeting-reminder',
            data: { eventId: event.id, userId: a.user.id },
            opts: {
              // A stable jobId makes the repeat sweeps no-ops: BullMQ ignores
              // an add for an id it already holds. Retaining completed jobs
              // for two hours keeps the id alive across the whole window.
              jobId: `meeting-reminder:${event.id}:${a.user.id}`,
              removeOnComplete: { age: 2 * 60 * 60 },
              removeOnFail: { age: 2 * 60 * 60 },
            },
          })),
      );

      if (jobs.length > 0) {
        await this.emailQueue.addBulk(jobs);
        this.logger.log(`Queued ${jobs.length} meeting reminders`);
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
  /**
   * Monday morning: what everyone still owes.
   *
   * One message per person rather than per item — someone carrying eight items
   * should not start the week with eight emails. Owners with no account are
   * included and reached by email alone, since there is no inbox to file an
   * in-app notification against.
   */
  @Cron('0 8 * * 1', { timeZone: CRON_TZ })
  async sendWeeklyActionItemDigest() {
    this.logger.log('Starting weekly action item digest...');

    try {
      const open = await (this.prisma as any).actionItem.findMany({
        where: {
          status: { in: ['TODO', 'IN_PROGRESS', 'BLOCKED'] },
        },
        select: {
          title: true,
          dueDate: true,
          ownerId: true,
          ownerName: true,
          ownerEmail: true,
          owner: {
            select: { id: true, name: true, email: true, ministryId: true },
          },
          minutes: { select: { event: { select: { title: true } } } },
        },
        orderBy: { dueDate: 'asc' },
      });

      // Group by account where there is one, otherwise by address. Keying on
      // the account id matters: the same person's email could differ in case
      // from what was typed on an item.
      const byRecipient = new Map<string, any>();

      for (const item of open) {
        const email = item.owner?.email ?? item.ownerEmail;
        if (!email) continue;

        const key = item.owner?.id ?? email.toLowerCase();
        if (!byRecipient.has(key)) {
          byRecipient.set(key, {
            userId: item.owner?.id ?? null,
            ministryId: item.owner?.ministryId ?? null,
            email,
            name: item.owner?.name ?? item.ownerName ?? 'Colleague',
            items: [],
          });
        }

        byRecipient.get(key).items.push({
          title: item.title,
          dueDate: item.dueDate.toISOString(),
          eventTitle: item.minutes?.event?.title ?? null,
        });
      }

      for (const [key, r] of byRecipient) {
        await this.emailQueue.add(
          'send-action-item-digest',
          { userId: r.userId, email: r.email, name: r.name, items: r.items },
          {
            // Dated, so a redeploy on the same Monday cannot send it twice.
            jobId: `action-item-digest:${key}:${new Date().toISOString().slice(0, 10)}`,
            removeOnComplete: { age: 24 * 60 * 60 },
            removeOnFail: { age: 24 * 60 * 60 },
          },
        );

        if (r.userId) {
          await this.notifications.notifyActionItemWeeklyDigest(
            r.userId,
            r.ministryId,
            r.items.length,
          );
        }
      }

      this.logger.log(`Queued ${byRecipient.size} action item digests`);
    } catch (error) {
      this.logger.error('Error in weekly action item digest cron', error);
    }
  }

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
