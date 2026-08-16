import { BadRequestException } from '@nestjs/common';
import { CheckinService } from '../checkin.service';
import { GEOFENCE_RADIUS_METERS } from '../geofence.constants';

/**
 * The radius, as the service actually enforces it.
 *
 * geofence.util.spec covers `isWithinRadius`, which the service does not call —
 * it imports `haversineDistance` and compares inline. So the line that decides
 * whether someone may check in had no test at all, and neither did the
 * consequence of failing it: that no attendance row is written.
 *
 * These go through `checkIn` rather than poking at the private method, because
 * "was a row created" is the part worth asserting.
 */
// CheckinService builds an EncryptionUtil in its constructor to encrypt
// coordinates, and that needs 32 bytes as 64 hex characters. Its in-code
// fallback ('0123456789abcdef0123456789abcdef') is 32 *characters*, so it
// fails the length check — the service cannot be constructed without this set.
process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY ?? 'a'.repeat(64);

describe('CheckinService — geofence enforcement', () => {
  /** Freetown, near enough a plausible ministry venue. */
  const ANCHOR_LAT = 8.4657;
  const ANCHOR_LNG = -13.2317;
  const M_PER_DEG_LAT = 111_320;

  const metresNorth = (metres: number) => ({
    lat: ANCHOR_LAT + metres / M_PER_DEG_LAT,
    lng: ANCHOR_LNG,
  });

  let prisma: any;
  let qrToken: any;
  let service: CheckinService;

  /**
   * An open, published event.
   *
   * Anchored or not is the only question: an anchored event gates entry, and an
   * unanchored one has no code to scan in the first place — the generate path
   * refuses a fix too poor to anchor from.
   */
  const seedEvent = (anchored = true) => {
    qrToken.findToken.mockResolvedValue({
      token: 'tok',
      eventId: 'e1',
      expiresAt: new Date(Date.now() + 5 * 60_000),
    });
    prisma.event.findUnique.mockResolvedValue({
      id: 'e1',
      title: 'Cabinet Meeting',
      status: 'PUBLISHED',
      endAt: new Date(Date.now() + 60 * 60_000),
      ministryId: 'min-moh',
      allowGuestCheckIn: true,
      checkInAnchorLat: anchored ? ANCHOR_LAT : null,
      checkInAnchorLng: anchored ? ANCHOR_LNG : null,
    });
  };

  const created = () => prisma.attendance.create.mock.calls[0][0].data;

  beforeEach(() => {
    jest.clearAllMocks();
    qrToken = { findToken: jest.fn() };
    prisma = {
      event: { findUnique: jest.fn() },
      attendance: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: any) => ({ id: 'a1', ...data })),
      },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      eventAttendee: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    service = new CheckinService(
      prisma,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      qrToken,
      { invalidateAnalyticsFor: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  const staff = { id: 'u1', ministryId: 'min-moh' };
  const dto = (over: Record<string, unknown> = {}) =>
    ({ signedName: 'Aminata Kamara', signature: 'data:,x', ...over }) as any;

  describe('anchored event', () => {
    beforeEach(() => seedEvent(true));

    it('accepts someone inside the radius', async () => {
      const near = metresNorth(GEOFENCE_RADIUS_METERS - 20);

      await service.checkIn(
        'tok',
        dto({ ...near, gpsAccuracy: 12 }),
        staff,
        {},
      );

      expect(created().withinGeofence).toBe(true);
      expect(created().checkInMethod).toBe('GEO');
    });

    it('refuses someone outside it, and writes nothing', async () => {
      const far = metresNorth(GEOFENCE_RADIUS_METERS + 50);

      await expect(
        service.checkIn('tok', dto({ ...far, gpsAccuracy: 12 }), staff, {}),
      ).rejects.toThrow(BadRequestException);

      // The point of the whole exercise: a refused check-in is not a flagged
      // record, it is no record.
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('refuses when no location is supplied at all', async () => {
      await expect(service.checkIn('tok', dto(), staff, {})).rejects.toThrow(
        BadRequestException,
      );
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('refuses a fix too vague to localise anything', async () => {
      const near = metresNorth(10);

      await expect(
        service.checkIn('tok', dto({ ...near, gpsAccuracy: 900 }), staff, {}),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });

    // The case this whole change exists for. A phone indoors positions itself
    // from Wi-Fi and reports hundreds of metres; the person is in the room, and
    // used to be told their signal was insufficient.
    it('lets in a vague fix that could still be inside, recorded unverified', async () => {
      const near = metresNorth(120);

      await service.checkIn(
        'tok',
        dto({ ...near, gpsAccuracy: 200 }),
        staff,
        {},
      );

      expect(created().withinGeofence).toBeNull();
      expect(created().checkInMethod).toBe('GEO');
      expect(created().gpsAccuracy).toBe(200);
    });

    it('still refuses someone who cannot be inside even at their closest', async () => {
      const far = metresNorth(400);

      await expect(
        service.checkIn('tok', dto({ ...far, gpsAccuracy: 100 }), staff, {}),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('names the reason in a code, not only in prose', async () => {
      const far = metresNorth(400);

      // Prose gets rewritten; a client matching on it breaks silently. The
      // code is the contract.
      await expect(
        service.checkIn('tok', dto({ ...far, gpsAccuracy: 20 }), staff, {}),
      ).rejects.toMatchObject({
        response: { code: 'OUTSIDE_AREA' },
      });

      await expect(
        service.checkIn('tok', dto(), staff, {}),
      ).rejects.toMatchObject({
        response: { code: 'LOCATION_REQUIRED' },
      });

      await expect(
        service.checkIn(
          'tok',
          dto({ ...metresNorth(10), gpsAccuracy: 900 }),
          staff,
          {},
        ),
      ).rejects.toMatchObject({
        response: { code: 'ACCURACY_TOO_LOW' },
      });
    });

    it('keeps the anchor out of the refusal, so it cannot be trilaterated', async () => {
      const far = metresNorth(400);

      await expect(
        service.checkIn('tok', dto({ ...far, gpsAccuracy: 20 }), staff, {}),
      ).rejects.toMatchObject({
        response: { message: expect.not.stringMatching(/\d+\s*m\b/) },
      });
    });

    it('flags an accuracy of exactly zero without blocking it', async () => {
      // A real fix is never exactly 0m, so this is the signature of a mock
      // location provider. It is deliberately a flag rather than a refusal:
      // the heuristic is weak enough that blocking on it would lock out
      // genuine attendees. Recorded so a human can judge, not enforced.
      const near = metresNorth(10);

      await service.checkIn('tok', dto({ ...near, gpsAccuracy: 0 }), staff, {});

      expect(created().mockLocationFlag).toBe(true);
      expect(created().withinGeofence).toBe(true);
    });
  });

  describe('an anchor always gates', () => {
    // Location verification is no longer a per-event setting. Generating a code
    // requires a fix good enough to anchor from, so every code that exists is
    // fenced and every holder of one has to be inside the area.
    beforeEach(() => seedEvent(true));

    it('turns away someone plainly outside the area', async () => {
      const far = metresNorth(4_000);

      await expect(
        service.checkIn('tok', dto({ ...far, gpsAccuracy: 15 }), staff, {}),
      ).rejects.toThrow();
    });

    it('verifies someone plainly inside', async () => {
      const near = metresNorth(20);

      await service.checkIn(
        'tok',
        dto({ ...near, gpsAccuracy: 10 }),
        staff,
        {},
      );

      expect(created().withinGeofence).toBe(true);
    });

    it('refuses a check-in that sends no location at all', async () => {
      await expect(service.checkIn('tok', dto(), staff, {})).rejects.toThrow();
    });
  });

  describe('unanchored event', () => {
    beforeEach(() => seedEvent(false));

    it('checks in without a location, unverified', async () => {
      await service.checkIn('tok', dto(), staff, {});

      expect(created().withinGeofence).toBeNull();
      expect(created().checkInMethod).toBe('QR');
    });

    it('still records a location when one is offered', async () => {
      // The client now asks for a fix on every check-in. With no anchor there
      // is nothing to measure against, but the reading is still part of the
      // record — this used to be dropped because it was never requested.
      const somewhere = metresNorth(4_000);

      await service.checkIn(
        'tok',
        dto({ ...somewhere, gpsAccuracy: 18 }),
        staff,
        {},
      );

      expect(created().lat).not.toBeNull();
      expect(created().lng).not.toBeNull();
      expect(created().gpsAccuracy).toBe(18);
      // Far outside any fence, but no fence exists, so it is recorded rather
      // than refused.
      expect(created().withinGeofence).toBeNull();
    });
  });
});
