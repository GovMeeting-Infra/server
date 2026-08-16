import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import { toCsv } from './csv.util';

/**
 * Enough of the caller to scope a query. The exports previously took a bare
 * ministryId, which meant a super-admin — who has none — silently got an empty
 * file, even though their dashboard spans every ministry.
 */
interface ScopedUser {
  systemRole: string;
  ministryId?: string | null;
}
import {
  EventStatsDto,
  AttendanceStatsDto,
  UserStatsDto,
  ActionItemStatsDto,
  CheckInMethodsDto,
  EventsOverTimeDto,
  TrendDto,
  EvidenceStatsDto,
  MinistryBreakdownDto,
  AnalyticsDashboardDto,
} from './dto/analytics.dto';
import { ministryScope } from '../common/utils/ministry-scope.util';

@Injectable()
export class ReportsService {
  private logger = new Logger('ReportsService');

  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  async getAnalyticsDashboard(user: {
    systemRole: string;
    ministryId?: string;
  }): Promise<AnalyticsDashboardDto> {
    const scope = ministryScope(user);
    const isAllMinistries = Object.keys(scope).length === 0;

    // The key must describe the data, not the caller. Keying on the actor's
    // ministry alone would let a super-admin's cross-ministry figures and a
    // ministry admin's own figures collide on one entry and serve each other.
    const cacheKey = `reports:analytics:${isAllMinistries ? 'all' : user.ministryId}`;
    const cached = await this.cache.get(cacheKey);

    if (cached) {
      return cached as AnalyticsDashboardDto;
    }

    const [
      eventStats,
      attendanceStats,
      userStats,
      actionItemStats,
      checkInMethods,
      eventsOverTime,
      trend,
      evidence,
    ] = await Promise.all([
      this.getEventStats(scope),
      this.getAttendanceStats(scope),
      this.getUserStats(scope),
      this.getActionItemStats(scope),
      this.getCheckInMethods(scope),
      this.getEventsOverTime(scope),
      this.getRecentTrend(scope),
      this.getEvidenceStats(scope),
    ]);

    const data: AnalyticsDashboardDto = {
      eventStats,
      attendanceStats,
      userStats,
      actionItemStats,
      checkInMethods,
      eventsOverTime,
      trend,
      evidence,
      // Only a super admin has more than one ministry to compare.
      byMinistry: isAllMinistries ? await this.getByMinistry() : undefined,
      scope: isAllMinistries ? 'all' : 'ministry',
      generatedAt: new Date(),
    };

    await this.cache.set(cacheKey, data, 3600);
    return data;
  }

  /** Completed / in-progress / overdue, scoped via the item's source event. */
  private async getActionItemStats(
    scope: Record<string, unknown>,
  ): Promise<ActionItemStatsDto> {
    // Action items carry no ministry of their own; they inherit it from the
    // event their minutes belong to.
    const where = { minutes: { event: scope } };
    const now = new Date();

    const [total, completed, inProgress, todo, overdue, cancelled] =
      await Promise.all([
        (this.prisma as any).actionItem.count({ where }),
        (this.prisma as any).actionItem.count({
          where: { ...where, status: 'COMPLETED' },
        }),
        (this.prisma as any).actionItem.count({
          where: { ...where, status: 'IN_PROGRESS' },
        }),
        (this.prisma as any).actionItem.count({
          where: { ...where, status: { in: ['TODO', 'BLOCKED'] } },
        }),
        (this.prisma as any).actionItem.count({
          where: {
            ...where,
            dueDate: { lt: now },
            status: { notIn: ['COMPLETED', 'CANCELLED'] },
          },
        }),
        // Counted so a progress bar can say what it leaves out. Without it,
        // todo + inProgress + completed silently fails to reach total.
        (this.prisma as any).actionItem.count({
          where: { ...where, status: 'CANCELLED' },
        }),
      ]);

    return { total, completed, inProgress, todo, overdue, cancelled };
  }

  /** QR vs manual vs geofence, aggregated from the stored checkInMethod. */
  private async getCheckInMethods(
    scope: Record<string, unknown>,
  ): Promise<CheckInMethodsDto> {
    const grouped = await (this.prisma as any).attendance.groupBy({
      by: ['checkInMethod'],
      where: { event: scope },
      _count: { _all: true },
    });

    const counts = new Map<string, number>(
      grouped.map((g: any) => [g.checkInMethod, g._count._all]),
    );

    const qr = counts.get('QR') ?? 0;
    const manual = counts.get('MANUAL') ?? 0;
    const geo = counts.get('GEO') ?? 0;

    return { qr, manual, geo, total: qr + manual + geo };
  }

  /**
   * The last 30 days against the 30 before them.
   *
   * Every headline on the reports page is an all-time total, and a total with
   * nothing to compare it to gets absorbed as identity rather than read as a
   * measurement — "we are an 84% ministry" instead of "we were down six points
   * this month". These are deliberately a separate, explicitly-windowed block
   * rather than a filter on the totals: the totals are genuinely all-time, and
   * the fix for a mislabelled period is not to relabel it again.
   */
  private async getRecentTrend(
    scope: Record<string, unknown>,
  ): Promise<TrendDto> {
    const now = new Date();
    const day = 24 * 60 * 60 * 1000;
    const start = new Date(now.getTime() - 30 * day);
    const priorStart = new Date(now.getTime() - 60 * day);

    const published = { ...scope, status: 'PUBLISHED' };

    const window = async (from: Date, to: Date) => {
      const [checkIns, walkIns, invited, meetings] = await Promise.all([
        (this.prisma as any).attendance.count({
          where: { event: published, checkInAt: { gte: from, lt: to } },
        }),
        (this.prisma as any).attendance.count({
          where: {
            event: published,
            isWalkIn: true,
            checkInAt: { gte: from, lt: to },
          },
        }),
        (this.prisma as any).eventAttendee.count({
          where: { event: { ...published, startAt: { gte: from, lt: to } } },
        }),
        (this.prisma as any).event.count({
          where: { ...published, startAt: { gte: from, lt: to } },
        }),
      ]);
      return {
        checkIns,
        walkIns,
        invited,
        meetings,
        // Walk-ins excluded from the numerator, for the same reason as the
        // headline: they have no invitation for the denominator to hold.
        attendanceRate:
          invited > 0
            ? parseFloat(((checkIns - walkIns) / invited).toFixed(2))
            : 0,
      };
    };

    const [current, previous] = await Promise.all([
      window(start, now),
      window(priorStart, start),
    ]);

    return { current, previous };
  }

  /** Events created per month over the last 12 months, oldest first. */
  private async getEventsOverTime(
    scope: Record<string, unknown>,
  ): Promise<EventsOverTimeDto[]> {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() - 11, 1);

    const events = await (this.prisma as any).event.findMany({
      where: { ...scope, createdAt: { gte: start } },
      select: { createdAt: true },
    });

    // Seed every month so gaps render as zero rather than disappearing.
    const buckets = new Map<string, number>();
    for (let i = 0; i < 12; i++) {
      const d = new Date(start.getFullYear(), start.getMonth() + i, 1);
      buckets.set(
        `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
        0,
      );
    }

    for (const e of events) {
      const d = new Date(e.createdAt);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      if (buckets.has(key)) buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    return [...buckets.entries()].map(([month, count]) => ({ month, count }));
  }

  private async getEventStats(
    scope: Record<string, unknown>,
  ): Promise<EventStatsDto> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [total, upcoming, past, byType] = await Promise.all([
      (this.prisma as any).event.count({ where: { ...scope } }),
      (this.prisma as any).event.count({
        where: { ...scope, startAt: { gt: now } },
      }),
      (this.prisma as any).event.count({
        where: { ...scope, endAt: { lt: now } },
      }),
      (this.prisma as any).event.groupBy({
        by: ['type'],
        where: { ...scope, createdAt: { gte: thirtyDaysAgo } },
        _count: true,
      }),
    ]);

    return {
      total,
      upcoming,
      past,
      byType: byType.map((item: any) => ({
        type: item.type,
        _count: item._count,
      })),
    };
  }

  private async getAttendanceStats(
    scope: Record<string, unknown>,
  ): Promise<AttendanceStatsDto> {
    // This once read an arbitrary 50 events (take: 50, no orderBy), so the
    // headline rate was computed over a truncated slice. It now counts across
    // every in-scope record — and, since this change, published ones only.
    //
    // Neither count filtered on status, so every invitee of a DRAFT list that
    // was never sent, and of every CANCELLED meeting that never happened, sat
    // in the denominator with no check-in that could ever match. The headline
    // rate was structurally depressed by meetings nobody was ever asked to
    // attend, and the page reported it as turnout.
    const published = { ...scope, status: 'PUBLISHED' };

    const [totalCheckIns, walkIns, totalInvited] = await Promise.all([
      (this.prisma as any).attendance.count({ where: { event: published } }),
      (this.prisma as any).attendance.count({
        where: { event: published, isWalkIn: true },
      }),
      (this.prisma as any).eventAttendee.count({ where: { event: published } }),
    ]);

    // Turnout counts invited people who turned up, and nobody else.
    //
    // The numerator used to be every attendance row, walk-ins included — but a
    // walk-in is by definition someone with no invitation, so they were counted
    // by a numerator the denominator could not see. One real meeting with one
    // invitee and one walk-in reported 200% turnout, which is not a rate at all;
    // it is two different populations divided by each other.
    //
    // Excluding walk-ins bounds this at 100%: an invited person has one
    // attendance row at most, enforced by the unique constraint on
    // (eventId, userId). Walk-ins are still reported — separately, as the count
    // they are.
    const invitedWhoCame = totalCheckIns - walkIns;
    const attendanceRate = totalInvited > 0 ? invitedWhoCame / totalInvited : 0;

    return {
      totalCheckIns,
      invitedWhoCame,
      walkIns,
      totalInvited,
      attendanceRate: parseFloat(attendanceRate.toFixed(2)),
    };
  }

  /**
   * How much of the attendance record would survive being challenged.
   *
   * This is the product's distinguishing mechanism — a signature drawn on the
   * attendee's own device, and a position checked against the area the
   * organiser anchored — and none of it reached the reports page. The columns
   * were already stored and already in the CSV export.
   *
   * A null signature means an organiser recorded a walk-in and there was nobody
   * at the device to sign; an empty string means a signature was captured and
   * later erased under GDPR. Both are unsigned for this purpose, and they are
   * deliberately not the same thing anywhere else.
   */
  private async getEvidenceStats(
    scope: Record<string, unknown>,
  ): Promise<EvidenceStatsDto> {
    const published = { ...scope, status: 'PUBLISHED' };
    const where = { event: published };

    const [total, signed, insideArea, outsideArea, mockFlagged] =
      await Promise.all([
        (this.prisma as any).attendance.count({ where }),
        (this.prisma as any).attendance.count({
          where: { ...where, NOT: [{ signature: null }, { signature: '' }] },
        }),
        (this.prisma as any).attendance.count({
          where: { ...where, withinGeofence: true },
        }),
        (this.prisma as any).attendance.count({
          where: { ...where, withinGeofence: false },
        }),
        (this.prisma as any).attendance.count({
          where: { ...where, mockLocationFlag: true },
        }),
      ]);

    return {
      total,
      signed,
      insideArea,
      outsideArea,
      // Neither inside nor outside: no area was anchored, or the fix was too
      // vague to judge. "Unverified" is a real third state, not a failure.
      unverified: total - insideArea - outsideArea,
      mockFlagged,
    };
  }

  /**
   * The same headline figures, one row per ministry.
   *
   * Only a super admin sees this, and it is the single cut that role exists for
   * — the cross-ministry view was one aggregate number, which is the one thing
   * a platform operator can already guess and the one thing they cannot act on.
   */
  private async getByMinistry(): Promise<MinistryBreakdownDto[]> {
    const ministries = await (this.prisma as any).ministry.findMany({
      where: { active: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    return Promise.all(
      ministries.map(async (m: { id: string; name: string }) => {
        const published = { ministryId: m.id, status: 'PUBLISHED' };
        const [meetings, checkIns, walkIns, invited] = await Promise.all([
          (this.prisma as any).event.count({ where: published }),
          (this.prisma as any).attendance.count({
            where: { event: published },
          }),
          (this.prisma as any).attendance.count({
            where: { event: published, isWalkIn: true },
          }),
          (this.prisma as any).eventAttendee.count({
            where: { event: published },
          }),
        ]);
        const invitedWhoCame = checkIns - walkIns;
        return {
          ministryId: m.id,
          name: m.name,
          meetings,
          checkIns,
          invited,
          attendanceRate:
            invited > 0 ? parseFloat((invitedWhoCame / invited).toFixed(2)) : 0,
        };
      }),
    );
  }

  private async getUserStats(
    scope: Record<string, unknown>,
  ): Promise<UserStatsDto> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    // Erasing someone sets deletedAt and anonymises them, but deliberately
    // leaves `active` alone — so every count here was including people whose
    // name is now "Anonymous". A ministry headcount that counts erased staff
    // survives one briefing and fails one audit.
    const present = { ...scope, deletedAt: null };

    const [totalUsers, activeUsers, usersByRole, userLoginData] =
      await Promise.all([
        (this.prisma as any).user.count({ where: present }),
        (this.prisma as any).user.count({
          where: {
            ...present,
            active: true,
            lastLoginAt: { gte: thirtyDaysAgo },
          },
        }),
        (this.prisma as any).user.groupBy({
          by: ['systemRole'],
          where: present,
          _count: true,
        }),
        (this.prisma as any).user.findMany({
          where: { ...present, lastLoginAt: { not: null } },
          select: { lastLoginAt: true },
        }),
      ]);

    let averageDaysSinceLastLogin = 0;
    if (userLoginData.length > 0) {
      const totalDaysSinceLastLogin = userLoginData.reduce(
        (sum: number, user: any) => {
          if (user.lastLoginAt) {
            const days =
              (now.getTime() - user.lastLoginAt.getTime()) /
              (1000 * 60 * 60 * 24);
            return sum + days;
          }
          return sum;
        },
        0,
      );
      averageDaysSinceLastLogin = parseFloat(
        (totalDaysSinceLastLogin / userLoginData.length).toFixed(1),
      );
    }

    return {
      totalUsers,
      activeUsers,
      usersByRole: usersByRole.map((item: any) => ({
        role: item.systemRole,
        count: item._count,
      })),
      averageDaysSinceLastLogin,
    };
  }

  async exportToCSV(user: ScopedUser): Promise<string> {
    const events = await (this.prisma as any).event.findMany({
      where: ministryScope(user),
      include: {
        attendances: true,
        attendees: true,
      },
      orderBy: { startAt: 'desc' },
    });

    const csvRows: string[][] = [
      [
        'Event',
        'Date',
        'Type',
        'Attendees Invited',
        'CheckIns',
        'Attendance Rate (%)',
      ],
    ];

    for (const event of events) {
      const invitedCount = event.attendees.length;
      const checkInCount = event.attendances.length;
      const rate =
        invitedCount > 0
          ? ((checkInCount / invitedCount) * 100).toFixed(1)
          : '0';

      csvRows.push([
        event.title,
        event.startAt.toISOString().split('T')[0],
        event.type || 'GENERAL',
        invitedCount.toString(),
        checkInCount.toString(),
        rate,
      ]);
    }

    return toCsv(csvRows);
  }

  async exportAttendanceToCSV(user: ScopedUser): Promise<string> {
    const attendances = await (this.prisma as any).attendance.findMany({
      where: {
        event: ministryScope(user),
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        event: { select: { id: true, title: true, startAt: true } },
      },
      orderBy: { checkInAt: 'desc' },
    });

    const csvRows: string[][] = [
      [
        'Event',
        'Date',
        'User',
        'Email',
        'Title',
        'Organisation',
        'Phone',
        'Checked In At',
        'Geofence Verified',
        'Walk-in',
      ],
    ];

    for (const attendance of attendances) {
      csvRows.push([
        attendance.event.title,
        attendance.event.startAt.toISOString().split('T')[0],
        // Guests have no linked user, so fall back to what they signed with.
        attendance.user?.name ?? attendance.guestName ?? attendance.signedName,
        attendance.user?.email ?? attendance.guestEmail ?? '',
        // Collected from guests only, so blank for staff and for walk-ins an
        // organizer recorded at the desk.
        attendance.guestTitle ?? '',
        attendance.guestOrganisation ?? '',
        attendance.guestPhone ?? '',
        attendance.checkInAt.toISOString(),
        // null means no check-in area was set, which is not the same as
        // failing the check.
        attendance.withinGeofence === null
          ? 'Not verified'
          : attendance.withinGeofence
            ? 'Yes'
            : 'No',
        attendance.isWalkIn ? 'Yes' : 'No',
      ]);
    }

    return toCsv(csvRows);
  }

  async exportActionItemsToCSV(user: ScopedUser): Promise<string> {
    const actionItems = await (this.prisma as any).actionItem.findMany({
      where: {
        minutes: {
          event: ministryScope(user),
        },
      },
      include: {
        owner: { select: { name: true, email: true } },
        minutes: { include: { event: { select: { title: true } } } },
      },
      orderBy: { dueDate: 'asc' },
    });

    const csvRows: string[][] = [
      [
        'Event',
        'Title',
        'Owner',
        'Due Date',
        'Status',
        'Created At',
        'Completed At',
      ],
    ];

    for (const item of actionItems) {
      csvRows.push([
        item.minutes.event.title,
        item.title,
        item.owner?.name || 'Unassigned',
        item.dueDate.toISOString().split('T')[0],
        item.status,
        item.createdAt.toISOString().split('T')[0],
        item.completedAt?.toISOString().split('T')[0] || '-',
      ]);
    }

    return toCsv(csvRows);
  }
}
