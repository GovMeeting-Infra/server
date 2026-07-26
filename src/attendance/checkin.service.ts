import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ConflictException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { QRTokenService } from './qr-token.service';
import { CheckInDto } from './dto/check-in.dto';
import { GuestCheckInDto } from './dto/guest-check-in.dto';
import { GenerateCheckInCodeDto } from './dto/generate-check-in-code.dto';
import { haversineDistance } from './geofence.util';
import {
  GEOFENCE_RADIUS_METERS,
  ANCHOR_MAX_ACCURACY_METERS,
  CHECKIN_MAX_ACCURACY_METERS,
} from './geofence.constants';

/** Why a token cannot currently be used, or OPEN when it can. */
export type CheckInStatus =
  | 'INVALID'
  | 'EXPIRED'
  | 'UNAVAILABLE'
  | 'ENDED'
  | 'OPEN';

interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
}

interface GeofenceVerdict {
  withinGeofence: boolean | null;
  checkInMethod: 'QR' | 'GEO';
  distance: number | null;
  mockLocationFlag: boolean;
}

const ANCHOR_FIELDS = {
  checkInAnchorLat: true,
  checkInAnchorLng: true,
  checkInAnchorAccuracy: true,
  checkInAnchorSetAt: true,
  checkInAnchorSetById: true,
} as const;

@Injectable()
export class CheckinService {
  private logger = new Logger('CheckinService');
  private encryption: EncryptionUtil;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private qrToken: QRTokenService,
  ) {
    this.encryption = new EncryptionUtil(
      process.env.DATA_ENCRYPTION_KEY || '0123456789abcdef0123456789abcdef',
    );
  }

  // ==========================================================================
  // Code generation (organizer side)
  // ==========================================================================

  /**
   * Mint or rotate a check-in code, capturing the check-in area from the
   * organizer's own coordinates the first time.
   *
   * The anchor is the whole point of this flow: venue lat/lng were almost never
   * filled in, so anchoring to the person generating the code is the only way
   * geofencing engages in practice.
   */
  async issueCheckInCode(
    eventId: string,
    dto: GenerateCheckInCodeDto,
    actor: { id: string; ministryId?: string | null },
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        status: true,
        endAt: true,
        ministryId: true,
        allowGuestCheckIn: true,
        ...ANCHOR_FIELDS,
      },
    });

    if (!event) throw new NotFoundException('Event not found');

    if (event.status === 'DRAFT' || event.status === 'CANCELLED') {
      throw new BadRequestException(
        'Publish the event before generating a check-in code',
      );
    }
    if (event.endAt < new Date()) {
      throw new BadRequestException('This meeting has ended');
    }

    const hasAnchor =
      event.checkInAnchorLat !== null && event.checkInAnchorLng !== null;
    const wantsCapture = !hasAnchor || dto.resetAnchor === true;
    const usableFix =
      dto.lat != null &&
      dto.lng != null &&
      dto.gpsAccuracy != null &&
      dto.gpsAccuracy > 0 &&
      dto.gpsAccuracy <= ANCHOR_MAX_ACCURACY_METERS;

    let anchorChange: 'set' | 'cleared' | null = null;
    let anchorData: Record<string, unknown> | null = null;

    if (wantsCapture && usableFix) {
      anchorChange = 'set';
      anchorData = {
        checkInAnchorLat: dto.lat,
        checkInAnchorLng: dto.lng,
        checkInAnchorAccuracy: Math.round(dto.gpsAccuracy as number),
        checkInAnchorSetAt: new Date(),
        checkInAnchorSetById: actor.id,
      };
    } else if (wantsCapture && dto.resetAnchor === true && hasAnchor) {
      // Resetting without a usable fix must clear the old anchor rather than
      // silently leave it in place — otherwise the organizer believes they have
      // moved the fence when they have not.
      anchorChange = 'cleared';
      anchorData = {
        checkInAnchorLat: null,
        checkInAnchorLng: null,
        checkInAnchorAccuracy: null,
        checkInAnchorSetAt: null,
        checkInAnchorSetById: null,
      };
    }
    // Not capturing: incoming coordinates are ignored entirely, so a rotating
    // token can never drag the fence along with the organizer.

    const { token, expiresAt, updated } = await (this.prisma as any).$transaction(
      async (tx: any) => {
        let updated = event;
        if (anchorData) {
          updated = await tx.event.update({
            where: { id: eventId },
            data: anchorData,
            select: {
              id: true,
              title: true,
              status: true,
              endAt: true,
              ministryId: true,
              allowGuestCheckIn: true,
              ...ANCHOR_FIELDS,
            },
          });
        }
        const minted = await this.qrToken.ensureActiveToken(
          eventId,
          { force: dto.rotate === true },
          tx,
        );
        return { ...minted, updated };
      },
    );

    await this.audit.log({
      action: 'CHECKIN_CODE_ISSUED',
      actionCategory: 'ATTENDANCE',
      entityType: 'Event',
      entityId: eventId,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId: event.ministryId,
      actorId: actor.id,
      description: `Issued check-in code for event: ${event.title}`,
      metadata: { anchored: updated.checkInAnchorLat !== null, tokenExpiresAt: expiresAt },
    });

    if (anchorChange) {
      // Separate row: moving the fence is the security-relevant act, and it
      // should be findable without trawling every code issuance.
      await this.audit.log({
        action: 'CHECKIN_ANCHOR_SET',
        actionCategory: 'ATTENDANCE',
        entityType: 'Event',
        entityId: eventId,
        entityName: event.title,
        status: 'SUCCESS',
        ministryId: event.ministryId,
        actorId: actor.id,
        description:
          anchorChange === 'set'
            ? `Check-in area set for event: ${event.title}`
            : `Check-in area cleared for event: ${event.title}`,
        metadata: {
          change: anchorChange,
          accuracy: updated.checkInAnchorAccuracy,
          radiusMeters: GEOFENCE_RADIUS_METERS,
        },
      });
    }

    return this.buildCodeResponse(updated, token, expiresAt);
  }

  /** Read-only view of the current code. Never mints. */
  async getCheckInCode(eventId: string) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        status: true,
        endAt: true,
        allowGuestCheckIn: true,
        ...ANCHOR_FIELDS,
      },
    });

    if (!event) throw new NotFoundException('Event not found');

    const active = await this.qrToken.findActiveToken(eventId);
    return this.buildCodeResponse(
      event,
      active?.token ?? null,
      active?.expiresAt ?? null,
    );
  }

  /** Expire live tokens so no further scans work. */
  async closeCheckIn(
    eventId: string,
    actor: { id: string; ministryId?: string | null },
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: { id: true, title: true, ministryId: true },
    });
    if (!event) throw new NotFoundException('Event not found');

    const count = await this.qrToken.expireTokens(eventId);

    await this.audit.log({
      action: 'CHECKIN_CODE_REVOKED',
      actionCategory: 'ATTENDANCE',
      entityType: 'Event',
      entityId: eventId,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId: event.ministryId,
      actorId: actor.id,
      description: `Closed check-in for event: ${event.title}`,
      metadata: { tokensExpired: count },
    });
  }

  private buildCodeResponse(
    event: any,
    token: string | null,
    expiresAt: Date | null,
  ) {
    // Attendees scan this, so it must point at the web frontend that serves
    // /checkin/[token] — not at APP_URL, which is this API's own origin.
    const webUrl =
      process.env.WEB_URL ||
      process.env.NEXT_PUBLIC_WEB_URL ||
      'http://localhost:3000';

    return {
      token,
      qrCodeUrl: token ? `${webUrl}/checkin/${token}` : null,
      expiresAt,
      // Refresh a minute before expiry so the displayed code is never dead.
      refreshAt: expiresAt
        ? new Date(new Date(expiresAt).getTime() - 60 * 1000)
        : null,
      geofence: {
        enabled: event.checkInAnchorLat !== null && event.checkInAnchorLng !== null,
        radiusMeters: GEOFENCE_RADIUS_METERS,
        anchorLat: event.checkInAnchorLat,
        anchorLng: event.checkInAnchorLng,
        anchorAccuracy: event.checkInAnchorAccuracy,
        anchorSetAt: event.checkInAnchorSetAt,
      },
      allowGuestCheckIn: event.allowGuestCheckIn,
      eventStatus: event.status,
      endAt: event.endAt,
    };
  }

  // ==========================================================================
  // Token context (public, attendee side)
  // ==========================================================================

  /**
   * Resolve what the scanned token can currently do. Strictly read-only — the
   * check-in page calls it on every load.
   */
  async getCheckInContext(token: string) {
    const row = await this.qrToken.findToken(token);

    if (!row) return { status: 'INVALID' as CheckInStatus, event: null, geofenceRequired: false };
    if (row.expiresAt < new Date()) {
      return { status: 'EXPIRED' as CheckInStatus, event: null, geofenceRequired: false };
    }

    const event = await (this.prisma as any).event.findUnique({
      where: { id: row.eventId },
      select: {
        id: true,
        title: true,
        startAt: true,
        endAt: true,
        venueName: true,
        status: true,
        allowGuestCheckIn: true,
        checkInAnchorLat: true,
        checkInAnchorLng: true,
      },
    });

    if (!event) {
      return { status: 'INVALID' as CheckInStatus, event: null, geofenceRequired: false };
    }

    const geofenceRequired =
      event.checkInAnchorLat !== null && event.checkInAnchorLng !== null;

    if (event.status === 'DRAFT' || event.status === 'CANCELLED') {
      // Rendered identically to INVALID by the client: someone holding a code
      // for an unpublished event should not learn that it exists.
      return { status: 'UNAVAILABLE' as CheckInStatus, event: null, geofenceRequired };
    }

    const publicEvent = {
      id: event.id,
      title: event.title,
      startAt: event.startAt,
      endAt: event.endAt,
      venueName: event.venueName,
      allowGuestCheckIn: event.allowGuestCheckIn,
    };

    if (event.endAt < new Date()) {
      return { status: 'ENDED' as CheckInStatus, event: publicEvent, geofenceRequired };
    }

    // Never expose anchor coordinates here — this endpoint is unauthenticated,
    // and handing out the centre of the fence makes spoofing trivial.
    return { status: 'OPEN' as CheckInStatus, event: publicEvent, geofenceRequired };
  }

  // ==========================================================================
  // Check-in
  // ==========================================================================

  async checkIn(
    token: string,
    dto: CheckInDto,
    user: { id: string; name?: string },
    meta: RequestMeta = {},
  ) {
    const event = await this.resolveOpenEvent(token);
    const verdict = this.resolveGeofence(event, dto);

    const existing = await (this.prisma as any).attendance.findFirst({
      where: { eventId: event.id, userId: user.id },
    });
    if (existing) {
      throw new ConflictException('Already checked in to this event');
    }

    return this.recordAttendance(event, dto, verdict, meta, {
      userId: user.id,
      signedName: dto.signedName.trim(),
    });
  }

  async guestCheckIn(
    token: string,
    dto: GuestCheckInDto,
    meta: RequestMeta = {},
  ) {
    const event = await this.resolveOpenEvent(token);

    if (!event.allowGuestCheckIn) {
      throw new ForbiddenException(
        'Guest check-in is not enabled for this meeting',
      );
    }

    const email = dto.guestEmail.trim().toLowerCase();

    // Staff must sign in, so an email that belongs to an account is refused
    // rather than accepted as a guest — otherwise anyone could be recorded as
    // present simply by typing a colleague's address.
    const account = await (this.prisma as any).user.findFirst({
      where: { email, active: true, deletedAt: null },
      select: { id: true },
    });
    if (account) {
      throw new ConflictException(
        'This email has an account — please sign in to check in.',
      );
    }

    const verdict = this.resolveGeofence(event, dto);

    const invite = await (this.prisma as any).eventAttendee.findFirst({
      where: {
        eventId: event.id,
        OR: [
          { externalEmail: { equals: email, mode: 'insensitive' } },
          { user: { email: { equals: email, mode: 'insensitive' } } },
        ],
      },
      select: { id: true },
    });

    const existing = await (this.prisma as any).attendance.findFirst({
      where: { eventId: event.id, guestEmail: email },
    });
    if (existing) {
      throw new ConflictException('Already checked in to this event');
    }

    try {
      return await this.recordAttendance(event, dto, verdict, meta, {
        userId: null,
        signedName: dto.guestName.trim(),
        guestName: dto.guestName.trim(),
        guestEmail: email,
        isWalkIn: !invite,
      });
    } catch (error: any) {
      // Two submissions racing past the findFirst above land here; the unique
      // index is the real guarantee. Surface it as the same clean conflict
      // rather than a 500.
      if (error?.code === 'P2002') {
        throw new ConflictException('Already checked in to this event');
      }
      throw error;
    }
  }

  /** Shared token + event gate for both check-in paths. */
  private async resolveOpenEvent(token: string) {
    const row = await this.qrToken.findToken(token);
    if (!row) throw new BadRequestException('Invalid check-in code');
    if (row.expiresAt < new Date()) {
      throw new BadRequestException('This check-in code has expired');
    }

    const event = await (this.prisma as any).event.findUnique({
      where: { id: row.eventId },
      select: {
        id: true,
        title: true,
        status: true,
        endAt: true,
        ministryId: true,
        allowGuestCheckIn: true,
        checkInAnchorLat: true,
        checkInAnchorLng: true,
      },
    });

    if (!event) throw new NotFoundException('Event not found');
    if (event.status === 'DRAFT' || event.status === 'CANCELLED') {
      throw new BadRequestException('Invalid check-in code');
    }
    if (event.endAt < new Date()) {
      throw new BadRequestException('This meeting has ended. Check-in is closed.');
    }

    return event;
  }

  /**
   * Decide the geofence verdict.
   *
   * When an anchor exists this is strict: coordinates are mandatory. The old
   * code only entered the geofence branch when the client happened to send
   * lat/lng, so omitting them skipped verification entirely — and because it
   * tested truthiness, an exact 0.0 coordinate skipped it too.
   */
  private resolveGeofence(
    event: { checkInAnchorLat: number | null; checkInAnchorLng: number | null },
    dto: { lat?: number; lng?: number; gpsAccuracy?: number },
  ): GeofenceVerdict {
    const anchored =
      event.checkInAnchorLat !== null && event.checkInAnchorLng !== null;

    if (!anchored) {
      // No area was captured, so nothing can be verified. null rather than
      // false: "unverified" is a genuinely different state from "outside".
      return {
        withinGeofence: null,
        checkInMethod: 'QR',
        distance: null,
        mockLocationFlag: false,
      };
    }

    if (dto.lat == null || dto.lng == null) {
      throw new BadRequestException(
        'Location is required to check in to this meeting. Enable GPS and try again.',
      );
    }
    if (dto.gpsAccuracy == null || dto.gpsAccuracy > CHECKIN_MAX_ACCURACY_METERS) {
      throw new BadRequestException(
        'GPS accuracy insufficient for location verification. Move somewhere with a clearer signal and try again.',
      );
    }

    // An accuracy of exactly 0 is not physically achievable and is the usual
    // signature of a mock-location provider. Recorded, not rejected — it is a
    // heuristic, and heuristics produce false positives.
    const mockLocationFlag = dto.gpsAccuracy === 0;

    const distance = haversineDistance(
      dto.lat,
      dto.lng,
      event.checkInAnchorLat as number,
      event.checkInAnchorLng as number,
    );

    if (distance > GEOFENCE_RADIUS_METERS) {
      throw new BadRequestException(
        'You appear to be outside the meeting location.',
      );
    }

    return {
      withinGeofence: true,
      checkInMethod: 'GEO',
      distance,
      mockLocationFlag,
    };
  }

  private async recordAttendance(
    event: any,
    dto: { lat?: number; lng?: number; gpsAccuracy?: number; signature: string },
    verdict: GeofenceVerdict,
    meta: RequestMeta,
    identity: {
      userId: string | null;
      signedName: string;
      guestName?: string;
      guestEmail?: string;
      isWalkIn?: boolean;
    },
  ) {
    const attendance = await (this.prisma as any).attendance.create({
      data: {
        eventId: event.id,
        userId: identity.userId,
        guestName: identity.guestName ?? null,
        guestEmail: identity.guestEmail ?? null,
        isWalkIn: identity.isWalkIn ?? false,
        signedName: identity.signedName,
        signature: dto.signature,
        lat: dto.lat != null ? this.encryption.encrypt(String(dto.lat)) : null,
        lng: dto.lng != null ? this.encryption.encrypt(String(dto.lng)) : null,
        // Column is an integer; the browser reports a float, which previously
        // made every real GPS check-in fail to write.
        gpsAccuracy:
          dto.gpsAccuracy != null ? Math.round(dto.gpsAccuracy) : null,
        withinGeofence: verdict.withinGeofence,
        mockLocationFlag: verdict.mockLocationFlag,
        checkInMethod: verdict.checkInMethod,
        ipAddress: meta.ipAddress ?? null,
        userAgent: meta.userAgent ?? null,
      },
    });

    await this.audit.log({
      action: 'ATTENDANCE_CHECKIN',
      actionCategory: 'ATTENDANCE',
      entityType: 'Attendance',
      entityId: attendance.id,
      entityName: identity.signedName,
      status: 'SUCCESS',
      ministryId: event.ministryId,
      actorId: identity.userId ?? undefined,
      description: `Checked in to event: ${event.title} (${verdict.checkInMethod})`,
      metadata: {
        eventId: event.id,
        checkInMethod: verdict.checkInMethod,
        withinGeofence: verdict.withinGeofence,
        // Kept so the radius and accuracy thresholds can be tuned against real
        // readings rather than guesswork.
        distanceMeters:
          verdict.distance == null ? null : Math.round(verdict.distance),
        gpsAccuracy: dto.gpsAccuracy ?? null,
        mockLocationFlag: verdict.mockLocationFlag,
        guestEmail: identity.guestEmail ?? null,
        isWalkIn: identity.isWalkIn ?? false,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    return {
      id: attendance.id,
      eventId: event.id,
      eventTitle: event.title,
      signedName: attendance.signedName,
      checkInAt: attendance.checkInAt,
      checkInMethod: attendance.checkInMethod,
      withinGeofence: attendance.withinGeofence,
      isWalkIn: attendance.isWalkIn,
    };
  }

  // ==========================================================================
  // Staff-operated
  // ==========================================================================

  async manualCheckIn(
    eventId: string,
    userId: string,
    dto: { signedName: string; signature: string },
    staffId: string,
    ministryId: string,
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // findFirst, not findUnique on the compound key: userId is nullable now, so
    // the compound-unique input no longer accepts it cleanly.
    const existing = await (this.prisma as any).attendance.findFirst({
      where: { eventId, userId },
    });

    if (existing) {
      throw new ConflictException('Already checked in');
    }

    const attendance = await (this.prisma as any).attendance.create({
      data: {
        eventId,
        userId,
        signedName: dto.signedName,
        signature: dto.signature,
        checkInMethod: 'MANUAL',
        // Staff vouched for them in person; there is no location reading to
        // judge, so this is recorded as unverified rather than true.
        withinGeofence: null,
      },
    });

    await this.audit.log({
      action: 'ATTENDANCE_MANUAL_CHECKIN',
      actionCategory: 'ATTENDANCE',
      entityType: 'Attendance',
      entityId: attendance.id,
      entityName: attendance.signedName,
      status: 'SUCCESS',
      ministryId,
      actorId: staffId,
      description: `Staff check-in: ${attendance.signedName} to event: ${event.title}`,
    });

    return attendance;
  }

  async removeCheckIn(
    eventId: string,
    attendanceId: string,
    actorId: string,
    ministryId: string,
  ) {
    const attendance = await (this.prisma as any).attendance.findFirst({
      where: { id: attendanceId, eventId },
      include: { event: { select: { title: true } } },
    });

    if (!attendance) {
      throw new NotFoundException('Check-in record not found for this event');
    }

    await (this.prisma as any).attendance.delete({
      where: { id: attendanceId },
    });

    await this.audit.log({
      action: 'ATTENDANCE_REMOVED',
      actionCategory: 'ATTENDANCE',
      entityType: 'Attendance',
      entityId: attendanceId,
      entityName: attendance.signedName,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Removed check-in for ${attendance.signedName} from event: ${attendance.event.title}`,
    });
  }

  /**
   * Check-in records for an event, newest first. The signature blob is left
   * out — it is large and only needed on the individual record.
   */
  async listCheckIns(eventId: string) {
    return (this.prisma as any).attendance.findMany({
      where: { eventId },
      select: {
        id: true,
        eventId: true,
        userId: true,
        guestName: true,
        guestEmail: true,
        isWalkIn: true,
        signedName: true,
        checkInAt: true,
        checkInMethod: true,
        withinGeofence: true,
        mockLocationFlag: true,
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { checkInAt: 'desc' },
    });
  }
}
