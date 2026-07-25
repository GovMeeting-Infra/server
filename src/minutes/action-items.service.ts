import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateActionItemDto } from './dto/create-action-item.dto';
import { UpdateActionItemDto, ActionItemStatusEnum } from './dto/update-action-item.dto';
import { ministryScope, assertSameMinistry } from '../common/utils/ministry-scope.util';

@Injectable()
export class ActionItemsService {
  private logger = new Logger('ActionItemsService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
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

    let ownerId = dto.ownerId;

    if (dto.ownerName && !dto.ownerId) {
      const owner = await (this.prisma as any).user.findFirst({
        where: {
          ministryId,
          name: {
            contains: dto.ownerName,
            mode: 'insensitive',
          },
        },
      });

      if (owner) {
        ownerId = owner.id;
      } else {
        this.logger.warn(
          `Owner "${dto.ownerName}" not found in ministry ${ministryId}`,
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
        ownerName: dto.ownerName,
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

    return actionItem;
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

    if (!isOwner && !isAdmin) {
      throw new ForbiddenException(
        'Only the assigned owner or a ministry admin can change this action item',
      );
    }

    const updateData: any = {};

    if (dto.title !== undefined) updateData.title = dto.title;
    if (dto.description !== undefined) updateData.description = dto.description;
    if (dto.dueDate !== undefined) updateData.dueDate = new Date(dto.dueDate);

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
