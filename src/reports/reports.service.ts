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
  RoomStatsDto,
  UserStatsDto,
  ActionItemStatsDto,
  CheckInMethodsDto,
  EventsOverTimeDto,
  AnalyticsDashboardDto
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
      roomStats,
      userStats,
      actionItemStats,
      checkInMethods,
      eventsOverTime,
    ] = await Promise.all([
      this.getEventStats(scope),
      this.getAttendanceStats(scope),
      this.getRoomStats(scope),
      this.getUserStats(scope),
      this.getActionItemStats(scope),
      this.getCheckInMethods(scope),
      this.getEventsOverTime(scope),
    ]);

    const data: AnalyticsDashboardDto = {
      eventStats,
      attendanceStats,
      roomStats,
      userStats,
      actionItemStats,
      checkInMethods,
      eventsOverTime,
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

    const [total, completed, inProgress, todo, overdue] = await Promise.all([
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
    ]);

    return { total, completed, inProgress, todo, overdue };
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

  private async getEventStats(scope: Record<string, unknown>): Promise<EventStatsDto> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [total, upcoming, past, byType] = await Promise.all([
      (this.prisma as any).event.count({ where: { ...scope } }),
      (this.prisma as any).event.count({ where: { ...scope, startAt: { gt: now } } }),
      (this.prisma as any).event.count({ where: { ...scope, endAt: { lt: now } } }),
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

  private async getAttendanceStats(scope: Record<string, unknown>): Promise<AttendanceStatsDto> {
    // This previously read an arbitrary 50 events (take: 50, no orderBy), so
    // the headline rate was computed over a truncated slice. Count across all
    // in-scope records instead.
    const [totalCheckIns, totalInvited] = await Promise.all([
      (this.prisma as any).attendance.count({ where: { event: scope } }),
      (this.prisma as any).eventAttendee.count({ where: { event: scope } }),
    ]);

    // Overall rate: check-ins against invitations, rather than an unweighted
    // mean of per-event rates where a 1-person event counts as much as a 500.
    const attendanceRate =
      totalInvited > 0 ? totalCheckIns / totalInvited : 0;

    return {
      totalCheckIns,
      attendanceRate: parseFloat(attendanceRate.toFixed(2)),
    };
  }

  private async getRoomStats(scope: Record<string, unknown>): Promise<RoomStatsDto> {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [totalRooms, activeRooms, bookingsThisMonth, allRoomBookings] = await Promise.all([
      (this.prisma as any).room.count({ where: { ...scope } }),
      (this.prisma as any).room.count({ where: { ...scope, active: true } }),
      (this.prisma as any).roomBooking.count({
        where: {
          ...scope,
          createdAt: { gte: monthAgo },
          status: 'CONFIRMED',
        },
      }),
      (this.prisma as any).roomBooking.findMany({
        where: { ...scope, status: 'CONFIRMED' },
        select: { startTime: true, endTime: true },
      }),
    ]);

    let averageUtilization = 0;
    if (allRoomBookings.length > 0) {
      const totalHours = allRoomBookings.reduce((sum: number, booking: any) => {
        const hours = (booking.endTime.getTime() - booking.startTime.getTime()) / (1000 * 60 * 60);
        return sum + hours;
      }, 0);
      averageUtilization = parseFloat(
        (totalHours / (activeRooms * 24 * 30)).toFixed(2),
      );
    }

    return {
      totalRooms,
      activeRooms,
      bookingsThisMonth,
      averageUtilization: Math.min(averageUtilization, 1),
    };
  }

  private async getUserStats(scope: Record<string, unknown>): Promise<UserStatsDto> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [totalUsers, activeUsers, usersByRole, userLoginData] = await Promise.all([
      (this.prisma as any).user.count({ where: { ...scope } }),
      (this.prisma as any).user.count({
        where: {
          ...scope,
          active: true,
          lastLoginAt: { gte: thirtyDaysAgo },
        },
      }),
      (this.prisma as any).user.groupBy({
        by: ['systemRole'],
        where: { ...scope },
        _count: true,
      }),
      (this.prisma as any).user.findMany({
        where: { ...scope, lastLoginAt: { not: null } },
        select: { lastLoginAt: true },
      }),
    ]);

    let averageLoginFrequency = 0;
    if (userLoginData.length > 0) {
      const totalDaysSinceLastLogin = userLoginData.reduce((sum: number, user: any) => {
        if (user.lastLoginAt) {
          const days = (now.getTime() - user.lastLoginAt.getTime()) / (1000 * 60 * 60 * 24);
          return sum + days;
        }
        return sum;
      }, 0);
      averageLoginFrequency = parseFloat(
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
      averageLoginFrequency,
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
      ['Event', 'Date', 'Type', 'Attendees Invited', 'CheckIns', 'Attendance Rate (%)'],
    ];

    for (const event of events) {
      const invitedCount = event.attendees.length;
      const checkInCount = event.attendances.length;
      const rate = invitedCount > 0 ? ((checkInCount / invitedCount) * 100).toFixed(1) : '0';

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
      ['Event', 'Date', 'User', 'Email', 'Checked In At', 'Geofence Verified', 'Walk-in'],
    ];

    for (const attendance of attendances) {
      csvRows.push([
        attendance.event.title,
        attendance.event.startAt.toISOString().split('T')[0],
        // Guests have no linked user, so fall back to what they signed with.
        attendance.user?.name ?? attendance.guestName ?? attendance.signedName,
        attendance.user?.email ?? attendance.guestEmail ?? '',
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
      ['Event', 'Title', 'Owner', 'Due Date', 'Status', 'Created At', 'Completed At'],
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
