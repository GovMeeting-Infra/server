import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { NotificationsService } from '../notifications/notifications.service';
import { MinutesAccessService } from './minutes-access.service';
import {
  ministryScope,
  assertSameMinistry,
} from '../common/utils/ministry-scope.util';
import { canReadArchived } from './archive.policy';
import { CreateMinutesDto } from './dto/create-minutes.dto';
import { UpdateMinutesDto } from './dto/update-minutes.dto';

@Injectable()
export class MinutesService {
  private logger = new Logger('MinutesService');
  private readonly EDIT_WINDOW_DAYS = 2;

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private notifications: NotificationsService,
    private access: MinutesAccessService,
    @InjectQueue('email-queue') private emailQueue: Queue,
  ) {}

  async draftMinutes(
    eventId: string,
    dto: CreateMinutesDto,
    userId: string,
    ministryId: string,
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: { coOrganizers: true },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // A public activity is a launch or a ceremony, not a meeting that produces
    // a record of proceedings. Its attendance still matters — check-in and the
    // attendee list are untouched — but minutes do not apply.
    if (event.isPublic) {
      throw new BadRequestException(
        'Public activities do not have meeting minutes',
      );
    }

    const canDraft =
      event.organizerId === userId ||
      event.coOrganizers?.some((c: any) => c.userId === userId);

    if (!canDraft) {
      throw new ForbiddenException('Only organizers can draft minutes');
    }

    let minutes = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
    });

    if (!minutes) {
      minutes = await (this.prisma as any).minutes.create({
        data: {
          eventId,
          status: 'DRAFT',
          draftedById: userId,
          draftedAt: new Date(),
        },
      });

      await this.replacePoints(minutes.id, dto);

      await this.audit.log({
        action: 'MINUTES_DRAFTED',
        actionCategory: 'MINUTES_MANAGEMENT',
        entityType: 'Minutes',
        entityId: minutes.id,
        entityName: event.title,
        status: 'SUCCESS',
        ministryId,
        actorId: userId,
        description: `Drafted minutes for event: ${event.title}`,
      });
    } else {
      minutes = await (this.prisma as any).minutes.update({
        where: { id: minutes.id },
        data: {
          draftedById: userId,
          draftedAt: new Date(),
        },
      });

      await this.replacePoints(minutes.id, dto);

      await this.audit.log({
        action: 'MINUTES_UPDATED',
        actionCategory: 'MINUTES_MANAGEMENT',
        entityType: 'Minutes',
        entityId: minutes.id,
        entityName: event.title,
        status: 'SUCCESS',
        ministryId,
        actorId: userId,
        description: `Updated minutes draft for event: ${event.title}`,
      });
    }

    return this.getMinutes(eventId);
  }

  /**
   * Swap a list of points for the one just submitted.
   *
   * Replace rather than reconcile: the client sends the list as the drafter
   * arranged it, so position is the array index and there is nothing to merge.
   * Only the lists actually present in the payload are touched — omitting a
   * key leaves that list alone, while sending an empty array clears it, which
   * is how a drafter removes their last decision.
   *
   * One transaction so a record can never be seen having lost its old points
   * and not yet gained the new ones.
   */
  private async replacePoints(minutesId: string, dto: UpdateMinutesDto) {
    const lists: [string, string[] | undefined][] = [
      ['DECISION', dto.decisions],
      ['NEXT_STEP', dto.nextSteps],
    ];

    const work = lists
      .filter(([, values]) => values !== undefined)
      .flatMap(([type, values]) => [
        (this.prisma as any).minutePoint.deleteMany({
          where: { minutesId, type },
        }),
        (this.prisma as any).minutePoint.createMany({
          data: (values as string[])
            .map((text) => text.trim())
            .filter((text) => text.length > 0)
            .map((text, order) => ({ minutesId, type, text, order })),
        }),
      ]);

    if (work.length) await (this.prisma as any).$transaction(work);
  }

  async updateMinutes(
    eventId: string,
    dto: UpdateMinutesDto,
    userId: string,
    userRole: string,
    ministryId: string,
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: { coOrganizers: true },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    // Checked before the generic refusal below so the caller is told the real
    // reason. An archived record is frozen permanently, which is quite
    // different from an edit window that a ministry admin can still override.
    if (minutes.status === 'ARCHIVED') {
      throw new ForbiddenException(
        'These minutes have been archived and can no longer be changed',
      );
    }

    const canEdit = await this.canEditMinutes(
      eventId,
      userId,
      userRole,
      ministryId,
    );

    if (!canEdit) {
      throw new ForbiddenException('Edit window expired (2 days after event)');
    }

    await this.replacePoints(minutes.id, dto);

    await this.audit.log({
      action: 'MINUTES_EDITED',
      actionCategory: 'MINUTES_MANAGEMENT',
      entityType: 'Minutes',
      entityId: minutes.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Edited minutes for event: ${event.title}`,
      changes: dto as unknown as Record<string, unknown>,
    });

    return this.getMinutes(eventId);
  }

  async publishMinutes(eventId: string, userId: string, ministryId: string) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: {
        coOrganizers: true,
        attendees: true,
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const canPublish =
      event.organizerId === userId ||
      event.coOrganizers?.some((c: any) => c.userId === userId);

    if (!canPublish) {
      throw new ForbiddenException('Only organizers can publish minutes');
    }

    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
      include: { _count: { select: { points: true, actionItems: true } } },
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    if (minutes.status === 'ARCHIVED') {
      throw new ForbiddenException(
        'These minutes have been archived and can no longer be changed',
      );
    }

    // Any one of the three is a record worth sending. Which one is the
    // meeting's business — plenty of meetings decide nothing and only agree
    // who does what next — but an empty record should not reach everyone who
    // attended.
    if (minutes._count.points + minutes._count.actionItems === 0) {
      throw new BadRequestException(
        'Record at least one decision, action item or next step before publishing',
      );
    }

    if (!event.attendees?.length) {
      throw new BadRequestException('Event must have attendees to publish');
    }

    const published = await (this.prisma as any).minutes.update({
      where: { id: minutes.id },
      data: {
        status: 'PUBLISHED',
        publishedById: userId,
        publishedAt: new Date(),
      },
    });

    await this.audit.log({
      action: 'MINUTES_PUBLISHED',
      actionCategory: 'MINUTES_MANAGEMENT',
      entityType: 'Minutes',
      entityId: minutes.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId,
      actorId: userId,
      description: `Published minutes for event: ${event.title}`,
    });

    // Attendees who have muted minutes notifications are filtered out inside
    // the service; this never throws, so a notification failure cannot undo a
    // publish that already succeeded.
    await this.notifications.notifyMinutesPublished(eventId);

    // The record goes to everyone who was there, with the action items it
    // produced. Guests get a link that works without an account; wrapped so a
    // mail or Redis problem cannot undo a publish that already succeeded.
    try {
      await this.distribute(eventId, minutes.id);
    } catch (error) {
      this.logger.error('Failed to distribute published minutes', error);
    }

    return published;
  }

  /**
   * Send the published record to everyone entitled to it.
   *
   * Staff already have the in-app notification and a page they can open; guests
   * get a tokenised link, which is the only route they have.
   */
  private async distribute(eventId: string, minutesId: string) {
    const recipients = await this.access.recipientsFor(eventId);

    for (const r of recipients) {
      if (!r.email) continue;

      const guestLink = r.userId
        ? null
        : await this.access.issueGuestLink(minutesId, r.email);

      await this.emailQueue.add(
        'send-minutes-published',
        {
          eventId,
          userId: r.userId,
          email: r.email,
          name: r.name,
          guestLink,
        },
        {
          jobId: `minutes-published:${minutesId}:${r.userId ?? r.email.toLowerCase()}`,
          removeOnComplete: { age: 24 * 60 * 60 },
          removeOnFail: { age: 24 * 60 * 60 },
        },
      );
    }

    this.logger.log(
      `Queued published minutes to ${recipients.length} recipient(s) for event ${eventId}`,
    );
  }

  /**
   * Whether the caller may edit, and why not when they may not.
   *
   * The boolean alone left the page unable to tell someone whether their two
   * days had run out or they were never an organiser — so it said both at once,
   * named no date, and offered nobody to ask. The window end comes back too:
   * rendering a deadline the server calculated is presentation, where
   * recomputing `endAt + 2 days` in the client would be a second copy of the
   * rule waiting to drift.
   */
  async describeEditPermission(
    eventId: string,
    userId: string,
    userRole: string,
    actorMinistryId?: string,
  ): Promise<{
    canEdit: boolean;
    reason:
      | 'OPEN'
      | 'ADMIN_OVERRIDE'
      | 'WINDOW_CLOSED'
      | 'NOT_ORGANIZER'
      | 'ARCHIVED'
      | 'OTHER_MINISTRY'
      | 'NOT_FOUND';
    editWindowEndsAt: Date | null;
  }> {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: { coOrganizers: true },
    });

    if (!event) {
      return {
        canEdit: false,
        reason: 'NOT_FOUND' as const,
        editWindowEndsAt: null,
      };
    }

    // An archived record is frozen for everyone, including leadership. That is
    // the point of archiving it — checked before any role logic so no override
    // below can reopen it.
    const existing = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
      select: { status: true },
    });

    if (existing?.status === 'ARCHIVED') {
      return {
        canEdit: false,
        reason: 'ARCHIVED' as const,
        editWindowEndsAt: null,
      };
    }

    // Without this a ministry admin could edit another ministry's minutes —
    // the role checks below are deliberately broad and carry no scope of their
    // own.
    if (
      userRole !== 'SUPER_ADMIN' &&
      actorMinistryId !== undefined &&
      event.ministryId !== actorMinistryId
    ) {
      return {
        canEdit: false,
        reason: 'OTHER_MINISTRY' as const,
        editWindowEndsAt: null,
      };
    }

    const isOrganizerOrCoOrg =
      event.organizerId === userId ||
      event.coOrganizers?.some((c: any) => c.userId === userId);

    const isMinistryLevel = ['MINISTER', 'MINISTRY_ADMIN'].includes(userRole);

    const editWindowEnd = new Date(
      event.endAt.getTime() + this.EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    if (!isOrganizerOrCoOrg && !isMinistryLevel) {
      return {
        canEdit: false,
        reason: 'NOT_ORGANIZER' as const,
        editWindowEndsAt: editWindowEnd,
      };
    }

    const withinWindow = new Date() <= editWindowEnd;

    if (!withinWindow && isMinistryLevel) {
      return {
        canEdit: true,
        reason: 'ADMIN_OVERRIDE' as const,
        editWindowEndsAt: editWindowEnd,
      };
    }

    return {
      canEdit: withinWindow,
      // The two cases the UI has to tell apart: still open, or closed on a
      // date the reader can be told. Fusing them into one boolean is why the
      // page said "the window has closed or you aren't an organizer" and left
      // people with no idea which, and nobody to ask.
      reason: withinWindow ? ('OPEN' as const) : ('WINDOW_CLOSED' as const),
      editWindowEndsAt: editWindowEnd,
    };
  }

  /**
   * How many people publishing would email, and how many are outside
   * government.
   *
   * Uses the same recipientsFor the send itself uses, so the number shown in
   * the confirmation cannot disagree with the number that actually receive it.
   * External guests are counted separately because they are the part people do
   * not expect: a walk-in with no account still gets the record, on a permanent
   * link.
   */
  async countPublishRecipients(
    eventId: string,
  ): Promise<{ total: number; external: number }> {
    const recipients = await this.access.recipientsFor(eventId);
    return {
      total: recipients.length,
      external: recipients.filter((r) => !r.userId).length,
    };
  }

  /**
   * Whether this person could publish right now, and what is stopping them.
   *
   * The page mirrored these preconditions with its own copy of the
   * organiser check and its own count. Reported here so the affordance and the
   * rule that governs it come from one place, and so the blocked reason the
   * page shows is the same sentence the server would have thrown.
   */
  async canPublishMinutes(
    eventId: string,
    userId: string,
    _userRole: string,
  ): Promise<{ allowed: boolean; blockedReason: string | null }> {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: {
        organizerId: true,
        isPublic: true,
        coOrganizers: { select: { userId: true } },
        attendees: { select: { id: true }, take: 1 },
      },
    });

    if (!event) return { allowed: false, blockedReason: 'Meeting not found.' };

    if (event.isPublic) {
      return {
        allowed: false,
        blockedReason: 'Public activities do not have minutes.',
      };
    }

    const isOrganizer =
      event.organizerId === userId ||
      event.coOrganizers?.some((c: any) => c.userId === userId);

    if (!isOrganizer) {
      return {
        allowed: false,
        blockedReason: 'Only the organiser and co-organisers can send minutes.',
      };
    }

    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
      include: { _count: { select: { points: true, actionItems: true } } },
    });

    if (!minutes || minutes._count.points + minutes._count.actionItems === 0) {
      return {
        allowed: false,
        blockedReason:
          'Save at least one decision, action item or next step first.',
      };
    }

    if (!event.attendees?.length) {
      return {
        allowed: false,
        blockedReason: 'Add who attended before sending the minutes.',
      };
    }

    return { allowed: true, blockedReason: null };
  }

  /** The boolean alone, for callers that only gate on it. */
  async canEditMinutes(
    eventId: string,
    userId: string,
    userRole: string,
    actorMinistryId?: string,
  ): Promise<boolean> {
    const { canEdit } = await this.describeEditPermission(
      eventId,
      userId,
      userRole,
      actorMinistryId,
    );
    return canEdit;
  }

  /**
   * Every minutes record the user may see, newest meeting first.
   *
   * Minutes were previously reachable only by navigating to their event, so
   * there was no way to answer "which meetings still have no minutes written
   * up". Scoped through the owning event's ministry, matching how search
   * already treats minutes.
   */
  async listMinutes(
    user: { systemRole: string; ministryId?: string | null },
    opts: { q?: string; status?: string; skip?: number; take?: number } = {},
  ) {
    const take = Math.min(opts.take ?? 25, 100);
    const skip = opts.skip ?? 0;
    const term = opts.q?.trim();

    // Archived records are leadership-only, and are kept out of the default
    // listing even for them so the page stays about current business.
    const mayReadArchived = canReadArchived(user.systemRole);
    const archiveFilter =
      opts.status === 'ARCHIVED' && mayReadArchived
        ? { status: 'ARCHIVED' }
        : { status: { not: 'ARCHIVED' } };

    const where: any = {
      event: ministryScope(user),
      ...(opts.status && opts.status !== 'ARCHIVED'
        ? { status: opts.status }
        : archiveFilter),
      ...(term
        ? {
            OR: [
              { event: { title: { contains: term, mode: 'insensitive' } } },
              // The record has no prose left to match on: its content is the
              // decisions and next steps themselves.
              {
                points: {
                  some: { text: { contains: term, mode: 'insensitive' } },
                },
              },
            ],
          }
        : {}),
    };

    // The ministry scope has to survive the search OR above, which replaces the
    // event filter when a term is present.
    if (term) {
      where.AND = [{ event: ministryScope(user) }];
      delete where.event;
    }

    const [data, total] = await Promise.all([
      (this.prisma as any).minutes.findMany({
        where,
        select: {
          id: true,
          status: true,
          // Enough to say what the meeting settled without opening it. The
          // list used to show a summary line; the first decisions are the
          // closest honest equivalent.
          points: {
            where: { type: 'DECISION' },
            orderBy: { order: 'asc' },
            take: 2,
            select: { id: true, text: true },
          },
          draftedAt: true,
          publishedAt: true,
          updatedAt: true,
          event: {
            select: { id: true, title: true, startAt: true, ministryId: true },
          },
          draftedBy: { select: { id: true, name: true } },
          publishedBy: { select: { id: true, name: true } },
          _count: { select: { actionItems: true, points: true } },
        },
        orderBy: { event: { startAt: 'desc' } },
        skip,
        take,
      }),
      (this.prisma as any).minutes.count({ where }),
    ]);

    return { data, total };
  }

  /**
   * Archive a published record ahead of the six-month retention point.
   *
   * Restricted to the same roles that may read archived records — it would be
   * odd to let someone file a record away that they then cannot open.
   */
  async archiveMinutes(
    eventId: string,
    actor: { id: string; systemRole: string; ministryId?: string | null },
  ) {
    const { minutes, event } = await this.loadForArchival(eventId, actor);

    if (minutes.status === 'ARCHIVED') {
      throw new BadRequestException('These minutes are already archived');
    }

    // Only a published record is a record. Archiving a draft would freeze
    // half-finished work, which is why the nightly job skips drafts too.
    if (minutes.status !== 'PUBLISHED') {
      throw new BadRequestException('Only published minutes can be archived');
    }

    const updated = await (this.prisma as any).minutes.update({
      where: { id: minutes.id },
      data: {
        status: 'ARCHIVED',
        archivedAt: new Date(),
        // Clear any previous exemption, so a record archived by hand is
        // treated the same as one the job archived.
        archiveExempt: false,
      },
    });

    await this.audit.log({
      action: 'MINUTES_ARCHIVED',
      actionCategory: 'MINUTES_MANAGEMENT',
      entityType: 'Minutes',
      entityId: minutes.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId: event.ministryId,
      actorId: actor.id,
      description: `Archived minutes for event: ${event.title}`,
      metadata: { manual: true },
    });

    return updated;
  }

  /** Take a record back out of the archive, exempting it from the job. */
  async restoreMinutes(
    eventId: string,
    actor: { id: string; systemRole: string; ministryId?: string | null },
  ) {
    const { minutes, event } = await this.loadForArchival(eventId, actor);

    if (minutes.status !== 'ARCHIVED') {
      throw new BadRequestException('These minutes are not archived');
    }

    const updated = await (this.prisma as any).minutes.update({
      where: { id: minutes.id },
      data: {
        // The job only ever archives published records, so that is what a
        // restored one goes back to.
        status: 'PUBLISHED',
        archivedAt: null,
        archiveExempt: true,
      },
    });

    await this.audit.log({
      action: 'MINUTES_RESTORED',
      actionCategory: 'MINUTES_MANAGEMENT',
      entityType: 'Minutes',
      entityId: minutes.id,
      entityName: event.title,
      status: 'SUCCESS',
      ministryId: event.ministryId,
      actorId: actor.id,
      description: `Restored minutes from the archive for event: ${event.title}`,
    });

    return updated;
  }

  private async loadForArchival(
    eventId: string,
    actor: { systemRole: string; ministryId?: string | null },
  ) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      select: { id: true, title: true, ministryId: true },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // A minister governs their own ministry's records, not everyone's.
    assertSameMinistry(actor, event.ministryId);

    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
      select: { id: true, status: true },
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    return { minutes, event };
  }

  async getMinutes(eventId: string, systemRole?: string) {
    const minutes = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
      include: {
        actionItems: {
          orderBy: { createdAt: 'desc' },
        },
        // As the drafter arranged them, which is the only order that means
        // anything for a list of decisions.
        points: { orderBy: [{ type: 'asc' }, { order: 'asc' }] },
        draftedBy: { select: { id: true, name: true, email: true } },
        publishedBy: { select: { id: true, name: true, email: true } },
      },
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    // Archived records are readable only by ministry leadership. Reported as
    // not-found rather than forbidden: whether an archived record exists is
    // itself part of what is being withheld.
    if (minutes.status === 'ARCHIVED' && !canReadArchived(systemRole)) {
      throw new NotFoundException('Minutes not found');
    }

    return minutes;
  }
}
