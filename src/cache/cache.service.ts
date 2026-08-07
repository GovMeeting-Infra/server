import { Injectable, Logger } from '@nestjs/common';
import { createClient, RedisClientType } from 'redis';

export const CACHE_TTL = {
  ROLES: 15 * 60,
  MINISTRY: 30 * 60,
  EVENTS: 10 * 60,
  DASHBOARD: 5 * 60,
  DEFAULT: 5 * 60,
} as const;

/** How long bootstrap waits for the first Redis connection before giving up on
 *  it and starting anyway. The client keeps reconnecting in the background. */
const INITIAL_CONNECT_TIMEOUT_MS = 5_000;

@Injectable()
export class CacheService {
  private client: RedisClientType;
  private logger = new Logger('CacheService');
  private ready = false;

  constructor() {
    this.client = createClient({
      url: process.env.REDIS_URL || 'redis://localhost:6379',
      // Empty means "credentials are in the URL", which is how Upstash works.
      password: process.env.REDIS_PASSWORD || undefined,
      // Fail commands immediately while disconnected instead of queueing them.
      // The queue is worse than a cache miss: every request that touched the
      // cache would block until Redis came back, turning a cache outage into a
      // site outage. Callers below already treat an error as a miss.
      disableOfflineQueue: true,
      socket: {
        connectTimeout: INITIAL_CONNECT_TIMEOUT_MS,
        // Retry forever so the cache heals on its own, but back off to 5s
        // rather than hammering a downed server 20 times a second.
        reconnectStrategy: (retries: number) => Math.min(retries * 200, 5_000),
      },
    });

    this.client.on('error', (err) =>
      this.logger.error('Redis Client Error', err),
    );
    this.client.on('ready', () => {
      this.ready = true;
      this.logger.log('✅ Redis connected');
    });
    this.client.on('end', () => (this.ready = false));
    this.client.on('reconnecting', () => (this.ready = false));
  }

  /**
   * Starts the connection without letting it hold up bootstrap.
   *
   * This used to `await client.connect()` outright. Because `reconnectStrategy`
   * never gives up, that promise neither resolves nor rejects while Redis is
   * unreachable — so `onModuleInit` never returned, Nest never finished
   * `app.init()`, and `app.listen()` was never called. A Redis outage did not
   * degrade the API; it stopped it from opening its port at all, and the
   * symptom was an empty `ss -lntp` with no error to explain it.
   */
  async onModuleInit() {
    const connected = this.client
      .connect()
      .then(() => true)
      .catch((error) => {
        this.logger.error('Failed to connect to Redis:', error);
        return false;
      });

    const timedOut = new Promise<false>((resolve) =>
      setTimeout(() => resolve(false), INITIAL_CONNECT_TIMEOUT_MS).unref(),
    );

    if (!(await Promise.race([connected, timedOut]))) {
      this.logger.warn(
        `Redis not reachable within ${INITIAL_CONNECT_TIMEOUT_MS}ms — starting without a cache and retrying in the background.`,
      );
    }
  }

  /**
   * Whether the cache is actually usable right now.
   *
   * The health endpoint needs this because every method below swallows its
   * error and returns a miss: a `get()` that comes back `null` says nothing
   * about whether Redis answered, so health checks built on it reported
   * "connected" throughout an outage.
   */
  async ping(): Promise<boolean> {
    if (!this.ready) return false;
    try {
      await this.client.ping();
      return true;
    } catch (error) {
      this.logger.error('Redis ping failed:', error);
      return false;
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
      await this.client.setEx(key, ttlSeconds, JSON.stringify(value));
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
      this.logger.error(
        `Cache invalidate error for pattern ${pattern}:`,
        error,
      );
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
    // quit() rejects if the client never opened, which would turn a shutdown
    // during a Redis outage into a noisy failure.
    if (!this.client.isOpen) return;
    try {
      await this.client.quit();
    } catch (error) {
      this.logger.error('Error closing Redis connection:', error);
    }
  }
}
