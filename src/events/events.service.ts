import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { EventsRepository } from './events.repository';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { AddAttendeesDto } from './dto/add-attendees.dto';
import { randomBytes } from 'crypto';
import { ministryScope, assertSameMinistry } from '../common/utils/ministry-scope.util';

@Injectable()
export class EventsService {
  private logger = new Logger('EventsService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private cache: CacheService,
    private eventsRepository: EventsRepository,
    private notifications: NotificationsService,
  ) {}

  async createEvent(
    dto: CreateEventDto,
    organizerId: string,
    ministryId: string,
    actorRole?: string,
  ) {
    const startAt = new Date(dto.startAt);
    const endAt = new Date(dto.endAt);

    if (startAt >= endAt) {
      throw new BadRequestException('Start time must be before end time');
    }

    const {
      coOrganizerIds,
      ministryId: requestedMinistryId,
      inviteeUserIds,
      inviteeExternals,
      invitedMinistryIds,
      ...eventData
    } = dto;

    // Only super-admins may file an event under another ministry; for everyone
    // else the ministry always comes from their own session.
    const targetMinistryId =
      actorRole === 'SUPER_ADMIN' && requestedMinistryId
        ? requestedMinistryId
        : ministryId;

    if (actorRole === 'SUPER_ADMIN' && requestedMinistryId) {
      const ministry = await (this.prisma as any).ministry.findUnique({
        where: { id: requestedMinistryId },
        select: { id: true },
      });

      if (!ministry) {
        throw new NotFoundException(`Ministry ${requestedMinistryId} not found`);
      }
    }

    const referencedUserIds = [
      ...new Set([...(coOrganizerIds ?? []), ...(inviteeUserIds ?? [])]),
    ];

    if (referencedUserIds.length) {
      const found = await (this.prisma as any).user.findMany({
        where: { id: { in: referencedUserIds } },
        select: { id: true },
      });

      const missing = referencedUserIds.filter(
        (id) => !found.some((u: any) => u.id === id),
      );

      if (missing.length > 0) {
        throw new NotFoundException(`Unknown user(s): ${missing.join(', ')}`);
      }
    }

    if (dto.roomId) {
      const conflicts = await this.eventsRepository.checkRoomConflicts(
        dto.roomId,
        startAt,
        endAt,
      );

      if (conflicts.length > 0) {
        throw new ConflictException(
          'Room is already booked for this time period',
        );
      }
    }

    if (invitedMinistryIds?.length) {
      const found = await (this.prisma as any).ministry.findMany({
        where: { id: { in: invitedMinistryIds } },
        select: { id: true },
      });

      const missing = invitedMinistryIds.filter(
        (id) => !found.some((m: any) => m.id === id),
      );

      if (missing.length > 0) {
        throw new NotFoundException(`Unknown ministry(ies): ${missing.join(', ')}`);
      }
    }

    const event = await this.eventsRepository.create({
      ...eventData,
      ...(invitedMinistryIds?.length && {
        invitedMinistries: {
          connect: invitedMinistryIds.map((id) => ({ id })),
        },
      }),
      startAt,
      endAt,
      status: 'DRAFT',
      ministryId: targetMinistryId,
      // Public activities belong to the ministry rather than a person, so they
      // are created without an organizer. Management of those falls back to
      // ministry admins — see assertCanAdminister below.
      organizerId: dto.isPublic ? null : organizerId,
      scope: eventData.scope ?? (dto.isPublic ? 'TEAM' : undefined),
      classification:
        eventData.classification ?? (dto.isPublic ? 'PUBLIC' : undefined),
    });

    if (coOrganizerIds?.length) {
      await (this.prisma as any).eventCoOrganizer.createMany({
        data: coOrganizerIds.map((userId) => ({ eventId: event.id, userId })),
        skipDuplicates: true,
      });
    }

    // Invitees supplied with the event save a second round trip from the form.
    // Same shape as addAttendees, including the per-row RSVP token.
    if (inviteeUserIds?.length || inviteeExternals?.length) {
      await (this.prisma as any).eventAttendee.createMany({
        data: [
          ...(inviteeUserIds ?? []).map((userId) => ({
            eventId: event.id,
            userId,
            status: 'INVITED',
            rsvpTokenHash: randomBytes(24).toString('base64url'),
          })),
          ...(inviteeExternals ?? []).map((guest) => ({
            eventId: event.id,
            externalName: guest.name,
            externalEmail: guest.email,
            status: 'INVITED',
            rsvpTokenHash: randomBytes(24).toString('base64url'),
          })),
        ],
        skipDuplicates: true,
      });

      await this.notifications.notifyMeetingInvitation(
        event.id,
        inviteeUserIds ?? [],
      );
    }

    await this.audit.log({
      action: 'EVENT_CREATED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId: targetMinistryId,
      actorId: organizerId,
      description: `Created event: ${event.title}`,
    });

    await this.cache.invalidatePattern(`events:*${targetMinistryId}*`);
    await this.cache.invalidateAnalytics();

    // Re-read so co-organizers are present on the response the client uses to
    // redirect to the new event.
    return this.eventsRepository.findOne(event.id);
  }

  /** Sortable columns, allow-listed so the query param can't reach arbitrary fields. */
  private static readonly SORTABLE = ['startAt', 'title', 'status'] as const;

  private static readonly ADMIN_ROLES = [
    'SUPER_ADMIN',
    'MINISTER',
    'MINISTRY_ADMIN',
  ];

  /** Upper bound for a date-range query, which is never paginated. */
  static readonly RANGE_MAX = 500;

  /**
   * Builds a half-open startAt filter from ISO date strings. Returns null when
   * neither bound is usable, so callers fall back to normal pagination rather
   * than silently querying everything.
   */
  static parseRange(from?: string, to?: string) {
    const gte = from ? new Date(from) : null;
    const lt = to ? new Date(to) : null;

    const valid = (d: Date | null) => d !== null && !Number.isNaN(d.getTime());

    if (!valid(gte) && !valid(lt)) return null;

    return {
      ...(valid(gte) && { gte: gte as Date }),
      ...(valid(lt) && { lt: lt as Date }),
    };
  }

  /**
   * Authorizes an action that is normally the organizer's alone.
   *
   * Public activities are created with no organizer, so identity checks cannot
   * carry them: without an admin fallback nobody could publish, cancel or
   * delete a public event. Co-organizers are accepted when `allowCoOrganizer`
   * is set, which cancel does but publish and delete do not.
   */
  private assertCanAdminister(
    event: any,
    actorId: string,
    actorRole: string | undefined,
    action: string,
    allowCoOrganizer = false,
  ) {
    if (event.organizerId === actorId) return;

    if (
      allowCoOrganizer &&
      event.coOrganizers?.some((c: any) => c.userId === actorId)
    ) {
      return;
    }

    const isAdmin = EventsService.ADMIN_ROLES.includes(actorRole ?? '');

    if (event.organizerId === null && isAdmin) return;

    throw new ForbiddenException(
      event.organizerId === null
        ? `Only a ministry admin can ${action} an event with no organizer`
        : `Only the event organizer can ${action}`,
    );
  }

  async listEvents(
    ministryId: string,
    user: { systemRole: string; ministryId?: string },
    options: {
      page?: number;
      isPublic?: boolean;
      sortBy?: string;
      order?: string;
      timeframe?: string;
      from?: string;
      to?: string;
      roomId?: string;
    } = {},
  ) {
    const now = new Date();

    // Calendar views ask for a window rather than a page. Half-open [from, to)
    // so a month range excludes the first instant of the next month.
    const range = EventsService.parseRange(options.from, options.to);

    // upcoming / now / past, matching how the list page groups events.
    const timeframeWhere =
      options.timeframe === 'upcoming'
        ? { startAt: { gt: now } }
        : options.timeframe === 'now'
          ? { startAt: { lte: now }, endAt: { gte: now } }
          : options.timeframe === 'past'
            ? { endAt: { lt: now } }
            : {};

    const where = {
      ...ministryScope(user),
      ...(options.isPublic !== undefined && { isPublic: options.isPublic }),
      ...timeframeWhere,
      ...(range && { startAt: range }),
      // Lets the rooms pages ask "what is scheduled in this room", which is
      // also how availability learns that an event occupies a slot.
      ...(options.roomId && { roomId: options.roomId }),
    };

    const page = Math.max(1, options.page || 1);
    // A month grid can't be paginated — it needs every event in the window — so
    // range queries get a much higher ceiling. Still bounded, not unlimited.
    const take = range ? EventsService.RANGE_MAX : 20;
    const skip = range ? 0 : (page - 1) * take;

    const sortBy = (EventsService.SORTABLE as readonly string[]).includes(
      options.sortBy ?? '',
    )
      ? (options.sortBy as string)
      : 'startAt';
    const order = options.order === 'asc' ? 'asc' : 'desc';

    // Timeframe buckets are relative to now, so a cached copy would keep
    // reporting an event as "happening now" after it ended — those queries skip
    // the cache. For the rest, sort belongs in the key because results are
    // paginated server-side, so a different sort is a different page of data.
    const cacheKey = options.timeframe
      ? null
      : `events:list:${ministryId}:${page}:${options.isPublic || 'all'}:${sortBy}:${order}:${options.from ?? '-'}:${options.to ?? '-'}:${options.roomId ?? '-'}`;

    if (cacheKey) {
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached;
    }

    const result = await this.eventsRepository.findMany(where, skip, take, {
      [sortBy]: order,
    });

    if (cacheKey) {
      await this.cache.setEvents(cacheKey, result);
    }

    return result;
  }

  /**
   * Active users the actor may name as a co-organizer or invitee: their own
   * ministry, or everyone for a super-admin. Self is excluded — you are
   * already the organizer.
   */
  async listCoOrganizerCandidates(user: {
    id: string;
    systemRole: string;
    ministryId?: string;
  }) {
    return (this.prisma as any).user.findMany({
      where: {
        ...ministryScope(user),
        active: true,
        deletedAt: null,
        id: { not: user.id },
      },
      select: { id: true, name: true, email: true, jobTitle: true },
      orderBy: { name: 'asc' },
    });
  }

  /** Active ministries for pickers. Names only — no ministry configuration. */
  async listMinistryOptions() {
    return (this.prisma as any).ministry.findMany({
      where: { active: true },
      select: { id: true, name: true, code: true },
      orderBy: { name: 'asc' },
    });
  }

  async getOne(id: string, user: { systemRole: string; ministryId?: string }) {
    const event = await this.eventsRepository.findOne(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    assertSameMinistry(user, event.ministryId);

    return event;
  }

  async updateEvent(
    id: string,
    dto: UpdateEventDto,
    actorId: string,
    ministryId: string,
    actorRole?: string,
  ) {
    const event = await this.eventsRepository.findOne(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    // Dropping CanManageEventGuard from this route widened who may edit, so the
    // ministry boundary has to be enforced here or a ministry admin could edit
    // another ministry's events.
    assertSameMinistry(
      { systemRole: actorRole ?? '', ministryId: ministryId },
      event.ministryId,
    );

    // Editing is wider than deleting: co-organizers and ministry-level admins
    // can amend an event they did not create.
    const isCoOrganizer = event.coOrganizers?.some(
      (c: any) => c.userId === actorId,
    );
    const isMinistryAdmin = ['MINISTER', 'MINISTRY_ADMIN', 'SUPER_ADMIN'].includes(
      actorRole ?? '',
    );

    if (event.organizerId !== actorId && !isCoOrganizer && !isMinistryAdmin) {
      throw new ForbiddenException(
        'Only the organizer, a co-organizer or a ministry admin can update this event',
      );
    }

    const updateData: any = { ...dto };

    if (dto.startAt || dto.endAt) {
      const startAt = dto.startAt ? new Date(dto.startAt) : event.startAt;
      const endAt = dto.endAt ? new Date(dto.endAt) : event.endAt;

      if (startAt >= endAt) {
        throw new BadRequestException('Start time must be before end time');
      }

      if (event.roomId) {
        const conflicts = await this.eventsRepository.checkRoomConflicts(
          event.roomId,
          startAt,
          endAt,
          id,
        );

        if (conflicts.length > 0) {
          throw new ConflictException(
            'Room conflict with the new time slot',
          );
        }
      }

      updateData.startAt = startAt;
      updateData.endAt = endAt;
    }

    const updated = await this.eventsRepository.update(id, updateData);

    await this.audit.log({
      action: 'EVENT_UPDATED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Updated event: ${event.title}`,
      changes: dto as unknown as Record<string, unknown>,
    });

    await this.cache.invalidatePattern(`events:*${ministryId}*`);
    await this.cache.invalidateAnalytics();

    return updated;
  }

  async deleteEvent(
    id: string,
    actorId: string,
    ministryId: string,
    actorRole?: string,
  ) {
    const event = await this.eventsRepository.findOne(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    assertSameMinistry(
      { systemRole: actorRole ?? '', ministryId },
      event.ministryId,
    );
    this.assertCanAdminister(event, actorId, actorRole, 'delete');

    await this.eventsRepository.delete(id);

    await this.audit.log({
      action: 'EVENT_DELETED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Deleted event: ${event.title}`,
    });

    await this.cache.invalidatePattern(`events:*${ministryId}*`);
    await this.cache.invalidateAnalytics();
  }

  async publishEvent(
    id: string,
    actorId: string,
    ministryId: string,
    actorRole?: string,
  ) {
    const event = await this.eventsRepository.findOne(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    assertSameMinistry(
      { systemRole: actorRole ?? '', ministryId },
      event.ministryId,
    );
    this.assertCanAdminister(event, actorId, actorRole, 'publish');

    const updated = await this.eventsRepository.update(id, {
      status: 'PUBLISHED',
      publishedAt: new Date(),
    });

    await this.audit.log({
      action: 'EVENT_PUBLISHED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Published event: ${event.title}`,
    });

    await this.cache.invalidatePattern(`events:*${ministryId}*`);
    await this.cache.invalidateAnalytics();

    return updated;
  }

  async cancelEvent(
    id: string,
    actorId: string,
    ministryId: string,
    actorRole?: string,
  ) {
    const event = await this.eventsRepository.findOne(id);

    if (!event) {
      throw new NotFoundException(`Event ${id} not found`);
    }

    assertSameMinistry(
      { systemRole: actorRole ?? '', ministryId },
      event.ministryId,
    );
    this.assertCanAdminister(event, actorId, actorRole, 'cancel', true);

    if (event.status === 'CANCELLED') {
      throw new ConflictException('Event is already cancelled');
    }

    const updated = await this.eventsRepository.update(id, {
      status: 'CANCELLED',
    });

    await this.audit.log({
      action: 'EVENT_CANCELLED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: event.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Cancelled event: ${event.title}`,
    });

    await this.cache.invalidatePattern(`events:*${ministryId}*`);
    await this.cache.invalidateAnalytics();

    return updated;
  }

  async addCoOrganizer(
    eventId: string,
    userId: string,
    actorId: string,
    ministryId: string,
  ) {
    const event = await this.eventsRepository.findOne(eventId);

    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }

    if (event.organizerId !== actorId) {
      throw new ForbiddenException('Only event organizer can add co-organizers');
    }

    // Co-organizers are added by raw user id from the UI, so an unknown id is
    // routine input — report it instead of letting the FK violation surface
    // as an opaque 500.
    const user = await (this.prisma as any).user.findUnique({
      where: { id: userId },
      select: { id: true, ministryId: true },
    });

    if (!user) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    const existing = await (this.prisma as any).eventCoOrganizer.findFirst({
      where: { eventId, userId },
    });

    if (existing) {
      throw new ConflictException('User is already a co-organizer');
    }

    const coOrganizer = await (this.prisma as any).eventCoOrganizer.create({
      data: {
        eventId,
        userId,
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    await this.audit.log({
      action: 'COORGANIZER_ADDED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'EventCoOrganizer',
      entityId: coOrganizer.id,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Added co-organizer to event: ${event.title}`,
    });

    return coOrganizer;
  }

  async addAttendees(
    eventId: string,
    dto: AddAttendeesDto,
    actorId: string,
    ministryId: string,
    actorRole?: string,
  ) {
    const event = await this.eventsRepository.findOne(eventId);

    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }

    this.assertCanAdminister(
      event,
      actorId,
      actorRole,
      'invite attendees to this event',
      true,
    );

    const userIds = dto.userIds ?? [];
    const externals = dto.externals ?? [];

    if (userIds.length === 0 && externals.length === 0) {
      throw new BadRequestException('No attendees provided');
    }

    if (userIds.length > 0) {
      const found = await (this.prisma as any).user.findMany({
        where: { id: { in: userIds } },
        select: { id: true },
      });

      const missing = userIds.filter(
        (id) => !found.some((u: any) => u.id === id),
      );

      if (missing.length > 0) {
        throw new NotFoundException(`Unknown user(s): ${missing.join(', ')}`);
      }
    }

    // A unique rsvpTokenHash per row is what makes the /rsvp/:tokenHash link
    // resolvable, so mint one for every invitee.
    const rows = [
      ...userIds.map((userId) => ({
        eventId,
        userId,
        status: 'INVITED',
        rsvpTokenHash: randomBytes(24).toString('base64url'),
      })),
      ...externals.map((guest) => ({
        eventId,
        externalName: guest.name,
        externalEmail: guest.email,
        status: 'INVITED',
        rsvpTokenHash: randomBytes(24).toString('base64url'),
      })),
    ];

    // Re-inviting someone already on the list is a no-op rather than an error,
    // so a partly-overlapping invite still adds the new people.
    const result = await (this.prisma as any).eventAttendee.createMany({
      data: rows,
      skipDuplicates: true,
    });

    await this.audit.log({
      action: 'ATTENDEES_INVITED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'Event',
      entityId: eventId,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Invited ${result.count} attendee(s) to event: ${event.title}`,
    });

    await this.cache.invalidatePattern(`events:*${ministryId}*`);
    await this.cache.invalidateAnalytics();

    // Only people with accounts have an inbox; external guests are reached by
    // their RSVP link instead.
    await this.notifications.notifyMeetingInvitation(
      eventId,
      rows.filter((r: any) => r.userId).map((r: any) => r.userId),
    );

    return (this.prisma as any).eventAttendee.findMany({
      where: { eventId },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * RSVP to your own invitation from inside the app. The token flow at
   * /rsvp/:tokenHash is for emailed links and is one-shot; this one lets an
   * invitee change their mind, so it does not reject an existing response.
   */
  async selfRsvp(
    eventId: string,
    status: 'CONFIRMED' | 'DECLINED',
    actorId: string,
    ministryId: string,
  ) {
    const attendee = await (this.prisma as any).eventAttendee.findFirst({
      where: { eventId, userId: actorId },
    });

    if (!attendee) {
      throw new NotFoundException('You are not on the invitee list for this event');
    }

    const updated = await (this.prisma as any).eventAttendee.update({
      where: { id: attendee.id },
      data: { status, respondedAt: new Date() },
      include: { user: { select: { id: true, name: true, email: true } } },
    });

    await this.audit.log({
      action: 'RSVP_RESPONDED',
      actionCategory: 'ATTENDANCE',
      entityType: 'EventAttendee',
      entityId: attendee.id,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `RSVP ${status} (in-app) for event ${eventId}`,
    });

    return updated;
  }

  async removeAttendee(
    eventId: string,
    attendeeId: string,
    actorId: string,
    ministryId: string,
    actorRole?: string,
  ) {
    const event = await this.eventsRepository.findOne(eventId);

    if (!event) {
      throw new NotFoundException(`Event ${eventId} not found`);
    }

    this.assertCanAdminister(
      event,
      actorId,
      actorRole,
      'remove attendees from this event',
      true,
    );

    const attendee = await (this.prisma as any).eventAttendee.findFirst({
      where: { id: attendeeId, eventId },
    });

    if (!attendee) {
      throw new NotFoundException('Attendee not found on this event');
    }

    await (this.prisma as any).eventAttendee.delete({
      where: { id: attendeeId },
    });

    await this.audit.log({
      action: 'ATTENDEE_REMOVED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'EventAttendee',
      entityId: attendeeId,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId,
      description: `Removed an invitee from event: ${event.title}`,
    });

    await this.cache.invalidatePattern(`events:*${ministryId}*`);
    await this.cache.invalidateAnalytics();
  }
}
