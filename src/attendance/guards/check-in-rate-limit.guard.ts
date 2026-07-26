import {
  Injectable,
  CanActivate,
  ExecutionContext,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CacheService } from '../../cache/cache.service';

export interface RateLimitConfig {
  /** Requests allowed per IP within the window. */
  perIp: number;
  /** Requests allowed per token within the window, across all IPs. */
  perToken?: number;
  windowSeconds: number;
}

export const RATE_LIMIT = 'checkInRateLimit';

/**
 * Rate limit for the unauthenticated check-in routes.
 *
 * Uses the Redis already backing CacheService rather than @nestjs/throttler:
 * throttler's default store is in-process, which under PM2's multiple workers
 * would give each worker its own allowance and enforce nothing.
 *
 * The per-token budget is the one that matters — it caps the damage from a QR
 * image that has been photographed and shared, which a per-IP limit alone
 * cannot see.
 */
@Injectable()
export class CheckInRateLimitGuard implements CanActivate {
  constructor(
    private cache: CacheService,
    private reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const config = this.reflector.get<RateLimitConfig>(
      RATE_LIMIT,
      context.getHandler(),
    );
    if (!config) return true;

    const request = context.switchToHttp().getRequest();
    const ip = request.ip || request.socket?.remoteAddress || 'unknown';
    const token = request.params?.token;
    const route = context.getHandler().name;

    const checks: Array<{ key: string; limit: number }> = [
      { key: `ratelimit:${route}:ip:${ip}`, limit: config.perIp },
    ];
    if (config.perToken && token) {
      checks.push({
        key: `ratelimit:${route}:token:${token}`,
        limit: config.perToken,
      });
    }

    for (const { key, limit } of checks) {
      const count = await this.cache.incr(key, config.windowSeconds);
      // 0 means Redis is down; incr already logged it. Fail open.
      if (count > limit) {
        throw new HttpException(
          'Too many attempts. Please wait a moment and try again.',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    return true;
  }
}
