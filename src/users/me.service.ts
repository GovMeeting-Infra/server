import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { hashPassword, verifyPassword } from 'better-auth/crypto';
import { UpdateMeDto } from './dto/update-me.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';

/**
 * Self-service account operations.
 *
 * UsersService sits behind api/v1/admin/users and is admin-only, so until now
 * a STAFF user had no way to read or change their own record at all.
 */
@Injectable()
export class MeService {
  private logger = new Logger('MeService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async getProfile(userId: string) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        jobTitle: true,
        systemRole: true,
        ministryId: true,
        active: true,
        lastLoginAt: true,
        createdAt: true,
        updatedAt: true,
        ministry: { select: { id: true, name: true } },
      },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    const now = new Date();

    const [organizedEvents, attendedEvents, actionItems, upcomingEvents] =
      await Promise.all([
        (this.prisma as any).event.count({ where: { organizerId: userId } }),
        (this.prisma as any).attendance.count({ where: { userId } }),
        (this.prisma as any).actionItem.count({
          where: { ownerId: userId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        }),
        // Events they are invited to that haven't started yet.
        (this.prisma as any).eventAttendee.count({
          where: { userId, event: { startAt: { gt: now } } },
        }),
      ]);

    return {
      ...user,
      stats: { organizedEvents, attendedEvents, actionItems, upcomingEvents },
    };
  }

  /**
   * Only name, jobTitle and image. systemRole, ministryId and active are
   * deliberately not accepted here — they are administered through
   * /admin/users, and honouring them on a self-service route would let any
   * user promote themselves.
   */
  async updateProfile(userId: string, dto: UpdateMeDto) {
    const updated = await (this.prisma as any).user.update({
      where: { id: userId },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.jobTitle !== undefined && { jobTitle: dto.jobTitle }),
        ...(dto.image !== undefined && { image: dto.image }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        jobTitle: true,
        systemRole: true,
        ministryId: true,
      },
    });

    await this.audit.log({
      action: 'PROFILE_UPDATED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: userId,
      entityName: updated.name,
      status: 'SUCCESS',
      ministryId: updated.ministryId ?? '',
      actorId: userId,
      description: 'Updated own profile',
      changes: dto as unknown as Record<string, unknown>,
    });

    return updated;
  }

  /**
   * Verifies the current password against the stored credential hash and
   * replaces it, using the same better-auth/crypto helpers UsersService.create
   * already uses to seed passwords.
   */
  async changePassword(userId: string, dto: ChangePasswordDto) {
    if (dto.newPassword.length < 8) {
      throw new BadRequestException('New password must be at least 8 characters');
    }

    const account = await (this.prisma as any).account.findFirst({
      where: { userId, providerId: 'credential' },
    });

    if (!account?.password) {
      throw new BadRequestException(
        'This account has no password credential to change',
      );
    }

    const valid = await verifyPassword({
      hash: account.password,
      password: dto.currentPassword,
    });

    if (!valid) {
      await this.audit.log({
        action: 'PASSWORD_CHANGE_FAILED',
        actionCategory: 'USER_MANAGEMENT',
        entityType: 'User',
        entityId: userId,
        status: 'FAILURE',
        ministryId: '',
        actorId: userId,
        description: 'Incorrect current password',
      });
      throw new UnauthorizedException('Current password is incorrect');
    }

    await (this.prisma as any).account.update({
      where: { id: account.id },
      data: { password: await hashPassword(dto.newPassword) },
    });

    await this.audit.log({
      action: 'PASSWORD_CHANGED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: userId,
      status: 'SUCCESS',
      ministryId: '',
      actorId: userId,
      description: 'Changed own password',
    });

    return { success: true };
  }

  /** Upsert-backed so a user with no preferences row gets defaults, not a 404. */
  async getPreferences(userId: string) {
    return (this.prisma as any).userPreferences.upsert({
      where: { userId },
      create: { userId },
      update: {},
    });
  }

  async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
    const data = {
      ...(dto.emailNotifications !== undefined && {
        emailNotifications: dto.emailNotifications,
      }),
      ...(dto.minutesNotifications !== undefined && {
        minutesNotifications: dto.minutesNotifications,
      }),
      ...(dto.meetingReminders !== undefined && {
        meetingReminders: dto.meetingReminders,
      }),
      ...(dto.actionItemNotifications !== undefined && {
        actionItemNotifications: dto.actionItemNotifications,
      }),
      ...(dto.compactMode !== undefined && { compactMode: dto.compactMode }),
      ...(dto.sessionTimeout !== undefined && {
        sessionTimeout: dto.sessionTimeout,
      }),
    };

    return (this.prisma as any).userPreferences.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }
}
