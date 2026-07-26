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
