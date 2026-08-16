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
 * What a profile edit is allowed to leave in the audit log.
 *
 * AuditLog is append-only and readable by every ministry admin, so whatever
 * lands in `changes` is there permanently with no erasure path — including
 * after the account has been anonymised. Recording that someone set a phone
 * number is the useful half; recording the number itself would build a
 * permanent directory of personal contact details as a side effect of people
 * keeping their own profile current.
 */
function redactForAudit(dto: UpdateMeDto): Record<string, unknown> {
  const { phone, ...rest } = dto;
  return {
    ...rest,
    ...(phone !== undefined && {
      phone: phone.trim() ? '[set]' : '[cleared]',
    }),
  };
}

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
        phone: true,
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
          where: {
            ownerId: userId,
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
          },
        }),
        // Meetings ahead of them, counted the same three ways the events list
        // means "mine": they run it, they co-run it, or they were invited.
        // Counting invitations alone made this disagree with the list rendered
        // directly beneath it on the dashboard — a meeting you organised but
        // were never added to as an attendee appeared there and not here.
        (this.prisma as any).event.count({
          where: {
            startAt: { gt: now },
            OR: [
              { organizerId: userId },
              { coOrganizers: { some: { userId } } },
              { attendees: { some: { userId } } },
            ],
          },
        }),
      ]);

    return {
      ...user,
      stats: { organizedEvents, attendedEvents, actionItems, upcomingEvents },
    };
  }

  /**
   * Only name, jobTitle, phone and image. systemRole, ministryId and active are
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
        // An empty string is how the form says "clear it", and it has to reach
        // the column as null rather than as "" — otherwise a cleared number
        // still renders as a blank contact on every attendance row.
        ...(dto.phone !== undefined && { phone: dto.phone.trim() || null }),
        ...(dto.image !== undefined && { image: dto.image }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        image: true,
        jobTitle: true,
        phone: true,
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
      ministryId: updated.ministryId ?? undefined,
      actorId: userId,
      description: 'Updated own profile',
      changes: redactForAudit(dto),
    });

    return updated;
  }

  /**
   * Verifies the current password against the stored credential hash and
   * replaces it, using the same better-auth/crypto helpers UsersService.create
   * already uses to seed passwords.
   *
   * `currentToken` is the session doing the changing, and it is the one session
   * that survives. Everything else is deleted: the common reason to change a
   * password is believing someone else has it, and until now this method left
   * every other session alive while the page implied otherwise. The reset flow
   * has always revoked (password-reset.service.ts) — this brings the
   * self-service path in line, minus signing you out of the device in your hand.
   */
  async changePassword(
    userId: string,
    dto: ChangePasswordDto,
    currentToken?: string | null,
  ) {
    if (dto.newPassword.length < 8) {
      throw new BadRequestException(
        'New password must be at least 8 characters',
      );
    }

    const account = await (this.prisma as any).account.findFirst({
      where: { userId, providerId: 'credential' },
    });

    // So the entry lands in the right ministry's activity log. These calls used
    // to pass an empty string, which is not a real ministry id — the insert
    // failed the foreign key and the audit was silently dropped.
    const owner = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      select: { ministryId: true },
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
        ministryId: owner?.ministryId ?? undefined,
        actorId: userId,
        description: 'Incorrect current password',
      });
      throw new UnauthorizedException('Current password is incorrect');
    }

    await (this.prisma as any).account.update({
      where: { id: account.id },
      data: { password: await hashPassword(dto.newPassword) },
    });

    // Everything except the session in front of us. Without the token we cannot
    // tell which one that is, so we revoke the lot rather than leave the others
    // running — being signed out is recoverable, a stranger's live session is
    // not.
    const { count: revoked } = await (this.prisma as any).session.deleteMany({
      where: {
        userId,
        ...(currentToken ? { NOT: { token: currentToken } } : {}),
      },
    });

    await this.audit.log({
      action: 'PASSWORD_CHANGED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: userId,
      status: 'SUCCESS',
      ministryId: owner?.ministryId ?? undefined,
      actorId: userId,
      description:
        revoked > 0
          ? `Changed own password; signed out of ${revoked} other session${revoked === 1 ? '' : 's'}`
          : 'Changed own password',
    });

    // The page tells the person what happened to their other devices, so it
    // needs the number rather than a bare success flag.
    return { success: true, otherSessionsSignedOut: revoked };
  }

  /** Upsert-backed so a user with no preferences row gets defaults, not a 404. */
  /**
   * Everything the platform holds about the requester, for the data-export
   * button in Settings.
   *
   * Scoped hard to this one user: their own record, their own attendance, the
   * action items assigned to them, and the meetings they organized or attended.
   * Related rows are reduced to what identifies the meeting — exporting an
   * event must not hand over its other attendees.
   */
  async exportMyData(userId: string) {
    const [user, attendance, actionItems, organized, attended, notifications] =
      await Promise.all([
        (this.prisma as any).user.findUnique({
          where: { id: userId },
          select: {
            id: true,
            email: true,
            name: true,
            jobTitle: true,
            image: true,
            systemRole: true,
            active: true,
            lastLoginAt: true,
            createdAt: true,
            updatedAt: true,
            ministry: { select: { id: true, name: true } },
            preferences: true,
          },
        }),
        (this.prisma as any).attendance.findMany({
          where: { userId },
          select: {
            id: true,
            signedName: true,
            checkInAt: true,
            checkInMethod: true,
            withinGeofence: true,
            gpsAccuracy: true,
            ipAddress: true,
            userAgent: true,
            event: { select: { id: true, title: true, startAt: true } },
          },
          orderBy: { checkInAt: 'desc' },
        }),
        (this.prisma as any).actionItem.findMany({
          where: { ownerId: userId },
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            dueDate: true,
            completedAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        }),
        (this.prisma as any).event.findMany({
          where: { organizerId: userId },
          select: {
            id: true,
            title: true,
            startAt: true,
            endAt: true,
            status: true,
          },
          orderBy: { startAt: 'desc' },
        }),
        (this.prisma as any).eventAttendee.findMany({
          where: { userId },
          select: {
            status: true,
            respondedAt: true,
            event: { select: { id: true, title: true, startAt: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
        (this.prisma as any).notification.findMany({
          where: { userId },
          select: {
            type: true,
            title: true,
            body: true,
            read: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

    if (!user) throw new NotFoundException('User not found');

    await this.audit.log({
      action: 'DATA_EXPORTED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: userId,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: user.ministry?.id,
      actorId: userId,
      description: 'Exported their own personal data',
    });

    return {
      exportedAt: new Date().toISOString(),
      // Signatures and stored coordinates are deliberately excluded: the
      // coordinates are encrypted at rest and a signature image is of no use
      // outside the record it authenticates.
      note: 'Personal data held by the Smart Meeting platform for this account.',
      profile: user,
      attendance,
      actionItems,
      eventsOrganized: organized,
      eventsInvitedTo: attended,
      notifications,
    };
  }

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
      ...(dto.tourCompletedVersion !== undefined && {
        tourCompletedVersion: dto.tourCompletedVersion,
      }),
    };

    return (this.prisma as any).userPreferences.upsert({
      where: { userId },
      create: { userId, ...data },
      update: data,
    });
  }
}
