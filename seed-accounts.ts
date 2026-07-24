import { auth } from './src/auth/auth.config';
import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import crypto from 'crypto';

const connectionString = process.env.DATABASE_URL || 'postgresql://govmeeting:devpass@localhost:5432/govmeeting_dev';
const pool = new Pool({ connectionString });
const adapter = new PrismaPg(pool);
const prisma = new (PrismaClient as any)({ adapter });

const testUsers = [
  { email: 'staff@moh.gov.sl', password: 'Password@123', name: 'Staff User' },
  { email: 'admin@med.gov.sl', password: 'Password@123', name: 'Admin User' },
  { email: 'super@gov.sl', password: 'Password@123', name: 'Super Admin' },
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
