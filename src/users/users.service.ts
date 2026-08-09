import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserDetailsDto } from './dto/update-user-details.dto';
import {
  ministryScope,
  assertSameMinistry,
} from '../common/utils/ministry-scope.util';
// `auth` and better-auth's hashPassword used to be imported here, from when
// this service set passwords itself. Users now set their own from an invitation
// link, so both were dead — and they dragged better-auth's ESM build and
// auth.config's database pool into anything that imported this file, tests
// included.
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
    userId: string,
    userMinistryId?: string,
    userSystemRole?: string,
  ) {
    if (dto.systemRole === 'SUPER_ADMIN' && userMinistryId) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN can create SUPER_ADMIN users',
      );
    }

    const email = dto.email.toLowerCase().trim();
    const ministryId = await this.resolveTargetMinistry(
      dto,
      email,
      userMinistryId,
      userSystemRole,
    );

    try {
      const user = await (this.prisma as any).user.create({
        data: {
          email,
          name: dto.name,
          jobTitle: dto.jobTitle,
          systemRole: dto.systemRole,
          ministryId,
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

  /**
   * Ends every session this user holds, without touching the account itself.
   *
   * For the case where access must stop now but the person is not leaving — a
   * lost phone, a shared laptop, a suspected compromise. Deactivating them
   * would also do it, but that is a different statement to make about someone.
   */
  async revokeSessions(
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

    const { count } = await (this.prisma as any).session.deleteMany({
      where: { userId: id },
    });

    await this.audit.log({
      action: 'USER_SESSIONS_REVOKED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description: `Signed out ${user.email} on all devices (${count} session${count === 1 ? '' : 's'})`,
    });

    return { revoked: count };
  }

  /**
   * Releases a lockout immediately.
   *
   * Five wrong passwords locks an account for 15 minutes. That is the right
   * default against someone guessing, and the wrong one for a minister who
   * mistyped their password before a meeting starts, with nobody able to help.
   */
  async unlock(
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

    const wasLocked =
      user.lockedUntil !== null && new Date(user.lockedUntil) > new Date();

    await (this.prisma as any).user.update({
      where: { id },
      data: { lockedUntil: null, loginAttempts: 0 },
    });

    await this.audit.log({
      action: 'USER_UNLOCKED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description: wasLocked
        ? `Unlocked ${user.email} before the lockout expired`
        : `Reset the failed sign-in count for ${user.email}`,
    });

    return { unlocked: true, wasLocked };
  }

  /**
   * Decides which ministry a new user belongs to, and checks their email is
   * allowed there.
   *
   * Mirrors the override in RoomsService.createRoom and EventsService
   * .createEvent: only a super admin may file a record under another ministry,
   * and the target has to exist. A super admin has no ministry of its own, so
   * for them the field is required rather than optional.
   */
  private async resolveTargetMinistry(
    dto: CreateUserDto,
    email: string,
    actorMinistryId?: string,
    actorSystemRole?: string,
  ): Promise<string | null> {
    // Super admins are platform-wide and deliberately hold no ministry.
    if (dto.systemRole === 'SUPER_ADMIN') {
      return null;
    }

    const isSuperAdmin = actorSystemRole === 'SUPER_ADMIN';

    if (dto.ministryId && !isSuperAdmin && dto.ministryId !== actorMinistryId) {
      throw new ForbiddenException(
        'Only a SUPER_ADMIN can create users in another ministry',
      );
    }

    const targetMinistryId = isSuperAdmin
      ? dto.ministryId
      : dto.ministryId || actorMinistryId;

    if (!targetMinistryId) {
      throw new BadRequestException(
        'ministryId is required when creating a user as a SUPER_ADMIN',
      );
    }

    const ministry = await (this.prisma as any).ministry.findUnique({
      where: { id: targetMinistryId },
      select: { id: true, active: true, emailDomain: true, name: true },
    });

    if (!ministry) {
      throw new NotFoundException(`Ministry ${targetMinistryId} not found`);
    }

    if (!ministry.active) {
      throw new BadRequestException(
        `${ministry.name} is deactivated — its users cannot sign in`,
      );
    }

    // PRD §8: the address must sit under the ministry's own domain, not merely
    // under .gov.sl. The leading dot stops "notmoh.gov.sl" passing as
    // "moh.gov.sl".
    const domain = String(ministry.emailDomain).toLowerCase();
    if (!email.endsWith(`@${domain}`) && !email.endsWith(`.${domain}`)) {
      throw new BadRequestException(
        `Email must be on the ${ministry.name} domain (@${domain})`,
      );
    }

    return ministry.id;
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
        // So the list can offer Unlock only where it means something.
        lockedUntil: true,
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
    dto: UpdateUserDetailsDto,
    actorId: string,
    actorMinistryId?: string,
    actorRole = 'SUPER_ADMIN',
  ) {
    const user = await (this.prisma as any).user.findUnique({ where: { id } });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    this.assertCanManage(user, actorRole, actorMinistryId);

    const isSuperAdmin = actorRole === 'SUPER_ADMIN';

    if ((dto.ministryId || dto.email) && !isSuperAdmin) {
      throw new ForbiddenException(
        'Only a SUPER_ADMIN can change a user’s ministry or email',
      );
    }

    const transfer = await this.resolveTransfer(user, dto);

    const updated = await (this.prisma as any).user.update({
      where: { id },
      data: {
        ...(dto.name !== undefined && { name: dto.name }),
        ...(dto.jobTitle !== undefined && { jobTitle: dto.jobTitle }),
        ...(transfer.email !== undefined && { email: transfer.email }),
        ...(transfer.ministryId !== undefined && {
          ministryId: transfer.ministryId,
        }),
      },
      select: {
        id: true,
        email: true,
        name: true,
        jobTitle: true,
        ministryId: true,
      },
    });

    // The session payload carries ministryId and email, and every scoping
    // decision downstream trusts it. Leaving the old session alive would let
    // the user keep reading their previous ministry's data.
    if (transfer.ministryId !== undefined || transfer.email !== undefined) {
      await (this.prisma as any).session.deleteMany({ where: { userId: id } });
    }

    await this.audit.log({
      action: 'USER_UPDATED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: id,
      entityName: updated.email,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description:
        transfer.ministryId !== undefined
          ? `Moved ${user.email} to ${transfer.ministryName} as ${updated.email}`
          : `Updated user details: ${updated.email}`,
      changes: dto as unknown as Record<string, unknown>,
    });

    return updated;
  }

  /**
   * Works out the email and ministry a transfer lands on, and refuses the
   * combinations that would leave the account inconsistent.
   *
   * The domain rule and transfers collide: aminata@moh.gov.sl moving to
   * Education no longer satisfies med.gov.sl. Rather than quietly exempting
   * transfers from the rule that every other account obeys, the move has to
   * carry an address on the destination's domain.
   */
  private async resolveTransfer(
    user: { email: string; ministryId: string | null; systemRole: string },
    dto: UpdateUserDetailsDto,
  ): Promise<{
    email?: string;
    ministryId?: string;
    ministryName?: string;
  }> {
    const email = dto.email?.toLowerCase().trim();

    if (!dto.ministryId) {
      // An email change on its own still has to satisfy the ministry they are
      // already in.
      if (email && user.ministryId && user.systemRole !== 'SUPER_ADMIN') {
        const current = await this.requireMinistry(user.ministryId);
        this.assertEmailOnDomain(email, current);
      }
      return { email };
    }

    if (dto.ministryId === user.ministryId) {
      return { email };
    }

    const destination = await this.requireMinistry(dto.ministryId);

    if (!destination.active) {
      throw new BadRequestException(
        `${destination.name} is deactivated — reactivate it before moving anyone into it`,
      );
    }

    const finalEmail = email ?? user.email.toLowerCase();
    this.assertEmailOnDomain(finalEmail, destination, true);

    return {
      email,
      ministryId: destination.id,
      ministryName: destination.name,
    };
  }

  private async requireMinistry(id: string) {
    const ministry = await (this.prisma as any).ministry.findUnique({
      where: { id },
      select: { id: true, name: true, active: true, emailDomain: true },
    });

    if (!ministry) {
      throw new NotFoundException(`Ministry ${id} not found`);
    }

    return ministry;
  }

  private assertEmailOnDomain(
    email: string,
    ministry: { name: string; emailDomain: string },
    isTransfer = false,
  ): void {
    const domain = String(ministry.emailDomain).toLowerCase();

    if (email.endsWith(`@${domain}`) || email.endsWith(`.${domain}`)) {
      return;
    }

    throw new BadRequestException(
      isTransfer
        ? `Moving to ${ministry.name} needs an email on @${domain} — send the new address with the transfer`
        : `Email must be on the ${ministry.name} domain (@${domain})`,
    );
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

    // Deactivation only blocked the next sign-in before this. getSession now
    // refuses an inactive user as well, but ending the sessions here is what
    // makes "deactivate" take effect at the moment it is clicked.
    if (!active) {
      await (this.prisma as any).session.deleteMany({ where: { userId: id } });
    }

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

    // Deleting the credential stops them signing in again but does nothing to
    // the session they are holding right now, which is the one that matters
    // when an account is being erased.
    await (this.prisma as any).session.deleteMany({
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
