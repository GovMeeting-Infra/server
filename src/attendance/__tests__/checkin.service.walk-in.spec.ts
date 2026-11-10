import { CheckinService } from '../checkin.service';

/**
 * A signed-in colleague who scans in without having been invited is a
 * walk-in, exactly as a guest or a desk check-in would be. This path used to
 * leave the flag false for everybody, so such a person appeared under Checked
 * In and nowhere else on the attendees page, was missing from the export's
 * walk-in count, and was not sent the published minutes.
 */
process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY ?? 'a'.repeat(64);

describe('CheckinService.checkIn — the walk-in flag', () => {
  const ANCHOR_LAT = 8.4657;
  const ANCHOR_LNG = -13.2317;
  let prisma: any;
  let service: CheckinService;

  beforeEach(() => {
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
      eventAttendee: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    service = new CheckinService(
      prisma,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      {
        findToken: jest.fn().mockResolvedValue({
          token: 'tok',
          eventId: 'e1',
          expiresAt: new Date(Date.now() + 5 * 60_000),
        }),
      } as any,
      { invalidateAnalyticsFor: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  const atTheVenue = {
    signedName: 'Aminata Kamara',
    signature: 'data:,x',
    lat: ANCHOR_LAT,
    lng: ANCHOR_LNG,
    gpsAccuracy: 12,
  } as any;
  const user = {
    id: 'u1',
    name: 'Aminata Kamara',
    email: 'a.kamara@moh.gov.sl',
  };
  const created = () => prisma.attendance.create.mock.calls[0][0].data;

  it('marks an uninvited colleague as a walk-in', async () => {
    await service.checkIn('tok', atTheVenue, user);
    expect(created().isWalkIn).toBe(true);
  });

  it('does not mark an invited colleague', async () => {
    prisma.eventAttendee.findFirst.mockResolvedValue({ id: 'inv' });
    await service.checkIn('tok', atTheVenue, user);
    expect(created().isWalkIn).toBe(false);
  });

  it('counts an invitation made to their address as an invitation', async () => {
    // Invited through the Guests lookup, which records an address rather than
    // the account — still invited.
    await service.checkIn('tok', atTheVenue, user);
    expect(prisma.eventAttendee.findFirst.mock.calls[0][0].where.OR).toEqual([
      { userId: 'u1' },
      { externalEmail: { equals: 'a.kamara@moh.gov.sl', mode: 'insensitive' } },
    ]);
  });
});
