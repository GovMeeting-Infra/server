import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/** Enough recent failures to spot a pattern, not enough to page through. */
const FAILED_SAMPLE = 20;

/**
 * The operations console.
 *
 * Everything an engineer needs to answer "is it up, and if not what broke",
 * and nothing that would tell them what a ministry discussed.
 *
 * The health probes already exist and are unauthenticated, because a load
 * balancer has to reach them. This is the same picture assembled for a person,
 * plus the queue — which is the part that has never been visible anywhere.
 */
@Controller('api/v1/platform')
@UseGuards(RolesGuard)
export class PlatformController {
  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
    @InjectQueue('email-queue') private emailQueue: Queue,
  ) {}

  @Get('overview')
  @Roles('SUPER_ADMIN', 'PLATFORM_ADMIN')
  @ApiOperation({ summary: 'Health and mail-queue state for operators' })
  async overview() {
    const [database, cache, queue] = await Promise.all([
      this.checkDatabase(),
      this.checkCache(),
      this.checkQueue(),
    ]);

    return {
      checkedAt: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      database,
      cache,
      queue,
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
        error: error instanceof Error ? error.message : 'unknown',
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
        error: error instanceof Error ? error.message : 'unknown',
      };
    }
  }

  /**
   * Mail is the platform's quietest failure. One queue carries every message,
   * Resend allows ten requests a second, and publishing minutes enqueues one
   * job per recipient — so a large meeting can burst past the limit and the
   * only evidence is a rising failed count.
   *
   * Job *names* only, never job data: the payloads carry recipient addresses,
   * which is exactly the kind of thing this role does not get to read.
   */
  private async checkQueue() {
    try {
      const counts = await this.emailQueue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );

      const failed = await this.emailQueue.getFailed(0, FAILED_SAMPLE - 1);

      // Grouped, because twenty rows of the same failure is one problem and
      // reading it as twenty wastes an on-call engineer's first five minutes.
      const byKind = new Map<string, { count: number; lastReason: string }>();
      for (const job of failed) {
        const key = job.name;
        const previous = byKind.get(key);
        byKind.set(key, {
          count: (previous?.count ?? 0) + 1,
          lastReason: job.failedReason ?? previous?.lastReason ?? 'unknown',
        });
      }

      return {
        status: 'up' as const,
        counts,
        recentFailures: [...byKind.entries()].map(([name, v]) => ({
          name,
          count: v.count,
          lastReason: v.lastReason,
        })),
      };
    } catch (error) {
      // A queue that cannot be read is itself the finding, and it must not take
      // the rest of the page down with it.
      return {
        status: 'down' as const,
        error: error instanceof Error ? error.message : 'unknown',
      };
    }
  }
}
