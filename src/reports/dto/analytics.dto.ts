export class EventStatsDto {
  total: number;
  upcoming: number;
  past: number;
  byType: Array<{ type: string; _count: number }>;
}

export class AttendanceStatsDto {
  totalCheckIns: number;
  attendanceRate: number;
}

export class RoomStatsDto {
  totalRooms: number;
  activeRooms: number;
  bookingsThisMonth: number;
  averageUtilization: number;
}

export class UserStatsDto {
  totalUsers: number;
  activeUsers: number;
  usersByRole: Array<{ role: string; count: number }>;
  averageLoginFrequency: number;
}

export class AnalyticsDashboardDto {
  eventStats: EventStatsDto;
  attendanceStats: AttendanceStatsDto;
  roomStats: RoomStatsDto;
  userStats: UserStatsDto;
  generatedAt: Date;
}
