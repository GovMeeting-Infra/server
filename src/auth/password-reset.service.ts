import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { hashPassword } from 'better-auth/crypto';
import { v4 as uuid } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { MailService } from '../mail/mail.service';
import { passwordResetEmail } from '../mail/templates';

const RESET_TTL_MINUTES = 60;
const IDENTIFIER_PREFIX = 'reset:';

/**
 * Self-service password reset.
 *
 * Deliberately mirrors InvitesService: same Verification table, same sha256
 * storage of the token, same single-use consumption. The differences are the
 * short TTL, and that every response here is written to reveal nothing to an
 * unauthenticated caller.
 */
@Injectable()
export class PasswordResetService {
  private logger = new Logger('PasswordResetService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private mail: MailService,
  ) {}

  /** Only the hash is stored, so a database read cannot yield a usable link. */
  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private linkFor(token: string) {
    const base =
      process.env.WEB_URL ||
      process.env.NEXT_PUBLIC_WEB_URL ||
      'http://localhost:3000';
    return `${base}/reset-password?token=${token}`;
  }

  /**
   * Issues a reset link if the address belongs to a usable account.
   *
   * Returns nothing either way. The caller is unauthenticated, so telling it
   * whether the address exists — or whether mail was actually sent — would
   * turn this into an account-enumeration oracle.
   */
  async request(rawEmail: string, ipAddress?: string): Promise<void> {
    const email = rawEmail.trim().toLowerCase();

    const user = await (this.prisma as any).user.findFirst({
      where: { email, active: true, deletedAt: null },
      select: { id: true, email: true, name: true, ministryId: true },
    });

    if (!user) {
      // Logged, not returned. Someone probing for valid addresses learns
      // nothing from the response.
      this.logger.warn(
        `Password reset requested for an unknown or inactive address`,
      );
      return;
    }

    const token = randomBytes(32).toString('base64url');
    const identifier = `${IDENTIFIER_PREFIX}${user.id}`;

    // Re-requesting invalidates any previous link.
    await (this.prisma as any).verification.deleteMany({ where: { identifier } });

    await (this.prisma as any).verification.create({
      data: {
        identifier,
        value: this.hash(token),
        expiresAt: new Date(Date.now() + RESET_TTL_MINUTES * 60 * 1000),
      },
    });

    await this.audit.log({
      action: 'PASSWORD_RESET_REQUESTED',
      actionCategory: 'AUTH',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: user.ministryId ?? undefined,
      actorId: user.id,
      description: 'Password reset link issued',
      ipAddress,
    });

    // Result deliberately discarded — see the note above.
    await this.mail.send(
      user.email,
      passwordResetEmail({
        name: user.name,
        link: this.linkFor(token),
        expiresInMinutes: RESET_TTL_MINUTES,
      }),
    );
  }

  /** Looks up a live reset token, or throws. Used by both verify and consume. */
  private async findValid(token: string) {
    const record = await (this.prisma as any).verification.findFirst({
      where: {
        value: this.hash(token),
        identifier: { startsWith: IDENTIFIER_PREFIX },
      },
    });

    // One message for missing, expired, already-used and tampered, so the
    // endpoint doesn't disclose which.
    if (!record || record.expiresAt < new Date()) {
      throw new NotFoundException(
        'This reset link is invalid or has expired',
      );
    }

    const userId = record.identifier.slice(IDENTIFIER_PREFIX.length);
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        ministryId: true,
        active: true,
        deletedAt: true,
      },
    });

    if (!user || user.deletedAt || !user.active) {
      throw new NotFoundException(
        'This reset link is invalid or has expired',
      );
    }

    return { record, user };
  }

  async verify(token: string) {
    const { user } = await this.findValid(token);
    return { email: user.email, name: user.name };
  }

  /** Sets the new password and consumes the token, so the link works once. */
  async reset(token: string, password: string, ipAddress?: string) {
    if (password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters');
    }

    const { record, user } = await this.findValid(token);
    const hashed = await hashPassword(password);

    const account = await (this.prisma as any).account.findFirst({
      where: { userId: user.id, providerId: 'credential' },
    });

    if (account) {
      await (this.prisma as any).account.update({
        where: { id: account.id },
        data: { password: hashed },
      });
    } else {
      await (this.prisma as any).account.create({
        data: {
          userId: user.id,
          accountId: uuid(),
          providerId: 'credential',
          password: hashed,
        },
      });
    }

    await (this.prisma as any).verification.delete({ where: { id: record.id } });

    // A reset implies the old credential may be in someone else's hands, so
    // every existing session goes with it.
    const { count } = await (this.prisma as any).session.deleteMany({
      where: { userId: user.id },
    });

    await this.audit.log({
      action: 'PASSWORD_RESET_COMPLETED',
      actionCategory: 'AUTH',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: user.ministryId ?? undefined,
      actorId: user.id,
      description: 'Password reset via emailed link',
      metadata: { sessionsRevoked: count },
      ipAddress,
    });

    return { success: true, email: user.email };
  }
}
