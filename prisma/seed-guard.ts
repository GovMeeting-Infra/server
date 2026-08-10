/**
 * Refuses to seed anything that is not a local development database.
 *
 * Both seed scripts create fixtures whose passwords are published in this
 * repository — super@gov.sl, admin@med.gov.sl and staff@moh.gov.sl, all on
 * Password@123 — plus two ministries and a room. Those accounts once reached the
 * production database and had to be deleted by hand; recreating them is a single
 * mistyped command away.
 *
 * Two independent checks, because either can be absent when the other is not:
 *
 *   1. NODE_ENV=production, which is what the instance runs under.
 *   2. A database host that is not local. This is the load-bearing one — a shell
 *      with no NODE_ENV set but a production DATABASE_URL in .env is exactly how
 *      the accident happens, and that is the shape of the .env on the instance.
 *
 * ALLOW_REMOTE_SEED=1 overrides the host check for someone who genuinely means
 * it, for instance seeding a shared staging database. It does not override the
 * production check.
 */

const LOCAL_HOSTS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  'postgres',
  'db',
]);

function hostOf(connectionString: string): string | null {
  try {
    return new URL(connectionString).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function assertSafeToSeed(connectionString: string): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'Refusing to seed with NODE_ENV=production. These are test fixtures with a password published in the repository.',
    );
  }

  const host = hostOf(connectionString);

  if (!host) {
    throw new Error(
      'Refusing to seed: DATABASE_URL could not be parsed, so the target database cannot be identified.',
    );
  }

  if (LOCAL_HOSTS.has(host)) {
    return;
  }

  if (process.env.ALLOW_REMOTE_SEED === '1') {
    console.warn(
      `⚠️  Seeding a non-local database (${host}) because ALLOW_REMOTE_SEED=1.`,
    );
    return;
  }

  throw new Error(
    [
      `Refusing to seed ${host}: it is not a local database.`,
      '',
      'These scripts create test users whose password is published in this',
      'repository. They belong on a development machine, not on anything shared.',
      '',
      'If you are certain, re-run with ALLOW_REMOTE_SEED=1.',
    ].join('\n'),
  );
}
