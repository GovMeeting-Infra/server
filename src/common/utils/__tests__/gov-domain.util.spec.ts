import { matchesGovDomain } from '../gov-domain.util';

/**
 * Shared between sign-in and account creation, which is the point: an account
 * created outside this rule is one nobody could ever sign into.
 */
describe('matchesGovDomain', () => {
  it.each(['.gov.sl', 'gov.sl'])(
    'accepts a suffix written as %s',
    (configured) => {
      expect(matchesGovDomain('a@moh.gov.sl', configured)).toBe(true);
      expect(matchesGovDomain('a@gov.sl', configured)).toBe(true);
    },
  );

  it('refuses a lookalike that merely ends with the suffix', () => {
    // The bug this exists to prevent: a plain endsWith let evilgov.sl through
    // when the suffix was configured without its leading dot.
    expect(matchesGovDomain('a@evilgov.sl', 'gov.sl')).toBe(false);
    expect(matchesGovDomain('a@notmoh.gov.sl.example.com', 'gov.sl')).toBe(
      false,
    );
  });

  it('is case-insensitive on the address', () => {
    expect(matchesGovDomain('A@MOCTI.GOV.SL', '.gov.sl')).toBe(true);
  });

  it('refuses anything that is not an address, and an unset suffix', () => {
    expect(matchesGovDomain('not-an-address', '.gov.sl')).toBe(false);
    expect(matchesGovDomain('a@moh.gov.sl', '')).toBe(false);
  });
});
