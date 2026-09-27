import { BadRequestException } from '@nestjs/common';
import { CheckinService } from '../checkin.service';
import { CODE_OPENS_BEFORE_START_MINUTES } from '../geofence.constants';

/**
 * Generating a meeting's check-in code, which is also what sets its check-in
 * area: the organizer's position at the moment they press the button.
 *
 * Each day of a series is its own event, so each is anchored on its own day.
 * The failures worth pinning down are the ones that put the area in the wrong
 * place or remove it: generating from somewhere else ahead of time, a second
 * press dragging the area along, and a reset with a poor fix wiping it.
 */
// See checkin.service.geofence.spec: the service cannot be constructed
// without a 64-hex-character key.
process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY ?? 'a'.repeat(64);

describe('CheckinService.issueCheckInCode', () => {
  const MIN = 60_000;
  const ANCHOR = { lat: 8.4657, lng: -13.2317 };
  const organizer = { id: 'u-org', ministryId: 'min-moh' };

  let prisma: any;
  let qrToken: any;
  let service: CheckinService;

  /** A published meeting starting soon, anchored or not. */
  const seed = (over: { startsInMin?: number; anchored?: boolean } = {}) => {
    const startsIn = over.startsInMin ?? 30;
    const event = {
      id: 'e1',
      title: 'Weekly Review',
      status: 'PUBLISHED',
      startAt: new Date(Date.now() + startsIn * MIN),
      endAt: new Date(Date.now() + (startsIn + 60) * MIN),
      ministryId: 'min-moh',
      allowGuestCheckIn: false,
      requireGeofence: false,
      checkInAnchorLat: over.anchored ? ANCHOR.lat : null,
      checkInAnchorLng: over.anchored ? ANCHOR.lng : null,
      checkInAnchorAccuracy: over.anchored ? 20 : null,
      checkInAnchorSetAt: over.anchored ? new Date() : null,
      checkInAnchorSetById: over.anchored ? 'u-org' : null,
    };
    prisma.event.findUnique.mockResolvedValue(event);
    prisma.event.update.mockImplementation(({ data }: any) => ({
      ...event,
      ...data,
    }));
    return event;
  };

  /** What the area was written as, or undefined if it was not touched. */
  const anchorWrite = () => prisma.event.update.mock.calls[0]?.[0].data;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      event: { findUnique: jest.fn(), update: jest.fn() },
      $transaction: jest.fn((fn: any) => fn(prisma)),
    };
    qrToken = {
      ensureActiveToken: jest
        .fn()
        .mockResolvedValue({ token: 'tok', expiresAt: new Date() }),
    };
    service = new CheckinService(
      prisma,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      qrToken,
      {} as any,
    );
  });

  const goodFix = { ...ANCHOR, gpsAccuracy: 15 };

  describe('when it can be generated', () => {
    it('refuses before the window opens, so the area is set on the day', async () => {
      seed({ startsInMin: CODE_OPENS_BEFORE_START_MINUTES + 30 });

      await expect(
        service.issueCheckInCode('e1', goodFix, organizer),
      ).rejects.toThrow(BadRequestException);
      expect(qrToken.ensureActiveToken).not.toHaveBeenCalled();
      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('allows it once the window has opened', async () => {
      seed({ startsInMin: CODE_OPENS_BEFORE_START_MINUTES - 5 });

      const res = await service.issueCheckInCode('e1', goodFix, organizer);

      expect(res.token).toBe('tok');
    });

    it('tells the page when the window opens', async () => {
      const event = seed({ startsInMin: 30 });

      const res = await service.issueCheckInCode('e1', goodFix, organizer);

      expect(res.codeOpensAt?.getTime()).toBe(
        event.startAt.getTime() - CODE_OPENS_BEFORE_START_MINUTES * MIN,
      );
    });
  });

  describe('setting the area', () => {
    it('sets it from the first generate with a good fix', async () => {
      seed();

      const res = await service.issueCheckInCode('e1', goodFix, organizer);

      expect(anchorWrite()).toMatchObject({
        checkInAnchorLat: ANCHOR.lat,
        checkInAnchorLng: ANCHOR.lng,
        checkInAnchorSetById: 'u-org',
      });
      expect(res.geofence.enabled).toBe(true);
    });

    it('refuses a first generate whose fix is too vague', async () => {
      seed();

      await expect(
        service.issueCheckInCode(
          'e1',
          { ...ANCHOR, gpsAccuracy: 200 },
          organizer,
        ),
      ).rejects.toThrow(BadRequestException);
      expect(qrToken.ensureActiveToken).not.toHaveBeenCalled();
    });

    it('does not move it on a second generate from somewhere else', async () => {
      seed({ anchored: true });

      await service.issueCheckInCode(
        'e1',
        { lat: 8.49, lng: -13.2, gpsAccuracy: 10 },
        organizer,
      );

      expect(prisma.event.update).not.toHaveBeenCalled();
    });

    it('keeps it when the code is replaced', async () => {
      seed({ anchored: true });

      await service.issueCheckInCode('e1', { rotate: true }, organizer);

      expect(prisma.event.update).not.toHaveBeenCalled();
      expect(qrToken.ensureActiveToken).toHaveBeenCalledWith(
        'e1',
        expect.any(Date),
        { force: true },
        prisma,
      );
    });
  });

  describe('resetting the area', () => {
    it('moves it to a new good fix', async () => {
      seed({ anchored: true });

      await service.issueCheckInCode(
        'e1',
        { lat: 8.47, lng: -13.23, gpsAccuracy: 12, resetAnchor: true },
        organizer,
      );

      expect(anchorWrite()).toMatchObject({
        checkInAnchorLat: 8.47,
        checkInAnchorLng: -13.23,
      });
    });

    it.each([
      ['a vague fix', { ...ANCHOR, gpsAccuracy: 300 }],
      ['no fix at all', {}],
    ])(
      'refuses with %s and leaves the old area and code alone',
      async (_label, fix) => {
        // This used to clear the area, leaving a live code that accepted
        // everyone from anywhere.
        seed({ anchored: true });

        await expect(
          service.issueCheckInCode(
            'e1',
            { ...fix, resetAnchor: true },
            organizer,
          ),
        ).rejects.toThrow(BadRequestException);
        expect(prisma.event.update).not.toHaveBeenCalled();
        expect(qrToken.ensureActiveToken).not.toHaveBeenCalled();
      },
    );
  });
});
