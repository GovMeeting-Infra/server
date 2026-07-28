import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { hashPassword } from 'better-auth/crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { v4 as uuid } from 'uuid';

const INVITE_TTL_DAYS = 7;
const IDENTIFIER_PREFIX = 'invite:';

/**
 * Invitation tokens for new accounts.
 *
 * Users are created without a credential; they set their own password from a
 * one-time link, so no administrator ever handles someone else's password.
 * Tokens live in the existing Verification table (identifier / value /
 * expiresAt), which is already shaped for this — no schema change needed.
 */
@Injectable()
export class InvitesService {
  private logger = new Logger('InvitesService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  /** Only the hash is stored, so a database read cannot yield a usable link. */
  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private linkFor(token: string) {
    const base =
      process.env.WEB_URL || process.env.NEXT_PUBLIC_WEB_URL || 'http://localhost:3000';
    return `${base}/set-password?token=${token}`;
  }

  /**
   * Issues (or re-issues) an invite. Any previous invite for the user is
   * dropped first, so re-inviting invalidates the old link.
   */
  async issue(userId: string, actorId: string, ministryId: string) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, deletedAt: true },
    });

    if (!user || user.deletedAt) {
      throw new NotFoundException('User not found');
    }

    const token = randomBytes(32).toString('base64url');
    const identifier = `${IDENTIFIER_PREFIX}${userId}`;

    await (this.prisma as any).verification.deleteMany({ where: { identifier } });

    await (this.prisma as any).verification.create({
      data: {
        identifier,
        value: this.hash(token),
        expiresAt: new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    await this.audit.log({
      action: 'USER_INVITED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: userId,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Issued account invitation for ${user.email}`,
    });

    // No mail sender exists in this codebase yet — email.processor.ts only
    // logs. Recording the intent here means wiring a real sender later needs
    // no change at the call sites; the returned link is how the invite
    // actually reaches the user today.
    this.logger.log(
      `Invitation issued for ${user.email}; email delivery is not configured, link returned to the inviting admin`,
    );

    return {
      userId,
      email: user.email,
      name: user.name,
      link: this.linkFor(token),
      expiresInDays: INVITE_TTL_DAYS,
      emailSent: false,
    };
  }

  /** Looks up a live invite, or throws. Used by both verify and consume. */
  private async findValid(token: string) {
    const record = await (this.prisma as any).verification.findFirst({
      where: {
        value: this.hash(token),
        identifier: { startsWith: IDENTIFIER_PREFIX },
      },
    });

    // Identical response for missing, expired and already-used, so the
    // endpoint doesn't disclose which.
    if (!record || record.expiresAt < new Date()) {
      throw new NotFoundException('This invitation is invalid or has expired');
    }

    const userId = record.identifier.slice(IDENTIFIER_PREFIX.length);
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, active: true, deletedAt: true },
    });

    if (!user || user.deletedAt || !user.active) {
      throw new NotFoundException('This invitation is invalid or has expired');
    }

    return { record, user };
  }

  async verify(token: string) {
    const { user } = await this.findValid(token);
    return { email: user.email, name: user.name };
  }

  /** Sets the password and consumes the token, so the link works exactly once. */
  async setPassword(token: string, password: string) {
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

    await this.audit.log({
      action: 'INVITE_ACCEPTED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: '',
      actorId: user.id,
      description: `Set initial password via invitation`,
    });

    return { success: true, email: user.email };
  }
}
