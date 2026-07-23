import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateRoomDto } from './dto/create-room.dto';
import { UpdateRoomDto } from './dto/update-room.dto';

@Injectable()
export class RoomsService {
  private logger = new Logger('RoomsService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async createRoom(
    dto: CreateRoomDto,
    ministryId: string,
    userId: string,
  ) {
    try {
      const room = await (this.prisma as any).room.create({
        data: {
          ministryId,
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
        ministryId,
        actorId: userId,
        description: `Created room: ${room.name}`,
      });

      return room;
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new BadRequestException(`Room "${dto.name}" already exists in this ministry`);
      }
      throw error;
    }
  }

  async getRooms(ministryId: string) {
    return await (this.prisma as any).room.findMany({
      where: { ministryId, active: true },
      include: {
        _count: {
          select: { bookings: true, events: true },
        },
      },
    });
  }

  async getRoom(roomId: string, ministryId: string) {
    const room = await (this.prisma as any).room.findUnique({
      where: { id: roomId },
      include: {
        _count: {
          select: { bookings: true, events: true },
        },
      },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.ministryId !== ministryId) {
      throw new ForbiddenException('Cannot access room from another ministry');
    }

    return room;
  }

  async updateRoom(
    roomId: string,
    dto: UpdateRoomDto,
    ministryId: string,
    userId: string,
  ) {
    const room = await (this.prisma as any).room.findUnique({
      where: { id: roomId },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.ministryId !== ministryId) {
      throw new ForbiddenException('Cannot update room from another ministry');
    }

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

    return updated;
  }

  async deactivateRoom(
    roomId: string,
    ministryId: string,
    userId: string,
  ) {
    const room = await (this.prisma as any).room.findUnique({
      where: { id: roomId },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.ministryId !== ministryId) {
      throw new ForbiddenException('Cannot deactivate room from another ministry');
    }

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

    return updated;
  }

  async checkAvailability(
    roomId: string,
    startTime: Date,
    endTime: Date,
    ministryId: string,
  ) {
    const room = await (this.prisma as any).room.findUnique({
      where: { id: roomId },
    });

    if (!room) {
      throw new NotFoundException('Room not found');
    }

    if (room.ministryId !== ministryId) {
      throw new ForbiddenException('Cannot check availability for room from another ministry');
    }

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
          OR: [
            { endAt: { lte: startTime } },
            { startAt: { gte: endTime } },
          ],
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
