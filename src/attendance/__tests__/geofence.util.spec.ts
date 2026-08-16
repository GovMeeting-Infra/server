import {
  haversineDistance,
  isWithinRadius,
  classifyFix,
} from '../geofence.util';
import {
  GEOFENCE_RADIUS_METERS,
  CHECKIN_MAX_ACCURACY_METERS,
} from '../geofence.constants';

/** Freetown, Sierra Leone — a plausible ministry venue. */
const ANCHOR_LAT = 8.4657;
const ANCHOR_LNG = -13.2317;

/** Metres per degree of latitude, near enough at any latitude. */
const M_PER_DEG_LAT = 111_320;

function metresNorth(metres: number) {
  return { lat: ANCHOR_LAT + metres / M_PER_DEG_LAT, lng: ANCHOR_LNG };
}

describe('haversineDistance', () => {
  it('is zero at the same point', () => {
    expect(
      haversineDistance(ANCHOR_LAT, ANCHOR_LNG, ANCHOR_LAT, ANCHOR_LNG),
    ).toBeCloseTo(0, 6);
  });

  it('measures a known northward offset', () => {
    const p = metresNorth(50);
    const d = haversineDistance(p.lat, p.lng, ANCHOR_LAT, ANCHOR_LNG);
    expect(d).toBeGreaterThan(49);
    expect(d).toBeLessThan(51);
  });

  it('is symmetric', () => {
    const p = metresNorth(250);
    expect(haversineDistance(p.lat, p.lng, ANCHOR_LAT, ANCHOR_LNG)).toBeCloseTo(
      haversineDistance(ANCHOR_LAT, ANCHOR_LNG, p.lat, p.lng),
      6,
    );
  });

  it('handles the equator/prime-meridian origin rather than treating 0 as absent', () => {
    // Guards the class of bug the old truthiness check had, where an exact 0.0
    // coordinate was indistinguishable from "no coordinate".
    expect(haversineDistance(0, 0, 0, 0)).toBeCloseTo(0, 6);
    expect(haversineDistance(0, 0, 0, 1)).toBeGreaterThan(111_000);
  });
});

describe('isWithinRadius', () => {
  it('accepts a point well inside the fence', () => {
    const p = metresNorth(40);
    expect(
      isWithinRadius(
        p.lat,
        p.lng,
        ANCHOR_LAT,
        ANCHOR_LNG,
        GEOFENCE_RADIUS_METERS,
      ),
    ).toBe(true);
  });

  it('rejects a point well outside the fence', () => {
    const p = metresNorth(500);
    expect(
      isWithinRadius(
        p.lat,
        p.lng,
        ANCHOR_LAT,
        ANCHOR_LNG,
        GEOFENCE_RADIUS_METERS,
      ),
    ).toBe(false);
  });

  it('is inclusive at the boundary', () => {
    expect(
      isWithinRadius(ANCHOR_LAT, ANCHOR_LNG, ANCHOR_LAT, ANCHOR_LNG, 0),
    ).toBe(true);
  });

  it('rejects just outside and accepts just inside', () => {
    const inside = metresNorth(GEOFENCE_RADIUS_METERS - 5);
    const outside = metresNorth(GEOFENCE_RADIUS_METERS + 5);
    expect(
      isWithinRadius(
        inside.lat,
        inside.lng,
        ANCHOR_LAT,
        ANCHOR_LNG,
        GEOFENCE_RADIUS_METERS,
      ),
    ).toBe(true);
    expect(
      isWithinRadius(
        outside.lat,
        outside.lng,
        ANCHOR_LAT,
        ANCHOR_LNG,
        GEOFENCE_RADIUS_METERS,
      ),
    ).toBe(false);
  });
});

describe('classifyFix', () => {
  const classify = (distance: number, accuracy: number) =>
    classifyFix({
      distance,
      accuracy,
      radius: GEOFENCE_RADIUS_METERS,
      ceiling: CHECKIN_MAX_ACCURACY_METERS,
    });

  // A perfect reading behaves exactly as the old plain comparison did.
  it('treats a pinpoint fix as a plain distance test', () => {
    expect(classify(100, 0)).toBe('VERIFIED');
    expect(classify(101, 0)).toBe('OUTSIDE');
  });

  it('verifies only when the whole error disc sits inside', () => {
    expect(classify(60, 40)).toBe('VERIFIED');
    expect(classify(60, 41)).toBe('PLAUSIBLE');
  });

  // The case that was being refused outright: someone indoors, positioned by
  // Wi-Fi, who may well be standing in the room.
  it('accepts an overlapping disc as plausible rather than refusing it', () => {
    expect(classify(150, 60)).toBe('PLAUSIBLE');
  });

  it('still refuses someone who cannot be inside even at their closest', () => {
    expect(classify(150, 49)).toBe('OUTSIDE');
  });

  // The property the constants exist to produce: radius + ceiling is the
  // furthest anyone can stand and still be let in.
  it('caps the reachable distance at radius plus ceiling', () => {
    expect(classify(600, 500)).toBe('PLAUSIBLE');
    expect(classify(601, 500)).toBe('OUTSIDE');
  });

  it('refuses a fix too vague to localise anything, at any distance', () => {
    expect(classify(0, 501)).toBe('TOO_VAGUE');
    expect(classify(5_000, 5_000)).toBe('TOO_VAGUE');
  });
});
