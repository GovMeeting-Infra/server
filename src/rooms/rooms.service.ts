import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';
import {
  ministryScope,
  assertSameMinistry,
} from '../common/utils/ministry-scope.util';

@Injectable()
export class RoomsService {
  private logger = new Logger('RoomsService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private cache: CacheService,
  ) {}

  async createRoom(
    dto: CreateRoomDto,
    ministryId: string,
    userId: string,
    systemRole?: string,
  ) {
    // Same shape as createEvent's override: only a super-admin may file the
    // record under another ministry, and the target must exist.
    const targetMinistryId =
      systemRole === 'SUPER_ADMIN' && dto.ministryId
        ? dto.ministryId
        : ministryId;

    if (systemRole === 'SUPER_ADMIN' && dto.ministryId) {
      const ministry = await (this.prisma as any).ministry.findUnique({
        where: { id: dto.ministryId },
        select: { id: true },
      });

      if (!ministry) {
        throw new NotFoundException(`Ministry ${dto.ministryId} not found`);
      }
    }

    // Removing a room only sets active: false, but the (ministryId, name)
    // unique index still holds the name. Without this, re-adding a removed
    // room fails with "already exists" while the room is nowhere on the page —
    // a dead end with no way out from the UI. Reactivate it instead.
    const removed = await (this.prisma as any).room.findFirst({
      where: { ministryId: targetMinistryId, name: dto.name, active: false },
    });

    if (removed) {
      const revived = await (this.prisma as any).room.update({
        where: { id: removed.id },
        data: {
          active: true,
          location: dto.location,
          capacity: dto.capacity,
          amenities: dto.amenities || [],
          latitude: dto.latitude,
          longitude: dto.longitude,
        },
      });

      await this.audit.log({
        action: 'ROOM_REACTIVATED',
        actionCategory: 'ROOM_MANAGEMENT',
        entityType: 'Room',
        entityId: revived.id,
        entityName: revived.name,
        status: 'SUCCESS',
        ministryId: targetMinistryId,
        actorId: userId,
        description: `Reactivated previously removed room: ${revived.name}`,
      });

      await this.cache.invalidateAnalytics();
      return revived;
    }

    try {
      const room = await (this.prisma as any).room.create({
        data: {
          ministryId: targetMinistryId,
          name: dto.name,
          location: dto.location,
          capacity: dto.capacity,
          amenities: dto.amenities || [],
          latitude: dto.latitude,
          longitude: dto.longitude,
        },
      });

      await this.audit.log({
        action: 'ROOM_CREATED',
        actionCategory: 'ROOM_MANAGEMENT',
        entityType: 'Room',
        entityId: room.id,
        entityName: room.name,
        status: 'SUCCESS',
        ministryId: targetMinistryId,
        actorId: userId,
        description: `Created room: ${room.name}`,
      });

      await this.cache.invalidateAnalytics();

      return room;
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new BadRequestException(
          `Room "${dto.name}" already exists in this ministry`,
        );
      }
      throw error;
    }
  }

  async getRooms(ministryId: string, systemRole?: string) {
    // Super-admins span ministries; everyone else sees only their own rooms.
    const scope = ministryScope({ systemRole: systemRole ?? '', ministryId });

    const rooms = await (this.prisma as any).room.findMany({
      where: { ...scope, active: true },
      orderBy: { name: 'asc' },
      include: {
        _count: {
          // Cancelling a booking is a soft delete (status CANCELLED), so an
          // unfiltered count would keep reporting cancelled bookings as live.
          select: {
            bookings: { where: { status: 'CONFIRMED' } },
            events: true,
          },
        },
      },
    });

    if (rooms.length === 0) return rooms;

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);

    // A filtered _count can't sit alongside the unfiltered one for the same
    // relation, so today's tally comes from one grouped query and is merged in
    // — still two queries total rather than one per room.
    const todayCounts = await (this.prisma as any).roomBooking.groupBy({
      by: ['roomId'],
      where: {
        roomId: { in: rooms.map((r: any) => r.id) },
        status: 'CONFIRMED',
        startTime: { gte: startOfToday, lt: endOfToday },
      },
      _count: { _all: true },
    });

    const byRoom = new Map<string, number>(
      todayCounts.map((c: any) => [c.roomId, c._count._all]),
    );

    return rooms.map((room: any) => ({
      ...room,
      bookingsToday: byRoom.get(room.id) ?? 0,
    }));
  }

  async getRoom(roomId: string, ministryId: string, systemRole?: string) {
    const room = await (this.prisma as any).room.findUnique({
      where: { id: roomId },
      include: {
        _count: {
          // Cancelling a booking is a soft delete (status CANCELLED), so an
          // unfiltered count would keep reporting cancelled bookings as live.
          select: {
            bookings: { where: { status: 'CONFIRMED' } },
            events: true,
          },
        },
      },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    assertSameMinistry(
      { systemRole: systemRole ?? '', ministryId },
      room.ministryId,
    );

    return room;
  }

  async updateRoom(
    roomId: string,
    dto: UpdateRoomDto,
    ministryId: string,
    userId: string,
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

    const updated = await (this.prisma as any).room.update({
      where: { id: roomId },
      data: {
        ...(dto.name && { name: dto.name }),
        ...(dto.location && { location: dto.location }),
        ...(dto.capacity !== undefined && { capacity: dto.capacity }),
        ...(dto.amenities && { amenities: dto.amenities }),
        ...(dto.latitude !== undefined && { latitude: dto.latitude }),
        ...(dto.longitude !== undefined && { longitude: dto.longitude }),
      },
    });

    await this.audit.log({
      action: 'ROOM_UPDATED',
      actionCategory: 'ROOM_MANAGEMENT',
      entityType: 'Room',
      entityId: room.id,
      entityName: room.name,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Updated room: ${room.name}`,
      changes: dto as unknown as Record<string, unknown>,
    });

    await this.cache.invalidateAnalytics();

    return updated;
  }

  async deactivateRoom(
    roomId: string,
    ministryId: string,
    userId: string,
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

    const updated = await (this.prisma as any).room.update({
      where: { id: roomId },
      data: { active: false },
    });

    await this.audit.log({
      action: 'ROOM_DEACTIVATED',
      actionCategory: 'ROOM_MANAGEMENT',
      entityType: 'Room',
      entityId: room.id,
      entityName: room.name,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Deactivated room: ${room.name}`,
    });

    await this.cache.invalidateAnalytics();

    return updated;
  }

  async checkAvailability(
    roomId: string,
    startTime: Date,
    endTime: Date,
    ministryId: string,
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

    const conflicts = await (this.prisma as any).roomBooking.findMany({
      where: {
        roomId,
        status: 'CONFIRMED',
        NOT: {
          OR: [
            { endTime: { lte: startTime } },
            { startTime: { gte: endTime } },
          ],
        },
      },
    });

    const eventConflicts = await (this.prisma as any).event.findMany({
      where: {
        roomId,
        NOT: {
          OR: [{ endAt: { lte: startTime } }, { startAt: { gte: endTime } }],
        },
      },
    });

    return {
      available: conflicts.length === 0 && eventConflicts.length === 0,
      bookingConflicts: conflicts.length,
      eventConflicts: eventConflicts.length,
    };
  }
}
