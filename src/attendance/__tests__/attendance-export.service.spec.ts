import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { AttendanceExportService } from '../attendance-export.service';
import { PrismaService } from '../../prisma/prisma.service';

const EVENT_ID = 'event-1';
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgo=';

/** A staff member: title and ministry come from the account, never the row. */
const staffCheckIn = {
  id: 'att-staff',
  userId: 'user-1',
  guestName: null,
  guestEmail: null,
  guestTitle: null,
  guestOrganisation: null,
  guestPhone: null,
  isWalkIn: false,
  signedName: 'Aminata Kamara',
  signature: SIGNATURE,
  checkInAt: new Date('2026-03-01T09:05:00Z'),
  checkInMethod: 'QR',
  withinGeofence: true,
  gpsAccuracy: 12,
  mockLocationFlag: false,
  user: {
    id: 'user-1',
    name: 'Aminata Kamara',
    email: 'aminata@health.gov.sl',
    jobTitle: 'Director of Planning',
    ministry: { name: 'Ministry of Health' },
  },
};

/** A guest: the richest row, everything typed in by the person themselves. */
const guestCheckIn = {
  id: 'att-guest',
  userId: null,
  guestName: 'Foday Sesay',
  guestEmail: 'foday@example.org',
  guestTitle: 'Programme Lead',
  guestOrganisation: 'UNDP',
  guestPhone: '+232 76 000 000',
  isWalkIn: true,
  signedName: 'Foday Sesay',
  signature: SIGNATURE,
  checkInAt: new Date('2026-03-01T09:15:00Z'),
  checkInMethod: 'GEO',
  withinGeofence: false,
  gpsAccuracy: 40,
  mockLocationFlag: true,
  user: null,
};

/** A walk-in taken at the desk: name and email, and nobody signed. */
const deskWalkIn = {
  id: 'att-desk',
  userId: null,
  guestName: 'Musa Bangura',
  guestEmail: 'musa@works.gov.sl',
  guestTitle: null,
  guestOrganisation: null,
  guestPhone: null,
  isWalkIn: true,
  signedName: 'Musa Bangura',
  signature: null,
  checkInAt: new Date('2026-03-01T09:25:00Z'),
  checkInMethod: 'MANUAL',
  withinGeofence: null,
  gpsAccuracy: null,
  mockLocationFlag: false,
  user: null,
};

const invitedStaff = {
  id: 'inv-1',
  userId: 'user-1',
  externalName: null,
  externalEmail: null,
  status: 'CONFIRMED',
  respondedAt: new Date('2026-02-20T10:00:00Z'),
  user: {
    id: 'user-1',
    name: 'Aminata Kamara',
    email: 'aminata@health.gov.sl',
    jobTitle: 'Director of Planning',
    ministry: { name: 'Ministry of Health' },
  },
};

/** Invited by email, never turned up. */
const invitedExternal = {
  id: 'inv-2',
  userId: null,
  externalName: 'Zainab Turay',
  externalEmail: 'Zainab@Partner.org',
  status: 'INVITED',
  respondedAt: null,
  user: null,
};

const invitedDecliner = {
  id: 'inv-3',
  userId: null,
  externalName: 'Brima Koroma',
  externalEmail: 'brima@partner.org',
  status: 'DECLINED',
  respondedAt: new Date('2026-02-22T08:00:00Z'),
  user: null,
};

describe('AttendanceExportService', () => {
  let service: AttendanceExportService;

  const mockPrisma = {
    event: { findUnique: jest.fn() },
    attendance: { findMany: jest.fn() },
    eventAttendee: { findMany: jest.fn() },
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    mockPrisma.attendance.findMany.mockResolvedValue([
      staffCheckIn,
      guestCheckIn,
      deskWalkIn,
    ]);
    mockPrisma.eventAttendee.findMany.mockResolvedValue([
      invitedStaff,
      invitedExternal,
      invitedDecliner,
    ]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AttendanceExportService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get(AttendanceExportService);
  });

  describe('getEvent', () => {
    it('refuses an event that does not exist', async () => {
      mockPrisma.event.findUnique.mockResolvedValue(null);
      await expect(service.getEvent(EVENT_ID)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('the checked-in set', () => {
    it('takes a staff title and organisation from the account', async () => {
      const rows = await service.buildRows(EVENT_ID, 'checked-in');
      const staff = rows.find((r) => r.email === 'aminata@health.gov.sl')!;

      expect(staff.jobTitle).toBe('Director of Planning');
      expect(staff.organisation).toBe('Ministry of Health');
      // No staff account carries a phone number.
      expect(staff.phone).toBeNull();
    });

    it('takes a guest title, organisation and phone from what they typed', async () => {
      const rows = await service.buildRows(EVENT_ID, 'checked-in');
      const guest = rows.find((r) => r.email === 'foday@example.org')!;

      expect(guest.jobTitle).toBe('Programme Lead');
      expect(guest.organisation).toBe('UNDP');
      expect(guest.phone).toBe('+232 76 000 000');
      expect(guest.mockLocation).toBe(true);
    });

    it('leaves a desk walk-in blank rather than inventing detail', async () => {
      const rows = await service.buildRows(EVENT_ID, 'checked-in');
      const desk = rows.find((r) => r.email === 'musa@works.gov.sl')!;

      expect(desk.jobTitle).toBeNull();
      expect(desk.organisation).toBeNull();
      expect(desk.phone).toBeNull();
      expect(desk.signature).toBe('UNSIGNED');
    });

    it('orders by check-in time', async () => {
      const rows = await service.buildRows(EVENT_ID, 'checked-in');
      expect(rows.map((r) => r.name)).toEqual([
        'Aminata Kamara',
        'Foday Sesay',
        'Musa Bangura',
      ]);
    });

    it('leaves the signature blobs behind unless the PDF asks for them', async () => {
      const csvRows = await service.buildRows(EVENT_ID, 'checked-in');
      expect(csvRows[0].signature).toBe('SIGNED');

      const [{ select }] = mockPrisma.attendance.findMany.mock.calls[0];
      expect(select.signature).toBe(true);
    });
  });

  describe('signature states', () => {
    it('tells never-signed apart from erased', async () => {
      mockPrisma.attendance.findMany.mockResolvedValue([
        { ...staffCheckIn, signature: null },
        { ...guestCheckIn, signature: '' },
        { ...deskWalkIn, signature: SIGNATURE },
      ]);

      const rows = await service.buildRows(EVENT_ID, 'checked-in');
      expect(rows.map((r) => r.signature)).toEqual([
        'UNSIGNED',
        'ERASED',
        'SIGNED',
      ]);
    });
  });

  describe('the invited set', () => {
    it('is one row per person when someone was invited and turned up', async () => {
      const rows = await service.buildRows(EVENT_ID, 'invited');
      const aminata = rows.filter((r) => r.name === 'Aminata Kamara');

      expect(aminata).toHaveLength(1);
      expect(aminata[0].rsvpStatus).toBe('CONFIRMED');
      expect(aminata[0].attended).toBe(true);
      expect(aminata[0].checkInAt).toEqual(staffCheckIn.checkInAt);
    });

    it('marks an invitee who never came as absent', async () => {
      const rows = await service.buildRows(EVENT_ID, 'invited');
      const zainab = rows.find((r) => r.name === 'Zainab Turay')!;

      expect(zainab.attended).toBe(false);
      expect(zainab.checkInAt).toBeNull();
      expect(zainab.method).toBeNull();
    });

    it('includes people who turned up without an invitation', async () => {
      const rows = await service.buildRows(EVENT_ID, 'invited');
      expect(rows.map((r) => r.name)).toContain('Foday Sesay');
      expect(rows.map((r) => r.name)).toContain('Musa Bangura');
    });

    it('matches an invitation to a check-in regardless of email casing', async () => {
      mockPrisma.attendance.findMany.mockResolvedValue([
        {
          ...guestCheckIn,
          guestEmail: 'zainab@partner.org',
          guestName: 'Zainab Turay',
          isWalkIn: false,
        },
      ]);

      const rows = await service.buildRows(EVENT_ID, 'invited');
      const zainab = rows.filter((r) => r.name === 'Zainab Turay');

      expect(zainab).toHaveLength(1);
      expect(zainab[0].attended).toBe(true);
    });
  });

  describe('the RSVP sets', () => {
    it('filters confirmed and declined by status, and leaves walk-ins out', async () => {
      const confirmed = await service.buildRows(EVENT_ID, 'confirmed');
      expect(confirmed.map((r) => r.name)).toEqual(['Aminata Kamara']);

      const declined = await service.buildRows(EVENT_ID, 'declined');
      expect(declined.map((r) => r.name)).toEqual(['Brima Koroma']);
    });

    it('treats awaiting as everything that is neither confirmed nor declined', async () => {
      const awaiting = await service.buildRows(EVENT_ID, 'awaiting');
      expect(awaiting.map((r) => r.name)).toEqual(['Zainab Turay']);
    });
  });

  describe('toCsv', () => {
    it('writes the checked-in columns in order', async () => {
      const rows = await service.buildRows(EVENT_ID, 'checked-in');
      const [header] = service.toCsv(rows, 'checked-in').split('\r\n');

      expect(header).toBe(
        '﻿"Name","Email","Job Title","Organisation","Phone",' +
          '"Checked In At","Method","Walk-in","Signature","Geofence",' +
          '"GPS Accuracy (m)","Mock Location"',
      );
    });

    it('writes the invitee columns in order', async () => {
      const rows = await service.buildRows(EVENT_ID, 'invited');
      const [header] = service.toCsv(rows, 'invited').split('\r\n');

      expect(header).toBe(
        '﻿"Name","Email","Job Title","Organisation","Phone",' +
          '"RSVP Status","Responded At","Attended","Checked In At","Method",' +
          '"Signature"',
      );
    });

    it('keeps "not verified" distinct from a failed geofence check', async () => {
      const rows = await service.buildRows(EVENT_ID, 'checked-in');
      const lines = service.toCsv(rows, 'checked-in').split('\r\n');

      expect(lines[1]).toContain('"Yes"');
      expect(lines[2]).toContain('"No"');
      expect(lines[3]).toContain('"Not verified"');
    });

    it('never carries the coordinates, which are stored encrypted', async () => {
      const rows = await service.buildRows(EVENT_ID, 'checked-in');
      const csv = service.toCsv(rows, 'checked-in');

      expect(csv.toLowerCase()).not.toContain('lat');
      expect(csv.toLowerCase()).not.toContain('lng');
    });
  });
});
