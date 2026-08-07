export interface RedisConnectionOptions {
  host: string;
  port: number;
  username?: string;
  password?: string;
  tls?: Record<string, never>;
  maxRetriesPerRequest: null;
}

/**
 * Builds an ioredis-compatible connection object for BullMQ from REDIS_URL.
 *
 * This used to be hand-rolled string splitting in app.module.ts, which read the
 * userinfo segment as the hostname: `rediss://default:pw@host.upstash.io:6379`
 * parsed to host `default`. It happened to work against a local Redis only
 * because the dev URL has no username, so the split produced an empty string
 * and fell through to the `localhost` default.
 *
 * `maxRetriesPerRequest` must be null — BullMQ's blocking commands sit open
 * longer than ioredis' default retry budget, and hosted Redis will drop them.
 */
export function redisConnectionOptions(): RedisConnectionOptions {
  const raw = process.env.REDIS_URL || 'redis://localhost:6379';
  const url = new URL(raw);

  return {
    host: url.hostname,
    port: url.port ? parseInt(url.port, 10) : 6379,
    username: url.username || undefined,
    // Upstash carries credentials in the URL; local dev supplies them via
    // REDIS_PASSWORD against a URL that has no userinfo.
    password: url.password || process.env.REDIS_PASSWORD || undefined,
    // `rediss://` is TLS. Upstash refuses plaintext connections.
    tls: url.protocol === 'rediss:' ? {} : undefined,
    maxRetriesPerRequest: null,
  };
}
