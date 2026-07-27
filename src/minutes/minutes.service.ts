import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateMinutesDto } from './dto/create-minutes.dto';
import { UpdateMinutesDto } from './dto/update-minutes.dto';

@Injectable()
export class MinutesService {
  private logger = new Logger('MinutesService');
  private readonly EDIT_WINDOW_DAYS = 2;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
  ) {}

  async draftMinutes(
    eventId: string,
    dto: CreateMinutesDto,
    userId: string,
    ministryId: string,
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: { coOrganizers: true },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const canDraft =
      event.organizerId === userId ||
      event.coOrganizers?.some((c: any) => c.userId === userId);

    if (!canDraft) {
      throw new ForbiddenException('Only organizers can draft minutes');
    }

    let minutes = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
    });

    if (!minutes) {
      minutes = await (this.prisma as any).minutes.create({
        data: {
          eventId,
          body: dto.body,
          summary: dto.summary,
          status: 'DRAFT',
          draftedById: userId,
          draftedAt: new Date(),
        },
      });

      await this.audit.log({
        action: 'MINUTES_DRAFTED',
        actionCategory: 'MINUTES_MANAGEMENT',
        entityType: 'Minutes',
        entityId: minutes.id,
        entityName: event.title,
        status: 'SUCCESS',
        ministryId,
        actorId: userId,
        description: `Drafted minutes for event: ${event.title}`,
      });
    } else {
      minutes = await (this.prisma as any).minutes.update({
        where: { id: minutes.id },
        data: {
          body: dto.body,
          summary: dto.summary,
          draftedById: userId,
          draftedAt: new Date(),
        },
      });

      await this.audit.log({
        action: 'MINUTES_UPDATED',
        actionCategory: 'MINUTES_MANAGEMENT',
        entityType: 'Minutes',
        entityId: minutes.id,
        entityName: event.title,
        status: 'SUCCESS',
        ministryId,
        actorId: userId,
        description: `Updated minutes draft for event: ${event.title}`,
      });
    }

    return minutes;
  }

  async updateMinutes(
    eventId: string,
    dto: UpdateMinutesDto,
    userId: string,
    userRole: string,
    ministryId: string,
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: { coOrganizers: true },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const canEdit = await this.canEditMinutes(
      eventId,
      userId,
      userRole,
      ministryId,
    );

    if (!canEdit) {
      throw new ForbiddenException(
        'Edit window expired (2 days after event)',
      );
    }

    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    const updated = await (this.prisma as any).minutes.update({
      where: { id: minutes.id },
      data: {
        ...(dto.body && { body: dto.body }),
        ...(dto.summary && { summary: dto.summary }),
      },
    });

    await this.audit.log({
      action: 'MINUTES_EDITED',
      actionCategory: 'MINUTES_MANAGEMENT',
      entityType: 'Minutes',
      entityId: minutes.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Edited minutes for event: ${event.title}`,
      changes: dto as unknown as Record<string, unknown>,
    });

    return updated;
  }

  async publishMinutes(
    eventId: string,
    userId: string,
    ministryId: string,
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: {
        coOrganizers: true,
        attendees: true,
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const canPublish =
      event.organizerId === userId ||
      event.coOrganizers?.some((c: any) => c.userId === userId);

    if (!canPublish) {
      throw new ForbiddenException('Only organizers can publish minutes');
    }

    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    if (!minutes.body?.trim()) {
      throw new BadRequestException('Minutes body cannot be empty');
    }

    if (!event.attendees?.length) {
      throw new BadRequestException('Event must have attendees to publish');
    }

    const published = await (this.prisma as any).minutes.update({
      where: { id: minutes.id },
      data: {
        status: 'PUBLISHED',
        publishedById: userId,
        publishedAt: new Date(),
      },
    });

    await this.audit.log({
      action: 'MINUTES_PUBLISHED',
      actionCategory: 'MINUTES_MANAGEMENT',
      entityType: 'Minutes',
      entityId: minutes.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Published minutes for event: ${event.title}`,
    });

    // Attendees who have muted minutes notifications are filtered out inside
    // the service; this never throws, so a notification failure cannot undo a
    // publish that already succeeded.
    await this.notifications.notifyMinutesPublished(eventId);

    return published;
  }

  async canEditMinutes(
    eventId: string,
    userId: string,
    userRole: string,
    actorMinistryId?: string,
  ): Promise<boolean> {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: { coOrganizers: true },
    });

    if (!event) {
      return false;
    }

    // Without this a ministry admin could edit another ministry's minutes —
    // the role checks below are deliberately broad and carry no scope of their
    // own.
    if (
      userRole !== 'SUPER_ADMIN' &&
      actorMinistryId !== undefined &&
      event.ministryId !== actorMinistryId
    ) {
      return false;
    }

    const isOrganizerOrCoOrg =
      event.organizerId === userId ||
      event.coOrganizers?.some((c: any) => c.userId === userId);

    if (!isOrganizerOrCoOrg && !['MINISTER', 'MINISTRY_ADMIN'].includes(userRole)) {
      return false;
    }

    const editWindowEnd = new Date(
      event.endAt.getTime() + this.EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    if (new Date() > editWindowEnd && ['MINISTER', 'MINISTRY_ADMIN'].includes(userRole)) {
      return true;
    }

    return new Date() <= editWindowEnd;
  }

  async getMinutes(eventId: string) {
    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
      include: {
        actionItems: {
          orderBy: { createdAt: 'desc' },
        },
        draftedBy: { select: { id: true, name: true, email: true } },
        publishedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    return minutes;
  }
}
