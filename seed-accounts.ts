// Run directly (`npx ts-node seed-accounts.ts`), so nothing has loaded .env for
// us the way Nest's ConfigModule does for the app. Without this the script
// silently fell back to the local dev database and reported
// "Can't reach database server at 127.0.0.1:5432" on a machine that has no
// Postgres.
import 'dotenv/config';
import { auth } from './src/auth/auth.config';
import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import crypto from 'crypto';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error(
    '❌ DATABASE_URL is not set. Run this from the directory holding .env, or pass it inline.',
  );
  process.exit(1);
}

const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new (PrismaClient as any)({ adapter });

// Override before running this anywhere reachable from the internet:
//   SEED_PASSWORD='...' npx ts-node seed-accounts.ts
// The default is a published literal and these are real accounts — super@gov.sl
// is a SUPER_ADMIN.
const password = process.env.SEED_PASSWORD || 'Password@123';

const testUsers = [
  { email: 'staff@moh.gov.sl', password, name: 'Staff User' },
  { email: 'admin@med.gov.sl', password, name: 'Admin User' },
  { email: 'super@gov.sl', password, name: 'Super Admin' },
];

function hashPasswordSync(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(
    password.normalize('NFKC'),
    salt,
    64,
    { N: 16384, r: 16, p: 1, maxmem: 128 * 16384 * 16 * 2 }
  );
  return `${salt}:${key.toString('hex')}`;
}

async function main() {
  console.log('🔑 Creating/updating BetterAuth credentials...');

  for (const u of testUsers) {
    try {
      const user = await (prisma as any).user.findUnique({
        where: { email: u.email },
      });

      if (!user) {
        console.log(`  ⏭️  ${u.email}: User not found, skipping`);
        continue;
      }

      const hashed = hashPasswordSync(u.password);

      // Create or update Account record
      await (prisma as any).account.upsert({
        where: {
          userId_providerId_accountId: {
            userId: user.id,
            providerId: 'credential',
            accountId: `credential-${user.id}`,
          },
        },
        create: {
          userId: user.id,
          providerId: 'credential',
          accountId: `credential-${user.id}`,
          password: hashed,
        },
        update: {
          password: hashed,
          updatedAt: new Date(),
        },
      });

      console.log(`  ✅ ${u.email}`);
    } catch (error: any) {
      console.error(`  ❌ ${u.email}:`, error.message);
    }
  }

  await prisma.$disconnect();
  process.exit(0);
}

main();
