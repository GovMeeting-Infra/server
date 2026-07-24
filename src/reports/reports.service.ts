import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CacheService } from '../cache/cache.service';
import {
  EventStatsDto,
  AttendanceStatsDto,
  RoomStatsDto,
  UserStatsDto,
  AnalyticsDashboardDto
} from './dto/analytics.dto';

@Injectable()
export class ReportsService {
  private logger = new Logger('ReportsService');

  constructor(
    private prisma: PrismaService,
    private cache: CacheService,
  ) {}

  async getAnalyticsDashboard(ministryId: string): Promise<AnalyticsDashboardDto> {
    const cacheKey = `reports:analytics:${ministryId}`;
    let data = await this.cache.get(cacheKey);

    if (data) {
      return data as AnalyticsDashboardDto;
    }

    data = {
      eventStats: await this.getEventStats(ministryId),
      attendanceStats: await this.getAttendanceStats(ministryId),
      roomStats: await this.getRoomStats(ministryId),
      userStats: await this.getUserStats(ministryId),
      generatedAt: new Date(),
    };

    await this.cache.set(cacheKey, data, 3600);
    return data as AnalyticsDashboardDto;
  }

  private async getEventStats(ministryId: string): Promise<EventStatsDto> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [total, upcoming, past, byType] = await Promise.all([
      (this.prisma as any).event.count({ where: { ministryId } }),
      (this.prisma as any).event.count({ where: { ministryId, startAt: { gt: now } } }),
      (this.prisma as any).event.count({ where: { ministryId, endAt: { lt: now } } }),
      (this.prisma as any).event.groupBy({
        by: ['type'],
        where: { ministryId, createdAt: { gte: thirtyDaysAgo } },
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

  private async getAttendanceStats(ministryId: string): Promise<AttendanceStatsDto> {
    const events = await (this.prisma as any).event.findMany({
      where: { ministryId },
      include: {
        _count: { select: { attendees: true, attendances: true } }
      },
      take: 50,
    });

    const totalCheckIns = events.reduce((sum: number, e: any) => sum + e._count.attendances, 0);

    let attendanceRate = 0;
    if (events.length > 0) {
      const sumRates = events.reduce((sum: number, e: any) => {
        if (e._count.attendees === 0) return sum;
        return sum + (e._count.attendances / e._count.attendees);
      }, 0);
      attendanceRate = sumRates / events.length;
    }

    return {
      totalCheckIns,
      attendanceRate: parseFloat(attendanceRate.toFixed(2)),
    };
  }

  private async getRoomStats(ministryId: string): Promise<RoomStatsDto> {
    const now = new Date();
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [totalRooms, activeRooms, bookingsThisMonth, allRoomBookings] = await Promise.all([
      (this.prisma as any).room.count({ where: { ministryId } }),
      (this.prisma as any).room.count({ where: { ministryId, active: true } }),
      (this.prisma as any).roomBooking.count({
        where: {
          ministryId,
          createdAt: { gte: monthAgo },
          status: 'CONFIRMED',
        },
      }),
      (this.prisma as any).roomBooking.findMany({
        where: { ministryId, status: 'CONFIRMED' },
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

  private async getUserStats(ministryId: string): Promise<UserStatsDto> {
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const [totalUsers, activeUsers, usersByRole, userLoginData] = await Promise.all([
      (this.prisma as any).user.count({ where: { ministryId } }),
      (this.prisma as any).user.count({
        where: {
          ministryId,
          active: true,
          lastLoginAt: { gte: thirtyDaysAgo },
        },
      }),
      (this.prisma as any).user.groupBy({
        by: ['systemRole'],
        where: { ministryId },
        _count: true,
      }),
      (this.prisma as any).user.findMany({
        where: { ministryId, lastLoginAt: { not: null } },
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

  async exportToCSV(ministryId: string): Promise<string> {
    const events = await (this.prisma as any).event.findMany({
      where: { ministryId },
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

    return csvRows.map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');
  }

  async exportAttendanceToCSV(ministryId: string): Promise<string> {
    const attendances = await (this.prisma as any).attendance.findMany({
      where: {
        event: { ministryId },
      },
      include: {
        user: { select: { id: true, name: true, email: true } },
        event: { select: { id: true, title: true, startAt: true } },
      },
      orderBy: { checkInAt: 'desc' },
    });

    const csvRows: string[][] = [
      ['Event', 'Date', 'User', 'Email', 'Checked In At', 'Geofence Verified'],
    ];

    for (const attendance of attendances) {
      csvRows.push([
        attendance.event.title,
        attendance.event.startAt.toISOString().split('T')[0],
        attendance.user.name,
        attendance.user.email,
        attendance.checkInAt.toISOString(),
        attendance.withinGeofence ? 'Yes' : 'No',
      ]);
    }

    return csvRows.map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');
  }

  async exportActionItemsToCSV(ministryId: string): Promise<string> {
    const actionItems = await (this.prisma as any).actionItem.findMany({
      where: {
        minutes: {
          event: { ministryId },
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

    return csvRows.map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n');
  }
}
