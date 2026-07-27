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
import { UpdateActionItemDto, ActionItemStatusEnum } from './dto/update-action-item.dto';
import { ministryScope, assertSameMinistry } from '../common/utils/ministry-scope.util';

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
  ) {
    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { id: minutesId },
      include: { event: true },
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    let ownerId: string | null = null;
    let ownerName = dto.ownerName ?? null;

    if (dto.ownerId) {
      const owner = await this.resolveOwner(dto.ownerId, ministryId);
      ownerId = owner.id;
      ownerName = owner.name;
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

    // No-ops when owner resolution found nobody, which is the common case
    // today — the create form does not collect an owner.
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
      select: { id: true, name: true, ministryId: true },
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

    if (!isOwner && !isAdmin && !isCreator) {
      throw new ForbiddenException(
        'Only the assigned owner, the person who raised it, or a ministry admin can change this action item',
      );
    }

    const updateData: any = {};

    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.dueDate !== undefined) updateData.dueDate = new Date(dto.dueDate);

    // Undefined means "leave alone"; null means "unassign".
    const reassigning = dto.ownerId !== undefined;
    if (reassigning) {
      if (dto.ownerId === null) {
        updateData.ownerId = null;
        updateData.ownerName = null;
      } else {
        const owner = await this.resolveOwner(
          dto.ownerId as string,
          actionItem.minutes.event.ministryId,
        );
        updateData.ownerId = owner.id;
        // Kept in step with the account so the free-text field cannot drift
        // into naming somebody other than the actual owner.
        updateData.ownerName = owner.name;
      }
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
    if (reassigning && updated.ownerId && updated.ownerId !== actionItem.ownerId) {
      await this.notifications.notifyActionItemAssigned(actionItemId);
    } else if (dto.status && actionItem.ownerId && actionItem.ownerId !== userId) {
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
