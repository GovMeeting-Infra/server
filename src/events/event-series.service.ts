import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CacheService } from '../cache/cache.service';
import { CreateEventSeriesDto } from './dto/create-event-series.dto';
import { assertCanEditEvent } from './event-access';
import { assertSameMinistry } from '../common/utils/ministry-scope.util';
import { MAX_OCCURRENCES, occurrenceLimit } from './event-series.constants';

/**
 * Everything an occurrence inherits from the activity it was generated from.
 *
 * An occurrence is an ordinary Event row, so it needs everything that makes an
 * Event usable. This list used to be much shorter, and the omissions were not
 * obvious: `venueName` — the one field the create form refuses to submit
 * without — was missing, so every generated occurrence was in a state the rest
 * of the platform forbids.
 *
 * The check-in anchor fields are deliberately absent. Those are captured from
 * the organizer's handset at the venue on the day; inheriting one would fence
 * next month's meeting to where somebody stood this month.
 */
const INHERITED_FIELDS = [
  'title',
  'description',
  'isPublic',
  'type',
  'scope',
  'classification',
  'venueName',
  'venueLat',
  'venueLng',
  'geofenceRadius',
  'requireGeofence',
  'allowGuestCheckIn',
  'colorCategory',
  'bannerImage',
  'contactEmail',
  'contactPhone',
  'externalUrl',
  'ministryId',
  'organizerId',
  'status',
  'publishedAt',
] as const;

/** What the rebuild needs to know about each existing occurrence. */
const OCCURRENCE_SELECT = {
  id: true,
  startAt: true,
  endAt: true,
  minutes: { select: { id: true } },
  _count: { select: { attendances: true } },
};

interface Actor {
  id: string;
  systemRole?: string;
  ministryId: string;
}

@Injectable()
export class EventSeriesService {
  private logger = new Logger('EventSeriesService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private cache: CacheService,
  ) {}

  // ==========================================================================
  // Dates
  // ==========================================================================

  /**
   * The nth slot after `anchor`, counting from 1.
   *
   * Computed from the anchor every time rather than by walking a cursor
   * forward, because a walked cursor cannot recover from a clamp. A monthly
   * meeting on the 31st has to become the 28th in February and then go back to
   * the 31st in March; a cursor that was clamped to the 28th sees "the 28th" as
   * the date from then on and the meeting never returns to the end of the
   * month. Working from the original day each time makes February a special
   * case for February alone.
   *
   * UTC throughout, so a series generated on the server and one generated on a
   * laptop agree. Freetown is UTC+0 with no daylight saving, so this is about
   * being deterministic rather than about being correct today.
   */
  private nthDate(
    anchor: Date,
    frequency: string,
    interval: number,
    n: number,
  ): Date {
    const step = Math.max(interval || 1, 1);
    const date = new Date(anchor);

    switch (frequency) {
      case 'DAILY':
        date.setUTCDate(date.getUTCDate() + step * n);
        break;
      case 'WEEKLY':
        date.setUTCDate(date.getUTCDate() + 7 * step * n);
        break;
      case 'BIWEEKLY':
        date.setUTCDate(date.getUTCDate() + 14 * step * n);
        break;
      case 'WEEKDAYS':
        // Interval is meaningless here — "every weekday, every 3" is not a
        // thing anyone means — so it advances one working day at a time and the
        // form hides the control. The only frequency that has to be walked,
        // because how far a weekend pushes it depends where it lands.
        for (let i = 0; i < n; i++) {
          do {
            date.setUTCDate(date.getUTCDate() + 1);
          } while ([0, 6].includes(date.getUTCDay()));
        }
        break;
      case 'MONTHLY':
        this.addMonths(date, step * n);
        break;
      case 'QUARTERLY':
        this.addMonths(date, 3 * step * n);
        break;
      case 'YEARLY':
        this.addMonths(date, 12 * step * n);
        break;
    }

    return date;
  }

  /**
   * Add months to a date, clamping to the last day of the target month.
   *
   * setMonth rolls over instead of clamping: 31 January plus one month is
   * 3 March, so a board meeting held on the 30th used to walk quietly into the
   * following month and stay there.
   */
  private addMonths(date: Date, months: number) {
    const day = date.getUTCDate();
    date.setUTCDate(1);
    date.setUTCMonth(date.getUTCMonth() + months);
    const lastDay = new Date(
      Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
    ).getUTCDate();
    date.setUTCDate(Math.min(day, lastDay));
  }

  /**
   * The last instant of the day a rule runs until.
   *
   * The form sends a date with no time, so `new Date('2026-06-01')` is midnight
   * — which excludes a ten o'clock meeting on the very day the organizer chose
   * as the last one.
   */
  private endOfDay(until: Date): Date {
    const d = new Date(until);
    d.setUTCHours(23, 59, 59, 999);
    return d;
  }

  // ==========================================================================
  // Generating occurrences
  // ==========================================================================

  /**
   * The slots that follow `anchorStart` under `rule`, up to `slots` of them.
   *
   * The anchor is a meeting that already exists and keeps its place — the
   * activity being scheduled, or the last occurrence that has already been
   * held. Generation starts at the slot after it, which is why the first thing
   * this does is advance.
   */
  private generateOccurrences(
    template: any,
    rule: { frequency: string; interval: number; until: Date | null },
    seriesId: string,
    anchorStart: Date,
    durationMs: number,
    slots: number,
  ): any[] {
    const occurrences: any[] = [];
    if (slots <= 0) return occurrences;

    const until = rule.until ? this.endOfDay(rule.until) : null;

    const inherited: Record<string, unknown> = {};
    for (const field of INHERITED_FIELDS) {
      inherited[field] = template[field];
    }

    for (let n = 1; occurrences.length < slots; n++) {
      const startAt = this.nthDate(
        anchorStart,
        rule.frequency,
        rule.interval,
        n,
      );
      if (until && startAt > until) break;

      occurrences.push({
        ...inherited,
        seriesId,
        startAt,
        endAt: new Date(startAt.getTime() + durationMs),
      });
    }

    return occurrences;
  }

  /**
   * Give freshly generated occurrences the same people as the activity they
   * came from.
   *
   * None of this happened before, and the consequence was not cosmetic: an
   * occurrence had nobody invited, so no reminders and no RSVPs, and it had no
   * co-organizers, so the very people who scheduled the series could not edit
   * any occurrence but the first.
   */
  private async copyPeople(
    tx: any,
    template: any,
    occurrenceIds: string[],
  ): Promise<void> {
    if (occurrenceIds.length === 0) return;

    const coOrganizers = template.coOrganizers ?? [];
    if (coOrganizers.length > 0) {
      await tx.eventCoOrganizer.createMany({
        data: occurrenceIds.flatMap((eventId) =>
          coOrganizers.map((c: any) => ({ eventId, userId: c.userId })),
        ),
        skipDuplicates: true,
      });
    }

    const attendees = template.attendees ?? [];
    if (attendees.length > 0) {
      await tx.eventAttendee.createMany({
        data: occurrenceIds.flatMap((eventId) =>
          attendees.map((a: any) => ({
            eventId,
            userId: a.userId,
            externalName: a.externalName,
            externalEmail: a.externalEmail,
            // Its own token, never the original's: one RSVP link must answer
            // for one meeting, or accepting March would accept April too.
            rsvpTokenHash: randomBytes(24).toString('base64url'),
            // Nobody has answered for this occurrence yet, whatever they said
            // about the first one.
            status: 'INVITED',
            respondedAt: null,
            // Carried from the first occurrence rather than nulled. Null means
            // "never told about this meeting", which is what sendInvitations
            // looks for — and a generated occurrence should not produce its own
            // invitation email. One invitation covers the series; the reminder
            // cron still speaks up before each occurrence.
            lastInvitedAt: a.lastInvitedAt,
          })),
        ),
        skipDuplicates: true,
      });
    }

    const invitedMinistries = template.invitedMinistries ?? [];
    if (invitedMinistries.length > 0) {
      // An implicit many-to-many needs a nested write, so this is the one part
      // that cannot be a single createMany.
      for (const eventId of occurrenceIds) {
        await tx.event.update({
          where: { id: eventId },
          data: {
            invitedMinistries: {
              connect: invitedMinistries.map((m: any) => ({ id: m.id })),
            },
          },
        });
      }
    }
  }

  // ==========================================================================
  // Setting and changing the rule
  // ==========================================================================

  /**
   * Set the repeat rule for an activity, or replace the one it has.
   *
   * Replacing rebuilds only what is still to come. Occurrences that have
   * already started are left exactly as they are — they may carry attendance
   * and minutes, and rewriting a meeting that has happened is not an edit, it
   * is a falsification. An upcoming occurrence that already holds attendance or
   * minutes is preserved for the same reason and reported back.
   */
  async setRule(eventId: string, dto: CreateEventSeriesDto, actor: Actor) {
    const template = await this.loadTemplate(eventId, actor);
    const now = new Date();

    const result = await (this.prisma as any).$transaction(
      async (tx: any) => {
        const existing = template.seriesId
          ? await tx.event.findMany({
              where: { seriesId: template.seriesId },
              orderBy: { startAt: 'asc' },
              select: OCCURRENCE_SELECT,
            })
          : [];

        const { keep, doomed } = this.partition(existing, template.id, now);

        if (doomed.length > 0) {
          await tx.event.deleteMany({
            where: { id: { in: doomed.map((o: any) => o.id) } },
          });
        }

        const series = template.seriesId
          ? await tx.eventSeries.update({
              where: { id: template.seriesId },
              data: this.ruleData(dto),
            })
          : await tx.eventSeries.create({ data: this.ruleData(dto) });

        // The activity being edited always belongs to its own series, and is
        // never deleted — the page the organizer is standing on has to survive
        // the change.
        if (template.seriesId !== series.id) {
          await tx.event.update({
            where: { id: template.id },
            data: { seriesId: series.id },
          });
        }

        // Everything kept counts toward the total, so "six occurrences" means
        // six in all rather than six more on top of the ones already held.
        const kept = keep.length || 1;
        const slots = Math.max(
          occurrenceLimit(dto.endType, dto.count) - kept,
          0,
        );

        const anchorStart = keep.length
          ? new Date(
              Math.max(...keep.map((o: any) => new Date(o.startAt).getTime())),
            )
          : new Date(template.startAt);

        const durationMs =
          new Date(template.endAt).getTime() -
          new Date(template.startAt).getTime();

        const occurrences = this.generateOccurrences(
          template,
          {
            frequency: dto.frequency,
            interval: dto.interval || 1,
            until: dto.until ? new Date(dto.until) : null,
          },
          series.id,
          anchorStart,
          durationMs,
          slots,
        );

        if (occurrences.length > 0) {
          await tx.event.createMany({ data: occurrences });
          const created = await tx.event.findMany({
            where: {
              seriesId: series.id,
              startAt: { gt: anchorStart },
            },
            select: { id: true },
          });
          await this.copyPeople(
            tx,
            template,
            created.map((e: any) => e.id),
          );
        }

        return {
          series,
          created: occurrences.length,
          deleted: doomed.length,
          preserved: keep.filter((o: any) => this.isProtected(o, now)).length,
          truncated:
            dto.endType !== 'COUNT' &&
            occurrences.length + kept >= MAX_OCCURRENCES,
        };
      },
      { timeout: 30_000 },
    );

    await this.audit.log({
      action: template.seriesId
        ? 'EVENT_SERIES_UPDATED'
        : 'EVENT_SERIES_CREATED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'EventSeries',
      entityId: result.series.id,
      entityName: `Series: ${template.title}`,
      status: 'SUCCESS',
      ministryId: template.ministryId,
      actorId: actor.id,
      description: `${template.seriesId ? 'Changed' : 'Set'} the repeat rule for: ${template.title} (${dto.frequency})`,
      metadata: {
        frequency: dto.frequency,
        interval: dto.interval || 1,
        endType: dto.endType,
        count: dto.count,
        created: result.created,
        deleted: result.deleted,
        preserved: result.preserved,
      },
    });

    await this.invalidate(template.ministryId);

    return {
      seriesId: result.series.id,
      anchorEventId: template.id,
      created: result.created,
      deleted: result.deleted,
      preserved: result.preserved,
      truncated: result.truncated,
    };
  }

  /**
   * Stop an activity repeating.
   *
   * Upcoming occurrences go; ones already held stay, detached, as the standalone
   * records of meetings that happened. The rule itself is deleted rather than
   * left behind — an EventSeries row with no events is a leak nothing would
   * ever clean up.
   */
  async removeRule(eventId: string, actor: Actor) {
    const template = await this.loadTemplate(eventId, actor);

    if (!template.seriesId) {
      throw new BadRequestException('This activity does not repeat');
    }

    const now = new Date();

    const result = await (this.prisma as any).$transaction(
      async (tx: any) => {
        const existing = await tx.event.findMany({
          where: { seriesId: template.seriesId },
          orderBy: { startAt: 'asc' },
          select: OCCURRENCE_SELECT,
        });

        const { keep, doomed } = this.partition(existing, template.id, now);

        if (doomed.length > 0) {
          await tx.event.deleteMany({
            where: { id: { in: doomed.map((o: any) => o.id) } },
          });
        }

        await tx.event.updateMany({
          where: { seriesId: template.seriesId },
          data: { seriesId: null },
        });

        await tx.eventSeries.delete({ where: { id: template.seriesId } });

        return { deleted: doomed.length, keptStandalone: keep.length };
      },
      { timeout: 30_000 },
    );

    await this.audit.log({
      action: 'EVENT_SERIES_REMOVED',
      actionCategory: 'EVENT_MANAGEMENT',
      entityType: 'EventSeries',
      entityId: template.seriesId,
      entityName: `Series: ${template.title}`,
      status: 'SUCCESS',
      ministryId: template.ministryId,
      actorId: actor.id,
      description: `Stopped repeating: ${template.title}`,
      metadata: result,
    });

    await this.invalidate(template.ministryId);

    return result;
  }

  // ==========================================================================
  // Propagating an ordinary edit to later occurrences
  // ==========================================================================

  /**
   * Apply an edit made to one occurrence to every later one.
   *
   * Dates shift, they are not stamped. The version of this that was written
   * but never routed passed the update straight to updateMany, which would have
   * given every occurrence in the series the same startAt — collapsing a year
   * of meetings onto one afternoon. Instead the change is read as a whole-day
   * shift plus a time of day, so moving ten o'clock to eleven moves every later
   * occurrence an hour later on its own date, and moving Monday to Tuesday
   * moves the whole series forward a day and keeps its cadence.
   */
  async applyToFutureOccurrences(
    tx: any,
    edited: { id: string; seriesId: string; startAt: Date; endAt: Date },
    previous: { startAt: Date; endAt: Date },
    fields: Record<string, unknown>,
  ): Promise<{ updated: number }> {
    const now = new Date();

    const later = await tx.event.findMany({
      where: {
        seriesId: edited.seriesId,
        id: { not: edited.id },
        startAt: { gt: now },
      },
      orderBy: { startAt: 'asc' },
      select: { id: true, startAt: true },
    });

    if (later.length === 0) return { updated: 0 };

    const startMoved =
      new Date(edited.startAt).getTime() !==
      new Date(previous.startAt).getTime();
    const endMoved =
      new Date(edited.endAt).getTime() !== new Date(previous.endAt).getTime();

    // Nothing about when it happens changed, so every later occurrence takes
    // the same values and one statement does it.
    if (!startMoved && !endMoved) {
      if (Object.keys(fields).length === 0) return { updated: 0 };
      const result = await tx.event.updateMany({
        where: { id: { in: later.map((o: any) => o.id) } },
        data: fields,
      });
      return { updated: result.count };
    }

    const from = new Date(previous.startAt);
    const to = new Date(edited.startAt);
    const dayShift = Math.round(
      (Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()) -
        Date.UTC(
          from.getUTCFullYear(),
          from.getUTCMonth(),
          from.getUTCDate(),
        )) /
        86_400_000,
    );
    const durationMs =
      new Date(edited.endAt).getTime() - new Date(edited.startAt).getTime();

    const shifted = later.map((o: any) => {
      const d = new Date(o.startAt);
      const startAt = new Date(
        Date.UTC(
          d.getUTCFullYear(),
          d.getUTCMonth(),
          d.getUTCDate() + dayShift,
          to.getUTCHours(),
          to.getUTCMinutes(),
          to.getUTCSeconds(),
        ),
      );
      return {
        id: o.id,
        startAt,
        endAt: new Date(startAt.getTime() + durationMs),
      };
    });

    // A shift big enough to reorder the series, or to drag an upcoming meeting
    // back past one that has already happened, is refused rather than applied.
    // It is the one way this request can leave a series incoherent.
    for (let i = 1; i < shifted.length; i++) {
      if (shifted[i].startAt <= shifted[i - 1].startAt) {
        throw new BadRequestException(
          'That change would put the upcoming occurrences out of order. Save this occurrence only, or change the repeat rule instead.',
        );
      }
    }
    if (shifted.length && shifted[0].startAt <= new Date(edited.startAt)) {
      throw new BadRequestException(
        'That change would move a later occurrence before this one. Save this occurrence only, or change the repeat rule instead.',
      );
    }
    if (shifted.some((o) => o.startAt <= now)) {
      throw new BadRequestException(
        'That change would move an upcoming occurrence into the past. Save this occurrence only, or change the repeat rule instead.',
      );
    }

    // Prisma cannot write a different value per row in one updateMany, which is
    // exactly why the old version could not do this at all. Bounded by the
    // occurrence ceiling, so tens of rows at most.
    for (const o of shifted) {
      await tx.event.update({
        where: { id: o.id },
        data: { ...fields, startAt: o.startAt, endAt: o.endAt },
      });
    }

    return { updated: shifted.length };
  }

  // ==========================================================================
  // Shared
  // ==========================================================================

  /** The activity a rule is being set from, with the people to copy. */
  private async loadTemplate(eventId: string, actor: Actor) {
    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: {
        coOrganizers: { select: { userId: true } },
        attendees: {
          select: {
            userId: true,
            externalName: true,
            externalEmail: true,
            lastInvitedAt: true,
          },
        },
        invitedMinistries: { select: { id: true } },
      },
    });

    if (!event) throw new NotFoundException(`Event ${eventId} not found`);

    assertSameMinistry(
      { systemRole: actor.systemRole ?? '', ministryId: actor.ministryId },
      event.ministryId,
    );
    assertCanEditEvent(event, actor.id, actor.systemRole);

    return event;
  }

  private ruleData(dto: CreateEventSeriesDto) {
    return {
      frequency: dto.frequency,
      interval: dto.interval || 1,
      endType: dto.endType,
      count: dto.endType === 'COUNT' ? dto.count : null,
      until: dto.endType === 'UNTIL' && dto.until ? new Date(dto.until) : null,
    };
  }

  /** Has anybody checked in to this occurrence, or written it up? */
  private isProtected(occurrence: any, now: Date): boolean {
    return (
      new Date(occurrence.startAt) > now &&
      ((occurrence._count?.attendances ?? 0) > 0 || !!occurrence.minutes)
    );
  }

  /**
   * Which occurrences survive a rebuild and which are replaced.
   *
   * Kept: anything that has already started, anything upcoming that already
   * holds attendance or minutes, and the activity being edited. Every child of
   * Event cascades on delete — Attendance, Minutes, EventAttendee, QRToken —
   * so deleting an occurrence somebody checked into would take the signed
   * record of who was in the room with it, silently.
   */
  private partition(occurrences: any[], actedOnId: string, now: Date) {
    const keep: any[] = [];
    const doomed: any[] = [];

    for (const o of occurrences) {
      const started = new Date(o.startAt) <= now;
      if (started || o.id === actedOnId || this.isProtected(o, now)) {
        keep.push(o);
      } else {
        doomed.push(o);
      }
    }

    return { keep, doomed };
  }

  private async invalidate(ministryId: string) {
    // Never done before, so an activity that had just started repeating did not
    // show up in a cached list until the entry expired on its own.
    await this.cache.invalidatePattern(`events:*${ministryId}*`);
    await this.cache.invalidateAnalytics();
  }
}
