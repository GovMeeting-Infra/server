/**
 * The kinds of notification the platform raises, and which Settings toggle
 * governs each.
 *
 * Keeping the mapping in one table is what makes the preference gating
 * trustworthy: every producer goes through it, so a toggle cannot quietly stop
 * applying to one path.
 */
export type NotificationType =
  | 'MINUTES_PUBLISHED'
  | 'ACTION_ITEM_ASSIGNED'
  | 'ACTION_ITEM_STATUS_CHANGED'
  | 'MEETING_INVITATION'
  | 'MEETING_REMINDER';

/** Category toggles on UserPreferences. */
export type PreferenceKey =
  'minutesNotifications' | 'actionItemNotifications' | 'meetingReminders';

export const PREFERENCE_FOR: Record<NotificationType, PreferenceKey> = {
  MINUTES_PUBLISHED: 'minutesNotifications',
  ACTION_ITEM_ASSIGNED: 'actionItemNotifications',
  ACTION_ITEM_STATUS_CHANGED: 'actionItemNotifications',
  MEETING_INVITATION: 'meetingReminders',
  MEETING_REMINDER: 'meetingReminders',
};

export interface NotificationPreferences {
  emailNotifications: boolean;
  minutesNotifications: boolean;
  actionItemNotifications: boolean;
  meetingReminders: boolean;
}

/**
 * Used when a user has no UserPreferences row. Mirrors the schema defaults,
 * which are all true — a missing row must not silently mute someone.
 *
 * Deliberately not `as const`: these are runtime defaults that get compared
 * against real, mutable values, and literal-narrowing them makes those
 * comparisons look impossible to the compiler.
 */
export const DEFAULT_PREFERENCES: NotificationPreferences = {
  emailNotifications: true,
  minutesNotifications: true,
  actionItemNotifications: true,
  meetingReminders: true,
};
