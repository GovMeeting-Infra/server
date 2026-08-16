/**
 * Pure geodesic helpers, deliberately free of Nest DI so both the
 * code-generation path and the check-in path share one implementation and it
 * can be unit-tested without constructing CheckinService (which needs
 * DATA_ENCRYPTION_KEY).
 */

const EARTH_RADIUS_METERS = 6371000;

function toRad(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle distance in metres. */
export function haversineDistance(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) *
      Math.sin(dLng / 2);

  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_METERS * c;
}

export function isWithinRadius(
  lat: number,
  lng: number,
  anchorLat: number,
  anchorLng: number,
  radiusMeters: number,
): boolean {
  return haversineDistance(lat, lng, anchorLat, anchorLng) <= radiusMeters;
}

export type FenceVerdict = 'VERIFIED' | 'PLAUSIBLE' | 'OUTSIDE' | 'TOO_VAGUE';

/**
 * Where a fix sits relative to the check-in area.
 *
 * A position is a disc, not a point: the browser reports a centre and the
 * radius it is confident within. Treating accuracy as a gate before the
 * distance — reject anything vaguer than the fence itself — threw away every
 * indoor check-in, because a phone with no view of the sky falls back to
 * Wi-Fi and cell towers and reports 50-500m as a matter of course. The person
 * was standing in the room; the maths simply refused to look.
 *
 * So compare the two discs instead. Disjoint means outside beyond doubt.
 * Contained means inside beyond doubt. Overlapping means the reading cannot
 * settle it, which is a third answer and not a refusal.
 */
export function classifyFix({
  distance,
  accuracy,
  radius,
  ceiling,
}: {
  /** Metres from the anchor. */
  distance: number;
  /** Metres of error the browser reports around that position. */
  accuracy: number;
  radius: number;
  /** Beyond this the fix localises nothing and is refused outright. */
  ceiling: number;
}): FenceVerdict {
  if (accuracy > ceiling) return 'TOO_VAGUE';
  if (distance - accuracy > radius) return 'OUTSIDE';
  if (distance + accuracy <= radius) return 'VERIFIED';
  return 'PLAUSIBLE';
}
