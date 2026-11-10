import { matchesGovDomain } from '../common/utils/gov-domain.util';
import type { StaffCsvRow } from './staff-import.csv';

/**
 * Who on an uploaded staff list belongs on the ministry's roster.
 *
 * Pure, and split in two because the second half needs the database: `screen`
 * applies every rule that can be judged from the file and the ministry alone,
 * and `partition` sorts what survives against the accounts and roster rows
 * that already exist. The service runs the queries in between.
 *
 * The order of the checks in `screen` is deliberate. The domain is checked
 * before anything is looked up, so the "already has an account" answer is only
 * ever given for addresses inside the ministry's own domain — an uploader
 * cannot use this to ask whether an arbitrary address holds an account.
 */

export const MAX_NAME_LENGTH = 100;
export const MAX_EMAIL_LENGTH = 254;

export type SkipReason =
  | 'MISSING_NAME'
  | 'NAME_TOO_LONG'
  | 'INVALID_EMAIL'
  | 'WRONG_DOMAIN'
  | 'DUPLICATE_IN_FILE'
  | 'SUPPORT_ADDRESS'
  | 'HAS_ACCOUNT';

export interface Skipped {
  line: number;
  name: string;
  email: string;
  reason: SkipReason;
}

export interface Candidate {
  line: number;
  firstName: string;
  /** Null, not '', so a reader can tell "no surname" from "surname erased". */
  lastName: string | null;
  /** Lowercased: this is the roster's join key. */
  email: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function displayName(row: { firstName: string; lastName: string | null }) {
  return [row.firstName, row.lastName].filter(Boolean).join(' ');
}

export function screen(
  rows: StaffCsvRow[],
  { domain, supportEmail }: { domain: string; supportEmail: string | null },
): { candidates: Candidate[]; skipped: Skipped[] } {
  const candidates: Candidate[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  const support = supportEmail?.trim().toLowerCase() || null;

  for (const row of rows) {
    const email = row.email.toLowerCase();
    const name = displayName(row);
    const skip = (reason: SkipReason) =>
      skipped.push({ line: row.line, name, email, reason });

    if (!row.firstName) {
      skip('MISSING_NAME');
    } else if (
      row.firstName.length > MAX_NAME_LENGTH ||
      row.lastName.length > MAX_NAME_LENGTH
    ) {
      skip('NAME_TOO_LONG');
    } else if (email.length > MAX_EMAIL_LENGTH || !EMAIL.test(email)) {
      skip('INVALID_EMAIL');
    } else if (!matchesGovDomain(email, domain)) {
      skip('WRONG_DOMAIN');
    } else if (seen.has(email)) {
      // The first occurrence wins, so the line the uploader sees skipped is the
      // repeat, not the original.
      skip('DUPLICATE_IN_FILE');
    } else if (support && email === support) {
      // A shared mailbox is not a person, and would be offered as an attendee.
      seen.add(email);
      skip('SUPPORT_ADDRESS');
    } else {
      seen.add(email);
      candidates.push({
        line: row.line,
        firstName: row.firstName,
        lastName: row.lastName || null,
        email,
      });
    }
  }

  return { candidates, skipped };
}

export interface Existing {
  firstName: string;
  lastName: string | null;
}

export interface Change {
  line: number;
  email: string;
  from: Existing;
  to: Existing;
}

export function partition(
  candidates: Candidate[],
  {
    accountEmails,
    existing,
  }: {
    /** Lowercased addresses of live accounts, in any ministry. */
    accountEmails: Set<string>;
    /** This ministry's roster rows for the candidates, keyed by email. */
    existing: Map<string, Existing>;
  },
): {
  added: Candidate[];
  updated: Change[];
  unchanged: Candidate[];
  skipped: Skipped[];
  /** Rows to write: everything added, plus the new names of everything updated. */
  writes: Candidate[];
} {
  const added: Candidate[] = [];
  const updated: Change[] = [];
  const unchanged: Candidate[] = [];
  const skipped: Skipped[] = [];
  const writes: Candidate[] = [];

  for (const c of candidates) {
    if (accountEmails.has(c.email)) {
      // Already onboarded. The picker hides a roster row with an account's
      // address anyway; adding one would only be a row nobody can see.
      skipped.push({
        line: c.line,
        name: displayName(c),
        email: c.email,
        reason: 'HAS_ACCOUNT',
      });
      continue;
    }

    const before = existing.get(c.email);
    if (!before) {
      added.push(c);
      writes.push(c);
      continue;
    }

    // A blank surname in the file keeps the stored one: an upload adds and
    // corrects, it never removes.
    const after: Existing = {
      firstName: c.firstName,
      lastName: c.lastName ?? before.lastName,
    };
    if (
      after.firstName === before.firstName &&
      after.lastName === before.lastName
    ) {
      unchanged.push(c);
    } else {
      updated.push({ line: c.line, email: c.email, from: before, to: after });
      writes.push(c);
    }
  }

  return { added, updated, unchanged, skipped, writes };
}
