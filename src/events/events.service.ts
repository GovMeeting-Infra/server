import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { EventsRepository } from './events.repository';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { ministryScope, assertSameMinistry } from '../common/utils/ministry-scope.util';

@Injectable()
export class EventsService {
  private logger = new Logger('EventsService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private cache: CacheService,
    private eventsRepository: EventsRepository,
  ) {}

  async createEvent(
    dto: CreateEventDto,
    organizerId: string,
    ministryId: string,
  ) {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);

    if (startAt >= endAt) {
      throw new BadRequestException('Start time must be before end time');
    }

    if (dto.roomId) {
      const conflicts = await this.eventsRepository.checkRoomConflicts(
        dto.roomId,
        startAt,
        endAt,
      );

      if (conflicts.length > 0) {
        throw new ConflictException(
          'Room is already booked for this time period',
        );
      }
    }

    const event = await this.eventsRepository.create({
      ...dto,
      startAt,
      endAt,
      status: 'DRAFT',
      ministryId,
      organizerId,
    });

    await this.audit.log({
      action: 'EVENT_CREATED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId: organizerId,
      description: `Created event: ${event.title}`,
    });

    await this.cache.invalidatePattern(`events:*:${ministryId}`);

    return event;
  }

  async listEvents(
    ministryId: string,
    user: { systemRole: string; ministryId?: string },
    options: { page?: number; isPublic?: boolean } = {},
  ) {
    const where = {
      ...ministryScope(user),
      ...(options.isPublic !== undefined && { isPublic: options.isPublic }),
    };

    const page = Math.max(1, options.page || 1);
    const take = 20;
    const skip = (page - 1) * take;

    const cacheKey = `events:list:${ministryId}:${page}:${options.isPublic || 'all'}`;
    const cached = await this.cache.get(cacheKey);
    if (cached) return cached;

    const result = await this.eventsRepository.findMany(where, skip, take);

    await this.cache.setEvents(cacheKey, result);

    return result;
  }

  async getOne(id: string, user: { systemRole: string; ministryId?: string }) {
    const event = await this.eventsRepository.findOne(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    assertSameMinistry(user, event.ministryId);

    return event;
  }

  async updateEvent(
    id: string,
    dto: UpdateEventDto,
    actorId: string,
    ministryId: string,
  ) {
    const event = await this.eventsRepository.findOne(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    if (event.organizerId !== actorId) {
      throw new ForbiddenException('Only event organizer can update');
    }

    const updateData: any = { ...dto };

    if (dto.startAt || dto.endAt) {
      const startAt = dto.startAt ? new Date(dto.startAt) : event.startAt;
      const endAt = dto.endAt ? new Date(dto.endAt) : event.endAt;

      if (startAt >= endAt) {
        throw new BadRequestException('Start time must be before end time');
      }

      if (event.roomId) {
        const conflicts = await this.eventsRepository.checkRoomConflicts(
          event.roomId,
          startAt,
          endAt,
          id,
        );

        if (conflicts.length > 0) {
          throw new ConflictException(
            'Room conflict with the new time slot',
          );
        }
      }

      updateData.startAt = startAt;
      updateData.endAt = endAt;
    }

    const updated = await this.eventsRepository.update(id, updateData);

    await this.audit.log({
      action: 'EVENT_UPDATED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Updated event: ${event.title}`,
      changes: dto as unknown as Record<string, unknown>,
    });

    await this.cache.invalidatePattern(`events:*:${ministryId}`);

    return updated;
  }

  async deleteEvent(id: string, actorId: string, ministryId: string) {
    const event = await this.eventsRepository.findOne(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    if (event.organizerId !== actorId) {
      throw new ForbiddenException('Only event organizer can delete');
    }

    await this.eventsRepository.delete(id);

    await this.audit.log({
      action: 'EVENT_DELETED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Deleted event: ${event.title}`,
    });

    await this.cache.invalidatePattern(`events:*:${ministryId}`);
  }

  async publishEvent(id: string, actorId: string, ministryId: string) {
    const event = await this.eventsRepository.findOne(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    if (event.organizerId !== actorId) {
      throw new ForbiddenException('Only event organizer can publish');
    }

    const updated = await this.eventsRepository.update(id, {
      status: 'PUBLISHED',
      publishedAt: new Date(),
    });

    await this.audit.log({
      action: 'EVENT_PUBLISHED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Published event: ${event.title}`,
    });

    return updated;
  }

  async addCoOrganizer(
    eventId: string,
    userId: string,
    actorId: string,
    ministryId: string,
  ) {
    const event = await this.eventsRepository.findOne(eventId);

    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }

    if (event.organizerId !== actorId) {
      throw new ForbiddenException('Only event organizer can add co-organizers');
    }

    const coOrganizer = await (this.prisma as any).eventCoOrganizer.create({
      data: {
        eventId,
        userId,
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    await this.audit.log({
      action: 'COORGANIZER_ADDED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'EventCoOrganizer',
      entityId: coOrganizer.id,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Added co-organizer to event: ${event.title}`,
    });

    return coOrganizer;
  }
}
