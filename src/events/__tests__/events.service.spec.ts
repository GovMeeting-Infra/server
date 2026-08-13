import { Test, TestingModule } from '@nestjs/testing';
import {
  ForbiddenException,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { EventsService } from '../events.service';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../audit/audit.service';
import { getQueueToken } from '@nestjs/bullmq';
import { CacheService } from '../../cache/cache.service';
import { EventsRepository } from '../events.repository';
import { NotificationsService } from '../../notifications/notifications.service';
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
    // Co-organizer ids are validated against real accounts before creation.
    user: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          where.id.in.map((id: string) => ({ id })),
        ),
    },
    eventCoOrganizer: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    eventAttendee: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
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
    invalidateAnalytics: jest.fn().mockResolvedValue(undefined),
    invalidateAnalyticsFor: jest.fn().mockResolvedValue(undefined),
    setEvents: jest.fn().mockResolvedValue(undefined),
  };

  // EventsService has taken a repository and a notifications service since
  // before this spec was written, and neither was ever provided — so the
  // module failed to compile and every test in the file errored. The email
  // queue is the newer dependency, added when event creation started sending
  // invitations.
  const mockRepository = {
    findOne: jest.fn().mockImplementation((id: string) => ({
      id,
      ministryId: 'ministry-1',
    })),
    findMany: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    create: jest.fn().mockResolvedValue({ id: 'event-1' }),
    checkRoomConflicts: jest.fn().mockResolvedValue([]),
  };

  const mockNotifications = {
    notifyMeetingInvitation: jest.fn().mockResolvedValue(undefined),
  };

  const mockQueue = {
    add: jest.fn().mockResolvedValue(undefined),
  };

  /** getOne and listEvents take the acting user, not a bare ministry id. */
  const staff = { systemRole: 'STAFF', ministryId: 'ministry-1' };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
        { provide: CacheService, useValue: mockCache },
        { provide: EventsRepository, useValue: mockRepository },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: getQueueToken('email-queue'), useValue: mockQueue },
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
        // An internal meeting is rejected without a deputy, so this is no
        // longer optional in a valid-data fixture.
        coOrganizerIds: ['user-2'],
      };

      mockRepository.create.mockResolvedValue({
        id: 'event-1',
        ...dto,
        organizerId: 'user-1',
        ministryId: 'ministry-1',
        isPublic: false,
      });

      const result = await service.createEvent(dto, 'user-1', 'ministry-1');

      expect(result.id).toBeDefined();
      expect(mockRepository.create).toHaveBeenCalled();
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
        coOrganizerIds: ['user-2'],
      };

      mockPrisma.room.findUnique.mockResolvedValue({
        id: 'room-1',
        ministryId: 'ministry-1',
      });

      // The conflict check moved onto the repository; an empty list means the
      // room is free and creation proceeds.
      mockRepository.checkRoomConflicts.mockResolvedValue([]);
      mockRepository.create.mockResolvedValue({
        id: 'event-1',
        ...dto,
        organizerId: 'user-1',
        ministryId: 'ministry-1',
      });

      await service.createEvent(dto, 'user-1', 'ministry-1');

      expect(mockRepository.checkRoomConflicts).toHaveBeenCalled();
    });
  });

  describe('listEvents', () => {
    it('should return cached events if available', async () => {
      const cachedEvents = [
        { id: 'event-1', title: 'Event 1' },
        { id: 'event-2', title: 'Event 2' },
      ];

      mockCache.get.mockResolvedValue(cachedEvents);

      const result = await service.listEvents('ministry-1', staff, {
        page: 1,
      });

      expect(result).toEqual(cachedEvents);
      expect(mockRepository.findMany).not.toHaveBeenCalled();
    });

    it('should fetch from the repository if cache miss', async () => {
      mockCache.get.mockResolvedValue(null);
      mockRepository.findMany.mockResolvedValue({
        data: [{ id: 'event-1', title: 'Event 1', ministryId: 'ministry-1' }],
        total: 1,
      });

      await service.listEvents('ministry-1', staff, { page: 1 });

      expect(mockRepository.findMany).toHaveBeenCalled();
      // setEvents, not set: the list is written with the events TTL.
      expect(mockCache.setEvents).toHaveBeenCalled();
    });
  });

  describe('getOne', () => {
    it('should return event by id', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'event-1',
        title: 'Test Event',
        ministryId: 'ministry-1',
      });

      const result = await service.getOne('event-1', staff);

      expect(result.id).toBe('event-1');
    });

    it('should throw NotFoundException when event not found', async () => {
      mockRepository.findOne.mockResolvedValue(null);

      await expect(service.getOne('nonexistent', staff)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('should throw ForbiddenException when accessing other ministry event', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'event-1',
        title: 'Test Event',
        ministryId: 'ministry-2',
      });

      await expect(service.getOne('event-1', staff)).rejects.toThrow(
        ForbiddenException,
      );
    });
  });
});
