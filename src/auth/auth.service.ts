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
    return (
      domain === 'gov.sl' ||
      domain.endsWith(this.govEmailDomain)
    );
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

      if (new Date(session.expiresAt) < new Date()) {
        return null;
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
