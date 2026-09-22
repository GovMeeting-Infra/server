import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { StreamSegment } from './providers/transcription-provider';

export interface Recorder {
  id: string;
  systemRole: string;
  ministryId?: string | null;
}

/** Leadership can read and purge a transcript; only organizers record one. */
const OVERSIGHT_ROLES = ['MINISTER', 'MINISTRY_ADMIN'];

export interface ActiveSession {
  transcriptId: string;
  eventTitle: string;
  ministryId: string;
  /** Where this session's audio clock starts on the transcript's timeline. */
  offsetMs: number;
  nextOrder: number;
  /** Furthest point of audio heard this session, in seconds. */
  audioSeconds: number;
}

@Injectable()
export class TranscriptionService implements OnModuleInit {
  private logger = new Logger('TranscriptionService');
  private crypto = new EncryptionUtil();

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    @InjectQueue('ai-queue') private aiQueue: Queue,
  ) {}

  /**
   * A transcript left RECORDING means the process died mid-meeting — every
   * live session is in this process's memory, so after a restart there are
   * none. Close them so the organizer can resume or draft from what was saved.
   */
  async onModuleInit() {
    try {
      const { count } = await (this.prisma as any).transcript.updateMany({
        where: { status: 'RECORDING' },
        data: { status: 'COMPLETE', endedAt: new Date() },
      });
      if (count) this.logger.warn(`Closed ${count} recording(s) left open`);
    } catch (err: any) {
      // Housekeeping, not a reason to refuse to boot — e.g. a deploy that
      // reached the code before the migration.
      this.logger.error(`Could not close stale recordings: ${err.message}`);
    }
  }

  private async loadEvent(eventId: string) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        status: true,
        isPublic: true,
        ministryId: true,
        organizerId: true,
        coOrganizers: { select: { userId: true } },
        minutes: { select: { status: true } },
      },
    });
    if (!event) throw new NotFoundException('Event not found');
    return event;
  }

  private isOrganizer(event: any, userId: string) {
    return (
      event.organizerId === userId ||
      event.coOrganizers.some((c: any) => c.userId === userId)
    );
  }

  private hasOversight(event: any, user: Recorder) {
    if (user.systemRole === 'SUPER_ADMIN') return true;
    return (
      OVERSIGHT_ROLES.includes(user.systemRole) &&
      user.ministryId === event.ministryId
    );
  }

  /**
   * Recording is the organizers' call, as drafting minutes is. A transcript
   * holds everything anyone said, so it is narrower than the minutes: the
   * organizers and the ministry's leadership, not every attendee.
   */
  async assertCanRecord(eventId: string, user: Recorder) {
    const event = await this.loadEvent(eventId);
    if (!this.isOrganizer(event, user.id)) {
      throw new ForbiddenException('Only organizers can record a meeting');
    }
    if (event.isPublic) {
      throw new BadRequestException('Public activities are not recorded');
    }
    if (event.status === 'CANCELLED') {
      throw new BadRequestException('This meeting was cancelled');
    }
    if (event.minutes && event.minutes.status !== 'DRAFT') {
      throw new BadRequestException(
        'Minutes for this meeting are already published',
      );
    }
    return event;
  }

  async assertCanRead(eventId: string, user: Recorder) {
    const event = await this.loadEvent(eventId);
    if (this.isOrganizer(event, user.id) || this.hasOversight(event, user)) {
      return event;
    }
    // Not 403: whether a meeting was recorded is itself not for everyone.
    throw new NotFoundException('Transcript not found');
  }

  async beginSession(eventId: string, user: Recorder): Promise<ActiveSession> {
    const event = await this.assertCanRecord(eventId, user);
    const now = new Date();

    const existing = await (this.prisma as any).transcript.findUnique({
      where: { eventId },
      include: { _count: { select: { segments: true } } },
    });
    if (existing?.status === 'RECORDING') {
      throw new ConflictException('This meeting is already being recorded');
    }

    const transcript = existing
      ? await (this.prisma as any).transcript.update({
          where: { id: existing.id },
          data: { status: 'RECORDING', endedAt: null },
        })
      : await (this.prisma as any).transcript.create({
          data: {
            eventId,
            provider: 'deepgram',
            startedById: user.id,
            startedAt: now,
          },
        });

    await this.audit.log({
      action: existing ? 'RECORDING_RESUMED' : 'RECORDING_STARTED',
      actionCategory: 'MINUTES_MANAGEMENT',
      entityType: 'Transcript',
      entityId: transcript.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId: event.ministryId,
      actorId: user.id,
      description: `Started transcribing: ${event.title} (audio is not stored)`,
    });

    return {
      transcriptId: transcript.id,
      eventTitle: event.title,
      ministryId: event.ministryId,
      offsetMs: now.getTime() - new Date(transcript.startedAt).getTime(),
      nextOrder: existing?._count.segments ?? 0,
      audioSeconds: 0,
    };
  }

  async appendSegment(session: ActiveSession, segment: StreamSegment) {
    const order = session.nextOrder++;
    session.audioSeconds = Math.max(session.audioSeconds, segment.end);
    const row = {
      transcriptId: session.transcriptId,
      order,
      speaker: segment.speaker,
      text: this.crypto.encrypt(segment.text),
      startMs: session.offsetMs + Math.round(segment.start * 1000),
      endMs: session.offsetMs + Math.round(segment.end * 1000),
    };
    await (this.prisma as any).transcriptSegment.create({ data: row });
    return { ...row, text: segment.text };
  }

  async endSession(
    session: ActiveSession,
    user: Recorder,
    opts: { draft: boolean; failed?: boolean },
  ) {
    await (this.prisma as any).transcript.update({
      where: { id: session.transcriptId },
      data: {
        status: opts.failed ? 'FAILED' : 'COMPLETE',
        endedAt: new Date(),
        durationSec: { increment: Math.round(session.audioSeconds) },
      },
    });

    await this.audit.log({
      action: 'RECORDING_STOPPED',
      actionCategory: 'MINUTES_MANAGEMENT',
      entityType: 'Transcript',
      entityId: session.transcriptId,
      entityName: session.eventTitle,
      status: opts.failed ? 'FAILURE' : 'SUCCESS',
      ministryId: session.ministryId,
      actorId: user.id,
      description: `Stopped transcribing after ${Math.round(session.audioSeconds)}s of audio`,
    });

    if (opts.draft && session.nextOrder > 0) {
      await this.queueDraft(session.transcriptId);
    }
  }

  private async queueDraft(transcriptId: string) {
    await (this.prisma as any).transcript.update({
      where: { id: transcriptId },
      data: { aiDraftStatus: 'PENDING', aiDraftError: null },
    });
    // jobId dedupes a double click; removeOnComplete frees the id for a
    // deliberate redraft later.
    await this.aiQueue.add(
      'draft-minutes',
      { transcriptId },
      {
        jobId: `draft-${transcriptId}`,
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  async requestDraft(eventId: string, user: Recorder) {
    const event = await this.loadEvent(eventId);
    if (!this.isOrganizer(event, user.id)) {
      throw new ForbiddenException('Only organizers can draft minutes');
    }
    const transcript = await (this.prisma as any).transcript.findUnique({
      where: { eventId },
      include: { _count: { select: { segments: true } } },
    });
    if (!transcript) throw new NotFoundException('Transcript not found');
    if (transcript.status === 'RECORDING') {
      throw new ConflictException('Stop the recording before drafting');
    }
    if (transcript._count.segments === 0) {
      throw new BadRequestException('Nothing was transcribed');
    }
    await this.queueDraft(transcript.id);
    return this.getTranscript(eventId, user);
  }

  async getTranscript(eventId: string, user: Recorder) {
    await this.assertCanRead(eventId, user);
    const transcript = await (this.prisma as any).transcript.findUnique({
      where: { eventId },
      include: { segments: { orderBy: { order: 'asc' } } },
    });
    if (!transcript) throw new NotFoundException('Transcript not found');

    return {
      id: transcript.id,
      status: transcript.status,
      startedAt: transcript.startedAt,
      endedAt: transcript.endedAt,
      durationSec: transcript.durationSec,
      aiDraftStatus: transcript.aiDraftStatus,
      aiDraft: transcript.aiDraft,
      aiDraftError: transcript.aiDraftError,
      segments: transcript.segments.map((s: any) => ({
        id: s.id,
        speaker: s.speaker,
        startMs: s.startMs,
        endMs: s.endMs,
        text: this.crypto.decrypt(s.text),
      })),
    };
  }

  async deleteTranscript(eventId: string, user: Recorder) {
    const event = await this.assertCanRead(eventId, user);
    const transcript = await (this.prisma as any).transcript.findUnique({
      where: { eventId },
    });
    if (!transcript) throw new NotFoundException('Transcript not found');
    if (transcript.status === 'RECORDING') {
      throw new ConflictException('Stop the recording before deleting it');
    }
    await (this.prisma as any).transcript.delete({
      where: { id: transcript.id },
    });
    await this.audit.log({
      action: 'TRANSCRIPT_DELETED',
      actionCategory: 'MINUTES_MANAGEMENT',
      entityType: 'Transcript',
      entityId: transcript.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId: event.ministryId,
      actorId: user.id,
      description: `Deleted the transcript of: ${event.title}`,
    });
  }

  /** For the draft processor: the transcript in the order it was spoken. */
  async loadForDraft(transcriptId: string) {
    const transcript = await (this.prisma as any).transcript.findUnique({
      where: { id: transcriptId },
      include: {
        segments: { orderBy: { order: 'asc' } },
        event: {
          select: {
            title: true,
            startAt: true,
            attendees: {
              select: { externalName: true, user: { select: { name: true } } },
            },
          },
        },
      },
    });
    if (!transcript) return null;
    return {
      title: transcript.event.title,
      startAt: new Date(transcript.event.startAt),
      attendeeNames: transcript.event.attendees
        .map((a: any) => a.user?.name ?? a.externalName)
        .filter(Boolean),
      segments: transcript.segments.map((s: any) => ({
        speaker: s.speaker,
        text: this.crypto.decrypt(s.text),
      })),
    };
  }

  async saveDraft(transcriptId: string, draft: unknown) {
    await (this.prisma as any).transcript.update({
      where: { id: transcriptId },
      data: { aiDraftStatus: 'READY', aiDraft: draft, aiDraftError: null },
    });
  }

  async failDraft(transcriptId: string, message: string) {
    await (this.prisma as any).transcript.update({
      where: { id: transcriptId },
      data: { aiDraftStatus: 'FAILED', aiDraftError: message.slice(0, 500) },
    });
  }
}
