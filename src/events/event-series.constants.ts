/**
 * The ceiling on how many occurrences one repeat rule may produce.
 *
 * Two separate things used to share a single `series.count || 52`: the number
 * the organizer asked for, and the guard against a rule that never ends. So a
 * rule with no `count` silently stopped at 52 with nothing said, and a rule of
 * `count: 5000` was accepted and created 4,999 rows inside one request.
 *
 * 200 is roughly four years of weekly meetings, which is further ahead than any
 * ministry schedules, and small enough that generating or rebuilding a whole
 * series stays one bounded transaction.
 */
export const MAX_OCCURRENCES = 200;

/**
 * How many occurrences a rule will actually produce.
 *
 * COUNT means exactly what was asked for, capped. UNTIL and NEVER run to the
 * ceiling and stop there — the caller is told when that happened, so the form
 * can say the series was truncated rather than leaving someone to notice that
 * their "forever" meeting quietly ends.
 */
export function occurrenceLimit(
  endType: string,
  count?: number | null,
): number {
  if (endType === 'COUNT') {
    return Math.min(Math.max(count ?? 1, 1), MAX_OCCURRENCES);
  }
  return MAX_OCCURRENCES;
}
