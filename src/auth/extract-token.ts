import type { Request } from 'express';

/**
 * Reads the session token from a request: bearer header first, then the
 * authToken/__session cookie.
 *
 * Shared so the middleware, the session endpoint and sign-out all agree on
 * what "the current token" means — they previously each had their own copy,
 * and one of them dropped any token containing an '=' by destructuring only
 * the first split segment.
 */
export function extractToken(req: Request): string | null {
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.substring(7) || null;
  }

  const cookie = req.headers.cookie;
  if (!cookie) return null;

  for (const part of cookie.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === 'authToken' || key === '__session') {
      return rest.join('=') || null;
    }
  }

  return null;
}
