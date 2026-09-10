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
import {
  OfflineRegisterDto,
  OfflineAttendanceRecordDto,
} from './dto/offline-register.dto';
import { clampCapturedAt, toSkewSeconds } from './captured-at.util';
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

    if (wouldBeUnfenced) {
      // Always, now — this is no longer a per-event setting.
      //
      // A fix worse than ANCHOR_MAX_ACCURACY_METERS used to quietly mint a code
      // with no fence unless the organizer had ticked a box, so whether a
      // meeting was protected came down to their handset and whether they
      // remembered. Refusing is the honest answer: the organizer can move,
      // wait for a better signal, or record people at the desk — and any of
      // those is a decision rather than an accident.
      throw new BadRequestException(
        dto.lat == null || dto.lng == null
          ? 'A check-in code sets the 100m area attendees must be inside, so it cannot be generated without your location. Turn on location for this site and try again. If you cannot, record people at the desk from the attendees page instead.'
          : `Your location is only accurate to ${Math.round(
              dto.gpsAccuracy ?? 0,
            )}m, which is too vague to set the check-in area from. Step outside or near a window and try again. If the signal will not improve, record people at the desk from the attendees page instead.`,
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
        // Always true now. Kept in the response so the organizer page can keep
        // explaining why generating was refused rather than leaving the
        // refusal looking like a fault, and so an older client still reads a
        // field it expects.
        required: true,
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

    // An anchor is now the only question. Generating a code requires a usable
    // fix, so every code that exists is fenced, and every attendee holding one
    // has to be inside the area.
    const geofenceRequired =
      event.checkInAnchorLat !== null && event.checkInAnchorLng !== null;

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
    user: { id: string; name?: string; phone?: string | null },
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
      // Copied from the account rather than asked for at the door. The form
      // here is a name and a signature on whatever phone someone has in a
      // corridor, and it stays that way — but the attendance row has always had
      // a phone column that only guests ever filled, so every staff row showed
      // a dash. The session carries the whole user record, so this costs no
      // extra query. Undefined when they have not set one, which keeps it null.
      guestPhone: user.phone?.trim() || undefined,
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
    },
    dto: { lat?: number; lng?: number; gpsAccuracy?: number },
    options: { gate?: boolean } = {},
  ): GeofenceVerdict {
    const anchored =
      event.checkInAnchorLat !== null && event.checkInAnchorLng !== null;

    /*
     * An anchored meeting always gates — except when the reading is being
     * judged long after it was taken.
     *
     * Live, refusing a poor fix is helpful: the person is standing there and
     * can move, or ask the organizer. Hours later, at sync, refusing means
     * deleting someone who was in the room and signed for it, with no way for
     * them to know or put it right. So the offline path measures and records
     * the verdict without acting on it, and the row carries capturedOffline so
     * nobody mistakes an unverified reading for a confirmed one.
     */
    const gates = anchored && options.gate !== false;

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

  /**
   * Take in a register kept on an organizer's device while it had no signal.
   *
   * Not self-service check-in deferred. During an outage an attendee's own
   * phone cannot load the check-in page at all — it would have to reach the
   * same server that is unreachable — so the organizer's device becomes the
   * book everyone signs, and this is how that book arrives.
   *
   * Always answers 200 with a verdict per row. A batch that failed as a whole
   * would be retried as a whole, and the rows that did land the first time
   * would be recorded twice; and one person's bad data must not strand the
   * other thirty-nine. DUPLICATE is an ordinary outcome here rather than an
   * error — someone recorded at the desk may also have scanned for themselves
   * before the connection dropped.
   */
  async syncOfflineRegister(
    eventId: string,
    dto: OfflineRegisterDto,
    staff: { id: string },
    meta: RequestMeta = {},
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        title: true,
        status: true,
        startAt: true,
        endAt: true,
        ministryId: true,
        ...ANCHOR_FIELDS,
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }
    if (event.status === 'CANCELLED') {
      throw new BadRequestException('This event has been cancelled');
    }

    const syncedAt = new Date();

    /*
     * Adopt the device's fix as the fence only if the meeting has none.
     *
     * The outage may have begun before anyone generated a code, in which case
     * there is no anchor and never will be one. Taking the register device's
     * position is the only reading that was ever available. It is subject to
     * the same accuracy gate as a live anchor, and it can never move an anchor
     * that already exists — otherwise syncing would be a way to redraw the
     * fence after the fact, around wherever suited.
     */
    let anchor = {
      checkInAnchorLat: event.checkInAnchorLat,
      checkInAnchorLng: event.checkInAnchorLng,
    };

    if (
      event.checkInAnchorLat === null &&
      dto.anchorLat != null &&
      dto.anchorLng != null &&
      dto.anchorAccuracy != null &&
      dto.anchorAccuracy <= ANCHOR_MAX_ACCURACY_METERS
    ) {
      await (this.prisma as any).event.update({
        where: { id: eventId },
        data: {
          checkInAnchorLat: dto.anchorLat,
          checkInAnchorLng: dto.anchorLng,
          checkInAnchorAccuracy: Math.round(dto.anchorAccuracy),
          checkInAnchorSetAt: syncedAt,
          checkInAnchorSetById: staff.id,
        },
      });
      anchor = {
        checkInAnchorLat: dto.anchorLat,
        checkInAnchorLng: dto.anchorLng,
      };
    }

    const results: Array<{
      index: number;
      id: string | null;
      status: 'RECORDED' | 'DUPLICATE' | 'REJECTED';
      reason?: string;
    }> = [];

    for (const [index, record] of dto.records.entries()) {
      try {
        const recorded = await this.recordOfflineAttendance(
          event,
          anchor,
          record,
          staff,
          syncedAt,
          meta,
        );
        results.push({ index, id: recorded.id, status: recorded.status });
      } catch (error: any) {
        // One bad row must not cost the other thirty-nine. Recorded as
        // rejected with a reason so the device can show which person needs
        // entering by hand rather than silently dropping them.
        results.push({
          index,
          id: record.id ?? null,
          status: 'REJECTED',
          reason:
            typeof error?.message === 'string'
              ? error.message
              : 'Could not be recorded',
        });
      }
    }

    const recorded = results.filter((r) => r.status === 'RECORDED').length;
    const duplicates = results.filter((r) => r.status === 'DUPLICATE').length;
    const rejected = results.filter((r) => r.status === 'REJECTED').length;

    // One audit entry for the batch. Forty-two indistinguishable ones would
    // bury the fact that matters: a device synced a register it had been
    // holding, and for how long.
    await this.audit.log({
      action: 'ATTENDANCE_OFFLINE_SYNCED',
      actionCategory: 'ATTENDANCE',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: rejected > 0 ? 'FAILURE' : 'SUCCESS',
      ministryId: event.ministryId,
      actorId: staff.id,
      description: `Synced ${recorded} offline check-in(s) for ${event.title}` +
        (duplicates ? `; ${duplicates} already recorded` : '') +
        (rejected ? `; ${rejected} refused` : ''),
      metadata: { recorded, duplicates, rejected, syncedAt: syncedAt.toISOString() },
      ipAddress: meta.ipAddress,
    });

    await this.cache.invalidateAnalytics();

    return { syncedAt: syncedAt.toISOString(), results };
  }

  /** One row of a synced register. Mirrors manualCheckIn's rules deliberately. */
  private async recordOfflineAttendance(
    event: any,
    anchor: { checkInAnchorLat: number | null; checkInAnchorLng: number | null },
    record: OfflineAttendanceRecordDto,
    staff: { id: string },
    syncedAt: Date,
    meta: RequestMeta,
  ): Promise<{ id: string; status: 'RECORDED' | 'DUPLICATE' }> {
    const email = (record.email ?? record.guestEmail ?? '').trim().toLowerCase();
    const name = record.signedName.trim();

    // Same rule as the desk path: an authorized organizer is vouching in
    // person, so an email belonging to an account links to that account rather
    // than being stranded as an unrelated guest row.
    const target = email
      ? await (this.prisma as any).user.findFirst({
          where: { email, active: true, deletedAt: null },
          select: { id: true, phone: true },
        })
      : null;

    const existing = await (this.prisma as any).attendance.findFirst({
      where: target
        ? { eventId: event.id, userId: target.id }
        : { eventId: event.id, guestEmail: email || undefined },
      select: { id: true },
    });

    if (existing) {
      // Ordinary, not an error: they were recorded at the desk and also
      // managed to scan for themselves before the connection went.
      return { id: existing.id, status: 'DUPLICATE' };
    }

    const invite = email
      ? await (this.prisma as any).eventAttendee.findFirst({
          where: {
            eventId: event.id,
            OR: [
              { externalEmail: { equals: email, mode: 'insensitive' } },
              { user: { email: { equals: email, mode: 'insensitive' } } },
            ],
          },
          select: { id: true },
        })
      : null;

    // Measured, never gated. See the comment on resolveGeofence: refusing a
    // reading hours after it was taken deletes someone who was present.
    const verdict = this.resolveGeofence(
      anchor as any,
      {
        lat: record.lat,
        lng: record.lng,
        gpsAccuracy: record.gpsAccuracy,
      },
      { gate: false },
    );

    const timing = clampCapturedAt(record.capturedAt, event, syncedAt);

    try {
      const attendance = await (this.prisma as any).attendance.create({
        data: {
          ...(record.id ? { id: record.id } : {}),
          eventId: event.id,
          userId: target?.id ?? null,
          guestName: target ? null : record.guestName ?? name,
          guestEmail: target ? null : email || null,
          guestTitle: target ? null : record.guestTitle ?? null,
          guestOrganisation: target ? null : record.guestOrganisation ?? null,
          guestPhone: target?.phone?.trim() || record.guestPhone || null,
          isWalkIn: !invite,
          signedName: name,
          // Whatever was actually captured. Null where the register took no
          // signature, which is the same as a desk-recorded walk-in today.
          signature: record.signature ?? null,
          // MANUAL, because that is what happened: a member of staff vouched
          // for this person in person. capturedOffline carries the other fact.
          checkInMethod: 'MANUAL',
          withinGeofence: verdict.withinGeofence,
          mockLocationFlag: verdict.mockLocationFlag,
          lat: record.lat != null ? this.encryption.encrypt(String(record.lat)) : null,
          lng: record.lng != null ? this.encryption.encrypt(String(record.lng)) : null,
          gpsAccuracy:
            record.gpsAccuracy != null ? Math.round(record.gpsAccuracy) : null,
          checkInAt: timing.checkInAt,
          capturedAt: timing.capturedAt,
          capturedOffline: true,
          capturedById: staff.id,
          clockSkewSeconds: toSkewSeconds(record.clockSkewMs),
          syncedAt,
          // The syncing device's, not the attendee's. Recorded as what it is:
          // where the register was sent from, not where anyone stood.
          ipAddress: meta.ipAddress ?? null,
          userAgent: meta.userAgent ?? null,
        },
      });

      return { id: attendance.id, status: 'RECORDED' };
    } catch (error: any) {
      // The unique indexes are the real guarantee, and a client-minted id makes
      // a replayed batch collide on the primary key. Either way this row is
      // already recorded, which is success arriving twice.
      if (error?.code === 'P2002') {
        return { id: record.id ?? '', status: 'DUPLICATE' };
      }
      throw error;
    }
  }

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
      select: { id: true, phone: true },
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
          // An organizer recording someone at the desk has no reason to know
          // their number, but if the person has an account we already do.
          guestPhone: target?.phone?.trim() || null,
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

    // Reduced here rather than selected — Prisma has no way to project "is this
    // column non-empty", and the blob must not leave the server.
    //
    // Three states, not two. `hasSignature: !!signature` folded an erased
    // signature in with a walk-in, and the attendee table then narrated the
    // walk-in story over both: "recorded by an organiser at the desk, so there
    // was nobody to sign" — said about someone who signed and later asked for
    // it to be removed. Null means nobody ever signed; an empty string means a
    // signature was captured and then erased. On a register meant to survive
    // being challenged, those are not the same fact.
    return rows.map(({ signature, ...row }: any) => ({
      ...row,
      signatureState:
        signature === null || signature === undefined
          ? ('NONE' as const)
          : signature === ''
            ? ('ERASED' as const)
            : ('SIGNED' as const),
      // Kept for callers that only ask whether an image can be fetched.
      hasSignature: !!signature,
    }));
  }
}
