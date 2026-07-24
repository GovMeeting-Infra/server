// Prisma 7 configuration for CLI commands (migrate, db push, studio)
// The datasource URL must be configured here for Prisma CLI to function,
// since driver adapters cannot use url in schema.prisma.
// The app itself (PrismaService) builds its own connection via PrismaPg adapter.

export default {
  datasource: {
    url: process.env.DATABASE_URL || 'postgresql://govmeeting:devpass@localhost:5432/govmeeting_dev',
  },
};
