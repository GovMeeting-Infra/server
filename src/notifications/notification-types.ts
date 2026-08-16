/**
 * The kinds of notification the platform raises.
 *
 * These are no longer gated by preference — notifyMany stopped consulting
 * PREFERENCE_FOR when the Settings toggles were removed, and the table below
 * now only serves wantsEmail. The type is what the inbox sorts, filters and
 * icons by, so it has to describe the message honestly: a cancellation was
 * filed as MEETING_INVITATION for a while, which meant any filter by kind
 * would have offered someone a cancelled meeting under "invitations".
 */
export type NotificationType =
  | 'MINUTES_PUBLISHED'
  | 'ACTION_ITEM_ASSIGNED'
  | 'ACTION_ITEM_STATUS_CHANGED'
  | 'ACTION_ITEM_DUE_SOON'
  | 'ACTION_ITEM_WEEKLY_DIGEST'
  | 'MEETING_INVITATION'
  | 'MEETING_CHANGED'
  | 'MEETING_CANCELLED'
  | 'MEETING_REMINDER';

/** Category toggles on UserPreferences. */
export type PreferenceKey =
  'minutesNotifications' | 'actionItemNotifications' | 'meetingReminders';

export const PREFERENCE_FOR: Record<NotificationType, PreferenceKey> = {
  MINUTES_PUBLISHED: 'minutesNotifications',
  ACTION_ITEM_ASSIGNED: 'actionItemNotifications',
  ACTION_ITEM_STATUS_CHANGED: 'actionItemNotifications',
  // Both reuse the existing category rather than adding toggles: a new
  // preference flag would mean a schema migration, a DTO change, a wider
  // select in preferencesFor, and another switch in Settings — for a
  // distinction nobody asked to control separately.
  ACTION_ITEM_DUE_SOON: 'actionItemNotifications',
  ACTION_ITEM_WEEKLY_DIGEST: 'actionItemNotifications',
  MEETING_INVITATION: 'meetingReminders',
  MEETING_CHANGED: 'meetingReminders',
  MEETING_CANCELLED: 'meetingReminders',
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
