import { QRTokenService } from '../qr-token.service';

/**
 * One check-in code per meeting, lasting as long as the meeting.
 *
 * It used to last five minutes and be replaced over and over. That put the
 * organizer in charge of a clock — anybody arriving while the screen showed a
 * dead code could not get in — and the thing it was protecting against was
 * already handled by the check-in area, which a photographed code cannot carry
 * with it.
 *
 * These pin down the part that is easy to reintroduce by accident: that asking
 * for the code twice gives back the same code, and that replacing one is
 * something a person has to ask for.
 */
describe('QRTokenService', () => {
  const MEETING_END = new Date('2026-03-05T12:00:00Z');

  let prisma: any;
  let service: QRTokenService;
  let created: any[];

  beforeEach(() => {
    jest.clearAllMocks();
    created = [];
    prisma = {
      qRToken: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn(),
        create: jest.fn().mockImplementation(({ data }: any) => {
          created.push(data);
          return data;
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    service = new QRTokenService(prisma);
  });

  /** A code already on screen with the rest of the meeting to run. */
  const live = () => ({
    token: 'already-issued',
    expiresAt: MEETING_END,
  });

  it('mints a code that lasts until the meeting ends', async () => {
    const result = await service.ensureActiveToken('evt-1', MEETING_END);

    expect(result.expiresAt).toEqual(MEETING_END);
    expect(created[0]).toMatchObject({
      eventId: 'evt-1',
      expiresAt: MEETING_END,
    });
  });

  it('hands back the same code when asked again', async () => {
    prisma.qRToken.findFirst.mockResolvedValue(live());

    const result = await service.ensureActiveToken('evt-1', MEETING_END);

    expect(result.token).toBe('already-issued');
    expect(prisma.qRToken.create).not.toHaveBeenCalled();
  });

  // The old reuse rule refused to hand back a code with under a minute left,
  // so the last minute of every meeting quietly minted a new one.
  it('hands back the same code even in the final minute', async () => {
    const nearlyOver = new Date(Date.now() + 30_000);
    prisma.qRToken.findFirst.mockResolvedValue({
      token: 'already-issued',
      expiresAt: nearlyOver,
    });

    const result = await service.ensureActiveToken('evt-1', nearlyOver);

    expect(result.token).toBe('already-issued');
    expect(prisma.qRToken.create).not.toHaveBeenCalled();
  });

  it('replaces the code only when asked', async () => {
    prisma.qRToken.findFirst.mockResolvedValue(live());

    const result = await service.ensureActiveToken('evt-1', MEETING_END, {
      force: true,
    });

    expect(prisma.qRToken.create).toHaveBeenCalled();
    expect(result.token).not.toBe('already-issued');
  });

  it('ignores a code that has already run out', async () => {
    // findFirst only ever returns a live one, so this is the "no code yet"
    // path: a meeting whose code expired gets a new one rather than nothing.
    prisma.qRToken.findFirst.mockResolvedValue(null);

    const result = await service.ensureActiveToken('evt-1', MEETING_END);

    expect(result.token).toBeTruthy();
    expect(prisma.qRToken.create).toHaveBeenCalled();
  });

  it('gives two meetings different codes', async () => {
    await service.mintToken('evt-1', MEETING_END);
    await service.mintToken('evt-2', MEETING_END);

    expect(created[0].token).not.toBe(created[1].token);
  });

  it('closing check-in expires what is live', async () => {
    const count = await service.expireTokens('evt-1');

    expect(count).toBe(1);
    // The only kill switch now that nothing expires on its own, so it has to
    // reach every live code rather than just the newest.
    expect(prisma.qRToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ eventId: 'evt-1' }),
      }),
    );
  });
});
