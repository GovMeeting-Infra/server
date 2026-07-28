/**
 * Check-in area sizing.
 *
 * The fence is anchored to wherever the organizer stood when they generated the
 * QR code, not to the venue record — venue coordinates were almost never filled
 * in, which is why geofencing never actually engaged.
 */

/** Radius around the anchor an attendee must be inside. Fixed, not per-event. */
export const GEOFENCE_RADIUS_METERS = 100;

/**
 * Tightest fix we accept when *setting* the anchor. Deliberately stricter than
 * the attendee threshold: anchor error and attendee error compound, so a 90m
 * anchor plus a 90m attendee reading would make the 100m fence meaningless.
 * A worse fix than this mints the code ungeofenced rather than anchoring badly.
 */
export const ANCHOR_MAX_ACCURACY_METERS = 50;

/** Worst fix we accept from an attendee before refusing to judge the distance. */
export const CHECKIN_MAX_ACCURACY_METERS = 100;
