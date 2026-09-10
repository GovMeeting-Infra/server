import { CheckinService } from '../checkin.service';
import { GEOFENCE_RADIUS_METERS } from '../geofence.constants';

process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY ?? 'a'.repeat(64);

/**
 * The register an organizer keeps when the room has no signal.
 *
 * The rule these exist to protect is the one that is easiest to get wrong by
 * being conscientious: a record synced hours later must never be refused.
 * Refusing it deletes somebody who was in the room and signed for it, at a
 * point where nobody can notice or put it right.
 */
describe('CheckinService — offline register', () => {
  const ANCHOR_LAT = 8.4657;
  const ANCHOR_LNG = -13.2317;
  const M_PER_DEG_LAT = 111_320;

  const metresNorth = (metres: number) => ({
    lat: ANCHOR_LAT + metres / M_PER_DEG_LAT,
    lng: ANCHOR_LNG,
  });

  let prisma: any;
  let service: CheckinService;

  const EVENT = {
    id: 'e1',
    title: 'Cabinet Meeting',
    status: 'PUBLISHED',
    startAt: new Date('2026-09-07T09:00:00.000Z'),
    endAt: new Date('2026-09-07T11:00:00.000Z'),
    ministryId: 'min-moh',
    checkInAnchorLat: ANCHOR_LAT,
    checkInAnchorLng: ANCHOR_LNG,
    checkInAnchorAccuracy: 10,
    checkInAnchorSetAt: new Date('2026-09-07T08:55:00.000Z'),
    checkInAnchorSetById: 'u1',
  };

  const seedEvent = (over: Record<string, unknown> = {}) =>
    prisma.event.findUnique.mockResolvedValue({ ...EVENT, ...over });

  const rows = () =>
    prisma.attendance.create.mock.calls.map((c: any) => c[0].data);

  const record = (over: Record<string, unknown> = {}) => ({
    signedName: 'Aminata Kamara',
    guestName: 'Aminata Kamara',
    guestEmail: 'aminata@example.org',
    capturedAt: '2026-09-07T09:10:00.000Z',
    signature: 'data:image/png;base64,iVBORw0KGgo=',
    ...over,
  });

  const staff = { id: 'u-organizer' };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      event: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
      attendance: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: any) => ({ id: data.id ?? 'a1', ...data })),
      },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      eventAttendee: { findFirst: jest.fn().mockResolvedValue(null) },
    };

    service = new CheckinService(
      prisma,
      { log: jest.fn().mockResolvedValue(undefined) } as any,
      { findToken: jest.fn() } as any,
      {
        invalidateAnalyticsFor: jest.fn().mockResolvedValue(undefined),
        invalidateAnalytics: jest.fn().mockResolvedValue(undefined),
      } as any,
    );
    seedEvent();
  });

  it('records a signed attendee and flags it as captured offline', async () => {
    const result = await service.syncOfflineRegister(
      'e1',
      { records: [record({ ...metresNorth(20), gpsAccuracy: 15 })] },
      staff,
    );

    expect(result.results[0].status).toBe('RECORDED');
    const row = rows()[0];
    expect(row.capturedOffline).toBe(true);
    expect(row.capturedById).toBe('u-organizer');
    expect(row.syncedAt).toBeInstanceOf(Date);
    // Staff vouched in person; that is what MANUAL means and it stays true.
    expect(row.checkInMethod).toBe('MANUAL');
    expect(row.signature).toBe('data:image/png;base64,iVBORw0KGgo=');
  });

  it('keeps the time the person actually signed, not the time it synced', async () => {
    await service.syncOfflineRegister('e1', { records: [record()] }, staff);

    expect(rows()[0].checkInAt.toISOString()).toBe('2026-09-07T09:10:00.000Z');
    expect(rows()[0].capturedAt.toISOString()).toBe('2026-09-07T09:10:00.000Z');
  });

  it('records someone whose fix was outside the fence, rather than deleting them', async () => {
    // This is the whole policy. Live, a bad fix is refused and the person can
    // move. Hours later, refusing means erasing an attendee who signed.
    const far = metresNorth(GEOFENCE_RADIUS_METERS + 500);

    const result = await service.syncOfflineRegister(
      'e1',
      { records: [record({ ...far, gpsAccuracy: 10 })] },
      staff,
    );

    expect(result.results[0].status).toBe('RECORDED');
    expect(rows()[0].withinGeofence).toBe(false);
    expect(rows()[0].capturedOffline).toBe(true);
  });

  it('records someone whose device sent no location at all', async () => {
    const result = await service.syncOfflineRegister(
      'e1',
      { records: [record()] },
      staff,
    );

    expect(result.results[0].status).toBe('RECORDED');
    // Unverified, which is a different state from "outside".
    expect(rows()[0].withinGeofence).toBeNull();
  });

  it('pulls a broken device clock into the meeting rather than refusing it', async () => {
    // A tablet that came back from a power cut believing it was 1970.
    const result = await service.syncOfflineRegister(
      'e1',
      { records: [record({ capturedAt: '1970-01-01T00:00:00.000Z' })] },
      staff,
    );

    expect(result.results[0].status).toBe('RECORDED');
    expect(rows()[0].checkInAt.toISOString()).toBe('2026-09-07T07:00:00.000Z');
    // The claim is preserved so a disputed record can be examined.
    expect(rows()[0].capturedAt.toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('reports someone already recorded as a duplicate, not a failure', async () => {
    // They were written into the register at the desk and also scanned for
    // themselves before the connection went. Ordinary, not an error.
    prisma.attendance.findFirst.mockResolvedValue({ id: 'existing' });

    const result = await service.syncOfflineRegister(
      'e1',
      { records: [record()] },
      staff,
    );

    expect(result.results[0].status).toBe('DUPLICATE');
    expect(prisma.attendance.create).not.toHaveBeenCalled();
  });

  it('lets one bad row through without costing the rest of the register', async () => {
    prisma.attendance.create
      .mockRejectedValueOnce(new Error('column overflow'))
      .mockImplementation(({ data }: any) => ({ id: 'a2', ...data }));

    const result = await service.syncOfflineRegister(
      'e1',
      { records: [record({ guestEmail: 'first@example.org' }), record({ guestEmail: 'second@example.org' })] },
      staff,
    );

    expect(result.results.map((r) => r.status)).toEqual(['REJECTED', 'RECORDED']);
  });

  it('adopts the device fix as the fence only when the meeting has none', async () => {
    seedEvent({ checkInAnchorLat: null, checkInAnchorLng: null });

    await service.syncOfflineRegister(
      'e1',
      {
        records: [record()],
        anchorLat: ANCHOR_LAT,
        anchorLng: ANCHOR_LNG,
        anchorAccuracy: 12,
      },
      staff,
    );

    expect(prisma.event.update).toHaveBeenCalled();
    expect(prisma.event.update.mock.calls[0][0].data.checkInAnchorLat).toBe(
      ANCHOR_LAT,
    );
  });

  it('never moves a fence that already exists', async () => {
    // Otherwise syncing would be a way to redraw the area after the fact,
    // around wherever happened to suit.
    await service.syncOfflineRegister(
      'e1',
      {
        records: [record()],
        anchorLat: 0,
        anchorLng: 0,
        anchorAccuracy: 5,
      },
      staff,
    );

    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  it('refuses a device fix too vague to anchor from', async () => {
    seedEvent({ checkInAnchorLat: null, checkInAnchorLng: null });

    await service.syncOfflineRegister(
      'e1',
      {
        records: [record()],
        anchorLat: ANCHOR_LAT,
        anchorLng: ANCHOR_LNG,
        anchorAccuracy: 500,
      },
      staff,
    );

    expect(prisma.event.update).not.toHaveBeenCalled();
  });

  it('links a record to an account when the email belongs to one', async () => {
    prisma.user.findFirst.mockResolvedValue({ id: 'u-aminata', phone: '+232' });

    await service.syncOfflineRegister('e1', { records: [record()] }, staff);

    expect(rows()[0].userId).toBe('u-aminata');
    expect(rows()[0].guestEmail).toBeNull();
  });

  it('writes the client-minted id, so replaying the batch cannot double-record', async () => {
    await service.syncOfflineRegister(
      'e1',
      { records: [record({ id: 'tz4a98xxat96iws9zmbrgj3a' })] },
      staff,
    );

    expect(rows()[0].id).toBe('tz4a98xxat96iws9zmbrgj3a');
  });

  it('treats a primary key collision as already recorded', async () => {
    prisma.attendance.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );

    const result = await service.syncOfflineRegister(
      'e1',
      { records: [record({ id: 'tz4a98xxat96iws9zmbrgj3a' })] },
      staff,
    );

    expect(result.results[0].status).toBe('DUPLICATE');
  });

  it('refuses the whole batch for a cancelled meeting', async () => {
    seedEvent({ status: 'CANCELLED' });

    await expect(
      service.syncOfflineRegister('e1', { records: [record()] }, staff),
    ).rejects.toThrow();
  });
});
