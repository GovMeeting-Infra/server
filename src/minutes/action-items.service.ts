import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateActionItemDto } from './dto/create-action-item.dto';
import { UpdateActionItemDto, ActionItemStatusEnum } from './dto/update-action-item.dto';

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

  async updateStatus(
    actionItemId: string,
    dto: UpdateActionItemDto,
    userId: string,
    ministryId: string,
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
