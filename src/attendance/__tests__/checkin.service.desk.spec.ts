import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { CheckinService } from '../checkin.service';

/**
 * The desk: recording somebody at the door, and correcting it afterwards.
 *
 * A visitor recorded here used to leave none of the record a visitor recorded
 * by the QR code leaves — no job title, no organisation, no number, no
 * signature — and once a row was on the register the only way to fix a mistyped
 * name was to delete it and record it again, which moved the arrival time and
 * left an audit trail saying somebody had been removed from the meeting.
 *
 * The half worth guarding is what a correction must NOT be able to do.
 */
process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY ?? 'a'.repeat(64);

describe('CheckinService — the desk', () => {
  let prisma: any;
  let audit: any;
  let service: CheckinService;

  const created = () => prisma.attendance.create.mock.calls[0][0].data;
  const written = () => prisma.attendance.update.mock.calls[0][0].data;

  beforeEach(() => {
    jest.clearAllMocks();
    prisma = {
      event: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'e1',
          title: 'Cabinet Meeting',
          status: 'PUBLISHED',
          endAt: new Date(Date.now() + 60 * 60_000),
          ministryId: 'min-moh',
        }),
      },
      user: { findFirst: jest.fn().mockResolvedValue(null) },
      eventAttendee: { findFirst: jest.fn().mockResolvedValue(null) },
      attendance: {
        findFirst: jest.fn().mockResolvedValue(null),
        create: jest
          .fn()
          .mockImplementation(({ data }: any) => ({ id: 'a1', ...data })),
        update: jest.fn().mockImplementation(({ data }: any) => ({
          id: 'a1',
          signedName: 'Aminata Kamara',
          ...data,
        })),
        delete: jest.fn().mockResolvedValue({}),
      },
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    service = new CheckinService(
      prisma,
      audit,
      { findToken: jest.fn() } as any,
      { invalidateAnalyticsFor: jest.fn().mockResolvedValue(undefined) } as any,
    );
  });

  /** Somebody with an account: the platform already knows their details. */
  const asColleague = () =>
    prisma.user.findFirst.mockResolvedValue({
      id: 'u1',
      phone: '+232 76 000 111',
    });

  const visitor = {
    name: 'Fatmata Sesay',
    email: 'fatmata@example.org',
    guestTitle: 'Programme Lead',
    guestOrganisation: 'UNDP',
    guestPhone: '+232 77 123 456',
  } as any;

  describe('recording a visitor', () => {
    it('keeps the details that say who was in the room', async () => {
      await service.manualCheckIn('e1', visitor, 'organizer-1');

      expect(created()).toMatchObject({
        guestName: 'Fatmata Sesay',
        guestEmail: 'fatmata@example.org',
        guestTitle: 'Programme Lead',
        guestOrganisation: 'UNDP',
        guestPhone: '+232 77 123 456',
      });
    });

    it('refuses a visitor with no organisation behind them', async () => {
      // An attendance record that cannot say which organisation was in the
      // room is not much of a record, and nothing else on the platform holds
      // this for somebody with no account.
      await expect(
        service.manualCheckIn(
          'e1',
          { name: 'Fatmata Sesay', email: 'fatmata@example.org' } as any,
          'organizer-1',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.attendance.create).not.toHaveBeenCalled();
    });

    it('names what is missing rather than just refusing', async () => {
      await expect(
        service.manualCheckIn(
          'e1',
          { ...visitor, guestPhone: undefined },
          'organizer-1',
        ),
      ).rejects.toThrow(/phone number/);
    });
  });

  describe('recording a colleague', () => {
    it('asks for nothing the account already holds', async () => {
      asColleague();

      await service.manualCheckIn(
        'e1',
        { name: 'Aminata Kamara', email: 'aminata@moh.gov.sl' } as any,
        'organizer-1',
      );

      // The queue behind them is the reason. Their title and ministry are on
      // file, so retyping them at a desk buys nothing.
      expect(created()).toMatchObject({ userId: 'u1' });
      expect(prisma.attendance.create).toHaveBeenCalled();
    });

    it('falls back to the number on the account', async () => {
      asColleague();

      await service.manualCheckIn(
        'e1',
        { name: 'Aminata Kamara', email: 'aminata@moh.gov.sl' } as any,
        'organizer-1',
      );

      expect(created().guestPhone).toBe('+232 76 000 111');
    });

    it('prefers what was typed at the desk', async () => {
      asColleague();

      await service.manualCheckIn(
        'e1',
        {
          name: 'Aminata Kamara',
          email: 'aminata@moh.gov.sl',
          guestPhone: '+232 30 999 000',
        } as any,
        'organizer-1',
      );

      // The person is standing there; the account may be out of date.
      expect(created().guestPhone).toBe('+232 30 999 000');
    });
  });

  describe('the signature at the desk', () => {
    it('records one when it is offered', async () => {
      await service.manualCheckIn(
        'e1',
        { ...visitor, signature: 'data:image/png;base64,abc' },
        'organizer-1',
      );

      expect(created().signature).toBe('data:image/png;base64,abc');
    });

    it('stays null when nobody signs', async () => {
      await service.manualCheckIn('e1', visitor, 'organizer-1');

      // Null, never '': an empty string already means "captured then erased",
      // and a desk record must not be indistinguishable from a redacted one.
      expect(created().signature).toBeNull();
    });
  });

  describe('correcting a check-in', () => {
    const onRegister = (over: Record<string, unknown> = {}) =>
      prisma.attendance.findFirst.mockResolvedValue({
        id: 'a1',
        eventId: 'e1',
        userId: null,
        guestName: 'Fatmata Sesai',
        guestEmail: 'fatmata@example.org',
        guestTitle: null,
        guestOrganisation: null,
        guestPhone: null,
        signedName: 'Fatmata Sesai',
        signature: null,
        checkInAt: new Date('2026-03-05T10:05:00Z'),
        checkInMethod: 'MANUAL',
        event: { title: 'Cabinet Meeting' },
        ...over,
      });

    it('fixes a name typed wrong at the door', async () => {
      onRegister();

      await service.updateCheckIn(
        'e1',
        'a1',
        { signedName: 'Fatmata Sesay', guestName: 'Fatmata Sesay' } as any,
        'organizer-1',
        'min-moh',
      );

      expect(written()).toMatchObject({
        signedName: 'Fatmata Sesay',
        guestName: 'Fatmata Sesay',
      });
    });

    // The point of the whole thing. These are what the system observed, and a
    // register that can be backdated is not evidence of anything.
    it('cannot move when they arrived or how', async () => {
      onRegister();

      await service.updateCheckIn(
        'e1',
        'a1',
        {
          signedName: 'Fatmata Sesay',
          checkInAt: new Date('2026-01-01T00:00:00Z'),
          checkInMethod: 'GEO',
          withinGeofence: true,
        } as any,
        'organizer-1',
        'min-moh',
      );

      const data = written();
      expect(data).not.toHaveProperty('checkInAt');
      expect(data).not.toHaveProperty('checkInMethod');
      expect(data).not.toHaveProperty('withinGeofence');
    });

    it('lets a signature be added afterwards', async () => {
      onRegister();

      await service.updateCheckIn(
        'e1',
        'a1',
        { signature: 'data:image/png;base64,xyz' } as any,
        'organizer-1',
        'min-moh',
      );

      expect(written().signature).toBe('data:image/png;base64,xyz');
    });

    it('keeps the signature itself out of the audit entry', async () => {
      onRegister();

      await service.updateCheckIn(
        'e1',
        'a1',
        { signature: 'data:image/png;base64,xyz' } as any,
        'organizer-1',
        'min-moh',
      );

      // The blob must not leave the server, and an audit row is not the place
      // for a copy of somebody's mark.
      const entry = audit.log.mock.calls[0][0];
      expect(JSON.stringify(entry)).not.toContain('base64,xyz');
      expect(entry.changes.signature).toEqual({ from: 'none', to: 'replaced' });
    });

    it('refuses to re-file a staff check-in as somebody else', async () => {
      onRegister({ userId: 'u1', guestName: null, guestEmail: null });

      await expect(
        service.updateCheckIn(
          'e1',
          'a1',
          { guestEmail: 'someone.else@moh.gov.sl' } as any,
          'organizer-1',
          'min-moh',
        ),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.attendance.update).not.toHaveBeenCalled();
    });

    it('reports a clash with somebody already on the register', async () => {
      onRegister();
      prisma.attendance.update.mockRejectedValue({ code: 'P2002' });

      await expect(
        service.updateCheckIn(
          'e1',
          'a1',
          { guestEmail: 'taken@example.org' } as any,
          'organizer-1',
          'min-moh',
        ),
      ).rejects.toThrow(ConflictException);
    });

    it('writes nothing when nothing actually changed', async () => {
      onRegister();

      await service.updateCheckIn(
        'e1',
        'a1',
        { signedName: 'Fatmata Sesai' } as any,
        'organizer-1',
        'min-moh',
      );

      // An audit entry saying a record was amended, when it was not, is worse
      // than no entry at all.
      expect(prisma.attendance.update).not.toHaveBeenCalled();
      expect(audit.log).not.toHaveBeenCalled();
    });

    it('refuses a record belonging to another meeting', async () => {
      prisma.attendance.findFirst.mockResolvedValue(null);

      await expect(
        service.updateCheckIn(
          'e1',
          'a1',
          { signedName: 'Anyone' } as any,
          'organizer-1',
          'min-moh',
        ),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
