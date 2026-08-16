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
import { CacheService } from '../cache/cache.service';
import { EncryptionUtil } from '../common/utils/encryption.util';
import { QRTokenService } from './qr-token.service';
import { CheckInDto } from './dto/check-in.dto';
import { GuestCheckInDto } from './dto/guest-check-in.dto';
import { GenerateCheckInCodeDto } from './dto/generate-check-in-code.dto';
import { ManualCheckInDto } from './dto/manual-check-in.dto';
import { haversineDistance, classifyFix } from './geofence.util';
import {
  GEOFENCE_RADIUS_METERS,
  ANCHOR_MAX_ACCURACY_METERS,
  CHECKIN_MAX_ACCURACY_METERS,
  GEO_ERROR,
} from './geofence.constants';

/** Why a token cannot currently be used, or OPEN when it can. */
export type CheckInStatus =
  'INVALID' | 'EXPIRED' | 'UNAVAILABLE' | 'ENDED' | 'OPEN';

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
    private cache: CacheService,
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
        requireGeofence: true,
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

    // Whether this call would leave the event with no fence at all: either
    // there was never an anchor and this fix is too poor to set one, or the
    // organizer asked to reset and cannot.
    const wouldBeUnfenced = wantsCapture && !usableFix && !hasAnchor;

    if (event.requireGeofence && wouldBeUnfenced) {
      // The whole point of the setting. Before it existed, a fix worse than
      // ANCHOR_MAX_ACCURACY_METERS quietly minted a code with no fence, and
      // whether a meeting was protected came down to the organizer's handset.
      // Refusing is the honest answer: the organizer can move, wait, or turn
      // the requirement off, and any of those is a decision rather than an
      // accident.
      throw new BadRequestException(
        dto.lat == null || dto.lng == null
          ? 'This meeting requires location verification, so a check-in code cannot be generated without your location. Enable GPS and try again.'
          : `This meeting requires location verification, but your location is only accurate to ${Math.round(
              dto.gpsAccuracy ?? 0,
            )}m. Move into the open or wait for a better signal, then try again.`,
      );
    }

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

    const { token, expiresAt, updated } = await (
      this.prisma as any
    ).$transaction(async (tx: any) => {
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
            requireGeofence: true,
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
    });

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
      metadata: {
        anchored: updated.checkInAnchorLat !== null,
        tokenExpiresAt: expiresAt,
      },
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
        requireGeofence: true,
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
        enabled:
          event.checkInAnchorLat !== null && event.checkInAnchorLng !== null,
        radiusMeters: GEOFENCE_RADIUS_METERS,
        anchorLat: event.checkInAnchorLat,
        anchorLng: event.checkInAnchorLng,
        anchorAccuracy: event.checkInAnchorAccuracy,
        anchorSetAt: event.checkInAnchorSetAt,
        // Whether this event insists on a fence. Surfaced so the organizer
        // page can say why generating was refused, rather than leaving the
        // refusal to look like a fault.
        required: event.requireGeofence ?? false,
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

    if (!row)
      return {
        status: 'INVALID' as CheckInStatus,
        event: null,
        geofenceRequired: false,
      };
    if (row.expiresAt < new Date()) {
      return {
        status: 'EXPIRED' as CheckInStatus,
        event: null,
        geofenceRequired: false,
      };
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
        requireGeofence: true,
      },
    });

    if (!event) {
      return {
        status: 'INVALID' as CheckInStatus,
        event: null,
        geofenceRequired: false,
      };
    }

    // Both halves, because they answer different questions: an area has to
    // have been captured, and the organizer has to have asked for it to gate
    // entry. An anchored meeting with the requirement off is measured, not
    // policed, so the client must not block anyone over a refused fix.
    const geofenceRequired =
      event.requireGeofence === true &&
      event.checkInAnchorLat !== null &&
      event.checkInAnchorLng !== null;

    if (event.status === 'DRAFT' || event.status === 'CANCELLED') {
      // Rendered identically to INVALID by the client: someone holding a code
      // for an unpublished event should not learn that it exists.
      return {
        status: 'UNAVAILABLE' as CheckInStatus,
        event: null,
        geofenceRequired,
      };
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
      return {
        status: 'ENDED' as CheckInStatus,
        event: publicEvent,
        geofenceRequired,
      };
    }

    // Never expose anchor coordinates here — this endpoint is unauthenticated,
    // and handing out the centre of the fence makes spoofing trivial.
    return {
      status: 'OPEN' as CheckInStatus,
      event: publicEvent,
      geofenceRequired,
    };
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
        guestTitle: dto.guestTitle.trim(),
        guestOrganisation: dto.guestOrganisation.trim(),
        guestPhone: dto.guestPhone.trim(),
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
        requireGeofence: true,
      },
    });

    if (!event) throw new NotFoundException('Event not found');
    if (event.status === 'DRAFT' || event.status === 'CANCELLED') {
      throw new BadRequestException('Invalid check-in code');
    }
    if (event.endAt < new Date()) {
      throw new BadRequestException(
        'This meeting has ended. Check-in is closed.',
      );
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
    event: {
      checkInAnchorLat: number | null;
      checkInAnchorLng: number | null;
      requireGeofence?: boolean;
    },
    dto: { lat?: number; lng?: number; gpsAccuracy?: number },
  ): GeofenceVerdict {
    const anchored =
      event.checkInAnchorLat !== null && event.checkInAnchorLng !== null;

    // Measuring and refusing are different things, and only the organizer
    // decides the second. An anchored meeting with the requirement off still
    // records where people were; it just never turns anyone away over it.
    const gates = anchored && event.requireGeofence === true;

    if (!anchored) {
      // No area was captured, so nothing can be verified. null rather than
      // false: "unverified" is a genuinely different state from "outside".
      //
      // A location may still arrive — the client now asks for one on every
      // check-in, not only where a fence gates entry — and recordAttendance
      // stores whatever it is given. Nothing here rejects or discards it: with
      // no anchor there is nothing to measure against, only something to
      // record. The mock heuristic still applies, so an unverified row does
      // not quietly claim a clean fix.
      return {
        withinGeofence: null,
        checkInMethod: 'QR',
        distance: null,
        mockLocationFlag: dto.gpsAccuracy === 0,
      };
    }

    // An accuracy of exactly 0 is not physically achievable and is the usual
    // signature of a mock-location provider. Recorded, not rejected — it is a
    // heuristic, and heuristics produce false positives.
    const mockLocationFlag = dto.gpsAccuracy === 0;

    // No accuracy means an unbounded error disc, which is the same as having
    // sent no position at all — and it wants the same advice, not a confusing
    // complaint about precision.
    if (dto.lat == null || dto.lng == null || dto.gpsAccuracy == null) {
      if (!gates) {
        return {
          withinGeofence: null,
          checkInMethod: 'QR',
          distance: null,
          mockLocationFlag,
        };
      }
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: GEO_ERROR.LOCATION_REQUIRED,
        message:
          'This meeting checks you in by location, and your phone did not send one. Turn on location for this browser, then try again.',
      });
    }

    const distance = haversineDistance(
      dto.lat,
      dto.lng,
      event.checkInAnchorLat as number,
      event.checkInAnchorLng as number,
    );

    const verdict = classifyFix({
      distance,
      accuracy: dto.gpsAccuracy,
      radius: GEOFENCE_RADIUS_METERS,
      ceiling: CHECKIN_MAX_ACCURACY_METERS,
    });

    if (verdict === 'VERIFIED') {
      return {
        withinGeofence: true,
        checkInMethod: 'GEO',
        distance,
        mockLocationFlag,
      };
    }

    // Measured but not gated: record the verdict and let them in either way.
    if (!gates) {
      return {
        withinGeofence: verdict === 'OUTSIDE' ? false : null,
        checkInMethod: 'GEO',
        distance,
        mockLocationFlag,
      };
    }

    if (verdict === 'TOO_VAGUE') {
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: GEO_ERROR.ACCURACY_TOO_LOW,
        message: `Your phone could only place you within ${Math.round(
          dto.gpsAccuracy,
        )}m, which is too vague to confirm you are at the venue. Turn on precise location, move near a window or step outside, turn off any VPN, then try again.`,
      });
    }

    if (verdict === 'OUTSIDE') {
      // Deliberately no distance in this message. Three attempts with chosen
      // coordinates would trilaterate the anchor for anyone holding a token.
      // The accuracy is the attendee's own reading and safe to quote back.
      throw new BadRequestException({
        statusCode: 400,
        error: 'Bad Request',
        code: GEO_ERROR.OUTSIDE_AREA,
        message:
          'You are outside this meeting’s check-in area. Move closer to the venue and try again. If you are already inside the building, turn on precise location and try once more.',
      });
    }

    // Plausible: the discs overlap, so they may well be in the room, but the
    // reading cannot prove it. null, not true — an auditor leans on true, and
    // this is exactly the "unverified" the column already means elsewhere.
    return {
      withinGeofence: null,
      checkInMethod: 'GEO',
      distance,
      mockLocationFlag,
    };
  }

  private async recordAttendance(
    event: any,
    dto: {
      lat?: number;
      lng?: number;
      gpsAccuracy?: number;
      signature: string;
    },
    verdict: GeofenceVerdict,
    meta: RequestMeta,
    identity: {
      userId: string | null;
      signedName: string;
      guestName?: string;
      guestEmail?: string;
      // Collected only on the guest self-service path. Staff carry a title and
      // ministry on their account; a desk walk-in is recorded by someone else.
      guestTitle?: string;
      guestOrganisation?: string;
      guestPhone?: string;
      isWalkIn?: boolean;
    },
  ) {
    const attendance = await (this.prisma as any).attendance.create({
      data: {
        eventId: event.id,
        userId: identity.userId,
        guestName: identity.guestName ?? null,
        guestEmail: identity.guestEmail ?? null,
        guestTitle: identity.guestTitle ?? null,
        guestOrganisation: identity.guestOrganisation ?? null,
        guestPhone: identity.guestPhone ?? null,
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

    // Attendance feeds the attendance-rate and check-in-method panels, which
    // are cached for an hour. Without this a room full of people checking in
    // left the reports page showing the numbers from before the meeting.
    // Targeted rather than the pattern scan: this runs once per check-in.
    await this.cache.invalidateAnalyticsFor(event.ministryId);

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
    dto: ManualCheckInDto,
    staffId: string,
    meta: RequestMeta = {},
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        status: true,
        endAt: true,
        ministryId: true,
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (event.status === 'CANCELLED') {
      throw new BadRequestException('This event has been cancelled');
    }

    const name = dto.name.trim();
    const email = dto.email.trim().toLowerCase();

    // The attendee may legitimately belong to another ministry — events can
    // invite them — so this checks only that the account is real and usable.
    // Who may operate this desk is settled by CanManageEventGuard.
    //
    // Deliberately the opposite of guestCheckIn, which refuses an email that
    // belongs to an account: there the visitor is anonymous and could type a
    // colleague's address, whereas here an authorized organizer is vouching in
    // person. Linking means the check-in reaches that person's own attendance
    // record instead of being stranded as an unrelated guest row.
    const target = await (this.prisma as any).user.findFirst({
      where: { email, active: true, deletedAt: null },
      select: { id: true },
    });

    // findFirst, not findUnique on the compound key: userId is nullable, so the
    // compound-unique input no longer accepts it cleanly. Which of the two
    // unique indexes applies depends on whether this resolved to an account.
    const existing = await (this.prisma as any).attendance.findFirst({
      where: target
        ? { eventId, userId: target.id }
        : { eventId, guestEmail: email },
    });

    if (existing) {
      throw new ConflictException('Already checked in');
    }

    // Same rule as the guest path: "walk-in" means nobody invited them, not
    // that an organizer typed it. Without this the manual path never set the
    // flag, so the word meant different things depending on the door used.
    const invite = await (this.prisma as any).eventAttendee.findFirst({
      where: {
        eventId,
        OR: [
          { externalEmail: { equals: email, mode: 'insensitive' } },
          { user: { email: { equals: email, mode: 'insensitive' } } },
        ],
      },
      select: { id: true },
    });

    let attendance;
    try {
      attendance = await (this.prisma as any).attendance.create({
        data: {
          eventId,
          userId: target?.id ?? null,
          guestName: target ? null : name,
          guestEmail: target ? null : email,
          isWalkIn: !invite,
          signedName: name,
          // Null, not '': nobody signed. An empty string already means
          // "captured then erased" in UsersService.anonymize, and reusing it
          // would make a desk record indistinguishable from a redacted one.
          signature: null,
          checkInMethod: 'MANUAL',
          // Staff vouched for them in person; there is no location reading to
          // judge, so this is recorded as unverified rather than true.
          withinGeofence: null,
          ipAddress: meta.ipAddress ?? null,
          userAgent: meta.userAgent ?? null,
        },
      });
    } catch (error: any) {
      // Two submissions racing past the findFirst above land here; the unique
      // index is the real guarantee. Surface it as the same clean conflict
      // rather than a 500.
      if (error?.code === 'P2002') {
        throw new ConflictException('Already checked in');
      }
      throw error;
    }

    await this.audit.log({
      action: 'ATTENDANCE_MANUAL_CHECKIN',
      actionCategory: 'ATTENDANCE',
      entityType: 'Attendance',
      entityId: attendance.id,
      entityName: attendance.signedName,
      status: 'SUCCESS',
      // The event's ministry, not the caller's: the record belongs to the
      // meeting, and taking it from the actor misfiled every cross-ministry
      // check-in.
      ministryId: event.ministryId,
      actorId: staffId,
      description: `Staff check-in: ${attendance.signedName} to event: ${event.title}`,
      metadata: {
        eventId,
        email,
        // Worth auditing which of the two a desk record became: a linked row
        // lands in someone's attendance history, a guest row does not.
        targetUserId: target?.id ?? null,
        linkedToAccount: !!target,
      },
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    await this.cache.invalidateAnalyticsFor(event.ministryId);

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

    await this.cache.invalidateAnalyticsFor(ministryId);
  }

  /**
   * Check-in records for an event, newest first. The signature blob is left
   * out — it is large and only needed on the individual record — but whether
   * one exists is reported, so the list can distinguish a record the attendee
   * signed from one an organizer took at the desk.
   */
  async listCheckIns(eventId: string) {
    const rows = await (this.prisma as any).attendance.findMany({
      where: { eventId },
      select: {
        id: true,
        eventId: true,
        userId: true,
        guestName: true,
        guestEmail: true,
        guestTitle: true,
        guestOrganisation: true,
        guestPhone: true,
        isWalkIn: true,
        signedName: true,
        signature: true,
        checkInAt: true,
        checkInMethod: true,
        withinGeofence: true,
        gpsAccuracy: true,
        mockLocationFlag: true,
        // A staff member gives no title or organisation at check-in — their
        // account is where those live, so the list has to join them.
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            jobTitle: true,
            ministry: { select: { name: true } },
          },
        },
      },
      orderBy: { checkInAt: 'desc' },
    });

    // Reduced to a boolean here rather than selected as one — Prisma has no way
    // to project "is this column non-empty", and the blob must not leave the
    // server.
    return rows.map(({ signature, ...row }: any) => ({
      ...row,
      hasSignature: !!signature,
    }));
  }
}
