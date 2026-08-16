export class EventStatsDto {
  total: number;
  upcoming: number;
  past: number;
  byType: Array<{ type: string; _count: number }>;
}

export class AttendanceStatsDto {
  totalCheckIns: number;
  /** Invited people who turned up. The numerator behind attendanceRate. */
  invitedWhoCame: number;
  /** Turned up without an invitation, so outside the rate entirely. */
  walkIns: number;
  /** The denominator, so a rate is never shown without the counts behind it. */
  totalInvited: number;
  /** 0–1, and genuinely bounded at 1 now that walk-ins are excluded. */
  attendanceRate: number;
}

/**
 * How much of the attendance record would survive being challenged.
 *
 * The product's distinguishing mechanism, finally measured: a signature drawn
 * on the attendee's own device, and a position checked against the area the
 * organiser anchored.
 */
export class EvidenceStatsDto {
  total: number;
  /** Carries a signature that is neither absent nor erased. */
  signed: number;
  insideArea: number;
  outsideArea: number;
  /** No area anchored, or a fix too vague to judge. A real third state. */
  unverified: number;
  /** Reported an impossible accuracy or an explicit mock-location flag. */
  mockFlagged: number;
}

/** The headline figures for one ministry, for the cross-ministry view. */
export class MinistryBreakdownDto {
  ministryId: string;
  name: string;
  meetings: number;
  checkIns: number;
  invited: number;
  attendanceRate: number;
}

/** One window's worth of figures, for comparing against the one before it. */
export class TrendWindowDto {
  checkIns: number;
  invited: number;
  meetings: number;
  attendanceRate: number;
}

export class TrendDto {
  /** The last 30 days. */
  current: TrendWindowDto;
  /** The 30 days before those. */
  previous: TrendWindowDto;
}

export class UserStatsDto {
  totalUsers: number;
  activeUsers: number;
  usersByRole: Array<{ role: string; count: number }>;
  averageDaysSinceLastLogin: number;
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
  /** Last 30 days against the 30 before, so a total has something to mean against. */
  trend: TrendDto;
  /** Signature capture and geofence outcomes across every check-in. */
  evidence: EvidenceStatsDto;
  /** Present only for a super admin, who is the only role spanning ministries. */
  byMinistry?: MinistryBreakdownDto[];
  /** "All ministries" for super-admins, otherwise the ministry's own scope. */
  scope: 'ministry' | 'all';
  generatedAt: Date;
}
