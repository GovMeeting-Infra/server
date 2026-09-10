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
import { EventSeriesService } from '../event-series.service';
import { MailService } from '../../mail/mail.service';
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
    // Co-organizer ids are validated against real accounts before creation.
    user: {
      findMany: jest
        .fn()
        .mockImplementation(({ where }: any) =>
          where.id.in.map((id: string) => ({ id })),
        ),
      findUnique: jest.fn().mockResolvedValue({ name: 'Aminata Kamara' }),
    },
    ministry: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Ministry of Health' }),
    },
    eventCoOrganizer: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    // updateEvent runs its write and any propagation to later occurrences in
    // one transaction, so the mock has to hand the callback a client. Handing
    // back mockPrisma itself keeps every existing expectation pointing at the
    // same spies.
    $transaction: jest.fn((fn: any) => fn(mockPrisma)),
    eventAttendee: {
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(),
      update: jest.fn().mockResolvedValue({}),
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
  /**
   * findOne's default stands in for any event in ministry-1. Tests that need a
   * particular shape override it and put this back afterwards — clearAllMocks
   * resets call history but keeps implementations, so an override left in
   * place would silently reshape every test that runs after it.
   */
  const defaultFindOne = (id: string) => ({ id, ministryId: 'ministry-1' });

  const mockRepository = {
    findOne: jest.fn().mockImplementation(defaultFindOne),
    findMany: jest.fn().mockResolvedValue({ data: [], total: 0 }),
    create: jest.fn().mockResolvedValue({ id: 'event-1' }),
    update: jest.fn().mockResolvedValue({ id: 'event-1' }),
    delete: jest.fn().mockResolvedValue(undefined),
  };

  const mockNotifications = {
    notifyMeetingInvitation: jest.fn().mockResolvedValue(undefined),
    notifyMeetingChanged: jest.fn().mockResolvedValue(undefined),
  };

  // EventsService reaches for this only when an edit says it applies to later
  // occurrences; every other path leaves it untouched.
  const mockSeries = {
    applyToFutureOccurrences: jest.fn().mockResolvedValue({ updated: 0 }),
  };

  const mockQueue = {
    add: jest.fn().mockResolvedValue(undefined),
  };

  // The single-attendee resend sends inline rather than queueing, so the
  // service holds a MailService as well as the queue.
  const mockMail = {
    send: jest.fn().mockResolvedValue({ sent: true }),
  };

  /** getOne and listEvents take the acting user, not a bare ministry id. */
  const staff = { systemRole: 'STAFF', ministryId: 'ministry-1' };

  beforeEach(async () => {
    // Call history only — mockClear keeps the implementations set above, but
    // without this, assertions that a call did NOT happen see the previous
    // test's calls and pass or fail for the wrong reason.
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EventsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: AuditService, useValue: mockAudit },
        { provide: CacheService, useValue: mockCache },
        { provide: EventsRepository, useValue: mockRepository },
        { provide: EventSeriesService, useValue: mockSeries },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: MailService, useValue: mockMail },
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
  });

  /**
   * Who owns a public activity, and who is allowed to wave it onto the public
   * calendar.
   *
   * These were created ownerless, on the reasoning that a public activity
   * belongs to the ministry rather than a person. Nothing then tied one to the
   * person who wrote it — the Event row has no creator column — so a member of
   * staff would submit an activity for approval and find they could not correct
   * a typo in it, while an administrator who had only approved it was the sole
   * account that could touch it.
   *
   * The creator organizes it now. The pair of tests that matter are that this
   * did not also hand them the approval: publishing is the review step, and an
   * organizer who can approve their own activity is no review at all.
   */
  describe('public activities — ownership and approval', () => {
    afterEach(() => {
      mockRepository.findOne.mockImplementation(defaultFindOne);
      mockRepository.create.mockResolvedValue({ id: 'event-1' });
    });

    const publicDto = () =>
      ({
        title: 'Digital Skills Training',
        startAt: new Date('2026-08-01T10:00:00'),
        endAt: new Date('2026-08-01T12:00:00'),
        venueName: 'Miatta Conference Centre',
        isPublic: true,
        // Deliberately none: a public activity is exempt from needing a
        // deputy, so this is the shape the form actually submits.
      }) as any;

    /** The data handed to the repository, whatever else creation did. */
    const createdWith = () => mockRepository.create.mock.calls[0][0];

    it('organizes a public activity under whoever wrote it', async () => {
      mockRepository.create.mockResolvedValue({ id: 'event-1' });

      await service.createEvent(publicDto(), 'staff-1', 'ministry-1', 'STAFF');

      expect(createdWith().organizerId).toBe('staff-1');
    });

    it('still holds it as a draft for approval', async () => {
      mockRepository.create.mockResolvedValue({ id: 'event-1' });

      await service.createEvent(publicDto(), 'staff-1', 'ministry-1', 'STAFF');

      // Owning it must not shortcut the review: an internal meeting is live
      // from creation, a public activity waits.
      expect(createdWith().status).toBe('DRAFT');
      expect(createdWith().publishedAt).toBeNull();
    });

    it('does not make a public activity need a co-organizer', async () => {
      mockRepository.create.mockResolvedValue({ id: 'event-1' });

      await expect(
        service.createEvent(publicDto(), 'staff-1', 'ministry-1', 'STAFF'),
      ).resolves.toBeDefined();
    });

    it('refuses to let the organizer publish their own activity', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'event-1',
        ministryId: 'ministry-1',
        organizerId: 'staff-1',
        isPublic: true,
        status: 'DRAFT',
      });

      await expect(
        service.publishEvent('event-1', 'staff-1', 'ministry-1', 'STAFF'),
      ).rejects.toThrow(ForbiddenException);

      expect(mockRepository.update).not.toHaveBeenCalled();
    });

    it("lets a ministry admin publish someone else's activity", async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'event-1',
        ministryId: 'ministry-1',
        organizerId: 'staff-1',
        isPublic: true,
        status: 'DRAFT',
      });
      mockRepository.update.mockResolvedValue({
        id: 'event-1',
        status: 'PUBLISHED',
      });

      await service.publishEvent(
        'event-1',
        'admin-1',
        'ministry-1',
        'MINISTRY_ADMIN',
      );

      expect(mockRepository.update).toHaveBeenCalledWith(
        'event-1',
        expect.objectContaining({ status: 'PUBLISHED' }),
      );
    });

    it('leaves the organizer in place when it is published', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'event-1',
        ministryId: 'ministry-1',
        organizerId: 'staff-1',
        isPublic: true,
        status: 'DRAFT',
      });
      mockRepository.update.mockResolvedValue({ id: 'event-1' });

      await service.publishEvent(
        'event-1',
        'admin-1',
        'ministry-1',
        'MINISTRY_ADMIN',
      );

      // Approving is not taking over. The write must carry the status and the
      // timestamp and nothing about who owns the activity.
      expect(mockRepository.update.mock.calls[0][1]).not.toHaveProperty(
        'organizerId',
      );
    });

    it('lets an admin take a published activity back down', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'event-1',
        ministryId: 'ministry-1',
        organizerId: 'staff-1',
        isPublic: true,
        status: 'PUBLISHED',
      });

      // The counterpart of approving it. Without this an administrator could
      // put an activity on the public calendar and then be unable to remove
      // it, leaving the member of staff who wrote it as the only account that
      // could.
      await expect(
        service.deleteEvent(
          'event-1',
          'admin-1',
          'ministry-1',
          'MINISTRY_ADMIN',
        ),
      ).resolves.not.toThrow();
    });

    it('keeps an internal meeting private to its organizer', async () => {
      mockRepository.findOne.mockResolvedValue({
        id: 'event-2',
        ministryId: 'ministry-1',
        organizerId: 'staff-1',
        isPublic: false,
        status: 'PUBLISHED',
      });

      // The allowance above is scoped to public activities. Someone else's
      // internal meeting stays theirs, which is the rule it must not erode.
      await expect(
        service.deleteEvent(
          'event-2',
          'admin-1',
          'ministry-1',
          'MINISTRY_ADMIN',
        ),
      ).rejects.toThrow(ForbiddenException);
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

  /**
   * Re-sending an invitation on request, as opposed to the automatic sweep.
   * The decisions worth pinning down are that it does not rotate the RSVP
   * token, and that it records a send only when one actually happened.
   */
  describe('resendInvitation', () => {
    const attendee = {
      id: 'att-1',
      userId: 'user-2',
      externalName: null,
      externalEmail: null,
      rsvpTokenHash: 'existing-token',
      user: {
        id: 'user-2',
        name: 'Fatmata Sesay',
        email: 'fatmata@moh.gov.sl',
      },
    };

    beforeEach(() => {
      mockRepository.findOne.mockResolvedValue({
        id: 'event-1',
        title: 'Cabinet Meeting',
        ministryId: 'ministry-1',
        organizerId: 'user-1',
        startAt: new Date('2026-09-01T10:00:00'),
        endAt: new Date('2026-09-01T11:00:00'),
        venueName: 'Cabinet Room',
      });
      mockPrisma.eventAttendee.findFirst.mockResolvedValue(attendee);
      mockMail.send.mockResolvedValue({ sent: true });
    });

    it('reuses the existing RSVP token rather than rotating it', async () => {
      await service.resendInvitation(
        'event-1',
        'att-1',
        'user-1',
        'ministry-1',
        'STAFF',
      );

      // Rotating would break the link in every copy already sitting in
      // someone's inbox, which is the opposite of what a chase-up is for.
      const [, body] = mockMail.send.mock.calls[0];
      expect(body.text).toContain('/rsvp/existing-token');

      const rotations = mockPrisma.eventAttendee.update.mock.calls.filter(
        (c: any) => c[0].data.rsvpTokenHash !== undefined,
      );
      expect(rotations).toHaveLength(0);
    });

    it('mints a token only when the row has none', async () => {
      mockPrisma.eventAttendee.findFirst.mockResolvedValue({
        ...attendee,
        rsvpTokenHash: null,
      });

      await service.resendInvitation(
        'event-1',
        'att-1',
        'user-1',
        'ministry-1',
        'STAFF',
      );

      const minted = mockPrisma.eventAttendee.update.mock.calls.find(
        (c: any) => c[0].data.rsvpTokenHash !== undefined,
      );
      expect(minted).toBeDefined();
    });

    it('stamps lastInvitedAt and reports success', async () => {
      const result = await service.resendInvitation(
        'event-1',
        'att-1',
        'user-1',
        'ministry-1',
        'STAFF',
      );

      expect(result.emailSent).toBe(true);
      const stamped = mockPrisma.eventAttendee.update.mock.calls.find(
        (c: any) => c[0].data.lastInvitedAt !== undefined,
      );
      expect(stamped).toBeDefined();
    });

    it('does not stamp lastInvitedAt when the send fails, and says so', async () => {
      mockMail.send.mockResolvedValue({ sent: false, error: 'Mailbox full' });

      const result = await service.resendInvitation(
        'event-1',
        'att-1',
        'user-1',
        'ministry-1',
        'STAFF',
      );

      // The whole reason this route sends inline rather than queueing is so
      // the organizer learns the real outcome.
      expect(result.emailSent).toBe(false);
      expect(result.emailError).toBe('Mailbox full');

      const stamped = mockPrisma.eventAttendee.update.mock.calls.find(
        (c: any) => c[0].data.lastInvitedAt !== undefined,
      );
      expect(stamped).toBeUndefined();
    });

    it('refuses an attendee that does not belong to the event', async () => {
      mockPrisma.eventAttendee.findFirst.mockResolvedValue(null);

      await expect(
        service.resendInvitation(
          'event-1',
          'att-other',
          'user-1',
          'ministry-1',
          'STAFF',
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('lets the super admin act on an event it does not organize', async () => {
      // 'other-user' is neither the organizer (user-1) nor a co-organizer.
      await expect(
        service.resendInvitation(
          'event-1',
          'att-1',
          'other-user',
          'ministry-1',
          'SUPER_ADMIN',
        ),
      ).resolves.toMatchObject({ emailSent: true });
    });

    it('still refuses a ministry admin on someone else event', async () => {
      // A ministry-level admin only inherits an event nobody owns; an
      // organizer's own meeting stays theirs.
      await expect(
        service.resendInvitation(
          'event-1',
          'att-1',
          'other-user',
          'ministry-1',
          'MINISTRY_ADMIN',
        ),
      ).rejects.toThrow(ForbiddenException);
    });

    it('refuses someone with no address to send to', async () => {
      mockPrisma.eventAttendee.findFirst.mockResolvedValue({
        ...attendee,
        user: null,
        externalEmail: null,
      });

      await expect(
        service.resendInvitation(
          'event-1',
          'att-1',
          'user-1',
          'ministry-1',
          'STAFF',
        ),
      ).rejects.toThrow(BadRequestException);
    });
  });
});
