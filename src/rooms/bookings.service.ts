import {
  Injectable,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { BookRoomDto } from './dto/book-room.dto';
import { UpdateBookingDto } from './dto/update-booking.dto';
import { assertSameMinistry } from '../common/utils/ministry-scope.util';

@Injectable()
export class BookingsService {
  private logger = new Logger('BookingsService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private cache: CacheService,
  ) {}

  async bookRoom(
    dto: BookRoomDto,
    userId: string,
    ministryId: string,
    systemRole?: string,
  ) {
    const room = await (this.prisma as any).room.findUnique({
      where: { id: dto.roomId },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    assertSameMinistry(
      { systemRole: systemRole ?? '', ministryId },
      room.ministryId,
    );

    if (dto.attendeeCount > room.capacity) {
      throw new BadRequestException(
        `Attendee count (${dto.attendeeCount}) exceeds room capacity (${room.capacity})`,
      );
    }

    const startTime = new Date(dto.startTime);
    const endTime = new Date(dto.endTime);

    if (startTime >= endTime) {
      throw new BadRequestException('Start time must be before end time');
    }

    let booking;

    try {
      booking = await (this.prisma as any).$transaction(
        async (tx: any) => {
          const conflicts = await tx.roomBooking.findMany({
            where: {
              roomId: dto.roomId,
              status: 'CONFIRMED',
              NOT: {
                OR: [
                  { endTime: { lte: startTime } },
                  { startTime: { gte: endTime } },
                ],
              },
            },
          });

          if (conflicts.length > 0) {
            throw new Error('CONFLICT');
          }

          const eventConflicts = await tx.event.findMany({
            where: {
              roomId: dto.roomId,
              NOT: {
                OR: [
                  { endAt: { lte: startTime } },
                  { startAt: { gte: endTime } },
                ],
              },
            },
          });

          if (eventConflicts.length > 0) {
            throw new Error('CONFLICT');
          }

          return tx.roomBooking.create({
            data: {
              // The room's ministry, not the actor's — a super-admin booking
              // across ministries must file the booking against the ministry
              // that owns the room, or it disappears from that ministry's view.
              ministryId: room.ministryId,
              roomId: dto.roomId,
              userId,
              startTime,
              endTime,
              purpose: dto.purpose,
              attendeeCount: dto.attendeeCount,
              notes: dto.notes,
              status: 'CONFIRMED',
            },
          });
        },
        { isolationLevel: 'Serializable' as any, timeout: 5000 },
      );
    } catch (err: any) {
      if (err.message === 'CONFLICT') {
        throw new BadRequestException('Time slot just booked');
      }
      if (err.code === 'P2034') {
        throw new BadRequestException('Booking conflict; retry');
      }
      throw err;
    }

    await this.audit.log({
      action: 'BOOKING_CREATED',
      actionCategory: 'BOOKING_MANAGEMENT',
      entityType: 'RoomBooking',
      entityId: booking.id,
      entityName: `${room.name} - ${startTime.toISOString()}`,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Booked room: ${room.name} from ${startTime.toISOString()} to ${endTime.toISOString()}`,
    });

    await this.cache.invalidateAnalytics();

    return booking;
  }

  async getBooking(bookingId: string, ministryId: string, systemRole?: string) {
    const booking = await (this.prisma as any).roomBooking.findUnique({
      where: { id: bookingId },
      include: {
        room: true,
        bookedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    assertSameMinistry(
      { systemRole: systemRole ?? '', ministryId },
      booking.ministryId,
    );

    return booking;
  }

  async getBookingsByRoom(
    roomId: string,
    ministryId: string,
    startDate?: Date,
    endDate?: Date,
    systemRole?: string,
  ) {
    const room = await (this.prisma as any).room.findUnique({
      where: { id: roomId },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    assertSameMinistry(
      { systemRole: systemRole ?? '', ministryId },
      room.ministryId,
    );

    const where: any = {
      roomId,
      status: 'CONFIRMED',
    };

    if (startDate || endDate) {
      where.NOT = {
        OR: [],
      };
      if (endDate) {
        where.NOT.OR.push({ endTime: { lte: startDate || new Date() } });
      }
      if (startDate) {
        where.NOT.OR.push({ startTime: { gte: endDate || new Date() } });
      }
    }

    return await (this.prisma as any).roomBooking.findMany({
      where,
      include: {
        bookedBy: { select: { id: true, name: true, email: true } },
      },
      orderBy: { startTime: 'asc' },
    });
  }

  async getBookingsByUser(
    userId: string,
    ministryId: string,
    systemRole?: string,
  ) {
    return await (this.prisma as any).roomBooking.findMany({
      where: {
        userId,
        // Already scoped to the caller's own bookings, so the ministry filter
        // only serves to hide a super-admin's bookings in other ministries.
        ...(systemRole === 'SUPER_ADMIN' ? {} : { ministryId }),
        status: 'CONFIRMED',
      },
      include: {
        room: true,
      },
      orderBy: { startTime: 'asc' },
    });
  }

  async updateBooking(
    bookingId: string,
    dto: UpdateBookingDto,
    userId: string,
    ministryId: string,
    systemRole?: string,
  ) {
    const booking = await (this.prisma as any).roomBooking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    assertSameMinistry(
      { systemRole: systemRole ?? '', ministryId },
      booking.ministryId,
    );

    if (booking.userId !== userId) {
      throw new ForbiddenException('Can only update your own bookings');
    }

    const startTime = dto.startTime
      ? new Date(dto.startTime)
      : booking.startTime;
    const endTime = dto.endTime ? new Date(dto.endTime) : booking.endTime;

    if (startTime >= endTime) {
      throw new BadRequestException('Start time must be before end time');
    }

    let updated;
    try {
      updated = await (this.prisma as any).$transaction(
        async (tx: any) => {
          if (dto.startTime || dto.endTime) {
            const conflicts = await tx.roomBooking.findMany({
              where: {
                roomId: booking.roomId,
                id: { not: bookingId },
                status: 'CONFIRMED',
                NOT: {
                  OR: [
                    { endTime: { lte: startTime } },
                    { startTime: { gte: endTime } },
                  ],
                },
              },
            });

            if (conflicts.length > 0) {
              throw new Error('CONFLICT');
            }

            const eventConflicts = await tx.event.findMany({
              where: {
                roomId: booking.roomId,
                NOT: {
                  OR: [
                    { endAt: { lte: startTime } },
                    { startAt: { gte: endTime } },
                  ],
                },
              },
            });

            if (eventConflicts.length > 0) {
              throw new Error('CONFLICT');
            }
          }

          return tx.roomBooking.update({
            where: { id: bookingId },
            data: {
              ...(dto.startTime && { startTime }),
              ...(dto.endTime && { endTime }),
              ...(dto.purpose && { purpose: dto.purpose }),
              ...(dto.attendeeCount !== undefined && {
                attendeeCount: dto.attendeeCount,
              }),
              ...(dto.notes !== undefined && { notes: dto.notes }),
            },
          });
        },
        { isolationLevel: 'Serializable' as any, timeout: 5000 },
      );
    } catch (err: any) {
      if (err.message === 'CONFLICT') {
        throw new BadRequestException('Time slot just booked');
      }
      if (err.code === 'P2034') {
        throw new BadRequestException('Booking conflict; retry');
      }
      throw err;
    }

    await this.audit.log({
      action: 'BOOKING_UPDATED',
      actionCategory: 'BOOKING_MANAGEMENT',
      entityType: 'RoomBooking',
      entityId: booking.id,
      entityName: `Booking update`,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Updated booking ${bookingId}`,
      changes: dto as unknown as Record<string, unknown>,
    });

    await this.cache.invalidateAnalytics();

    return updated;
  }

  async cancelBooking(
    bookingId: string,
    userId: string,
    ministryId: string,
    systemRole?: string,
  ) {
    const booking = await (this.prisma as any).roomBooking.findUnique({
      where: { id: bookingId },
    });

    if (!booking) {
      throw new NotFoundException('Booking not found');
    }

    assertSameMinistry(
      { systemRole: systemRole ?? '', ministryId },
      booking.ministryId,
    );

    if (booking.userId !== userId) {
      throw new ForbiddenException('Can only cancel your own bookings');
    }

    const updated = await (this.prisma as any).roomBooking.update({
      where: { id: bookingId },
      data: {
        status: 'CANCELLED',
        cancelledAt: new Date(),
      },
    });

    await this.audit.log({
      action: 'BOOKING_CANCELLED',
      actionCategory: 'BOOKING_MANAGEMENT',
      entityType: 'RoomBooking',
      entityId: booking.id,
      entityName: `Booking cancelled`,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Cancelled booking ${bookingId}`,
    });

    await this.cache.invalidateAnalytics();

    return updated;
  }
}
