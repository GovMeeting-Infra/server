import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient, SystemRole } from '../generated/prisma/client';

async function main() {
  console.log('🌱 Starting database seed...');

  // Initialize Prisma with the adapter config
  const connectionString = process.env.DATABASE_URL || 'postgresql://govmeeting:devpass@localhost:5432/govmeeting_dev';
  const pool = new Pool({ connectionString });
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });

  try {
    // 1. Create ministries
    const ministries = [
      {
        id: 'moh-001',
        code: 'MOH',
        name: 'Ministry of Health',
        emailDomain: 'moh.gov.sl',
      },
      {
        id: 'med-001',
        code: 'MED',
        name: 'Ministry of Education',
        emailDomain: 'med.gov.sl',
      },
    ];

    for (const ministry of ministries) {
      await prisma.ministry.upsert({
        where: { id: ministry.id },
        update: {},
        create: ministry,
      });
      console.log(`✅ Ministry: ${ministry.name}`);
    }

    // 2. Create users
    const users = [
      {
        id: 'usr-super-001',
        email: 'super@gov.sl',
        name: 'Super Admin',
        emailVerified: true,
        systemRole: SystemRole.SUPER_ADMIN,
        ministryId: 'moh-001',
        jobTitle: 'Administrator',
        active: true,
      },
      {
        id: 'usr-admin-001',
        email: 'admin@med.gov.sl',
        name: 'Admin User',
        emailVerified: true,
        systemRole: SystemRole.MINISTRY_ADMIN,
        ministryId: 'med-001',
        jobTitle: 'Ministry Admin',
        active: true,
      },
      {
        id: 'usr-staff-001',
        email: 'staff@moh.gov.sl',
        name: 'Staff User',
        emailVerified: true,
        systemRole: SystemRole.STAFF,
        ministryId: 'moh-001',
        jobTitle: 'Staff Member',
        active: true,
      },
    ];

    for (const user of users) {
      await prisma.user.upsert({
        where: { email: user.email },
        update: { ...user },
        create: user,
      });
      console.log(`✅ User: ${user.email}`);
    }

    // 3. Create test room
    const room = {
      id: 'room-001',
      name: 'Conference Room A',
      location: 'Building 1, Floor 2',
      capacity: 50,
      ministryId: 'moh-001',
      active: true,
    };

    await prisma.room.upsert({
      where: { id: room.id },
      update: {},
      create: room,
    });
    console.log(`✅ Room: ${room.name}`);

    console.log('\n✅ Seed complete!');
    console.log(
      '\n📝 Note: User accounts (email/password) are managed by BetterAuth.',
      '\n   When you start the app, use the auth endpoint to create accounts.',
      '\n   Test credentials to create:',
      '\n   - super@gov.sl / Password@123',
      '\n   - admin@med.gov.sl / Password@123',
      '\n   - staff@moh.gov.sl / Password@123',
    );
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main()
  .catch((error) => {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  });
