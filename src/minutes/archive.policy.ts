/**
 * Minutes archiving.
 *
 * Published minutes are archived once the meeting is old enough. Archiving is
 * a records-management act, not a cosmetic flag: an archived record is frozen,
 * drops out of everyday listings, and is readable only by ministry-level
 * leadership.
 */

/** How long after a meeting its minutes are archived. */
export const ARCHIVE_AFTER_MONTHS = 6;

/** Roles permitted to read an archived record. */
export const ARCHIVE_READER_ROLES = ['MINISTER', 'SUPER_ADMIN'];

export function archiveCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - ARCHIVE_AFTER_MONTHS);
  return cutoff;
}

export function canReadArchived(systemRole?: string): boolean {
  return ARCHIVE_READER_ROLES.includes(systemRole ?? '');
}
