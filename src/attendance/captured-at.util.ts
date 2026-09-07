/**
 * Deciding what time an offline check-in actually happened.
 *
 * The device says. The device may be wrong — the stated failure mode includes
 * power cuts, which is precisely what resets the real-time clock on the kind of
 * cheap tablet a ministry props at a door. A row stamped with a clock that came
 * back up in 1970, or a year ahead, is worse than useless in an attendance
 * record that may later be used to settle who was present.
 *
 * So the time is clamped rather than rejected. Refusing the record would delete
 * someone who was in the room and signed for it, hours after they left and with
 * no way to put it right; moving their time to the edge of the meeting keeps the
 * attendance and loses only precision that was never real.
 */

/** How early someone may plausibly have signed in. People arrive before the hour. */
const EARLY_GRACE_MS = 2 * 60 * 60 * 1000;

/** How late. Meetings overrun, and a register is sometimes finished afterwards. */
const LATE_GRACE_MS = 6 * 60 * 60 * 1000;

export type ClampReason = 'IN_RANGE' | 'CLAMPED_EARLY' | 'CLAMPED_LATE' | 'UNPARSEABLE';

export interface ClampedTime {
  /** What goes in checkInAt. Always inside the meeting's plausible window. */
  checkInAt: Date;
  /** What the device claimed, kept for anyone examining a disputed record. */
  capturedAt: Date | null;
  reason: ClampReason;
}

export function clampCapturedAt(
  rawCapturedAt: string | undefined,
  event: { startAt: Date; endAt: Date },
  syncedAt: Date,
): ClampedTime {
  const claimed = rawCapturedAt ? new Date(rawCapturedAt) : null;

  if (!claimed || Number.isNaN(claimed.getTime())) {
    // No usable claim. Sync time is the only honest answer left, and the flag
    // on the row says not to read it as an arrival time.
    return { checkInAt: syncedAt, capturedAt: null, reason: 'UNPARSEABLE' };
  }

  const earliest = new Date(event.startAt.getTime() - EARLY_GRACE_MS);
  /*
   * Never later than now. A device whose clock runs fast would otherwise
   * record an arrival in the future, and a report run this afternoon would
   * show attendance for a meeting that has not happened.
   */
  const latest = new Date(
    Math.min(syncedAt.getTime(), event.endAt.getTime() + LATE_GRACE_MS),
  );

  if (claimed < earliest) {
    return { checkInAt: earliest, capturedAt: claimed, reason: 'CLAMPED_EARLY' };
  }
  if (claimed > latest) {
    return { checkInAt: latest, capturedAt: claimed, reason: 'CLAMPED_LATE' };
  }

  return { checkInAt: claimed, capturedAt: claimed, reason: 'IN_RANGE' };
}

/**
 * A device's clock error, in seconds, guaranteed to fit the column.
 *
 * The obvious version of this stored milliseconds and was wrong in the one case
 * that matters: a tablet whose clock reset to 1970 is out by about 1.79
 * trillion milliseconds, which does not fit a 4-byte integer, so the write
 * failed and the attendee was reported as rejected. The device this column
 * exists to describe was the only one it could not describe.
 *
 * Clamped as well as converted. The value is a measurement from an unreliable
 * source, and nothing about an attendance record should be able to fail because
 * a number arrived larger than expected.
 */
const MAX_SKEW_SECONDS = 2_000_000_000;

export function toSkewSeconds(skewMs: number | undefined): number | null {
  if (skewMs === undefined || skewMs === null || !Number.isFinite(skewMs)) {
    return null;
  }
  const seconds = Math.round(skewMs / 1000);
  return Math.max(-MAX_SKEW_SECONDS, Math.min(MAX_SKEW_SECONDS, seconds));
}
