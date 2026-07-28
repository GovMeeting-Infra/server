import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { SignInDto } from './dto/sign-in.dto';
import { auth } from './auth.config';

/**
 * How long a session survives without activity. Must match auth.config.ts,
 * which better-auth uses when it first creates the row.
 */
export const SESSION_TTL_SECONDS = parseInt(
  process.env.SESSION_INACTIVITY_TIMEOUT_SECONDS || '43200',
  10,
);

/** Don't rewrite the row for every request in a burst. */
const EXTEND_THROTTLE_MS = 60 * 1000;

@Injectable()
export class AuthService {
  private logger = new Logger('AuthService');
  private govEmailDomain = process.env.GOVERNMENT_EMAIL_DOMAIN || '.gov.sl';

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async signIn(dto: SignInDto, ipAddress?: string) {
    const email = dto.email.toLowerCase().trim();

    if (!this.isGovDomain(email)) {
      await this.audit.log({
        action: 'LOGIN_FAILED',
        entityType: 'User',
        entityId: email,
        status: 'FAILURE',
        description: 'Invalid email domain (not government email)',
        ipAddress,
      });
      throw new UnauthorizedException('Government email required');
    }

    const user = await (this.prisma as any).user.findUnique({
      where: { email },
    });

    if (!user || !user.active) {
      await this.audit.log({
        action: 'LOGIN_FAILED',
        entityType: 'User',
        entityId: email,
        status: 'FAILURE',
        description: user ? 'Account inactive' : 'User not found',
        ipAddress,
      });
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
      await this.audit.log({
        action: 'LOGIN_FAILED',
        entityType: 'User',
        entityId: user.id,
        status: 'FAILURE',
        description: 'Account locked due to failed login attempts',
        ministryId: user.ministryId,
        actorId: user.id,
        ipAddress,
      });
      throw new UnauthorizedException('Account locked. Try again later.');
    }

    try {
      const result = await auth.api.signInEmail({
        body: {
          email,
          password: dto.password,
        },
      });

      if (!result) {
        await (this.prisma as any).user.update({
          where: { id: user.id },
          data: {
            loginAttempts: user.loginAttempts + 1,
            lockedUntil:
              user.loginAttempts >= 4
                ? new Date(Date.now() + 15 * 60 * 1000)
                : null,
          },
        });

        await this.audit.log({
          action: 'LOGIN_FAILED',
          entityType: 'User',
          entityId: user.id,
          status: 'FAILURE',
          description: 'Invalid password',
          ministryId: user.ministryId,
          actorId: user.id,
          ipAddress,
        });

        throw new UnauthorizedException('Invalid credentials');
      }

      await (this.prisma as any).user.update({
        where: { id: user.id },
        data: {
          loginAttempts: 0,
          lockedUntil: null,
          lastLoginAt: new Date(),
        },
      });

      await this.audit.log({
        action: 'LOGIN_SUCCESS',
        entityType: 'User',
        entityId: user.id,
        status: 'SUCCESS',
        ministryId: user.ministryId,
        actorId: user.id,
        ipAddress,
      });

      return result;
    } catch (error) {
      if (error instanceof UnauthorizedException) {
        throw error;
      }

      this.logger.error('BetterAuth sign-in error:', error);
      throw new BadRequestException('Sign-in failed');
    }
  }

  private isGovDomain(email: string): boolean {
    const domain = email.split('@')[1];
    if (!domain) return false;
    return domain === 'gov.sl' || domain.endsWith(this.govEmailDomain);
  }

  /**
   * Invalidate a session server-side.
   *
   * Clearing the cookie alone is not signing out: getSession resolves the
   * token against the Session table, so a token captured from a shared machine
   * or a log kept working until it expired. Deleting the row is what actually
   * ends the session.
   *
   * Idempotent — signing out twice, or with a token that is already gone, is
   * a success, not an error.
   */
  async signOut(sessionToken: string | null, ipAddress?: string) {
    if (!sessionToken) return { signedOut: false };

    const session = await (this.prisma as any).session.findUnique({
      where: { token: sessionToken },
      select: {
        id: true,
        userId: true,
        user: { select: { ministryId: true } },
      },
    });

    if (!session) return { signedOut: false };

    await (this.prisma as any).session.delete({ where: { id: session.id } });

    await this.audit.log({
      action: 'LOGOUT',
      actionCategory: 'AUTH',
      entityType: 'Session',
      entityId: session.id,
      status: 'SUCCESS',
      ministryId: session.user?.ministryId ?? undefined,
      actorId: session.userId,
      description: 'User signed out',
      ipAddress,
    });

    return { signedOut: true };
  }

  async getSession(sessionToken: string) {
    try {
      const session = await (this.prisma as any).session.findUnique({
        where: { token: sessionToken },
        include: { user: true },
      });

      if (!session) {
        return null;
      }

      const now = new Date();

      if (new Date(session.expiresAt) < now) {
        return null;
      }

      // Slide the window forward on activity. Without this the timeout is
      // absolute — someone working continuously was signed out a fixed period
      // after signing in, despite the setting being named for inactivity.
      //
      // Throttled because SessionMiddleware runs on every single request:
      // extending only once the window has moved on by more than a minute
      // turns one UPDATE per request into one per minute of activity.
      const ttlMs = SESSION_TTL_SECONDS * 1000;
      const freshExpiry = new Date(now.getTime() + ttlMs);
      const elapsedSinceExtension =
        freshExpiry.getTime() - new Date(session.expiresAt).getTime();

      if (elapsedSinceExtension > EXTEND_THROTTLE_MS) {
        await (this.prisma as any).session.update({
          where: { id: session.id },
          data: { expiresAt: freshExpiry, updatedAt: now },
        });
      }

      return {
        id: session.user.id,
        email: session.user.email,
        name: session.user.name,
        systemRole: session.user.systemRole,
        jobTitle: session.user.jobTitle,
        ministryId: session.user.ministryId,
      };
    } catch (error) {
      this.logger.error('Session lookup failed:', error);
      return null;
    }
  }
}
