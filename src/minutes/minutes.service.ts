import {
  Injectable,
  ForbiddenException,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { NotificationsService } from '../notifications/notifications.service';
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
          body: dto.body,
          summary: dto.summary,
          status: 'DRAFT',
          draftedById: userId,
          draftedAt: new Date(),
        },
      });

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
          body: dto.body,
          summary: dto.summary,
          draftedById: userId,
          draftedAt: new Date(),
        },
      });

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

    return minutes;
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
      throw new ForbiddenException(
        'Edit window expired (2 days after event)',
      );
    }

    const updated = await (this.prisma as any).minutes.update({
      where: { id: minutes.id },
      data: {
        ...(dto.body && { body: dto.body }),
        ...(dto.summary && { summary: dto.summary }),
      },
    });

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

    return updated;
  }

  async publishMinutes(
    eventId: string,
    userId: string,
    ministryId: string,
  ) {
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
    });

    if (!minutes) {
      throw new NotFoundException('Minutes not found');
    }

    if (minutes.status === 'ARCHIVED') {
      throw new ForbiddenException(
        'These minutes have been archived and can no longer be changed',
      );
    }

    if (!minutes.body?.trim()) {
      throw new BadRequestException('Minutes body cannot be empty');
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

    return published;
  }

  async canEditMinutes(
    eventId: string,
    userId: string,
    userRole: string,
    actorMinistryId?: string,
  ): Promise<boolean> {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: { coOrganizers: true },
    });

    if (!event) {
      return false;
    }

    // An archived record is frozen for everyone, including leadership. That is
    // the point of archiving it — checked before any role logic so no override
    // below can reopen it.
    const existing = await (this.prisma as any).minutes.findUnique({
      where: { eventId },
      select: { status: true },
    });

    if (existing?.status === 'ARCHIVED') {
      return false;
    }

    // Without this a ministry admin could edit another ministry's minutes —
    // the role checks below are deliberately broad and carry no scope of their
    // own.
    if (
      userRole !== 'SUPER_ADMIN' &&
      actorMinistryId !== undefined &&
      event.ministryId !== actorMinistryId
    ) {
      return false;
    }

    const isOrganizerOrCoOrg =
      event.organizerId === userId ||
      event.coOrganizers?.some((c: any) => c.userId === userId);

    if (!isOrganizerOrCoOrg && !['MINISTER', 'MINISTRY_ADMIN'].includes(userRole)) {
      return false;
    }

    const editWindowEnd = new Date(
      event.endAt.getTime() + this.EDIT_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );

    if (new Date() > editWindowEnd && ['MINISTER', 'MINISTRY_ADMIN'].includes(userRole)) {
      return true;
    }

    return new Date() <= editWindowEnd;
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
              { summary: { contains: term, mode: 'insensitive' } },
              { body: { contains: term, mode: 'insensitive' } },
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
          summary: true,
          draftedAt: true,
          publishedAt: true,
          updatedAt: true,
          event: {
            select: { id: true, title: true, startAt: true, ministryId: true },
          },
          draftedBy: { select: { id: true, name: true } },
          publishedBy: { select: { id: true, name: true } },
          _count: { select: { actionItems: true } },
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
      throw new BadRequestException(
        'Only published minutes can be archived',
      );
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
