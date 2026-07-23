import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { RSVPStatus } from './dto/rsvp.dto';

@Injectable()
export class RSVPService {
  private logger = new Logger('RSVPService');
  private encryption: EncryptionUtil;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {
    this.encryption = new EncryptionUtil(
      process.env.DATA_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef',
    );
  }

  async respond(rsvpTokenHash: string, status: RSVPStatus) {
    const attendee = await (this.prisma as any).eventAttendee.findUnique({
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

    return {
      id: updated.id,
      eventId: updated.eventId,
      status: updated.status,
      respondedAt: updated.respondedAt,
      eventTitle: attendee.event.title,
    };
  }

  async generateRSVPToken(attendeeId: string): Promise<string> {
    const token = EncryptionUtil.hashToken(
      `${attendeeId}-${Date.now()}`,
    );

    return token;
  }

  async getAttendeesByStatus(
    eventId: string,
    status: string,
  ) {
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
