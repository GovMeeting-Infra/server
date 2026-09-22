import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TranscriptionService } from '../transcription.service';

// Segment text is encrypted with DATA_ENCRYPTION_KEY, which must be 64 hex
// characters; the in-code fallback is not, as checkin.service.geofence notes.
process.env.DATA_ENCRYPTION_KEY =
  process.env.DATA_ENCRYPTION_KEY ?? 'a'.repeat(64);

describe('TranscriptionService', () => {
  const ORGANIZER = { id: 'u-org', systemRole: 'STAFF', ministryId: 'min-a' };
  const STAFF = { id: 'u-staff', systemRole: 'STAFF', ministryId: 'min-a' };
  const MINISTER = { id: 'u-min', systemRole: 'MINISTER', ministryId: 'min-a' };
  const OTHER_MINISTER = {
    id: 'u-min2',
    systemRole: 'MINISTER',
    ministryId: 'min-b',
  };

  let prisma: any;
  let audit: any;
  let queue: any;
  let service: TranscriptionService;

  const seedEvent = (over: Record<string, unknown> = {}) =>
    prisma.event.findUnique.mockResolvedValue({
      id: 'e1',
      title: 'Budget review',
      status: 'PUBLISHED',
      isPublic: false,
      ministryId: 'min-a',
      organizerId: ORGANIZER.id,
      coOrganizers: [],
      minutes: null,
      ...over,
    });

  beforeEach(() => {
    prisma = {
      event: { findUnique: jest.fn() },
      transcript: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => ({
          id: 't1',
          ...data,
        })),
        update: jest
          .fn()
          .mockResolvedValue({ id: 't1', startedAt: new Date() }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        delete: jest.fn(),
      },
      transcriptSegment: { create: jest.fn() },
    };
    audit = { log: jest.fn() };
    queue = { add: jest.fn() };
    service = new TranscriptionService(prisma, audit, queue);
  });

  describe('who may record', () => {
    it('lets the organizer start', async () => {
      seedEvent();
      const session = await service.beginSession('e1', ORGANIZER);
      expect(session.transcriptId).toBe('t1');
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'RECORDING_STARTED' }),
      );
    });

    it('lets a co-organizer start', async () => {
      seedEvent({ coOrganizers: [{ userId: STAFF.id }] });
      await expect(service.beginSession('e1', STAFF)).resolves.toBeDefined();
    });

    it('refuses anyone else, even a minister', async () => {
      seedEvent();
      await expect(service.beginSession('e1', STAFF)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.beginSession('e1', MINISTER)).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('refuses once the minutes are published', async () => {
      seedEvent({ minutes: { status: 'PUBLISHED' } });
      await expect(service.beginSession('e1', ORGANIZER)).rejects.toThrow(
        BadRequestException,
      );
    });

    it('refuses a second recording of the same meeting', async () => {
      seedEvent();
      prisma.transcript.findUnique.mockResolvedValue({
        id: 't1',
        status: 'RECORDING',
        _count: { segments: 3 },
      });
      await expect(service.beginSession('e1', ORGANIZER)).rejects.toThrow(
        ConflictException,
      );
    });

    it('resumes an earlier transcript on the same timeline', async () => {
      seedEvent();
      const startedAt = new Date(Date.now() - 60_000);
      prisma.transcript.findUnique.mockResolvedValue({
        id: 't1',
        status: 'COMPLETE',
        startedAt,
        _count: { segments: 5 },
      });
      prisma.transcript.update.mockResolvedValue({ id: 't1', startedAt });
      const session = await service.beginSession('e1', ORGANIZER);
      expect(session.nextOrder).toBe(5);
      expect(session.offsetMs).toBeGreaterThanOrEqual(60_000);
    });
  });

  describe('who may read', () => {
    it('hides the transcript from ordinary staff', async () => {
      seedEvent();
      await expect(service.assertCanRead('e1', STAFF)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('shows it to leadership of the same ministry only', async () => {
      seedEvent();
      await expect(
        service.assertCanRead('e1', MINISTER),
      ).resolves.toBeDefined();
      await expect(service.assertCanRead('e1', OTHER_MINISTER)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  it('encrypts segment text before it is stored', async () => {
    const session = {
      transcriptId: 't1',
      eventTitle: 'x',
      ministryId: 'min-a',
      offsetMs: 1000,
      nextOrder: 0,
      audioSeconds: 0,
    };
    const row = await service.appendSegment(session, {
      text: 'We agreed the budget.',
      speaker: 0,
      start: 2,
      end: 3.5,
    });
    const stored = prisma.transcriptSegment.create.mock.calls[0][0].data;
    expect(stored.text).not.toContain('budget');
    expect(stored.startMs).toBe(3000);
    expect(stored.endMs).toBe(4500);
    expect(row.text).toBe('We agreed the budget.');
    expect(session.nextOrder).toBe(1);
  });

  it('queues a draft only when something was said', async () => {
    const session = {
      transcriptId: 't1',
      eventTitle: 'x',
      ministryId: 'min-a',
      offsetMs: 0,
      nextOrder: 0,
      audioSeconds: 0,
    };
    await service.endSession(session, ORGANIZER, { draft: true });
    expect(queue.add).not.toHaveBeenCalled();

    await service.endSession({ ...session, nextOrder: 4 }, ORGANIZER, {
      draft: true,
    });
    expect(queue.add).toHaveBeenCalledWith(
      'draft-minutes',
      { transcriptId: 't1' },
      expect.objectContaining({ jobId: 'draft-t1' }),
    );
  });
});
