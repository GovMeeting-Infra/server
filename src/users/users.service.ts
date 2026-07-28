import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import {
  ministryScope,
  assertSameMinistry,
} from '../common/utils/ministry-scope.util';
import { auth } from '../auth/auth.config';
import { hashPassword } from 'better-auth/crypto';
import { v4 as uuid } from 'uuid';
import { InvitesService } from '../invites/invites.service';

@Injectable()
export class UsersService {
  private logger = new Logger('UsersService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private invites: InvitesService,
  ) {}

  /** Roles that may administer other users. */
  private static readonly ADMIN_ROLES = [
    'SUPER_ADMIN',
    'MINISTRY_ADMIN',
    'MINISTER',
  ];

  /**
   * Authorizes acting on another user.
   *
   * The previous checks passed a hard-coded systemRole: 'SUPER_ADMIN' into
   * assertSameMinistry, which made the helper exempt every caller and turned
   * the ministry boundary into a no-op — a ministry admin could act on another
   * ministry's users. This uses the actor's real role.
   */
  private assertCanManage(
    target: { systemRole: string; ministryId: string | null },
    actorRole: string,
    actorMinistryId?: string,
  ) {
    if (actorRole !== 'SUPER_ADMIN') {
      if (target.systemRole === 'SUPER_ADMIN') {
        throw new ForbiddenException('Cannot act on a super-admin');
      }
      assertSameMinistry(
        { systemRole: actorRole, ministryId: actorMinistryId },
        target.ministryId ?? '',
      );
    }
  }

  /** A ministry admin must not be able to mint a peer above themselves. */
  private assertCanAssignRole(role: string, actorRole: string) {
    if (role === 'SUPER_ADMIN' && actorRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only a super-admin can assign SUPER_ADMIN');
    }
    if (role === 'MINISTER' && actorRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException('Only a super-admin can assign MINISTER');
    }
  }

  async create(
    dto: CreateUserDto,
    ministryId: string,
    userId: string,
    userMinistryId?: string,
  ) {
    if (dto.systemRole === 'SUPER_ADMIN' && userMinistryId) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN can create SUPER_ADMIN users',
      );
    }

    try {
      const user = await (this.prisma as any).user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          jobTitle: dto.jobTitle,
          systemRole: dto.systemRole,
          ministryId: dto.systemRole === 'SUPER_ADMIN' ? null : ministryId,
          active: true,
        },
      });

      // No credential row is created: the user sets their own password from
      // the invitation link, so no administrator ever handles it.

      await (this.prisma as any).userPreferences.create({
        data: {
          userId: user.id,
        },
      });

      await this.audit.log({
        action: 'USER_CREATED',
        actionCategory: 'USER_MANAGEMENT',
        entityType: 'User',
        entityId: user.id,
        entityName: user.email,
        status: 'SUCCESS',
        ministryId: userMinistryId || 'SYSTEM',
        actorId: userId,
        description: `Created user: ${user.email}`,
      });

      const invite = await this.invites.issue(
        user.id,
        userId,
        userMinistryId || 'SYSTEM',
      );

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        systemRole: user.systemRole,
        invite,
      };
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new ConflictException('Email already exists');
      }
      throw error;
    }
  }

  async findAll(
    user: { systemRole: string; ministryId?: string },
    filters: { q?: string; role?: string; ministryId?: string } = {},
  ) {
    const isSuperAdmin = user.systemRole === 'SUPER_ADMIN';
    const scope = ministryScope(user);
    const q = filters.q?.trim();

    return (this.prisma as any).user.findMany({
      where: {
        ...scope,
        // Super-admins are never listed as manageable rows.
        systemRole: filters.role ? filters.role : { not: 'SUPER_ADMIN' },
        // Soft-deleted users are only visible to super-admins.
        ...(isSuperAdmin ? {} : { deletedAt: null }),
        ...(isSuperAdmin && filters.ministryId
          ? { ministryId: filters.ministryId }
          : {}),
        ...(q
          ? {
              OR: [
                { name: { contains: q, mode: 'insensitive' } },
                { email: { contains: q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        email: true,
        name: true,
        jobTitle: true,
        systemRole: true,
        ministryId: true,
        active: true,
        deletedAt: true,
        createdAt: true,
      },
      orderBy: { email: 'asc' },
    });
  }

  async findOne(id: string) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        jobTitle: true,
        systemRole: true,
        ministryId: true,
        active: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    return user;
  }

  async updateRole(
    id: string,
    dto: UpdateUserRoleDto,
    actorId: string,
    actorMinistryId?: string,
    actorRole = 'SUPER_ADMIN',
  ) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    this.assertCanManage(user, actorRole, actorMinistryId);
    this.assertCanAssignRole(dto.systemRole, actorRole);

    const updated = await (this.prisma as any).user.update({
      where: { id },
      data: { systemRole: dto.systemRole },
      select: {
        id: true,
        email: true,
        systemRole: true,
      },
    });

    await this.audit.log({
      action: 'USER_ROLE_UPDATED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description: `Updated user role to ${dto.systemRole}`,
      changes: { systemRole: dto.systemRole },
    });

    return updated;
  }

  /**
   * Admin edit of another user's details. Email is deliberately excluded: it
   * is the login identity and is domain-gated at creation.
   */
  async updateDetails(
    id: string,
    dto: { name?: string; jobTitle?: string },
    actorId: string,
    actorMinistryId?: string,
    actorRole = 'SUPER_ADMIN',
  ) {
    const user = await (this.prisma as any).user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    this.assertCanManage(user, actorRole, actorMinistryId);

    const updated = await (this.prisma as any).user.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.jobTitle !== undefined && { jobTitle: dto.jobTitle }),
      },
      select: { id: true, email: true, name: true, jobTitle: true },
    });

    await this.audit.log({
      action: 'USER_UPDATED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: id,
      entityName: updated.email,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description: `Updated user details: ${updated.email}`,
      changes: dto,
    });

    return updated;
  }

  /** Re-issues an invitation for a user who hasn't set a password yet. */
  async reissueInvite(
    id: string,
    actorId: string,
    actorMinistryId?: string,
    actorRole = 'SUPER_ADMIN',
  ) {
    const user = await (this.prisma as any).user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    this.assertCanManage(user, actorRole, actorMinistryId);

    return this.invites.issue(id, actorId, actorMinistryId || 'SYSTEM');
  }

  /** Reversible access toggle. Replaces the previous one-way deactivate. */
  async setActive(
    id: string,
    active: boolean,
    actorId: string,
    actorMinistryId?: string,
    actorRole = 'SUPER_ADMIN',
  ) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    this.assertCanManage(user, actorRole, actorMinistryId);

    const updated = await (this.prisma as any).user.update({
      where: { id },
      data: { active },
      select: {
        id: true,
        email: true,
        active: true,
      },
    });

    await this.audit.log({
      action: active ? 'USER_REACTIVATED' : 'USER_DEACTIVATED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description: `${active ? 'Reactivated' : 'Deactivated'} user: ${user.email}`,
      changes: { active },
    });

    return updated;
  }

  async anonymize(
    id: string,
    actorId: string,
    actorMinistryId?: string,
    actorRole = 'SUPER_ADMIN',
  ) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    this.assertCanManage(user, actorRole, actorMinistryId);

    const anonEmail = `anonymous-${uuid()}@ministry.local`;

    const updated = await (this.prisma as any).user.update({
      where: { id },
      data: {
        email: anonEmail,
        name: 'Anonymous',
        jobTitle: '',
        deletedAt: new Date(),
      },
    });

    await (this.prisma as any).account.deleteMany({
      where: { userId: id },
    });

    await (this.prisma as any).attendance.updateMany({
      where: { userId: id },
      data: {
        signedName: 'Anonymous',
        signature: '',
        lat: null,
        lng: null,
      },
    });

    await (this.prisma as any).notification.deleteMany({
      where: { userId: id },
    });

    await this.audit.log({
      action: 'USER_ANONYMIZED',
      actionCategory: 'GDPR_COMPLIANCE',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description: `Anonymized user data (GDPR right-to-be-forgotten): ${user.email}`,
    });

    return {
      id: updated.id,
      anonymized: true,
      timestamp: updated.deletedAt,
    };
  }

  private generateTempPassword(): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
    let password = '';
    for (let i = 0; i < 12; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}
