import { Injectable, Logger } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';

export const CACHE_TTL = {
  ROLES: 15 * 60,
  MINISTRY: 30 * 60,
  EVENTS: 10 * 60,
  DASHBOARD: 5 * 60,
  DEFAULT: 5 * 60,
} as const;

@Injectable()
export class CacheService {
  private client: RedisClientType;
  private logger = new Logger('CacheService');

  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      password: process.env.REDIS_PASSWORD || undefined,
      socket: {
        reconnectStrategy: (retries: number) =>
          Math.min(retries * 50, 500),
      },
    });

    this.client.on('error', (err) =>
      this.logger.error('Redis Client Error', err),
    );
    this.client.on('connect', () =>
      this.logger.log('✅ Redis connected'),
    );
  }

  async onModuleInit() {
    try {
      await this.client.connect();
    } catch (error) {
      this.logger.error('Failed to connect to Redis:', error);
    }
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const value = await this.client.get(key);
      if (!value) return null;
      return JSON.parse(value) as T;
    } catch (error) {
      this.logger.error(`Cache get error for key ${key}:`, error);
      return null;
    }
  }

  async set<T>(
    key: string,
    value: T,
    ttlSeconds: number = CACHE_TTL.DEFAULT,
  ): Promise<void> {
    try {
      await this.client.setEx(
        key,
        ttlSeconds,
        JSON.stringify(value),
      );
    } catch (error) {
      this.logger.error(`Cache set error for key ${key}:`, error);
    }
  }

  async setRoles<T>(key: string, value: T): Promise<void> {
    return this.set(key, value, CACHE_TTL.ROLES);
  }

  async setMinistry<T>(key: string, value: T): Promise<void> {
    return this.set(key, value, CACHE_TTL.MINISTRY);
  }

  async setEvents<T>(key: string, value: T): Promise<void> {
    return this.set(key, value, CACHE_TTL.EVENTS);
  }

  async setDashboard<T>(key: string, value: T): Promise<void> {
    return this.set(key, value, CACHE_TTL.DASHBOARD);
  }

  /**
   * Increment a counter, setting its TTL on first use, and return the new
   * value. Backs rate limiting on the public check-in routes.
   *
   * Returns 0 when Redis is unreachable, which callers treat as "under the
   * limit". Failing open is deliberate and matches the rest of this class: a
   * Redis outage must not make it impossible to check in to a meeting.
   */
  async incr(key: string, ttlSeconds: number): Promise<number> {
    try {
      const count = await this.client.incr(key);
      if (count === 1) {
        await this.client.expire(key, ttlSeconds);
      }
      return count;
    } catch (error) {
      this.logger.error(`Cache incr error for key ${key}:`, error);
      return 0;
    }
  }

  async delete(key: string): Promise<void> {
    try {
      await this.client.del(key);
    } catch (error) {
      this.logger.error(`Cache delete error for key ${key}:`, error);
    }
  }

  async invalidatePattern(pattern: string): Promise<void> {
    try {
      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        await this.client.del(keys);
      }
    } catch (error) {
      this.logger.error(`Cache invalidate error for pattern ${pattern}:`, error);
    }
  }

  /**
   * Clears every cached analytics dashboard.
   *
   * Analytics aggregates events, attendance, rooms, users and action items, so
   * any of those changing makes every scope stale — including the super-admin's
   * cross-ministry "all" entry, which is why this cannot be narrowed to the
   * acting ministry. Called from the services that mutate those records;
   * without it the reports page served hour-old numbers.
   */
  async invalidateAnalytics(): Promise<void> {
    await this.invalidatePattern('reports:analytics:*');
  }

  async clear(): Promise<void> {
    try {
      await this.client.flushDb();
    } catch (error) {
      this.logger.error('Cache clear error:', error);
    }
  }

  async onModuleDestroy() {
    await this.client.quit();
  }
}
