import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The check-in anchor is the organizer's physical location at the moment they
 * generated the QR code. These queries use `include` without a `select`, which
 * returns every scalar, so the coordinates must be omitted explicitly — they
 * belong only to the guarded checkin-code endpoint.
 *
 * `checkInAnchorSetAt` is deliberately kept: it is useful ("area set at 09:12")
 * and reveals nothing about where.
 */
const OMIT_ANCHOR = {
  checkInAnchorLat: true,
  checkInAnchorLng: true,
  checkInAnchorAccuracy: true,
  checkInAnchorSetById: true,
} as const;

@Injectable()
export class EventsRepository {
  constructor(private prisma: PrismaService) {}

  async create(data: any) {
    return (this.prisma as any).event.create({
      data,
      omit: OMIT_ANCHOR,
      include: {
        organizer: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async findOne(id: string) {
    return (this.prisma as any).event.findUnique({
      where: { id },
      omit: OMIT_ANCHOR,
      include: {
        organizer: { select: { id: true, name: true, email: true } },
        coOrganizers: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        invitedMinistries: { select: { id: true, name: true, code: true } },
        attendees: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        minutes: true,
        // The other dates too, so the page can say where this meeting sits in
        // its series and link to the ones either side. Bounded by
        // MAX_OCCURRENCES, and three small columns each.
        series: {
          include: {
            events: {
              select: { id: true, startAt: true, status: true },
              orderBy: { startAt: 'asc' },
            },
          },
        },
      },
    });
  }

  async findMany(where: any, skip: number, take: number, orderBy?: any) {
    const [data, total] = await Promise.all([
      (this.prisma as any).event.findMany({
        where,
        skip,
        take,
        orderBy: orderBy ?? { startAt: 'desc' },
        omit: OMIT_ANCHOR,
        include: {
          organizer: { select: { id: true, name: true } },
          // Just the ids, so a list card can tell whether the person reading it
          // may edit the event. Without this the card showed an Edit link on
          // every event to everyone, and the refusal only arrived on the page
          // it led to.
          coOrganizers: { select: { userId: true } },
          // attendances alongside attendees so a list row can say how many of
          // the invited have actually checked in, without a second request.
          _count: { select: { attendees: true, attendances: true } },
        },
      }),
      (this.prisma as any).event.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * `tx` so an update that has to happen alongside others — editing one
   * occurrence and shifting the rest of its series — shares their transaction
   * and their rollback. Going straight to the client instead would also lose
   * the anchor omission above, quietly putting the check-in coordinates into
   * the response.
   */
  async update(id: string, data: any, tx?: any) {
    return ((tx ?? this.prisma) as any).event.update({
      where: { id },
      data,
      omit: OMIT_ANCHOR,
      include: { organizer: true },
    });
  }

  async delete(id: string) {
    return (this.prisma as any).event.delete({ where: { id } });
  }
}
