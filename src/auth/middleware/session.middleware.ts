import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { AuthService } from '../auth.service';
import { extractToken } from '../extract-token';

/**
 * Resolves the session token on every request and attaches the user to
 * `req.user`, which RolesGuard, CanManageEventGuard and the @CurrentUser
 * decorator all read from.
 *
 * This never rejects a request — it only populates the user when a valid
 * session exists. Authorization stays the guards' responsibility, so public
 * routes (check-in, RSVP, public calendar) keep working unauthenticated.
 */
@Injectable()
export class SessionMiddleware implements NestMiddleware {
  constructor(private authService: AuthService) {}

  async use(req: Request, _res: Response, next: NextFunction): Promise<void> {
    const token = extractToken(req);

    if (token) {
      try {
        const user = await this.authService.getSession(token);
        if (user) {
          (req as any).user = user;
        }
      } catch {
        // A bad or expired token is simply an anonymous request.
      }
    }

    next();
  }
}
