import { Controller, Get, Inject } from '@nestjs/common';
import { ApiOperation, ApiResponse } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';

interface HealthCheckResponse {
  status: 'healthy' | 'degraded' | 'unhealthy';
  timestamp: string;
  uptime: number;
  database: {
    status: 'connected' | 'disconnected';
    latency?: number;
  };
  redis: {
    status: 'connected' | 'disconnected';
    latency?: number;
  };
  services: {
    api: string;
    database: string;
    cache: string;
  };
}

@Controller('api/v1')
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  @Get('health')
  @ApiOperation({ summary: 'Health check endpoint' })
  @ApiResponse({
    status: 200,
    description: 'Service is healthy',
    schema: {
      example: {
        status: 'healthy',
        timestamp: '2026-07-23T12:00:00Z',
        uptime: 3600,
        database: { status: 'connected', latency: 2 },
        redis: { status: 'connected', latency: 1 },
        services: {
          api: 'ok',
          database: 'ok',
          cache: 'ok',
        },
      },
    },
  })
  async health(): Promise<HealthCheckResponse> {
    const startTime = Date.now();
    const healthStatus: HealthCheckResponse = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: { status: 'disconnected' },
      redis: { status: 'disconnected' },
      services: {
        api: 'ok',
        database: 'ok',
        cache: 'ok',
      },
    };

    // Check database
    try {
      const dbStart = Date.now();
      await (this.prisma as any).user.findFirst();
      const dbLatency = Date.now() - dbStart;
      healthStatus.database = { status: 'connected', latency: dbLatency };
    } catch (error) {
      healthStatus.database.status = 'disconnected';
      healthStatus.services.database = 'error';
      healthStatus.status = 'degraded';
    }

    // Check Redis.
    // ping() rather than get(): every CacheService read swallows its error and
    // returns a miss, so a `null` from get() cannot tell a cold cache apart
    // from a dead one — this check called Redis "connected" all through an
    // outage.
    const redisStart = Date.now();
    if (await this.cache.ping()) {
      healthStatus.redis = {
        status: 'connected',
        latency: Date.now() - redisStart,
      };
    } else {
      healthStatus.redis.status = 'disconnected';
      healthStatus.services.cache = 'error';
      healthStatus.status = 'degraded';
    }

    // If both database and Redis are down, mark as unhealthy
    if (
      healthStatus.database.status === 'disconnected' &&
      healthStatus.redis.status === 'disconnected'
    ) {
      healthStatus.status = 'unhealthy';
    }

    return healthStatus;
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Readiness probe for process/uptime monitoring' })
  @ApiResponse({ status: 200, description: 'Service is ready' })
  async readiness(): Promise<{ ready: boolean }> {
    try {
      // The database only. Losing Redis costs the cache and delays queued
      // email; the API still serves every request, so reporting "not ready"
      // would pull a working instance out of rotation. Redis state is in
      // /health, which reports degraded instead.
      await (this.prisma as any).user.findFirst();
      return { ready: true };
    } catch (error) {
      return { ready: false };
    }
  }

  @Get('liveness')
  @ApiOperation({ summary: 'Liveness probe for process/uptime monitoring' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  liveness(): { alive: boolean } {
    return { alive: true };
  }
}
