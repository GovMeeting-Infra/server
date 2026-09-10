import { BadRequestException } from '@nestjs/common';
import { EventSeriesService } from '../event-series.service';
import { MAX_OCCURRENCES } from '../event-series.constants';

/**
 * Repeating activities, which had no test of any kind.
 *
 * That is not an oversight worth glossing over: the feature shipped, was
 * unreachable from the interface for changing or stopping a repeat, and in
 * production has never produced a single series. So these cover the arithmetic
 * and the destructive parts rather than the wiring — what a rule generates,
 * what a rebuild is allowed to delete, and what an edit does to the meetings
 * that come after it.
 */
describe('EventSeriesService', () => {
  const HOUR = 60 * 60 * 1000;

  let prisma: any;
  let audit: any;
  let cache: any;
  let service: EventSeriesService;

  /** Rows the transaction body creates, in the order it created them. */
  let createdEvents: any[];
  let deletedIds: string[];

  const actor = {
    id: 'organizer-1',
    systemRole: 'STAFF',
    ministryId: 'ministry-1',
  };

  const baseEvent = (over: Record<string, unknown> = {}) => ({
    id: 'evt-1',
    title: 'Weekly Digital Skills Training',
    description: 'For civil servants',
    isPublic: false,
    type: 'MEETING',
    scope: 'TEAM',
    classification: null,
    venueName: 'Miatta Conference Centre',
    venueLat: null,
    venueLng: null,
    geofenceRadius: 100,
    requireGeofence: true,
    allowGuestCheckIn: true,
    colorCategory: 'blue',
    bannerImage: null,
    contactEmail: 'training@mocti.gov.sl',
    contactPhone: '+23276000000',
    externalUrl: null,
    ministryId: 'ministry-1',
    organizerId: 'organizer-1',
    status: 'PUBLISHED',
    publishedAt: new Date('2026-03-01T09:00:00Z'),
    seriesId: null,
    startAt: new Date('2026-03-05T10:00:00Z'),
    endAt: new Date('2026-03-05T12:00:00Z'),
    coOrganizers: [{ userId: 'deputy-1' }],
    attendees: [
      {
        userId: 'staff-9',
        externalName: null,
        externalEmail: null,
        lastInvitedAt: null,
      },
    ],
    invitedMinistries: [],
    ...over,
  });

  beforeEach(() => {
    jest.clearAllMocks();
    createdEvents = [];
    deletedIds = [];

    prisma = {
      event: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockImplementation(({ where }: any) => ({
          count: where.id?.in?.length ?? 0,
        })),
        createMany: jest.fn().mockImplementation(({ data }: any) => {
          createdEvents.push(...data);
          return { count: data.length };
        }),
        deleteMany: jest.fn().mockImplementation(({ where }: any) => {
          deletedIds.push(...(where.id?.in ?? []));
          return { count: where.id?.in?.length ?? 0 };
        }),
      },
      eventSeries: {
        create: jest.fn().mockResolvedValue({ id: 'series-1' }),
        update: jest.fn().mockResolvedValue({ id: 'series-1' }),
        delete: jest.fn().mockResolvedValue({}),
      },
      eventCoOrganizer: { createMany: jest.fn().mockResolvedValue({}) },
      eventAttendee: { createMany: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    cache = {
      invalidatePattern: jest.fn().mockResolvedValue(undefined),
      invalidateAnalytics: jest.fn().mockResolvedValue(undefined),
    };

    service = new EventSeriesService(prisma, audit, cache);
  });

  /** Sets the template the rule is generated from. */
  const seed = (over: Record<string, unknown> = {}) => {
    const event = baseEvent(over);
    prisma.event.findUnique.mockResolvedValue(event);
    return event;
  };

  const startsOf = () =>
    createdEvents.map((e) => e.startAt.toISOString().slice(0, 16));

  describe('generating a series', () => {
    it('counts the activity itself as the first occurrence', async () => {
      seed();
      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'COUNT', count: 4 } as any,
        actor,
      );

      // Four in all, not four on top of the one that already exists — the
      // meaning `count` has always had when a series is first created.
      expect(createdEvents).toHaveLength(3);
      expect(startsOf()).toEqual([
        '2026-03-12T10:00',
        '2026-03-19T10:00',
        '2026-03-26T10:00',
      ]);
    });

    it('keeps the time of day and the length of the meeting', async () => {
      seed();
      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'COUNT', count: 2 } as any,
        actor,
      );

      const occurrence = createdEvents[0];
      expect(occurrence.startAt.toISOString()).toBe('2026-03-12T10:00:00.000Z');
      expect(occurrence.endAt.getTime() - occurrence.startAt.getTime()).toBe(
        2 * HOUR,
      );
    });

    // The field the create form refuses to submit without. Every generated
    // occurrence used to be missing it, which is a state the rest of the
    // platform forbids.
    it('carries the venue and the rest of the activity onto each occurrence', async () => {
      seed();
      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'COUNT', count: 2 } as any,
        actor,
      );

      expect(createdEvents[0]).toMatchObject({
        venueName: 'Miatta Conference Centre',
        contactEmail: 'training@mocti.gov.sl',
        contactPhone: '+23276000000',
        colorCategory: 'blue',
        allowGuestCheckIn: true,
        requireGeofence: true,
        status: 'PUBLISHED',
      });
    });

    // Inheriting one would fence next month's meeting to wherever somebody
    // stood this month.
    it('never inherits the check-in area', async () => {
      seed({ checkInAnchorLat: 8.46, checkInAnchorLng: -13.23 });
      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'COUNT', count: 2 } as any,
        actor,
      );

      expect(createdEvents[0]).not.toHaveProperty('checkInAnchorLat');
      expect(createdEvents[0]).not.toHaveProperty('checkInAnchorLng');
    });

    it('gives every occurrence the same co-organizers and invitees', async () => {
      seed();
      prisma.event.findMany.mockResolvedValue([
        { id: 'new-1' },
        { id: 'new-2' },
      ]);

      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'COUNT', count: 3 } as any,
        actor,
      );

      // Without the co-organizer rows, the people who scheduled the series
      // cannot edit any occurrence but the first.
      expect(prisma.eventCoOrganizer.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [
            { eventId: 'new-1', userId: 'deputy-1' },
            { eventId: 'new-2', userId: 'deputy-1' },
          ],
        }),
      );
      expect(prisma.eventAttendee.createMany).toHaveBeenCalled();
    });

    it('gives each invitee a different RSVP link per occurrence', async () => {
      seed();
      prisma.event.findMany.mockResolvedValue([
        { id: 'new-1' },
        { id: 'new-2' },
      ]);

      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'COUNT', count: 3 } as any,
        actor,
      );

      const rows = prisma.eventAttendee.createMany.mock.calls[0][0].data;
      const tokens = rows.map((r: any) => r.rsvpTokenHash);
      // Copying the token would let one reply accept every meeting in the
      // series, including ones nobody has looked at yet.
      expect(new Set(tokens).size).toBe(rows.length);
      expect(rows.every((r: any) => r.status === 'INVITED')).toBe(true);
    });
  });

  describe('how a rule ends', () => {
    it('stops on the last day when a rule runs until a date', async () => {
      seed();
      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'UNTIL', until: '2026-03-26' } as any,
        actor,
      );

      // 26 March inclusive. The form sends a date with no time, so treating it
      // as midnight would drop the ten o'clock meeting on the very day the
      // organizer picked as the last one.
      expect(startsOf()).toEqual([
        '2026-03-12T10:00',
        '2026-03-19T10:00',
        '2026-03-26T10:00',
      ]);
    });

    it('caps a rule that never ends', async () => {
      seed();
      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'NEVER' } as any,
        actor,
      );

      expect(createdEvents).toHaveLength(MAX_OCCURRENCES - 1);
    });
  });

  describe('working out the next date', () => {
    const firstStartFor = async (over: Record<string, unknown>, rule: any) => {
      seed(over);
      createdEvents = [];
      await service.setRule(
        'evt-1',
        { endType: 'COUNT', count: 2, ...rule },
        actor,
      );
      return createdEvents[0].startAt.toISOString();
    };

    // setMonth rolls over, so 31 January plus a month used to become 3 March
    // and a monthly meeting walked quietly into the following month for good.
    it('keeps a monthly meeting on its date across a short month', async () => {
      const start = await firstStartFor(
        {
          startAt: new Date('2026-01-31T10:00:00Z'),
          endAt: new Date('2026-01-31T11:00:00Z'),
        },
        { frequency: 'MONTHLY' },
      );
      expect(start).toBe('2026-02-28T10:00:00.000Z');
    });

    it('does not lose the date after clamping it once', async () => {
      seed({
        startAt: new Date('2026-01-31T10:00:00Z'),
        endAt: new Date('2026-01-31T11:00:00Z'),
      });
      await service.setRule(
        'evt-1',
        { frequency: 'MONTHLY', endType: 'COUNT', count: 4 } as any,
        actor,
      );
      // February is clamped, March returns to the 31st rather than staying on
      // the 28th for the rest of the year.
      expect(startsOf()).toEqual([
        '2026-02-28T10:00',
        '2026-03-31T10:00',
        '2026-04-30T10:00',
      ]);
    });

    it('skips the weekend for a weekday rule', async () => {
      // 5 March 2026 is a Thursday, so the next two working days are Friday
      // and the Monday after.
      seed();
      await service.setRule(
        'evt-1',
        { frequency: 'WEEKDAYS', endType: 'COUNT', count: 3 } as any,
        actor,
      );
      expect(startsOf()).toEqual(['2026-03-06T10:00', '2026-03-09T10:00']);
    });

    it('spaces a fortnightly rule two weeks apart', async () => {
      const start = await firstStartFor({}, { frequency: 'BIWEEKLY' });
      expect(start).toBe('2026-03-19T10:00:00.000Z');
    });
  });

  describe('changing a rule that already has occurrences', () => {
    const now = new Date();
    const ago = (days: number) => new Date(now.getTime() - days * 24 * HOUR);
    const ahead = (days: number) => new Date(now.getTime() + days * 24 * HOUR);

    /** Two held, one running, two still to come. */
    const existing = () => [
      {
        id: 'held-1',
        startAt: ago(14),
        endAt: ago(14),
        minutes: null,
        _count: { attendances: 12 },
      },
      {
        id: 'held-2',
        startAt: ago(7),
        endAt: ago(7),
        minutes: null,
        _count: { attendances: 9 },
      },
      {
        id: 'evt-1',
        startAt: ahead(1),
        endAt: ahead(1),
        minutes: null,
        _count: { attendances: 0 },
      },
      {
        id: 'future-1',
        startAt: ahead(8),
        endAt: ahead(8),
        minutes: null,
        _count: { attendances: 0 },
      },
      {
        id: 'future-2',
        startAt: ahead(15),
        endAt: ahead(15),
        minutes: null,
        _count: { attendances: 0 },
      },
    ];

    beforeEach(() => {
      seed({ seriesId: 'series-1', startAt: ahead(1), endAt: ahead(1) });
      prisma.event.findMany.mockResolvedValue(existing());
    });

    it('leaves occurrences that have already happened alone', async () => {
      await service.setRule(
        'evt-1',
        { frequency: 'BIWEEKLY', endType: 'COUNT', count: 6 } as any,
        actor,
      );

      expect(deletedIds).not.toContain('held-1');
      expect(deletedIds).not.toContain('held-2');
      expect(deletedIds).toEqual(
        expect.arrayContaining(['future-1', 'future-2']),
      );
    });

    // The page the organizer is standing on has to survive the change.
    it('never deletes the occurrence being edited', async () => {
      await service.setRule(
        'evt-1',
        { frequency: 'BIWEEKLY', endType: 'COUNT', count: 6 } as any,
        actor,
      );

      expect(deletedIds).not.toContain('evt-1');
    });

    it('keeps an upcoming occurrence somebody has already checked into', async () => {
      const rows = existing();
      rows[3]._count.attendances = 3;
      prisma.event.findMany.mockResolvedValue(rows);

      await service.setRule(
        'evt-1',
        { frequency: 'BIWEEKLY', endType: 'COUNT', count: 6 } as any,
        actor,
      );

      // Every child of Event cascades on delete, so removing this row would
      // take the signed record of who was in the room with it.
      expect(deletedIds).not.toContain('future-1');
    });

    it('keeps an upcoming occurrence that already has minutes', async () => {
      const rows = existing();
      rows[4].minutes = { id: 'min-1' } as any;
      prisma.event.findMany.mockResolvedValue(rows);

      await service.setRule(
        'evt-1',
        { frequency: 'BIWEEKLY', endType: 'COUNT', count: 6 } as any,
        actor,
      );

      expect(deletedIds).not.toContain('future-2');
    });

    it('counts what it kept toward the total', async () => {
      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'COUNT', count: 5 } as any,
        actor,
      );

      // Three kept — two held plus the one being edited — so two more make five.
      expect(createdEvents).toHaveLength(2);
    });

    it('generates nothing when the new total is already met', async () => {
      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'COUNT', count: 2 } as any,
        actor,
      );

      expect(createdEvents).toHaveLength(0);
      // Shortening a series below what has already happened is a real answer,
      // not an error — the meetings still took place.
      expect(deletedIds).toEqual(
        expect.arrayContaining(['future-1', 'future-2']),
      );
    });

    it('reuses the existing rule row rather than making a second', async () => {
      await service.setRule(
        'evt-1',
        { frequency: 'WEEKLY', endType: 'COUNT', count: 5 } as any,
        actor,
      );

      expect(prisma.eventSeries.update).toHaveBeenCalled();
      expect(prisma.eventSeries.create).not.toHaveBeenCalled();
    });
  });

  describe('stopping a repeat', () => {
    const now = new Date();

    beforeEach(() => {
      seed({ seriesId: 'series-1' });
      prisma.event.findMany.mockResolvedValue([
        {
          id: 'held-1',
          startAt: new Date(now.getTime() - 7 * 24 * HOUR),
          minutes: null,
          _count: { attendances: 5 },
        },
        {
          id: 'future-1',
          startAt: new Date(now.getTime() + 7 * 24 * HOUR),
          minutes: null,
          _count: { attendances: 0 },
        },
      ]);
    });

    it('removes what is still to come and keeps what happened', async () => {
      const result = await service.removeRule('evt-1', actor);

      expect(deletedIds).toEqual(['future-1']);
      expect(result.keptStandalone).toBe(1);
    });

    it('deletes the rule itself rather than orphaning it', async () => {
      await service.removeRule('evt-1', actor);

      expect(prisma.eventSeries.delete).toHaveBeenCalledWith({
        where: { id: 'series-1' },
      });
    });

    it('refuses an activity that does not repeat', async () => {
      seed({ seriesId: null });
      await expect(service.removeRule('evt-1', actor)).rejects.toThrow(
        BadRequestException,
      );
    });
  });

  describe('applying an edit to later occurrences', () => {
    const now = new Date();
    const ahead = (days: number, hour: number) => {
      const d = new Date(now.getTime() + days * 24 * HOUR);
      d.setUTCHours(hour, 0, 0, 0);
      return d;
    };

    const later = [
      { id: 'future-1', startAt: ahead(7, 10) },
      { id: 'future-2', startAt: ahead(14, 10) },
    ];

    const edited = {
      id: 'evt-1',
      seriesId: 'series-1',
      startAt: ahead(1, 10),
      endAt: ahead(1, 12),
    };

    /** What each later occurrence was moved to, in order. */
    const written = () =>
      prisma.event.update.mock.calls.map(([arg]: any) => ({
        id: arg.where.id,
        startAt: arg.data.startAt?.toISOString(),
      }));

    beforeEach(() => {
      prisma.event.findMany.mockResolvedValue(later);
    });

    // The whole reason the old version could not be used: it handed the update
    // to updateMany, which would have given every occurrence one startAt and
    // collapsed a year of meetings onto a single afternoon.
    it('moves each later occurrence by the same amount, on its own date', async () => {
      const result = await service.applyToFutureOccurrences(
        prisma,
        { ...edited, startAt: ahead(1, 14), endAt: ahead(1, 16) },
        { startAt: ahead(1, 10), endAt: ahead(1, 12) },
        { title: 'Renamed' },
      );

      expect(result.updated).toBe(2);
      const rows = written();
      expect(rows[0].startAt).toBe(ahead(7, 14).toISOString());
      expect(rows[1].startAt).toBe(ahead(14, 14).toISOString());
    });

    it('shifts the whole series when the day moves', async () => {
      await service.applyToFutureOccurrences(
        prisma,
        { ...edited, startAt: ahead(3, 10), endAt: ahead(3, 12) },
        { startAt: ahead(1, 10), endAt: ahead(1, 12) },
        {},
      );

      const rows = written();
      expect(rows[0].startAt).toBe(ahead(9, 10).toISOString());
      expect(rows[1].startAt).toBe(ahead(16, 10).toISOString());
    });

    it('uses one statement when only the details changed', async () => {
      const result = await service.applyToFutureOccurrences(
        prisma,
        edited,
        { startAt: edited.startAt, endAt: edited.endAt },
        { venueName: 'Youyi Building' },
      );

      expect(prisma.event.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['future-1', 'future-2'] } },
        data: { venueName: 'Youyi Building' },
      });
      expect(prisma.event.update).not.toHaveBeenCalled();
      expect(result.updated).toBe(2);
    });

    it('moves the whole series along when the shift is large', async () => {
      // Every occurrence moves by the same amount, so a big shift carries the
      // series with it rather than scrambling it. Worth pinning down, because
      // it is the reason the ordering guard below is about something subtler.
      await service.applyToFutureOccurrences(
        prisma,
        { ...edited, startAt: ahead(30, 10), endAt: ahead(30, 12) },
        { startAt: ahead(1, 10), endAt: ahead(1, 12) },
        {},
      );

      const rows = written();
      expect(rows[0].startAt).toBe(ahead(36, 10).toISOString());
      expect(rows[1].startAt).toBe(ahead(43, 10).toISOString());
    });

    it('refuses to collapse two occurrences that share a day', async () => {
      // A morning and an afternoon sitting on the same date. Giving the series
      // one time of day would land both on the same instant, which is the one
      // way a uniform shift can leave it incoherent.
      prisma.event.findMany.mockResolvedValue([
        { id: 'morning', startAt: ahead(7, 9) },
        { id: 'afternoon', startAt: ahead(7, 15) },
      ]);

      await expect(
        service.applyToFutureOccurrences(
          prisma,
          { ...edited, startAt: ahead(1, 11), endAt: ahead(1, 12) },
          { startAt: ahead(1, 10), endAt: ahead(1, 12) },
          {},
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('refuses a shift that would push an occurrence into the past', async () => {
      await expect(
        service.applyToFutureOccurrences(
          prisma,
          { ...edited, startAt: ahead(-30, 10), endAt: ahead(-30, 12) },
          { startAt: ahead(1, 10), endAt: ahead(1, 12) },
          {},
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('does nothing when there is nothing after this one', async () => {
      prisma.event.findMany.mockResolvedValue([]);

      const result = await service.applyToFutureOccurrences(
        prisma,
        edited,
        { startAt: ahead(1, 10), endAt: ahead(1, 12) },
        { title: 'Renamed' },
      );

      expect(result.updated).toBe(0);
    });
  });
});
