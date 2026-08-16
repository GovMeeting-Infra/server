import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateActionItemDto } from './dto/create-action-item.dto';
import {
  UpdateActionItemDto,
  ActionItemStatusEnum,
} from './dto/update-action-item.dto';
import {
  ministryScope,
  assertSameMinistry,
} from '../common/utils/ministry-scope.util';

@Injectable()
export class ActionItemsService {
  private logger = new Logger('ActionItemsService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private cache: CacheService,
    private notifications: NotificationsService,
  ) {}

  async createActionItem(
    minutesId: string,
    dto: CreateActionItemDto,
    userId: string,
    ministryId: string,
    systemRole?: string,
  ) {
    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { id: minutesId },
      include: { event: true },
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    // The record is frozen, so nothing new can be attached to it.
    if (minutes.status === 'ARCHIVED') {
      throw new ForbiddenException(
        'These minutes have been archived and can no longer be changed',
      );
    }

    // The caller's ministry was never checked against the minutes' own — only
    // @Roles, which is role-only. updateStatus has always done this; without it
    // here, knowing an eventId was enough to file work against another ministry.
    assertSameMinistry(
      { systemRole: systemRole ?? '', ministryId },
      minutes.event.ministryId,
    );

    let ownerId: string | null = null;
    let ownerName = dto.ownerName ?? null;
    let ownerEmail = dto.ownerEmail?.trim().toLowerCase() ?? null;

    if (dto.ownerId) {
      const owner = await this.resolveOwner(dto.ownerId, ministryId);
      ownerId = owner.id;
      ownerName = owner.name;
      ownerEmail = owner.email;
    } else if (ownerEmail) {
      // Email is the reliable key — the name match below is a fallback for
      // minutes typed up from paper. Mirrors manualCheckIn: resolve to an
      // account when one exists, otherwise keep the raw details so the person
      // can still be reached and the item still reads correctly.
      const owner = await (this.prisma as any).user.findFirst({
        where: { email: ownerEmail, active: true, deletedAt: null },
        select: { id: true, name: true, email: true, ministryId: true },
      });

      if (owner) {
        // The same bar resolveOwner applies. Without it, addressing someone by
        // email instead of picking them was a way around the cross-ministry
        // rule — and silently recording them as an external owner would not
        // help, since they would still be emailed the work.
        if (owner.ministryId !== ministryId) {
          throw new ForbiddenException(
            'Action items can only be assigned within the ministry that owns the meeting',
          );
        }
        ownerId = owner.id;
        ownerName = owner.name;
        ownerEmail = owner.email;
      }
    } else if (dto.ownerName) {
      // Name matching is a fallback for minutes typed up from paper. It is
      // deliberately exact rather than the substring match this used to do:
      // "contains" took the first partial hit, so "Kallon" could silently
      // assign the work to the wrong Kallon.
      const owner = await (this.prisma as any).user.findFirst({
        where: {
          ministryId,
          active: true,
          deletedAt: null,
          name: { equals: dto.ownerName.trim(), mode: 'insensitive' },
        },
        select: { id: true, name: true },
      });

      if (owner) {
        ownerId = owner.id;
        ownerName = owner.name;
      } else {
        // Recorded against the name alone, so the minutes still read correctly
        // even though nobody's board picks it up.
        this.logger.warn(
          `No exact match for owner "${dto.ownerName}" in ministry ${ministryId}; item left unassigned`,
        );
      }
    }

    const actionItem = await (this.prisma as any).actionItem.create({
      data: {
        minutesId,
        title: dto.title,
        description: dto.description,
        ownerId,
        dueDate: new Date(dto.dueDate),
        status: 'TODO',
        point: dto.point || 'ACTION_POINT',
        ownerName,
        ownerEmail,
        assignedById: userId,
      },
    });

    await this.audit.log({
      action: 'ACTION_ITEM_CREATED',
      actionCategory: 'ACTION_ITEM_MANAGEMENT',
      entityType: 'ActionItem',
      entityId: actionItem.id,
      entityName: actionItem.title,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Created action item: ${actionItem.title} for minutes of event: ${minutes.event.title}`,
    });

    await this.cache.invalidateAnalytics();

    // Reaches an account holder in-app and by email, and an owner with no
    // account by email alone.
    await this.notifications.notifyActionItemAssigned(actionItem.id);

    return actionItem;
  }

  /**
   * Confirms an owner is a real, usable account in the item's own ministry.
   *
   * Assigning work across ministries would leak the item into an inbox on the
   * other side of a boundary the rest of the app enforces carefully.
   */
  private async resolveOwner(ownerId: string, ministryId: string) {
    const owner = await (this.prisma as any).user.findFirst({
      where: { id: ownerId, active: true, deletedAt: null },
      select: { id: true, name: true, email: true, ministryId: true },
    });

    if (!owner) {
      throw new NotFoundException('No active user with that ID');
    }

    if (owner.ministryId !== ministryId) {
      throw new ForbiddenException(
        'Action items can only be assigned within the ministry that owns the meeting',
      );
    }

    return owner;
  }

  /** Roles that may move any action item within their ministry. */
  private static readonly ADMIN_ROLES = [
    'SUPER_ADMIN',
    'MINISTER',
    'MINISTRY_ADMIN',
  ];

  async updateStatus(
    actionItemId: string,
    dto: UpdateActionItemDto,
    userId: string,
    ministryId: string,
    systemRole?: string,
  ) {
    const actionItem = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      include: {
        minutes: {
          include: { event: true },
        },
        assistants: { select: { userId: true } },
        // The outgoing owner, so a reassignment can tell them it is no longer
        // theirs — the row is overwritten a few lines below.
        owner: {
          select: { id: true, name: true, email: true, ministryId: true },
        },
      },
    });

    if (!actionItem) {
      throw new NotFoundException('Action item not found');
    }

    // This method previously performed no authorization at all: any signed-in
    // user could edit any action item by id, across ministries. The owning
    // ministry comes from the item's source event.
    assertSameMinistry(
      { systemRole: systemRole ?? '', ministryId },
      actionItem.minutes.event.ministryId,
    );

    const isOwner = actionItem.ownerId === userId;
    const isAdmin = ActionItemsService.ADMIN_ROLES.includes(systemRole ?? '');
    // Whoever raised the item can still manage it. Without this an unassigned
    // item is untouchable by everyone except a ministry admin — including the
    // person who just created it, who cannot even assign an owner to it.
    const isCreator = actionItem.assignedById === userId;
    const isAssistant = actionItem.assistants?.some(
      (a: { userId: string }) => a.userId === userId,
    );

    if (!isOwner && !isAdmin && !isCreator && !isAssistant) {
      throw new ForbiddenException(
        'Only the assigned owner, the person who raised it, or a ministry admin can change this action item',
      );
    }

    // An assistant is doing the work and reporting on it; they do not decide
    // what the work is. Deliberately the same narrow set a guest may write
    // through their minutes link, because it is the same idea.
    if (isAssistant && !isOwner && !isAdmin && !isCreator) {
      const permitted = new Set(['status', 'progressNotes', 'progressLink']);
      const overreach = Object.keys(dto).filter(
        (key) => dto[key as keyof UpdateActionItemDto] !== undefined && !permitted.has(key),
      );

      if (overreach.length) {
        throw new ForbiddenException(
          'As an assistant you can update the status and record progress, but not change the task itself. Ask the owner.',
        );
      }
    }

    const updateData: any = {};

    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.progressNotes !== undefined)
      updateData.progressNotes = dto.progressNotes;
    if (dto.progressLink !== undefined)
      updateData.progressLink = dto.progressLink;
    if (dto.priority !== undefined) updateData.priority = dto.priority;

    if (dto.dueDate !== undefined) {
      const next = new Date(dto.dueDate);
      updateData.dueDate = next;
      // Re-arm the reminder. The stamp is what the 08:00 cron filters on, and
      // it was never cleared, so rescheduling an item guaranteed it would never
      // be reminded about again.
      if (next.getTime() !== actionItem.dueDate.getTime()) {
        updateData.reminderSentAt = null;
      }
    }

    // Undefined means "leave alone"; null means "unassign".
    const reassigning = dto.ownerId !== undefined;
    if (reassigning) {
      if (dto.ownerId === null) {
        updateData.ownerId = null;
        updateData.ownerName = null;
        updateData.ownerEmail = null;
      } else {
        const owner = await this.resolveOwner(
          dto.ownerId as string,
          actionItem.minutes.event.ministryId,
        );
        updateData.ownerId = owner.id;
        // Kept in step with the account so the free-text fields cannot drift
        // into naming somebody other than the actual owner.
        updateData.ownerName = owner.name;
        updateData.ownerEmail = owner.email;
      }
    } else if (dto.ownerEmail !== undefined) {
      // Reassigning to someone with no account: keep the details, drop any
      // account link so the two cannot disagree about who owns this.
      updateData.ownerEmail = dto.ownerEmail?.trim().toLowerCase() ?? null;
      updateData.ownerId = null;
      if (dto.ownerName !== undefined) updateData.ownerName = dto.ownerName;
    }

    if (dto.status) {
      updateData.status = dto.status;
      if (dto.status === ActionItemStatusEnum.COMPLETED) {
        updateData.completedAt = new Date();
      } else {
        updateData.completedAt = null;
      }
    }

    const updated = await (this.prisma as any).actionItem.update({
      where: { id: actionItemId },
      data: updateData,
    });

    await this.audit.log({
      action: 'ACTION_ITEM_UPDATED',
      actionCategory: 'ACTION_ITEM_MANAGEMENT',
      entityType: 'ActionItem',
      entityId: actionItem.id,
      entityName: actionItem.title,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Updated action item: ${actionItem.title}`,
      changes: dto as unknown as Record<string, unknown>,
    });

    await this.cache.invalidateAnalytics();

    // A new owner is told they have been given the item; that is more useful
    // than also telling them its status changed in the same breath.
    if (
      reassigning &&
      updated.ownerId &&
      updated.ownerId !== actionItem.ownerId
    ) {
      await this.notifications.notifyActionItemAssigned(actionItemId);

      // The other half of a reassignment. The new owner has always been told;
      // the person it was taken from was told nothing at all, so an item
      // simply disappeared off their board.
      const previousEmail = actionItem.owner?.email ?? actionItem.ownerEmail;
      if (previousEmail) {
        await this.notifications.notifyActionItemUnassigned(
          actionItemId,
          {
            id: actionItem.ownerId ?? null,
            name: actionItem.owner?.name ?? actionItem.ownerName ?? 'Colleague',
            email: previousEmail,
            ministryId: actionItem.owner?.ministryId ?? null,
          },
          updated.ownerName ?? null,
        );
      }
    } else if (dto.status === ActionItemStatusEnum.COMPLETED) {
      // Everyone with a stake in the work: the owner, whoever raised it, the
      // people helping, and the organizer of the meeting it came from.
      await this.notifications.notifyActionItemCompleted(actionItemId, userId);
    } else if (
      dto.status &&
      actionItem.ownerId &&
      actionItem.ownerId !== userId
    ) {
      // Only when the status actually moved, and never back to the person who
      // moved it — telling someone what they just did is noise.
      await this.notifications.notifyActionItemStatusChanged(
        actionItemId,
        dto.status,
      );
    }

    return updated;
  }

  async getActionItem(actionItemId: string) {
    const actionItem = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        assignedBy: { select: { id: true, name: true, email: true } },
        assistants: {
          select: {
            id: true,
            userId: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
      },
    });

    if (!actionItem) {
      throw new NotFoundException('Action item not found');
    }

    return actionItem;
  }

  async listByMinutes(minutesId: string) {
    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { id: minutesId },
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    return await (this.prisma as any).actionItem.findMany({
      where: { minutesId },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        assignedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    });
  }

  /**
   * Every action item across the actor's ministry, with its source event.
   * Until now action items were only reachable per-event, so nothing could
   * render a cross-event task board.
   */
  async listForMinistry(
    user: { id: string; systemRole: string; ministryId?: string },
    ownerId?: string,
  ) {
    const scope = ministryScope(user);

    return await (this.prisma as any).actionItem.findMany({
      where: {
        // Action items have no ministry of their own; they inherit it from the
        // event their minutes belong to.
        minutes: { event: scope },
        ...(ownerId && { ownerId }),
      },
      include: {
        owner: { select: { id: true, name: true, email: true } },
        assignedBy: { select: { id: true, name: true, email: true } },
        assistants: {
          select: {
            id: true,
            userId: true,
            user: { select: { id: true, name: true, email: true } },
          },
        },
        minutes: {
          select: {
            id: true,
            event: { select: { id: true, title: true, ministryId: true } },
          },
        },
      },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    });
  }

  async listByUser(userId: string) {
    return await (this.prisma as any).actionItem.findMany({
      where: { ownerId: userId },
      include: {
        minutes: { include: { event: true } },
        owner: { select: { id: true, name: true, email: true } },
      },
      orderBy: [{ status: 'asc' }, { dueDate: 'asc' }],
    });
  }

  /**
   * Whoever may already manage the item may recruit help for it.
   *
   * Assistants deliberately cannot: a helper who can add helpers is a second
   * owner by another name, and the point of this table is that exactly one
   * person stays answerable.
   */
  private async assertCanManage(
    actionItemId: string,
    userId: string,
    ministryId: string,
    systemRole?: string,
  ) {
    const item = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      include: { minutes: { include: { event: true } } },
    });

    if (!item) throw new NotFoundException('Action item not found');

    assertSameMinistry(
      { systemRole: systemRole ?? '', ministryId },
      item.minutes.event.ministryId,
    );

    const allowed =
      item.ownerId === userId ||
      item.assignedById === userId ||
      ActionItemsService.ADMIN_ROLES.includes(systemRole ?? '');

    if (!allowed) {
      throw new ForbiddenException(
        'Only the owner, the person who raised it, or a ministry admin can change who is helping',
      );
    }

    return item;
  }

  async addAssistant(
    actionItemId: string,
    assistantUserId: string,
    userId: string,
    ministryId: string,
    systemRole?: string,
  ) {
    const item = await this.assertCanManage(
      actionItemId,
      userId,
      ministryId,
      systemRole,
    );

    // Same rule as assigning an owner: help comes from within the ministry
    // that owns the meeting, and resolveOwner is where that already lives.
    const assistant = await this.resolveOwner(
      assistantUserId,
      item.minutes.event.ministryId,
    );

    if (assistant.id === item.ownerId) {
      throw new BadRequestException(
        'That person already owns this action item',
      );
    }

    await (this.prisma as any).actionItemAssistant.upsert({
      where: {
        actionItemId_userId: { actionItemId, userId: assistant.id },
      },
      update: {},
      create: { actionItemId, userId: assistant.id, addedById: userId },
    });

    await this.audit.log({
      action: 'ACTION_ITEM_ASSISTANT_ADDED',
      actionCategory: 'ACTION_ITEM_MANAGEMENT',
      entityType: 'ActionItem',
      entityId: actionItemId,
      entityName: item.title,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Asked ${assistant.name} to help with: ${item.title}`,
    });

    // Being asked to help is news, and the assignment notification already
    // says the right thing.
    try {
      await this.notifications.notifyActionItemAssigned(actionItemId);
    } catch (error) {
      this.logger.error(
        `Could not notify assistant: ${(error as Error).message}`,
      );
    }

    return this.getActionItem(actionItemId);
  }

  async removeAssistant(
    actionItemId: string,
    assistantUserId: string,
    userId: string,
    ministryId: string,
    systemRole?: string,
  ) {
    const item = await this.assertCanManage(
      actionItemId,
      userId,
      ministryId,
      systemRole,
    );

    await (this.prisma as any).actionItemAssistant.deleteMany({
      where: { actionItemId, userId: assistantUserId },
    });

    await this.audit.log({
      action: 'ACTION_ITEM_ASSISTANT_REMOVED',
      actionCategory: 'ACTION_ITEM_MANAGEMENT',
      entityType: 'ActionItem',
      entityId: actionItemId,
      entityName: item.title,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Removed a helper from: ${item.title}`,
    });

    return this.getActionItem(actionItemId);
  }

  async listDueSoon(ministryId: string, hoursAhead = 24) {
    const now = new Date();
    const futureDate = new Date(now.getTime() + hoursAhead * 60 * 60 * 1000);

    return await (this.prisma as any).actionItem.findMany({
      where: {
        status: { not: ActionItemStatusEnum.COMPLETED },
        dueDate: {
          gte: now,
          lte: futureDate,
        },
        owner: { ministryId },
      },
      include: {
        minutes: { include: { event: true } },
        owner: { select: { id: true, name: true, email: true } },
      },
      orderBy: { dueDate: 'asc' },
    });
  }
}
