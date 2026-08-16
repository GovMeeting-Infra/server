import { createHmac, timingSafeEqual } from 'crypto';

/** The only kind of mail here that can be turned off. */
export const DIGEST_KIND = 'WEEKLY_DIGEST';

function secret(): string {
  return process.env.BETTER_AUTH_SECRET || 'dev-only-unsubscribe-secret';
}

/**
 * A signature over the address, so an unsubscribe link cannot be edited into
 * one that silences somebody else.
 *
 * Stateless on purpose: no token table to write on every send, and no rows to
 * expire. The address is already in the URL — the signature is only there to
 * prove we put it there.
 */
export function signEmail(email: string): string {
  return createHmac('sha256', secret())
    .update(`${DIGEST_KIND}:${email.trim().toLowerCase()}`)
    .digest('base64url');
}

export function verifyEmail(email: string, token: string): boolean {
  const expected = Buffer.from(signEmail(email));
  const given = Buffer.from(token ?? '');

  // Same length first: timingSafeEqual throws on a mismatch, and the throw
  // would itself leak the length.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** Where the digest's unsubscribe link points. */
export function digestUnsubscribeUrl(email: string): string {
  const base =
    process.env.WEB_URL ??
    process.env.NEXT_PUBLIC_WEB_URL ??
    'http://localhost:3000';

  const params = new URLSearchParams({
    email: email.trim().toLowerCase(),
    token: signEmail(email),
  });

  return `${base}/unsubscribe?${params.toString()}`;
}
