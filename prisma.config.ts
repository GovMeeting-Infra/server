// Prisma 7 configuration for CLI commands (migrate, db push, studio)
// The datasource URL must be configured here for Prisma CLI to function,
// since driver adapters cannot use url in schema.prisma.
// The app itself (PrismaService) builds its own connection via PrismaPg adapter.

// Prisma 7 does NOT read .env when a config file is present, so load it here.
// Without this the CLI silently fell back to the localhost dev database and
// migrations landed there instead of on the URL in .env.
import 'dotenv/config';

// Migrations must run against the DIRECT (non-pooled) endpoint: Neon's pooler
// is PgBouncer in transaction mode, which breaks the advisory locks and
// session state `prisma migrate` relies on. The app itself keeps using the
// pooled DATABASE_URL.
const configuredUrl = process.env.DIRECT_URL || process.env.DATABASE_URL;

if (!configuredUrl) {
  // Loud, because the silent version of this sent two rounds of production
  // migrations at a localhost database that wasn't there.
  console.warn(
    '[prisma.config] Neither DIRECT_URL nor DATABASE_URL is set — falling back to the local dev database.',
  );
}

const url =
  configuredUrl || 'postgresql://govmeeting:devpass@localhost:5432/govmeeting_dev';

export default {
  datasource: { url },
};
