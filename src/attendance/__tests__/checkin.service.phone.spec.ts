import { CheckinService } from '../checkin.service';

/**
 * The attendance row has a phone column that only guests ever filled, so every
 * staff row showed a dash on the attendees page and in the exports.
 *
 * The copy was written — `checkIn` reads `user.phone` — but the object it reads
 * is the projection AuthService.getSession builds field by field, and `phone`
 * was not among them. So the number was always undefined here while the desk
 * path, which asks the database instead, stamped it correctly: the same person
 * got a phone number or a dash depending on which door they came through.
 *
 * These assert the copy at this end. auth.service.signin.spec asserts the
 * session carries the field for it to copy.
 */
process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY ?? 'a'.repeat(64);

describe('CheckinService — the phone number on a staff row', () => {
  const ANCHOR_LAT = 8.4657;
  const ANCHOR_LNG = -13.2317;

  let prisma: any;
  let qrToken: any;
  let service: CheckinService;

  const created = () => prisma.attendance.create.mock.calls[0][0].data;

  beforeEach(() => {
    jest.clearAllMocks();
    qrToken = {
      findToken: jest.fn().mockResolvedValue({
        token: 'tok',
        eventId: 'e1',
        expiresAt: new Date(Date.now() + 5 * 60_000),
      }),
    };
    prisma = {
      event: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'e1',
          title: 'Cabinet Meeting',
          status: 'PUBLISHED',
          endAt: new Date(Date.now() + 60 * 60_000),
          ministryId: 'min-moh',
          allowGuestCheckIn: true,
          checkInAnchorLat: ANCHOR_LAT,
          checkInAnchorLng: ANCHOR_LNG,
        }),
      },
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

  /** Standing on the anchor, so nothing here turns on the geofence. */
  const atTheVenue = {
    signedName: 'Aminata Kamara',
    signature: 'data:,x',
    lat: ANCHOR_LAT,
    lng: ANCHOR_LNG,
    gpsAccuracy: 12,
  } as any;

  it('stamps the number from the account', async () => {
    await service.checkIn(
      'tok',
      atTheVenue,
      { id: 'u1', ministryId: 'min-moh', phone: '+232 76 000 111' } as any,
      {},
    );

    expect(created().guestPhone).toBe('+232 76 000 111');
  });

  it('leaves it null for someone who has not set one', async () => {
    await service.checkIn(
      'tok',
      atTheVenue,
      { id: 'u1', ministryId: 'min-moh', phone: null } as any,
      {},
    );

    // Null rather than an empty string: the attendees page prints a dash for
    // one and a blank cell for the other.
    expect(created().guestPhone).toBeNull();
  });

  // A number that is only whitespace is the same as no number, and storing it
  // would put an invisible value where the page expects a dash.
  it('treats a blank number as none', async () => {
    await service.checkIn(
      'tok',
      atTheVenue,
      { id: 'u1', ministryId: 'min-moh', phone: '   ' } as any,
      {},
    );

    expect(created().guestPhone).toBeNull();
  });
});
