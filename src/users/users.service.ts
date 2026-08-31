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
import { CacheService } from '../cache/cache.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserDetailsDto } from './dto/update-user-details.dto';
import {
  ministryScope,
  assertSameMinistry,
  PLATFORM_ROLES,
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
    private cache: CacheService,
  ) {}

  /** Roles that may administer other users. */
  private static readonly ADMIN_ROLES = [
    'SUPER_ADMIN',
    'PLATFORM_ADMIN',
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
    if (!PLATFORM_ROLES.includes(actorRole)) {
      if (PLATFORM_ROLES.includes(target.systemRole)) {
        // Deliberately vague. Naming the role would tell a ministry admin that
        // it exists, and the platform roles are not theirs to know about.
        throw new ForbiddenException('You cannot act on this account');
      }
      assertSameMinistry(
        { systemRole: actorRole, ministryId: actorMinistryId },
        target.ministryId ?? '',
      );
    }
  }

  /** A ministry admin must not be able to mint a peer above themselves. */
  /**
   * Who may hand out which role.
   *
   *   SUPER_ADMIN     nobody — the platform has exactly one, provisioned
   *                   directly against the database
   *   PLATFORM_ADMIN  the platform owner alone
   *   MINISTER        the owner and platform admins
   *   MINISTRY_ADMIN  those two, plus ministers and ministry admins
   *   STAFF           the same
   *
   * The split is provisioning versus appointment. Platform admins are engineers
   * who stand the platform up, so they create ministries and staff them —
   * including appointing a ministry's minister. What they cannot do is appoint
   * another of themselves: growing the set of people who can reach across every
   * ministry stays with the owner, or the role would be self-propagating.
   *
   * A minister is the administrator of their own ministry, so they administer
   * their people; they still cannot mint a second minister, which is enforced
   * separately by assertMinistryHasNoMinister. Staff never reach here — the
   * controller's @Roles keeps them out of user administration entirely.
   *
   * The DTOs already reject both platform roles, so those branches are
   * unreachable through HTTP. They stay because this method is the rule, and a
   * future caller that skips the DTO should meet it too.
   */
  private assertCanAssignRole(role: string, actorRole: string) {
    if (role === 'SUPER_ADMIN') {
      throw new ForbiddenException('That role cannot be assigned.');
    }
    if (role === 'PLATFORM_ADMIN' && actorRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'Only the platform owner can appoint a platform administrator',
      );
    }
    if (
      role === 'MINISTER' &&
      !PLATFORM_ROLES.includes(actorRole)
    ) {
      throw new ForbiddenException('You cannot appoint a minister');
    }
  }

  /**
   * You cannot do this to yourself.
   *
   * Deactivating your own account deletes your own sessions and signs you out
   * mid-request; erasing it anonymises you. Neither was blocked anywhere — not
   * in the UI, not here — so one mis-tap on an icon could lock a ministry's
   * only administrator out of their own ministry, recoverable solely by the
   * platform operator. The UI now hides both controls on the actor's own row,
   * and this exists because a hidden control is not a rule.
   */
  private assertNotSelf(targetId: string, actorId: string, action: string) {
    if (targetId === actorId) {
      throw new BadRequestException(
        `You cannot ${action} your own account. Ask another administrator to do it.`,
      );
    }
  }

  /**
   * One minister per ministry.
   *
   * The web app's role-change dialog has been stating this as a fact, and it
   * was not one: nothing checked it, so a second minister could be promoted
   * silently and nobody would find out until an audit. Naming the incumbent
   * matters — "already has a minister" sends someone hunting, and the answer is
   * something we already know.
   *
   * `exceptUserId` covers a no-op re-save of the sitting minister's own role.
   */
  private async assertMinistryHasNoMinister(
    ministryId: string | null,
    exceptUserId?: string,
  ) {
    if (!ministryId) return;

    const existing = await (this.prisma as any).user.findFirst({
      where: {
        ministryId,
        systemRole: 'MINISTER',
        deletedAt: null,
        ...(exceptUserId ? { id: { not: exceptUserId } } : {}),
      },
      select: { name: true },
    });

    if (existing) {
      throw new BadRequestException(
        `${existing.name} is already the minister for this ministry. A ministry has one minister, so change theirs first.`,
      );
    }
  }

  async create(
    dto: CreateUserDto,
    userId: string,
    userMinistryId?: string,
    userSystemRole?: string,
  ) {
    // One rule for both creating and promoting, rather than a second copy here
    // that can drift from the first.
    this.assertCanAssignRole(dto.systemRole, userSystemRole ?? 'STAFF');

    const email = dto.email.toLowerCase().trim();
    const ministryId = await this.resolveTargetMinistry(
      dto,
      email,
      userMinistryId,
      userSystemRole,
    );

    if (dto.systemRole === 'MINISTER') {
      await this.assertMinistryHasNoMinister(ministryId);
    }

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
        ministryId: userMinistryId ?? undefined,
        actorId: userId,
        description: `Created user: ${user.email}`,
      });

      await this.cache.invalidateAnalyticsFor(user.ministryId ?? null);

      const invite = await this.invites.issue(user.id, userId, userMinistryId);

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
      ministryId: actorMinistryId ?? undefined,
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
      ministryId: actorMinistryId ?? undefined,
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
    // No platform-role branch: assertCanAssignRole has already refused those
    // roles before anything reaches here, so every user created through this
    // path belongs to a ministry.
    //
    // The platform roles have no ministry of their own, so there is no "their"
    // ministry to default to — they must name one, and may name any.
    const isPlatformRole = PLATFORM_ROLES.includes(
      actorSystemRole ?? '',
    );

    if (dto.ministryId && !isPlatformRole && dto.ministryId !== actorMinistryId) {
      throw new ForbiddenException(
        'You can only create users in your own ministry',
      );
    }

    const targetMinistryId = isPlatformRole
      ? dto.ministryId
      : dto.ministryId || actorMinistryId;

    if (!targetMinistryId) {
      throw new BadRequestException(
        'Choose the ministry this user belongs to',
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
    const isOwner = user.systemRole === 'SUPER_ADMIN';
    const isPlatformRole = PLATFORM_ROLES.includes(user.systemRole);
    const scope = ministryScope(user);
    const q = filters.q?.trim();

    // The owner is never a manageable row, not even to itself. Platform admins
    // are hidden from everyone below them — a ministry admin has no business
    // knowing the role exists — but the owner must see them, since appointing
    // them is the owner's job and so is taking it back.
    const hiddenRoles = isOwner
      ? ['SUPER_ADMIN']
      : ['SUPER_ADMIN', 'PLATFORM_ADMIN'];

    const rows = await (this.prisma as any).user.findMany({
      where: {
        ...scope,
        // A role filter narrows the visible set; it does not widen it. Asking
        // for a hidden role by name used to replace this clause outright,
        // which handed anyone who could read the list a way to enumerate the
        // roles it was meant to conceal.
        systemRole:
          filters.role && !hiddenRoles.includes(filters.role)
            ? filters.role
            : { notIn: hiddenRoles },
        // Soft-deleted users are only visible to the platform roles.
        ...(isPlatformRole ? {} : { deletedAt: null }),
        ...(isPlatformRole && filters.ministryId
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
        // Whether they have ever set a password. A user is created without a
        // credential — they make their own from the invitation link — so the
        // absence of this row is what "invited but not yet accepted" means.
        // Bounded and id-only: no credential material leaves this method.
        accounts: {
          where: { providerId: 'credential' },
          select: { id: true },
          take: 1,
        },
        // How much evidence erasing this person would blank. Erasing rewrites
        // the signed name and wipes the signature and GPS on every attendance
        // row they ever signed, and the dialog that asks for confirmation could
        // not say how many that was. Counted here rather than behind its own
        // endpoint: the list is already loaded when the question gets asked.
        _count: { select: { attendances: true } },
      },
      orderBy: { email: 'asc' },
    });

    const expiries = await this.inviteExpiries(
      rows
        .filter((r: { accounts: unknown[] }) => r.accounts.length === 0)
        .map((r: { id: string }) => r.id),
    );

    return rows.map(
      ({ accounts, ...rest }: { accounts: unknown[]; id: string }) => ({
        ...rest,
        hasCredential: accounts.length > 0,
        // Only meaningful while they have no credential; null once accepted,
        // because setPassword deletes the token.
        inviteExpiresAt: expiries.get(rest.id) ?? null,
      }),
    );
  }

  /**
   * When each user's outstanding invitation lapses, keyed by user id.
   *
   * Verification has no relation to User — the invite is stored under the
   * identifier `invite:<userId>` — so this is a second query rather than an
   * include. One for the whole page, not one per row.
   */
  private async inviteExpiries(
    userIds: string[],
  ): Promise<Map<string, Date | null>> {
    if (userIds.length === 0) return new Map();

    const rows = await (this.prisma as any).verification.findMany({
      where: { identifier: { in: userIds.map((id) => `invite:${id}`) } },
      select: { identifier: true, expiresAt: true },
    });

    return new Map(
      rows.map((r: { identifier: string; expiresAt: Date }) => [
        r.identifier.slice('invite:'.length),
        r.expiresAt,
      ]),
    );
  }

  async findOne(
    id: string,
    actorMinistryId?: string,
    actorRole = 'SUPER_ADMIN',
  ) {
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

    // Every other method on this service scopes by ministry; this one read it
    // out unscoped, so a ministry admin who guessed an id could read a user
    // from another ministry. Cross-ministry leakage is a compliance failure
    // here, not a rough edge.
    this.assertCanManage(user, actorRole, actorMinistryId);

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

    if (dto.systemRole === 'MINISTER') {
      await this.assertMinistryHasNoMinister(user.ministryId, user.id);
    }

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
      ministryId: actorMinistryId ?? undefined,
      actorId,
      description: `Updated user role to ${dto.systemRole}`,
      changes: { systemRole: dto.systemRole },
    });

    await this.cache.invalidateAnalyticsFor(user.ministryId ?? null);

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

    // Deliberately narrower than creating a user. An email is a login
    // identity and a ministry decides what someone can see, so moving either
    // is closer to erasing an account than to provisioning one — it stays with
    // the owner, platform admins included.
    if ((dto.ministryId || dto.email) && actorRole !== 'SUPER_ADMIN') {
      throw new ForbiddenException(
        'You cannot change a user’s ministry or email address',
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
      ministryId: actorMinistryId ?? undefined,
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
      if (
        email &&
        user.ministryId &&
        !PLATFORM_ROLES.includes(user.systemRole)
      ) {
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

    return this.invites.issue(id, actorId, actorMinistryId);
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
    this.assertNotSelf(id, actorId, active ? 'reactivate' : 'deactivate');

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
      ministryId: actorMinistryId ?? undefined,
      actorId,
      description: `${active ? 'Reactivated' : 'Deactivated'} user: ${user.email}`,
      changes: { active },
    });

    await this.cache.invalidateAnalyticsFor(user.ministryId ?? null);

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
    this.assertNotSelf(id, actorId, 'erase');

    const anonEmail = `anonymous-${uuid()}@ministry.local`;

    const updated = await (this.prisma as any).user.update({
      where: { id },
      data: {
        email: anonEmail,
        name: 'Anonymous',
        jobTitle: '',
        // Both of these are personal data and neither was being cleared. A
        // profile photo is a face, so an "anonymised" account was still
        // showing one wherever an avatar renders; the phone number was still
        // dialable. Erasure has to reach every identifying column, not the
        // three that happen to appear on the user list.
        phone: null,
        image: null,
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
      ministryId: actorMinistryId ?? undefined,
      actorId,
      description: `Anonymized user data (GDPR right-to-be-forgotten): ${user.email}`,
    });

    await this.cache.invalidateAnalyticsFor(user.ministryId ?? null);

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
