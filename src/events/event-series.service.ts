import {
  Injectable,
  BadRequestException,
  Logger,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateEventSeriesDto } from './dto/create-event-series.dto';
import { UpdateEventDto } from './dto/update-event.dto';

@Injectable()
export class EventSeriesService {
  private logger = new Logger('EventSeriesService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async createSeries(
    dto: CreateEventSeriesDto,
    baseEvent: any,
    ministryId: string,
    actorId: string,
  ) {
    const series = await (this.prisma as any).eventSeries.create({
      data: {
        frequency: dto.frequency,
        interval: dto.interval || 1,
        endType: dto.endType,
        count: dto.count,
        until: dto.until ? new Date(dto.until) : null,
      },
    });

    const occurrences = this.generateOccurrences(baseEvent, series);

    await (this.prisma as any).event.createMany({
      data: occurrences,
    });

    await this.audit.log({
      action: 'EVENT_SERIES_CREATED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'EventSeries',
      entityId: series.id,
      entityName: `Series: ${baseEvent.title}`,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Created recurring event series: ${baseEvent.title} (${dto.frequency})`,
      metadata: {
        frequency: dto.frequency,
        interval: dto.interval || 1,
        endType: dto.endType,
        count: dto.count,
      },
    });

    return series;
  }

  private generateOccurrences(
    baseEvent: any,
    series: any,
  ): any[] {
    const occurrences: any[] = [];
    let currentDate = new Date(baseEvent.startAt);
    let count = 0;
    const maxOccurrences = series.count || 52;

    while (count < maxOccurrences) {
      if (series.until && currentDate > new Date(series.until)) break;

      const endDate = new Date(currentDate);
      const duration = baseEvent.endAt.getTime() - baseEvent.startAt.getTime();
      endDate.setTime(endDate.getTime() + duration);

      occurrences.push({
        title: baseEvent.title,
        description: baseEvent.description,
        startAt: new Date(currentDate),
        endAt: new Date(endDate),
        isPublic: baseEvent.isPublic,
        type: baseEvent.type,
        scope: baseEvent.scope,
        classification: baseEvent.classification,
        venueLat: baseEvent.venueLat,
        venueLng: baseEvent.venueLng,
        geofenceRadius: baseEvent.geofenceRadius,
        roomId: baseEvent.roomId,
        ministryId: baseEvent.ministryId,
        organizerId: baseEvent.organizerId,
        seriesId: series.id,
        status: 'DRAFT',
      });

      this.incrementDate(currentDate, series.frequency, series.interval || 1);
      count++;
    }

    return occurrences;
  }

  private incrementDate(date: Date, frequency: string, interval: number) {
    switch (frequency) {
      case 'DAILY':
        date.setDate(date.getDate() + interval);
        break;
      case 'WEEKLY':
        date.setDate(date.getDate() + 7 * interval);
        break;
      case 'WEEKDAYS':
        do {
          date.setDate(date.getDate() + 1);
        } while ([0, 6].includes(date.getDay()));
        break;
      case 'BIWEEKLY':
        date.setDate(date.getDate() + 14 * interval);
        break;
      case 'MONTHLY':
        date.setMonth(date.getMonth() + interval);
        break;
      case 'QUARTERLY':
        date.setMonth(date.getMonth() + 3 * interval);
        break;
      case 'YEARLY':
        date.setFullYear(date.getFullYear() + interval);
        break;
    }
  }

  async updateRecurring(
    eventId: string,
    dto: UpdateEventDto,
    scope: 'THIS' | 'FUTURE' | 'ALL',
    actorId: string,
    ministryId: string,
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new Error('Event not found');
    }

    if (!event.seriesId) {
      throw new BadRequestException('Not a recurring event');
    }

    if (event.organizerId !== actorId) {
      throw new ForbiddenException('Only event organizer can update');
    }

    let updateCount = 0;

    if (scope === 'THIS') {
      await (this.prisma as any).event.update({
        where: { id: eventId },
        data: dto,
      });
      updateCount = 1;
    } else if (scope === 'FUTURE') {
      const result = await (this.prisma as any).event.updateMany({
        where: {
          seriesId: event.seriesId,
          startAt: { gte: event.startAt },
        },
        data: dto,
      });
      updateCount = result.count;
    } else if (scope === 'ALL') {
      const result = await (this.prisma as any).event.updateMany({
        where: { seriesId: event.seriesId },
        data: dto,
      });
      updateCount = result.count;
    }

    await this.audit.log({
      action: 'EVENT_SERIES_UPDATED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Updated recurring event (${scope} scope): ${event.title}`,
      metadata: {
        scope,
        eventsUpdated: updateCount,
      },
    });

    return { updated: updateCount };
  }

  async deleteSeries(
    seriesId: string,
    scope: 'THIS' | 'FUTURE' | 'ALL',
    eventId: string,
    actorId: string,
    ministryId: string,
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new Error('Event not found');
    }

    if (event.organizerId !== actorId) {
      throw new ForbiddenException('Only event organizer can delete');
    }

    let deleteCount = 0;

    if (scope === 'THIS') {
      await (this.prisma as any).event.delete({
        where: { id: eventId },
      });
      deleteCount = 1;
    } else if (scope === 'FUTURE') {
      const result = await (this.prisma as any).event.deleteMany({
        where: {
          seriesId,
          startAt: { gte: event.startAt },
        },
      });
      deleteCount = result.count;
    } else if (scope === 'ALL') {
      const result = await (this.prisma as any).event.deleteMany({
        where: { seriesId },
      });
      deleteCount = result.count;
    }

    await this.audit.log({
      action: 'EVENT_SERIES_DELETED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'EventSeries',
      entityId: seriesId,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Deleted recurring event series (${scope} scope): ${event.title}`,
      metadata: {
        scope,
        eventsDeleted: deleteCount,
      },
    });

    return { deleted: deleteCount };
  }
}
