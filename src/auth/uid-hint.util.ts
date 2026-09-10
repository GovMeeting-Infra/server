import { createHmac } from 'crypto';

/**
 * An opaque, stable, per-user tag the browser is allowed to read.
 *
 * The session cookie is HttpOnly, which is right — but it also means nothing
 * on the client can tell whose data it is holding. That is fine while the only
 * cache is in memory and dies with the tab. It stops being fine once pages and
 * API responses are cached to disk: on the shared tablet a ministry keeps at
 * the door, the next person to sign in would be served the last person's
 * cached pages, because a cache keyed only by URL cannot tell them apart.
 *
 * So the client gets this instead: enough to namespace a cache by, and nothing
 * else. It grants no access, carries no claim, and is checked by nobody — the
 * real session cookie still decides every question of who may do what. It is
 * the user id put through an HMAC rather than the id itself, so that a script
 * on the page cannot read out a database identifier it has no other way to
 * learn.
 */
export function uidHint(userId: string): string {
  // Falls back to an empty key rather than throwing. A missing secret makes the
  // value guessable-in-principle by someone who already knows a user id, which
  // costs nothing here — the tag authorises nothing. Refusing to sign people in
  // over it would be the far worse failure.
  const secret = process.env.BETTER_AUTH_SECRET ?? '';

  return createHmac('sha256', secret)
    .update(userId)
    .digest('base64url')
    .slice(0, 22);
}

/**
 * Deliberately readable by scripts, so the service worker and the cache
 * persister can namespace by it. Everything else matches the session cookie so
 * the two are set and cleared together.
 */
export const UID_HINT_COOKIE_OPTIONS = {
  path: '/',
  httpOnly: false,
  secure: true,
  sameSite: 'lax',
} as const;
