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
 * the attendee threshold, and it has to be: the anchor is the one reading every
 * later judgement is measured against, so its error is not one person's problem
 * but the whole meeting's. A worse fix than this is refused, both when setting the
 * area and when moving it.
 */
export const ANCHOR_MAX_ACCURACY_METERS = 50;

/**
 * How early before a meeting starts its check-in code can be generated.
 *
 * Generating the code sets the check-in area from wherever the organizer is
 * standing, so a code minted the day before — from the office, for a meeting
 * across town — fences the wrong building. Each day of a series is its own
 * meeting with its own area; this keeps each one being set at its venue, on
 * the day, while leaving room to set up before people arrive.
 */
export const CODE_OPENS_BEFORE_START_MINUTES = 120;

/**
 * Worst fix we accept from an attendee before refusing to judge at all.
 *
 * This was 100m, which read as "as precise as the fence" and sounded sensible.
 * In practice it refused most indoor check-ins: a phone that cannot see the sky
 * positions itself from Wi-Fi and cell towers and reports 50-500m, so people
 * standing in the room were told their signal was insufficient.
 *
 * With classifyFix weighing accuracy against distance, a ceiling is no longer
 * the gate — but one is still needed, because without it a client declaring
 * `accuracy: 5000` overlaps the fence from five kilometres away, and declaring
 * a large error becomes the way through. 500m still places someone within about
 * a city block: it admits the Wi-Fi fixes that were being refused and rejects
 * the IP-derived ones, which run to tens of kilometres.
 *
 * The number that actually bounds the system is the sum: the furthest anyone
 * can stand and still be accepted is GEOFENCE_RADIUS_METERS + this = 600m.
 */
export const CHECKIN_MAX_ACCURACY_METERS = 500;

/**
 * Why a check-in was refused, for a client that has to explain it to someone
 * holding a phone. The message alone is not enough — matching on prose breaks
 * the moment the wording improves.
 */
export const GEO_ERROR = {
  LOCATION_REQUIRED: 'LOCATION_REQUIRED',
  ACCURACY_TOO_LOW: 'ACCURACY_TOO_LOW',
  OUTSIDE_AREA: 'OUTSIDE_AREA',
} as const;
