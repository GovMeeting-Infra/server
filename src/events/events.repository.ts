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
        series: true,
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
          _count: { select: { attendees: true } },
        },
      }),
      (this.prisma as any).event.count({ where }),
    ]);

    return { data, total };
  }

  async update(id: string, data: any) {
    return (this.prisma as any).event.update({
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
