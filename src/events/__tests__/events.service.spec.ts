import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { EventsService } from '../events.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { CacheService } from '../../cache/cache.service';
import { CreateEventDto } from '../dto/create-event.dto';

describe('EventsService', () => {
  let service: EventsService;
  let prisma: PrismaService;
  let audit: AuditService;
  let cache: CacheService;

  const mockPrisma = {
    event: {
      create: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    room: {
      findUnique: jest.fn(),
    },
  };

  const mockAudit = {
    log: jest.fn().mockResolvedValue(undefined),
  };

  const mockCache = {
    set: jest.fn().mockResolvedValue(undefined),
    get: jest.fn().mockResolvedValue(null),
    delete: jest.fn().mockResolvedValue(undefined),
    invalidatePattern: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
        { provide: CacheService, useValue: mockCache },
      ],
    }).compile();

    service = module.get<EventsService>(EventsService);
    prisma = module.get<PrismaService>(PrismaService);
    audit = module.get<AuditService>(AuditService);
    cache = module.get<CacheService>(CacheService);
  });

  describe('createEvent', () => {
    it('should create an event with valid data', async () => {
      const dto: CreateEventDto = {
        title: 'Test Event',
        description: 'Test Description',
        startAt: new Date('2026-08-01T10:00:00'),
        endAt: new Date('2026-08-01T12:00:00'),
        venueName: 'Test Venue',
        type: 'MEETING',
      };

      const expectedEvent = {
        id: 'event-1',
        ...dto,
        organizerId: 'user-1',
        ministryId: 'ministry-1',
        isPublic: false,
      };

      mockPrisma.event.create.mockResolvedValue(expectedEvent);

      const result = await service.createEvent(dto, 'user-1', 'ministry-1');

      expect(result.id).toBeDefined();
      expect(mockPrisma.event.create).toHaveBeenCalled();
      expect(mockAudit.log).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'EVENT_CREATED',
          actorId: 'user-1',
          ministryId: 'ministry-1',
        }),
      );
    });

    it('should reject when start time equals end time', async () => {
      const now = new Date();
      const dto: CreateEventDto = {
        title: 'Invalid Event',
        startAt: now,
        endAt: now,
      };

      await expect(
        service.createEvent(dto, 'user-1', 'ministry-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should reject when end time is before start time', async () => {
      const start = new Date('2026-08-01T12:00:00');
      const end = new Date('2026-08-01T10:00:00');
      const dto: CreateEventDto = {
        title: 'Invalid Event',
        startAt: start,
        endAt: end,
      };

      await expect(
        service.createEvent(dto, 'user-1', 'ministry-1'),
      ).rejects.toThrow(BadRequestException);
    });

    it('should check room conflicts when roomId provided', async () => {
      const dto: CreateEventDto = {
        title: 'Event with Room',
        startAt: new Date('2026-08-01T10:00:00'),
        endAt: new Date('2026-08-01T11:00:00'),
        roomId: 'room-1',
      };

      mockPrisma.room.findUnique.mockResolvedValue({
        id: 'room-1',
        ministryId: 'ministry-1',
      });

      mockPrisma.event.create.mockResolvedValue({
        id: 'event-1',
        ...dto,
        organizerId: 'user-1',
        ministryId: 'ministry-1',
      });

      await service.createEvent(dto, 'user-1', 'ministry-1');

      expect(mockPrisma.room.findUnique).toHaveBeenCalledWith({
        where: { id: 'room-1' },
      });
    });
  });

  describe('listEvents', () => {
    it('should return cached events if available', async () => {
      const cachedEvents = [
        { id: 'event-1', title: 'Event 1' },
        { id: 'event-2', title: 'Event 2' },
      ];

      mockCache.get.mockResolvedValue(cachedEvents);

      const result = await service.listEvents('ministry-1', 1);

      expect(result).toEqual(cachedEvents);
      expect(mockPrisma.event.findMany).not.toHaveBeenCalled();
    });

    it('should fetch from database if cache miss', async () => {
      const events = [
        { id: 'event-1', title: 'Event 1', ministryId: 'ministry-1' },
      ];

      mockCache.get.mockResolvedValue(null);
      mockPrisma.event.findMany.mockResolvedValue(events);

      const result = await service.listEvents('ministry-1', 1);

      expect(mockPrisma.event.findMany).toHaveBeenCalled();
      expect(mockCache.set).toHaveBeenCalled();
    });
  });

  describe('getOne', () => {
    it('should return event by id', async () => {
      const event = {
        id: 'event-1',
        title: 'Test Event',
        ministryId: 'ministry-1',
      };

      mockPrisma.event.findUnique.mockResolvedValue(event);

      const result = await service.getOne('event-1', 'ministry-1');

      expect(result.id).toBe('event-1');
    });

    it('should throw NotFoundException when event not found', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(null);

      await expect(service.getOne('nonexistent', 'ministry-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException when accessing other ministry event', async () => {
      const event = {
        id: 'event-1',
        title: 'Test Event',
        ministryId: 'ministry-2',
      };

      mockPrisma.event.findUnique.mockResolvedValue(event);

      await expect(service.getOne('event-1', 'ministry-1')).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
