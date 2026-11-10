/**
 * Whether somebody who was invited to the platform has actually joined it.
 *
 * An invited account exists from the moment an admin creates it, but nobody
 * can sign into it until a password is set — through the invitation link, or
 * through "forgot password", which also creates one. Nothing on the User row
 * changes when that happens (emailVerified is never written, and lastLoginAt
 * stays null until the first sign-in), so the credential Account is the only
 * reliable signal.
 *
 * Roles that are worked in the app — co-organizing a meeting, helping on an
 * action item — need someone who can sign in. Offering a person who cannot
 * hands them a job, and an email linking to a page, they cannot open.
 */
export const ACCEPTED_ACCOUNT = {
  accounts: { some: { providerId: 'credential' } },
} as const;

/** The select that lets a caller tell, per user, without a second query. */
export const CREDENTIAL_SELECT = {
  accounts: {
    where: { providerId: 'credential' },
    select: { id: true },
    take: 1,
  },
} as const;

export function hasAccepted(user: { accounts?: unknown[] } | null | undefined) {
  return !!user?.accounts && user.accounts.length > 0;
}

/**
 * Splits a search into words, so "Abdul Mansaray" and "Mansaray Abdul" both
 * find him: every word has to match somewhere, in any of the fields given.
 * A single `contains` on the whole string only matched when the stored text
 * held it verbatim, and a roster stores first and last names apart.
 */
export function searchWords(q?: string): string[] {
  return (q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 6);
}

export function matchEveryWord(words: string[], fields: string[]) {
  if (words.length === 0) return {};
  return {
    AND: words.map((w) => ({
      OR: fields.map((f) => ({ [f]: { contains: w, mode: 'insensitive' } })),
    })),
  };
}

/** The same rule for lists already in memory. */
export function matchesEveryWord(words: string[], ...values: string[]) {
  const hay = values.join(' ').toLowerCase();
  return words.every((w) => hay.includes(w.toLowerCase()));
}
