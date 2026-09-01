import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { SettingsService, SETTINGS } from '../common/settings/settings.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/** Enough recent failures to spot a pattern, not enough to page through. */
const FAILED_SAMPLE = 20;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The operations console.
 *
 * Everything an engineer needs to answer "is it up, and if not what broke",
 * and nothing that would tell them what a ministry discussed. Every figure
 * here is a count, a latency, a status or a piece of configuration — no
 * titles, no names, no addresses belonging to a person.
 *
 * The health probes already exist and are unauthenticated, because a load
 * balancer has to reach them. This is the same picture assembled for a person,
 * plus the parts that have never been visible anywhere: the mail queue, the
 * failure rate, and whether the configuration is actually complete.
 *
 * One request rather than several, because the page polls: a handful of counts
 * in one round trip is cheaper than a handful of round trips, and every branch
 * degrades on its own so one broken dependency cannot blank the page.
 */
@Controller('api/v1/platform')
@UseGuards(RolesGuard)
export class PlatformController {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
    private settings: SettingsService,
    @InjectQueue('email-queue') private emailQueue: Queue,
  ) {}

  @Get('overview')
  @Roles('SUPER_ADMIN', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: 'Health, mail queue, activity and configuration' })
  async overview() {
    const since = new Date(Date.now() - DAY_MS);

    const [database, cache, queue, content, auth, activity, config] =
      await Promise.all([
        this.checkDatabase(),
        this.checkCache(),
        this.checkQueue(),
        this.contentTotals(),
        this.authHealth(since),
        this.recentActivity(since),
        this.configuration(),
      ]);

    const memory = process.memoryUsage();

    return {
      checkedAt: new Date().toISOString(),
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        nodeVersion: process.version,
        heapUsedMb: Math.round(memory.heapUsed / 1024 / 1024),
        rssMb: Math.round(memory.rss / 1024 / 1024),
      },
      database,
      cache,
      queue,
      content,
      auth,
      activity,
      config,
    };
  }

  private async checkDatabase() {
    const started = Date.now();
    try {
      await (this.prisma as any).$queryRawUnsafe('SELECT 1');
      return { status: 'up' as const, latencyMs: Date.now() - started };
    } catch (error) {
      return {
        status: 'down' as const,
        latencyMs: Date.now() - started,
        error: this.messageOf(error),
      };
    }
  }

  private async checkCache() {
    const started = Date.now();
    try {
      const ok = await this.cache.ping();
      return {
        status: ok ? ('up' as const) : ('down' as const),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return {
        status: 'down' as const,
        latencyMs: Date.now() - started,
        error: this.messageOf(error),
      };
    }
  }

  /**
   * Mail is the platform's quietest failure. One queue carries every message,
   * Resend allows ten requests a second, and publishing minutes enqueues one
   * job per recipient — so a large meeting can burst past the limit and the
   * only evidence is a rising failed count.
   *
   * Job *names* only, never job data: the payloads carry recipient addresses.
   */
  private async checkQueue() {
    try {
      const [counts, failed, waiting, paused] = await Promise.all([
        this.emailQueue.getJobCounts(
          'waiting',
          'active',
          'completed',
          'failed',
          'delayed',
        ),
        this.emailQueue.getFailed(0, FAILED_SAMPLE - 1),
        this.emailQueue.getWaiting(0, 0),
        this.emailQueue.isPaused(),
      ]);

      // Grouped, because twenty rows of the same failure is one problem and
      // reading it as twenty wastes an on-call engineer's first five minutes.
      const byKind = new Map<string, { count: number; lastReason: string }>();
      for (const job of failed) {
        const previous = byKind.get(job.name);
        byKind.set(job.name, {
          count: (previous?.count ?? 0) + 1,
          lastReason: job.failedReason ?? previous?.lastReason ?? 'unknown',
        });
      }

      // How long the front of the queue has been sitting there. A depth of
      // fifty means nothing on its own; fifty jobs where the oldest arrived an
      // hour ago means the worker is not running.
      const oldest = waiting[0]?.timestamp;

      return {
        status: 'up' as const,
        paused,
        counts,
        oldestWaitingAgeSeconds: oldest
          ? Math.round((Date.now() - oldest) / 1000)
          : null,
        recentFailures: [...byKind.entries()].map(([name, v]) => ({
          name,
          count: v.count,
          lastReason: v.lastReason,
        })),
      };
    } catch (error) {
      // A queue that cannot be read is itself the finding, and it must not take
      // the rest of the page down with it.
      return { status: 'down' as const, error: this.messageOf(error) };
    }
  }

  /** What is on the platform. Row counts, never rows. */
  private async contentTotals() {
    try {
      const p = this.prisma as any;
      const [
        ministries,
        activeMinistries,
        users,
        activeUsers,
        erasedUsers,
        events,
        upcomingEvents,
        minutes,
        publishedMinutes,
        attendance,
        actionItems,
        openActionItems,
        staffDirectory,
      ] = await Promise.all([
        p.ministry.count(),
        p.ministry.count({ where: { active: true } }),
        p.user.count({ where: { deletedAt: null } }),
        p.user.count({ where: { deletedAt: null, active: true } }),
        p.user.count({ where: { deletedAt: { not: null } } }),
        p.event.count(),
        p.event.count({ where: { startAt: { gte: new Date() } } }),
        p.minutes.count(),
        p.minutes.count({ where: { status: 'PUBLISHED' } }),
        p.attendance.count(),
        p.actionItem.count(),
        p.actionItem.count({ where: { status: { not: 'COMPLETED' } } }),
        p.staffDirectoryEntry.count(),
      ]);

      return {
        status: 'up' as const,
        ministries,
        activeMinistries,
        users,
        activeUsers,
        erasedUsers,
        events,
        upcomingEvents,
        minutes,
        publishedMinutes,
        attendance,
        actionItems,
        openActionItems,
        staffDirectory,
      };
    } catch (error) {
      return { status: 'down' as const, error: this.messageOf(error) };
    }
  }

  /**
   * Whether people can get in.
   *
   * Locked accounts and failed sign-ins are the two numbers that move together
   * when something is wrong with authentication rather than with a person — a
   * spike in both at once is a different story from one person forgetting a
   * password, and neither is visible anywhere today.
   */
  private async authHealth(since: Date) {
    try {
      const p = this.prisma as any;
      const now = new Date();
      const [activeSessions, lockedAccounts, failedSignIns, successfulSignIns] =
        await Promise.all([
          p.session.count({ where: { expiresAt: { gt: now } } }),
          p.user.count({
            where: { lockedUntil: { gt: now }, deletedAt: null },
          }),
          p.auditLog.count({
            where: { action: 'LOGIN_FAILED', createdAt: { gte: since } },
          }),
          p.auditLog.count({
            where: { action: 'LOGIN_SUCCESS', createdAt: { gte: since } },
          }),
        ]);

      return {
        status: 'up' as const,
        activeSessions,
        lockedAccounts,
        failedSignIns24h: failedSignIns,
        successfulSignIns24h: successfulSignIns,
      };
    } catch (error) {
      return { status: 'down' as const, error: this.messageOf(error) };
    }
  }

  /**
   * What the platform did in the last day, and what failed doing it.
   *
   * Grouped by action and category only. The audit rows themselves cannot be
   * shown here — entityName holds raw emails, event titles and attendee names,
   * and description concatenates them into sentences — but the *shape* of the
   * failures is exactly what an operator needs and carries none of that.
   */
  private async recentActivity(since: Date) {
    try {
      const p = this.prisma as any;
      const [byStatus, failuresByAction] = await Promise.all([
        p.auditLog.groupBy({
          by: ['status'],
          where: { createdAt: { gte: since } },
          _count: true,
        }),
        p.auditLog.groupBy({
          by: ['action', 'actionCategory'],
          where: { createdAt: { gte: since }, status: 'FAILURE' },
          _count: true,
        }),
      ]);

      const total = byStatus.reduce(
        (sum: number, r: any) => sum + r._count,
        0,
      );
      const failures =
        byStatus.find((r: any) => r.status === 'FAILURE')?._count ?? 0;

      return {
        status: 'up' as const,
        events24h: total,
        failures24h: failures,
        failureRate: total ? Math.round((failures / total) * 1000) / 10 : 0,
        failuresByAction: failuresByAction
          .map((r: any) => ({
            action: r.action,
            category: r.actionCategory,
            count: r._count,
          }))
          .sort((a: any, b: any) => b.count - a.count)
          .slice(0, 10),
      };
    } catch (error) {
      return { status: 'down' as const, error: this.messageOf(error) };
    }
  }

  /**
   * Configuration that is silently load-bearing.
   *
   * WEB_URL is the one worth the panel on its own: it is the base of every
   * emailed link — invitations, password resets, RSVP, the guest minutes
   * portal. Unset, it falls back to localhost and every link the platform
   * sends goes nowhere, with nothing failing anywhere an operator would look.
   *
   * Secrets are reported as configured or not, never echoed.
   */
  private async configuration() {
    const webUrl = process.env.WEB_URL ?? process.env.NEXT_PUBLIC_WEB_URL ?? '';

    const [sessionTimeout, governmentEmailDomain, supportEmail] =
      await Promise.all([
        this.settings.get(SETTINGS.SESSION_TIMEOUT_SECONDS),
        this.settings.get(SETTINGS.GOVERNMENT_EMAIL_DOMAIN),
        this.settings.get(SETTINGS.SUPPORT_EMAIL),
      ]);

    const isProduction = process.env.NODE_ENV === 'production';
    const isLocal = /localhost|127\.0\.0\.1/.test(webUrl);

    const warnings: string[] = [];
    if (!process.env.RESEND_API_KEY) {
      warnings.push(
        'No mail provider key. Every invitation, reset and notification is being silently discarded.',
      );
    }

    // Judged against the environment, not in the abstract. A localhost link
    // base is correct on a developer's machine and catastrophic on the server,
    // and a console that cries wolf in development is one nobody reads in
    // production.
    if (!webUrl) {
      warnings.push(
        'WEB_URL is unset, so every emailed link falls back to localhost and leads nowhere.',
      );
    } else if (isProduction && isLocal) {
      warnings.push(
        `Emailed links point at ${webUrl}, which only resolves on the server itself. Invitations, password resets and RSVP links are all unusable.`,
      );
    } else if (isProduction && !webUrl.startsWith('https://')) {
      warnings.push(
        `Emailed links point at ${webUrl}. A session cookie scoped Secure will not survive a plain-HTTP link.`,
      );
    }

    if (!supportEmail) {
      warnings.push(
        'No support address, so the help page sends people to their ministry administrator instead.',
      );
    }
    if (!process.env.CLOUDINARY_API_KEY) {
      warnings.push('No image upload key. Banner and logo uploads will fail.');
    }

    return {
      mailConfigured: Boolean(process.env.RESEND_API_KEY),
      emailFrom: process.env.EMAIL_FROM ?? null,
      uploadsConfigured: Boolean(process.env.CLOUDINARY_API_KEY),
      webUrl: webUrl || null,
      // So the page can say "correct for this environment" rather than leaving
      // a reader to judge a URL against a NODE_ENV shown three panels away.
      webUrlLooksRight: Boolean(webUrl) && (!isProduction || (!isLocal && webUrl.startsWith('https://'))),
      supportEmail: supportEmail || null,
      sessionTimeoutSeconds: Number(sessionTimeout),
      governmentEmailDomain,
      nodeEnv: process.env.NODE_ENV ?? 'development',
      warnings,
    };
  }

  private messageOf(error: unknown): string {
    return error instanceof Error ? error.message : 'unknown';
  }
}
