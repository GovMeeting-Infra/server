import { CheckinService } from '../checkin.service';

/**
 * The guest desk refuses an address that belongs to an account — staff sign
 * in — but an account still holding an unused invitation has no password to
 * sign in with. Telling that person to sign in left them stuck at the door.
 */
process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY ?? 'a'.repeat(64);

describe('CheckinService.guestCheckIn — invited but not yet joined', () => {
  const ANCHOR_LAT = 8.4657;
  const ANCHOR_LNG = -13.2317;

  let prisma: any;
  let service: CheckinService;

  const form = {
    guestName: 'Isatu Bangura',
    guestEmail: 'Isatu.Bangura@moh.gov.sl',
    guestTitle: 'Programme Officer',
    guestOrganisation: 'Ministry of Health',
    guestPhone: '+23276000000',
    signature: 'data:,x',
    lat: ANCHOR_LAT,
    lng: ANCHOR_LNG,
    gpsAccuracy: 12,
  } as any;

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
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      eventAttendee: { findFirst: jest.fn().mockResolvedValue({ id: 'inv' }) },
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

  const created = () => prisma.attendance.create.mock.calls[0][0].data;

  it('still sends somebody who has joined to sign in', async () => {
    prisma.user.findFirst.mockResolvedValue({
      id: 'u1',
      accounts: [{ id: 'acc' }],
    });
    await expect(service.guestCheckIn('tok', form)).rejects.toThrow(
      'please sign in',
    );
    expect(prisma.attendance.create).not.toHaveBeenCalled();
  });

  it('checks in somebody who has not accepted, against their account', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'u1', accounts: [] });

    await service.guestCheckIn('tok', form);

    expect(created()).toMatchObject({
      userId: 'u1',
      guestEmail: 'isatu.bangura@moh.gov.sl',
      guestName: 'Isatu Bangura',
      isWalkIn: false,
    });
  });

  it('does not check the same person in twice by either route', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'u1', accounts: [] });
    prisma.attendance.findFirst.mockResolvedValue({ id: 'earlier' });

    await expect(service.guestCheckIn('tok', form)).rejects.toThrow(
      'Already checked in',
    );
    // Matched on the account as well as the address: an organizer may already
    // have recorded them at the desk, which writes the user id, not the email.
    expect(prisma.attendance.findFirst.mock.calls[0][0].where.OR).toEqual([
      { guestEmail: 'isatu.bangura@moh.gov.sl' },
      { userId: 'u1' },
    ]);
  });

  it('leaves a true guest exactly as before', async () => {
    await service.guestCheckIn('tok', { ...form, guestEmail: 'visitor@x.org' });
    expect(created().userId).toBeNull();
  });
});
