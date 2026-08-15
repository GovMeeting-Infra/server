import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { MinutesService } from '../minutes.service';

/**
 * The minutes module had no tests at all until the record stopped being prose.
 * These cover the two rules that decide what a record contains — how the two
 * lists are replaced, and what may be published — plus the edit window, which
 * is the one piece of existing behaviour this change runs through.
 */
describe('MinutesService', () => {
  const ORGANIZER = 'u-organizer';
  const MINISTRY = 'min-moh';
  const EVENT_ID = 'e1';

  let prisma: any;
  let service: MinutesService;

  /** A meeting that ended an hour ago, so the edit window is open. */
  const seedEvent = (over: Record<string, unknown> = {}) => {
    prisma.event.findUnique.mockResolvedValue({
      id: EVENT_ID,
      title: 'Cabinet Meeting',
      isPublic: false,
      ministryId: MINISTRY,
      organizerId: ORGANIZER,
      endAt: new Date(Date.now() - 60 * 60_000),
      coOrganizers: [],
      attendees: [{ id: 'a1' }],
      ...over,
    });
  };

  const seedMinutes = (over: Record<string, unknown> = {}) => {
    prisma.minutes.findUnique.mockResolvedValue({
      id: 'm1',
      eventId: EVENT_ID,
      status: 'DRAFT',
      _count: { points: 0, actionItems: 0 },
      ...over,
    });
  };

  /** Everything handed to $transaction, flattened for inspection. */
  const pointWrites = () =>
    (prisma.$transaction.mock.calls[0]?.[0] ?? []) as any[];

  beforeEach(() => {
    jest.clearAllMocks();

    prisma = {
      event: { findUnique: jest.fn() },
      minutes: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue({ id: 'm1', eventId: EVENT_ID }),
        update: jest.fn().mockResolvedValue({ id: 'm1', eventId: EVENT_ID }),
      },
      minutePoint: {
        deleteMany: jest.fn().mockImplementation((args: any) => ({
          op: 'delete',
          ...args,
        })),
        createMany: jest.fn().mockImplementation((args: any) => ({
          op: 'create',
          ...args,
        })),
      },
      $transaction: jest.fn().mockResolvedValue([]),
    };

    service = new MinutesService(
      prisma,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { notifyMinutesPublished: jest.fn() } as any,
      { recipientsFor: jest.fn().mockResolvedValue([]) } as any,
      { add: jest.fn() } as any,
    );

    // getMinutes runs at the end of every write; it is not what is under test.
    jest.spyOn(service, 'getMinutes').mockResolvedValue({ id: 'm1' } as any);
  });

  describe('recording the two lists', () => {
    beforeEach(() => {
      seedEvent();
      prisma.minutes.findUnique.mockResolvedValue(null);
    });

    it('stores each line in the order it was given', async () => {
      await service.draftMinutes(
        EVENT_ID,
        { decisions: ['Approved the budget', 'Deferred the tender'] },
        ORGANIZER,
        MINISTRY,
      );

      const created = pointWrites().find((w) => w.op === 'create');
      expect(created.data).toEqual([
        {
          minutesId: 'm1',
          type: 'DECISION',
          text: 'Approved the budget',
          order: 0,
        },
        {
          minutesId: 'm1',
          type: 'DECISION',
          text: 'Deferred the tender',
          order: 1,
        },
      ]);
    });

    it('leaves a list alone when its key is absent', async () => {
      await service.draftMinutes(
        EVENT_ID,
        { decisions: ['Approved the budget'] },
        ORGANIZER,
        MINISTRY,
      );

      // Only the decisions were submitted, so nothing should have touched the
      // next steps — otherwise saving one list would silently wipe the other.
      const touched = pointWrites().map((w) => w.where?.type ?? w.data?.[0]?.type);
      expect(touched).not.toContain('NEXT_STEP');
    });

    it('clears a list when an empty array is sent', async () => {
      await service.draftMinutes(
        EVENT_ID,
        { decisions: [] },
        ORGANIZER,
        MINISTRY,
      );

      const writes = pointWrites();
      expect(writes.find((w) => w.op === 'delete').where).toEqual({
        minutesId: 'm1',
        type: 'DECISION',
      });
      expect(writes.find((w) => w.op === 'create').data).toEqual([]);
    });

    it('drops blank lines rather than storing them', async () => {
      await service.draftMinutes(
        EVENT_ID,
        { nextSteps: ['  ', 'Reconvene after the review', ''] },
        ORGANIZER,
        MINISTRY,
      );

      const created = pointWrites().find((w) => w.op === 'create');
      expect(created.data).toEqual([
        {
          minutesId: 'm1',
          type: 'NEXT_STEP',
          text: 'Reconvene after the review',
          order: 0,
        },
      ]);
    });

    it('replaces both lists in one transaction', async () => {
      await service.draftMinutes(
        EVENT_ID,
        { decisions: ['One'], nextSteps: ['Two'] },
        ORGANIZER,
        MINISTRY,
      );

      // One call, four operations: a record must never be seen having lost its
      // old points and not yet gained the new ones.
      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(pointWrites()).toHaveLength(4);
    });

    it('refuses minutes on a public activity', async () => {
      seedEvent({ isPublic: true });

      await expect(
        service.draftMinutes(EVENT_ID, { decisions: ['x'] }, ORGANIZER, MINISTRY),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses someone who is not an organizer', async () => {
      await expect(
        service.draftMinutes(EVENT_ID, { decisions: ['x'] }, 'someone', MINISTRY),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('publishing', () => {
    beforeEach(() => seedEvent());

    it('refuses a record with nothing in it', async () => {
      seedMinutes({ _count: { points: 0, actionItems: 0 } });

      await expect(
        service.publishMinutes(EVENT_ID, ORGANIZER, MINISTRY),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.minutes.update).not.toHaveBeenCalled();
    });

    // Which of the three is present is the meeting's business. Plenty of
    // meetings decide nothing and only agree who does what next.
    it.each([
      ['a decision or next step', { points: 1, actionItems: 0 }],
      ['an action item alone', { points: 0, actionItems: 1 }],
    ])('publishes a record carrying %s', async (_label, counts) => {
      seedMinutes({ _count: counts });

      await service.publishMinutes(EVENT_ID, ORGANIZER, MINISTRY);

      expect(prisma.minutes.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PUBLISHED' }),
        }),
      );
    });

    it('still refuses a meeting with no attendees', async () => {
      seedEvent({ attendees: [] });
      seedMinutes({ _count: { points: 3, actionItems: 0 } });

      await expect(
        service.publishMinutes(EVENT_ID, ORGANIZER, MINISTRY),
      ).rejects.toThrow(BadRequestException);
    });

    it('refuses to publish an archived record', async () => {
      seedMinutes({
        status: 'ARCHIVED',
        _count: { points: 3, actionItems: 0 },
      });

      await expect(
        service.publishMinutes(EVENT_ID, ORGANIZER, MINISTRY),
      ).rejects.toThrow(ForbiddenException);
    });
  });

  describe('the edit window', () => {
    it('lets the organizer edit within two days of the meeting', async () => {
      seedEvent();
      await expect(
        service.canEditMinutes(EVENT_ID, ORGANIZER, 'STAFF', MINISTRY),
      ).resolves.toBe(true);
    });

    it('closes for the organizer once the window has passed', async () => {
      seedEvent({ endAt: new Date(Date.now() - 5 * 24 * 60 * 60_000) });
      await expect(
        service.canEditMinutes(EVENT_ID, ORGANIZER, 'STAFF', MINISTRY),
      ).resolves.toBe(false);
    });

    it('still lets a minister edit past the window', async () => {
      seedEvent({ endAt: new Date(Date.now() - 5 * 24 * 60 * 60_000) });
      await expect(
        service.canEditMinutes(EVENT_ID, 'someone', 'MINISTER', MINISTRY),
      ).resolves.toBe(true);
    });

    it('refuses an editor from another ministry', async () => {
      seedEvent();
      await expect(
        service.canEditMinutes(EVENT_ID, ORGANIZER, 'STAFF', 'min-other'),
      ).resolves.toBe(false);
    });
  });
});
