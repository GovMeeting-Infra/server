import { clampCapturedAt, toSkewSeconds } from '../captured-at.util';

/**
 * A power cut is the stated outage, and a power cut is what resets the clock on
 * a cheap tablet. These cover what a wrong clock is allowed to claim.
 */
describe('clampCapturedAt', () => {
  const event = {
    startAt: new Date('2026-09-07T09:00:00.000Z'),
    endAt: new Date('2026-09-07T11:00:00.000Z'),
  };
  const syncedAt = new Date('2026-09-07T14:00:00.000Z');

  it('keeps a time that falls inside the meeting', () => {
    const result = clampCapturedAt('2026-09-07T09:05:00.000Z', event, syncedAt);
    expect(result.reason).toBe('IN_RANGE');
    expect(result.checkInAt.toISOString()).toBe('2026-09-07T09:05:00.000Z');
  });

  it('allows arriving before the meeting starts', () => {
    // People turn up early. An hour before is ordinary, not suspicious.
    const result = clampCapturedAt('2026-09-07T08:15:00.000Z', event, syncedAt);
    expect(result.reason).toBe('IN_RANGE');
  });

  it('pulls a clock stuck in the past up to the earliest plausible time', () => {
    // The tablet came back from a power cut believing it was 1970.
    const result = clampCapturedAt('1970-01-01T00:00:00.000Z', event, syncedAt);
    expect(result.reason).toBe('CLAMPED_EARLY');
    expect(result.checkInAt.toISOString()).toBe('2026-09-07T07:00:00.000Z');
    // The claim is kept, so a disputed record can be examined.
    expect(result.capturedAt?.toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });

  it('never records an arrival in the future', () => {
    // A clock running fast would otherwise put attendance in a meeting that has
    // not happened, and a report run this afternoon would show it.
    const result = clampCapturedAt('2027-01-01T00:00:00.000Z', event, syncedAt);
    expect(result.reason).toBe('CLAMPED_LATE');
    expect(result.checkInAt.getTime()).toBeLessThanOrEqual(syncedAt.getTime());
  });

  it('clamps to the end of the meeting rather than to sync time when that is sooner', () => {
    // Synced days later: the latest anyone could have signed is the meeting's
    // own window, not whenever the connection happened to return.
    const late = new Date('2026-09-10T00:00:00.000Z');
    const result = clampCapturedAt('2026-09-09T00:00:00.000Z', event, late);
    expect(result.checkInAt.toISOString()).toBe('2026-09-07T17:00:00.000Z');
  });

  it('falls back to sync time when the device sent nothing usable', () => {
    const result = clampCapturedAt('not a date', event, syncedAt);
    expect(result.reason).toBe('UNPARSEABLE');
    expect(result.checkInAt).toBe(syncedAt);
    expect(result.capturedAt).toBeNull();
  });

  it('never refuses a record', () => {
    // The rule that matters: someone who was in the room and signed is not
    // deleted hours later because their device disagreed about the date.
    for (const claim of ['1970-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z', 'rubbish']) {
      expect(() => clampCapturedAt(claim, event, syncedAt)).not.toThrow();
    }
  });
});

/**
 * Found against a real database rather than a mock: the millisecond version of
 * this overflowed a 4-byte integer for exactly the device it was written for.
 */
describe('toSkewSeconds', () => {
  it('fits a clock reset to 1970, which milliseconds did not', () => {
    // ~1.79e12 ms is far past a 4-byte integer; in seconds it is ~1.79e9.
    const skew = toSkewSeconds(-1_788_000_000_000);
    expect(skew).toBe(-1_788_000_000);
    expect(Math.abs(skew!)).toBeLessThan(2_147_483_647);
  });

  it('clamps anything wilder still, rather than failing the write', () => {
    // An attendance record must not be lost because a number was bigger than
    // expected.
    expect(toSkewSeconds(9e18)).toBe(2_000_000_000);
    expect(toSkewSeconds(-9e18)).toBe(-2_000_000_000);
  });

  it('keeps an ordinary few seconds of drift', () => {
    expect(toSkewSeconds(4200)).toBe(4);
  });

  it('treats a missing or nonsensical value as unknown', () => {
    expect(toSkewSeconds(undefined)).toBeNull();
    expect(toSkewSeconds(NaN)).toBeNull();
    expect(toSkewSeconds(Infinity)).toBeNull();
  });
});
