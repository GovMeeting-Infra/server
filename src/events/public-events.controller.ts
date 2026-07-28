import { Controller, Get, Param, Query, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EventsService } from './events.service';

/**
 * Unauthenticated read-only access to the public events calendar.
 *
 * Deliberately carries no guards and no @Roles: RolesGuard only rejects when a
 * handler declares roles, so its absence is what makes these routes public.
 *
 * The { isPublic: true, status: 'PUBLISHED' } filter is the security boundary
 * for every query here. It belongs in the where clause rather than a post-hoc
 * filter, so an internal or draft event can never be returned — including by
 * id. No ministry scoping applies: this calendar spans government.
 */
@Controller('api/v1/public/events')
export class PublicEventsController {
  constructor(private prisma: PrismaService) {}

  private static readonly PUBLISHED_PUBLIC = {
    isPublic: true,
    status: 'PUBLISHED' as const,
  };

  @Get()
  async list(@Query('from') from?: string, @Query('to') to?: string) {
    const range = EventsService.parseRange(from, to);

    return (this.prisma as any).event.findMany({
      where: {
        ...PublicEventsController.PUBLISHED_PUBLIC,
        ...(range && { startAt: range }),
      },
      orderBy: { startAt: 'asc' },
      take: EventsService.RANGE_MAX,
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        colorCategory: true,
        type: true,
        venueName: true,
        bannerImage: true,
      },
    });
  }

  @Get(':id')
  async getOne(@Param('id') id: string) {
    const event = await (this.prisma as any).event.findFirst({
      where: {
        id,
        ...PublicEventsController.PUBLISHED_PUBLIC,
      },
      select: {
        id: true,
        title: true,
        description: true,
        startAt: true,
        endAt: true,
        colorCategory: true,
        type: true,
        venueName: true,
        bannerImage: true,
        contactEmail: true,
        contactPhone: true,
        externalUrl: true,
        ministry: { select: { name: true } },
      },
    });

    if (!event) {
      // Same response whether the event is missing, a draft, or internal —
      // don't disclose which.
      throw new NotFoundException('Event not found');
    }

    return event;
  }
}
