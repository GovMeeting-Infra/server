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
import { APIError } from 'better-auth/api';
import { SettingsService, SETTINGS } from '../common/settings/settings.service';
import { matchesGovDomain } from '../common/utils/gov-domain.util';

/** Failures allowed before the account is locked. */
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

/** Don't rewrite the row for every request in a burst. */
const EXTEND_THROTTLE_MS = 60 * 1000;

@Injectable()
export class AuthService {
  private logger = new Logger('AuthService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    // The session timeout and the permitted email domain were a module-level
    // const and a field initializer, both frozen at import. Reading them
    // through SettingsService means a super admin can change either without a
    // redeploy; with no override stored, it returns the same environment value
    // as before.
    private settings: SettingsService,
  ) {}

  async signIn(dto: SignInDto, ipAddress?: string) {
    const email = dto.email.toLowerCase().trim();

    const user = await (this.prisma as any).user.findUnique({
      where: { email },
      include: { ministry: { select: { active: true, name: true } } },
    });

    // The government-domain rule governs who may be *given* an account: every
    // ordinary user is a civil servant reachable at their ministry's domain.
    // The platform's single super administrator is provisioned directly against
    // the database, belongs to no ministry, and may hold any address — so the
    // gate is skipped for that one account and enforced for everyone else.
    //
    // The lookup moved above this check to make that possible. An address that
    // matches no account is still refused here, so this cannot be used to probe
    // for accounts: the answer is the same either way.
    if (
      user?.systemRole !== 'SUPER_ADMIN' &&
      !(await this.isGovDomain(email))
    ) {
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

    // PRD §8: deactivating a ministry locks out its users, which is what makes
    // deactivation a usable alternative to deleting one. Super admins are
    // platform-wide and hold no ministry, so they are unaffected — and must be,
    // or deactivating the wrong ministry could not be undone.
    if (user.ministry && !user.ministry.active) {
      await this.audit.log({
        action: 'LOGIN_FAILED',
        entityType: 'User',
        entityId: user.id,
        status: 'FAILURE',
        description: `Ministry deactivated: ${user.ministry.name}`,
        ministryId: user.ministryId ?? undefined,
        actorId: user.id,
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

      // Kept for a future better-auth that signals failure by returning falsy
      // instead of throwing. Today the APIError branch below is the live path.
      if (!result) {
        await this.recordFailedAttempt(user, ipAddress);
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

      // better-auth rejects a bad password by throwing an APIError, not by
      // returning falsy. Without this branch the throw skipped the failed-attempt
      // bookkeeping above and surfaced as a 400 "Sign-in failed", which is both
      // the wrong status and the reason lockout never engaged.
      if (this.isInvalidCredentials(error)) {
        await this.recordFailedAttempt(user, ipAddress);
        throw new UnauthorizedException('Invalid credentials');
      }

      // Anything else is ours to fix, so say what it was: this used to be the
      // only trace, and it read as an unexplained 400.
      this.logger.error(
        `BetterAuth sign-in error for ${email}: ${(error as Error)?.message}`,
        (error as Error)?.stack,
      );
      throw new BadRequestException('Sign-in failed');
    }
  }

  /** Whether better-auth rejected the password, as opposed to failing. */
  private isInvalidCredentials(error: unknown): boolean {
    if (!(error instanceof APIError)) return false;
    return (
      error.statusCode === 401 ||
      (error.body as { code?: string } | undefined)?.code ===
        'INVALID_EMAIL_OR_PASSWORD'
    );
  }

  /**
   * Counts a failed sign-in and locks the account once it hits the limit.
   *
   * `loginAttempts` is the count *before* this attempt, so the lock lands on the
   * MAX_LOGIN_ATTEMPTS-th failure.
   */
  private async recordFailedAttempt(
    user: { id: string; loginAttempts: number; ministryId: string | null },
    ipAddress?: string,
  ): Promise<void> {
    const attempts = user.loginAttempts + 1;
    const locked = attempts >= MAX_LOGIN_ATTEMPTS;

    await (this.prisma as any).user.update({
      where: { id: user.id },
      data: {
        loginAttempts: attempts,
        lockedUntil: locked ? new Date(Date.now() + LOCKOUT_MS) : null,
      },
    });

    await this.audit.log({
      action: 'LOGIN_FAILED',
      entityType: 'User',
      entityId: user.id,
      status: 'FAILURE',
      description: locked
        ? `Invalid password — account locked after ${attempts} attempts`
        : 'Invalid password',
      ministryId: user.ministryId ?? undefined,
      actorId: user.id,
      ipAddress,
    });
  }

  private async isGovDomain(email: string): Promise<boolean> {
    // The rule itself lives in a shared helper, so that account creation
    // applies the same one. See matchesGovDomain for why it anchors on a dot.
    return matchesGovDomain(
      email,
      await this.settings.get(SETTINGS.GOVERNMENT_EMAIL_DOMAIN),
    );
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
        include: {
          user: { include: { ministry: { select: { active: true } } } },
        },
      });

      if (!session) {
        return null;
      }

      const now = new Date();

      if (new Date(session.expiresAt) < now) {
        return null;
      }

      // Revocation is checked on every request, not only at sign-in.
      //
      // Deactivating a user, deactivating their ministry and anonymising an
      // account all used to leave open sessions untouched, and the window below
      // slides forward on every request — so someone working continuously was
      // never ejected at all. Deleting their sessions (which the callers now do)
      // handles the common case; this handles the session created a millisecond
      // before the delete, and any that outlives it.
      const user = session.user;
      const revoked =
        !user.active ||
        user.deletedAt !== null ||
        (user.ministry !== null && !user.ministry.active);

      if (revoked) {
        return null;
      }

      // Move the window to now + timeout, in whichever direction that is.
      //
      // Forward, so the timeout measures inactivity rather than total time —
      // otherwise someone working continuously is signed out a fixed period
      // after signing in. Backward, because better-auth stamps expiresAt from
      // auth.config's import-time expiresIn: a session created after the
      // timeout was lowered still carried the old, longer window, so the
      // setting appeared to do nothing. This is what makes it authoritative.
      //
      // Throttled because SessionMiddleware runs on every single request:
      // moving it only once the gap exceeds a minute turns one UPDATE per
      // request into one per minute of activity. After a pull-back the gap is
      // the elapsed time, so it settles immediately rather than rewriting.
      const ttlMs =
        (await this.settings.getNumber(SETTINGS.SESSION_TIMEOUT_SECONDS)) *
        1000;
      const freshExpiry = new Date(now.getTime() + ttlMs);
      const drift = Math.abs(
        freshExpiry.getTime() - new Date(session.expiresAt).getTime(),
      );

      if (drift > EXTEND_THROTTLE_MS) {
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
