/**
 * Whether an address sits under the platform's government domain.
 *
 * Shared so that creating an account and signing into it agree. They did not
 * have to before, because every account belonged to a ministry and was checked
 * against that ministry's own domain instead — the platform roles have no
 * ministry, so this is the only rule they meet, and an account created outside
 * it would be one nobody could ever sign into.
 */
export function matchesGovDomain(email: string, configured: string): boolean {
  const domain = email.split('@')[1]?.toLowerCase();
  if (!domain) return false;

  const bare = configured.trim().toLowerCase().replace(/^\./, '');
  if (!bare) return false;

  // Anchored on a dot. A plain endsWith let evilgov.sl pass a "gov.sl" suffix,
  // which is how this was written the first time. The bare domain still counts,
  // so gov.sl itself is accepted alongside moh.gov.sl.
  return domain === bare || domain.endsWith(`.${bare}`);
}
