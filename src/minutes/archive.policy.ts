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

/**
 * Roles permitted to archive or restore by hand.
 *
 * Matches the @Roles() on the archive endpoints. Named here so the capability
 * the API reports and the guard that enforces it read from one list — the web
 * app kept its own copy of this, which is exactly the drift this prevents.
 */
export const ARCHIVE_MANAGER_ROLES = ['MINISTER', 'SUPER_ADMIN'];

export function archiveCutoff(now: Date = new Date()): Date {
  const cutoff = new Date(now);
  cutoff.setMonth(cutoff.getMonth() - ARCHIVE_AFTER_MONTHS);
  return cutoff;
}

export function canReadArchived(systemRole?: string): boolean {
  return ARCHIVE_READER_ROLES.includes(systemRole ?? '');
}
