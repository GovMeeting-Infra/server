import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { RSVPStatus } from './dto/rsvp.dto';

@Injectable()
export class RSVPService {
  private logger = new Logger('RSVPService');
  private encryption: EncryptionUtil;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private cache: CacheService,
  ) {
    this.encryption = new EncryptionUtil(
      process.env.DATA_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef',
    );
  }

  /**
   * What the invitation is for, so the RSVP page can name the meeting it is
   * asking about. Without this the page asked "Will you be attending?" over a
   * blank card — the recipient had to go back to the email to find out what
   * they were answering, and nothing tied the link to the invitation.
   *
   * Returns null for an unknown, malformed or already-detached token rather
   * than distinguishing them, matching how the guest minutes route refuses to
   * confirm whether a token ever existed.
   */
  async getInvitation(rsvpTokenHash: string) {
    const attendee = await (this.prisma as any).eventAttendee.findFirst({
      where: { rsvpTokenHash },
      include: {
        event: {
          select: {
            title: true,
            description: true,
            startAt: true,
            endAt: true,
            venueName: true,
            ministry: { select: { name: true } },
          },
        },
        user: { select: { name: true } },
      },
    });

    if (!attendee) return null;

    return {
      event: attendee.event,
      inviteeName: attendee.user?.name ?? attendee.externalName ?? null,
      status: attendee.status,
      respondedAt: attendee.respondedAt,
    };
  }

  async respond(rsvpTokenHash: string, status: RSVPStatus) {
    // rsvpTokenHash is indexed but not declared @unique, so findUnique throws
    // at the client layer — look it up as a non-unique field.
    const attendee = await (this.prisma as any).eventAttendee.findFirst({
      where: { rsvpTokenHash },
      include: { event: true, user: true },
    });

    if (!attendee) {
      throw new NotFoundException('RSVP token not found or expired');
    }

    if (attendee.respondedAt) {
      throw new BadRequestException('Already responded to this RSVP');
    }

    const updated = await (this.prisma as any).eventAttendee.update({
      where: { id: attendee.id },
      data: {
        status,
        respondedAt: new Date(),
      },
      include: { event: true, user: true },
    });

    await this.audit.log({
      action: 'RSVP_RESPONDED',
      actionCategory: 'ATTENDANCE',
      entityType: 'EventAttendee',
      entityId: attendee.id,
      entityName: attendee.externalEmail || attendee.user?.email,
      status: 'SUCCESS',
      ministryId: attendee.event.ministryId,
      actorId: attendee.userId,
      description: `RSVP ${status} for event: ${attendee.event.title}`,
      metadata: {
        eventId: attendee.eventId,
        status,
      },
    });

    // eventAttendee is the denominator of the attendance-rate panel, so a
    // wave of RSVPs moves the reported figure.
    await this.cache.invalidateAnalyticsFor(attendee.event.ministryId);

    return {
      id: updated.id,
      eventId: updated.eventId,
      status: updated.status,
      respondedAt: updated.respondedAt,
      eventTitle: attendee.event.title,
    };
  }

  async generateRSVPToken(attendeeId: string): Promise<string> {
    const token = EncryptionUtil.hashToken(`${attendeeId}-${Date.now()}`);

    return token;
  }

  async getAttendeesByStatus(eventId: string, status: string) {
    return (this.prisma as any).eventAttendee.findMany({
      where: {
        eventId,
        status,
      },
      include: {
        user: {
          select: { id: true, name: true, email: true },
        },
      },
    });
  }
}
