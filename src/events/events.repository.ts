import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class EventsRepository {
  constructor(private prisma: PrismaService) {}

  async create(data: any) {
    return (this.prisma as any).event.create({
      data,
      include: {
        organizer: { select: { id: true, name: true, email: true } },
      },
    });
  }

  async findOne(id: string) {
    return (this.prisma as any).event.findUnique({
      where: { id },
      include: {
        organizer: { select: { id: true, name: true, email: true } },
        coOrganizers: { include: { user: { select: { id: true, name: true, email: true } } } },
        invitedMinistries: { select: { id: true, name: true, code: true } },
        attendees: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
        minutes: true,
        room: true,
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
        include: {
          organizer: { select: { id: true, name: true } },
          _count: { select: { attendees: true } },
          room: { select: { id: true, name: true } },
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
      include: { organizer: true },
    });
  }

  async delete(id: string) {
    return (this.prisma as any).event.delete({ where: { id } });
  }

  async checkRoomConflicts(
    roomId: string,
    startAt: Date,
    endAt: Date,
    excludeEventId?: string,
  ) {
    return (this.prisma as any).$transaction(
      async (tx: any) => {
        return tx.event.findMany({
          where: {
            roomId,
            id: { not: excludeEventId },
            NOT: {
              OR: [
                { endAt: { lte: startAt } },
                { startAt: { gte: endAt } },
              ],
            },
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );
  }

  async getAvailableSlots(roomId: string, date: Date) {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const [bookings, events] = await Promise.all([
      (this.prisma as any).roomBooking.findMany({
        where: {
          roomId,
          status: 'CONFIRMED',
          startTime: { gte: dayStart, lte: dayEnd },
        },
      }),
      (this.prisma as any).event.findMany({
        where: {
          roomId,
          startAt: { gte: dayStart, lte: dayEnd },
        },
      }),
    ]);

    const slots: Array<{ start: Date; end: Date }> = [];
    let slotTime = new Date(dayStart);
    slotTime.setHours(7, 0, 0, 0);

    while (slotTime.getHours() < 19) {
      const slotEnd = new Date(slotTime.getTime() + 30 * 60 * 1000);

      const isBooked = [...bookings, ...events].some(
        (b) =>
          (b.startTime || b.startAt) < slotEnd &&
          (b.endTime || b.endAt) > slotTime,
      );

      if (!isBooked) {
        slots.push({ start: new Date(slotTime), end: new Date(slotEnd) });
      }

      slotTime.setMinutes(slotTime.getMinutes() + 30);
    }

    return slots;
  }
}
