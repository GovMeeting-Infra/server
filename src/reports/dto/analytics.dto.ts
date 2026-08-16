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

export class UserStatsDto {
  totalUsers: number;
  activeUsers: number;
  usersByRole: Array<{ role: string; count: number }>;
  averageLoginFrequency: number;
}

export class ActionItemStatsDto {
  total: number;
  completed: number;
  inProgress: number;
  todo: number;
  /** Past their due date and not yet completed or cancelled. */
  overdue: number;
  /** Closed without being done, so excluded from any progress measure. */
  cancelled: number;
}

export class CheckInMethodsDto {
  qr: number;
  manual: number;
  geo: number;
  total: number;
}

export class EventsOverTimeDto {
  /** YYYY-MM, oldest first. */
  month: string;
  count: number;
}

export class AnalyticsDashboardDto {
  eventStats: EventStatsDto;
  attendanceStats: AttendanceStatsDto;
  userStats: UserStatsDto;
  actionItemStats: ActionItemStatsDto;
  checkInMethods: CheckInMethodsDto;
  eventsOverTime: EventsOverTimeDto[];
  /** "All ministries" for super-admins, otherwise the ministry's own scope. */
  scope: 'ministry' | 'all';
  generatedAt: Date;
}
