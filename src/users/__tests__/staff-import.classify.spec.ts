import { partition, screen } from '../staff-import.classify';
import type { StaffCsvRow } from '../staff-import.csv';

const DOMAIN = 'mof.gov.sl';

let line = 1;
const row = (
  firstName: string,
  lastName: string,
  email: string,
): StaffCsvRow => ({
  line: ++line,
  firstName,
  lastName,
  email,
});

beforeEach(() => {
  line = 1;
});

describe('screen', () => {
  it('lowercases addresses and turns a blank surname into null', () => {
    const { candidates, skipped } = screen(
      [row('Aminata', '', 'A.Koroma@MOF.gov.sl')],
      {
        domain: DOMAIN,
        supportEmail: null,
      },
    );
    expect(skipped).toEqual([]);
    expect(candidates).toEqual([
      {
        line: 2,
        firstName: 'Aminata',
        lastName: null,
        email: 'a.koroma@mof.gov.sl',
      },
    ]);
  });

  it('gives each rejected row exactly one reason, in order', () => {
    const { candidates, skipped } = screen(
      [
        row('', 'Koroma', 'a@mof.gov.sl'),
        row('X'.repeat(101), 'Koroma', 'b@mof.gov.sl'),
        row('Ok', 'Y'.repeat(101), 'c@mof.gov.sl'),
        row('Ibrahim', 'Sesay', 'not-an-address'),
        row('Ibrahim', 'Sesay', 'i.sesay@gmail.com'),
        row('Fatmata', 'Bangura', 'f.bangura@mof.gov.sl'),
        row('Fatmata', 'B.', 'F.Bangura@mof.gov.sl'),
        row('Help', 'Desk', 'support@mof.gov.sl'),
      ],
      { domain: DOMAIN, supportEmail: ' Support@mof.gov.sl ' },
    );

    expect(skipped.map((s) => [s.line, s.reason])).toEqual([
      [2, 'MISSING_NAME'],
      [3, 'NAME_TOO_LONG'],
      [4, 'NAME_TOO_LONG'],
      [5, 'INVALID_EMAIL'],
      [6, 'WRONG_DOMAIN'],
      // The first occurrence wins; the repeat is the one reported.
      [8, 'DUPLICATE_IN_FILE'],
      [9, 'SUPPORT_ADDRESS'],
    ]);
    expect(candidates.map((c) => c.email)).toEqual(['f.bangura@mof.gov.sl']);
  });

  it('accepts subdomains but not look-alike domains', () => {
    const { candidates, skipped } = screen(
      [row('A', 'B', 'a@hr.mof.gov.sl'), row('C', 'D', 'c@evilmof.gov.sl')],
      { domain: DOMAIN, supportEmail: null },
    );
    expect(candidates.map((c) => c.email)).toEqual(['a@hr.mof.gov.sl']);
    expect(skipped[0].reason).toBe('WRONG_DOMAIN');
  });

  it('checks the domain before an address can reach the account lookup', () => {
    // An off-domain address is WRONG_DOMAIN, never a candidate, so whether it
    // holds an account is never asked and never answered.
    const { candidates } = screen([row('A', 'B', 'someone@other.gov.sl')], {
      domain: DOMAIN,
      supportEmail: null,
    });
    expect(candidates).toEqual([]);
  });
});

describe('partition', () => {
  const candidate = (
    email: string,
    firstName = 'A',
    lastName: string | null = 'B',
  ) => ({
    line: 2,
    firstName,
    lastName,
    email,
  });

  it('sorts candidates into added, updated, unchanged and has-an-account', () => {
    const result = partition(
      [
        candidate('new@mof.gov.sl'),
        candidate('renamed@mof.gov.sl', 'Abu'),
        candidate('same@mof.gov.sl'),
        candidate('onboarded@mof.gov.sl'),
      ],
      {
        accountEmails: new Set(['onboarded@mof.gov.sl']),
        existing: new Map([
          ['renamed@mof.gov.sl', { firstName: 'Abubakarr', lastName: 'B' }],
          ['same@mof.gov.sl', { firstName: 'A', lastName: 'B' }],
        ]),
      },
    );

    expect(result.added.map((c) => c.email)).toEqual(['new@mof.gov.sl']);
    expect(result.updated).toEqual([
      {
        line: 2,
        email: 'renamed@mof.gov.sl',
        from: { firstName: 'Abubakarr', lastName: 'B' },
        to: { firstName: 'Abu', lastName: 'B' },
      },
    ]);
    expect(result.unchanged.map((c) => c.email)).toEqual(['same@mof.gov.sl']);
    expect(result.skipped.map((s) => s.reason)).toEqual(['HAS_ACCOUNT']);
    expect(result.writes.map((c) => c.email)).toEqual([
      'new@mof.gov.sl',
      'renamed@mof.gov.sl',
    ]);
  });

  it('keeps a stored surname when the file leaves it blank', () => {
    const result = partition([candidate('a@mof.gov.sl', 'A', null)], {
      accountEmails: new Set(),
      existing: new Map([
        ['a@mof.gov.sl', { firstName: 'A', lastName: 'Kamara' }],
      ]),
    });
    expect(result.unchanged).toHaveLength(1);
    expect(result.writes).toEqual([]);
  });

  it('fills in a surname the roster did not have', () => {
    const result = partition([candidate('a@mof.gov.sl', 'A', 'Kamara')], {
      accountEmails: new Set(),
      existing: new Map([['a@mof.gov.sl', { firstName: 'A', lastName: null }]]),
    });
    expect(result.updated[0].to.lastName).toBe('Kamara');
  });
});
