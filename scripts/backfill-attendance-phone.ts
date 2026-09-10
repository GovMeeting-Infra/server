/**
 * Stamps the account's phone number onto staff attendance rows that were
 * recorded without one.
 *
 *   npx ts-node -r dotenv/config scripts/backfill-attendance-phone.ts [--apply]
 *
 * Why there is anything to backfill: AuthService.getSession returns a
 * hand-listed projection of the user, and `phone` was missing from it. So
 * CheckinService.checkIn, which copies the number off the session, wrote null
 * onto every staff row that came through a scanned QR code — while the desk
 * path, which asks the database instead, wrote the number correctly. The
 * projection is fixed; these are the rows recorded before it was.
 *
 * Only ever fills a blank. A number already on a row was either typed by a
 * guest or stamped by the desk path, and both are better evidence of who was
 * actually in the room than the account is. Rows whose owner has since erased
 * their number, or never set one, are left alone rather than guessed at.
 *
 * Dry run by default — it prints what it would change and writes nothing until
 * --apply.
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

async function main() {
  const apply = process.argv.includes('--apply');

  // Quiet: this is a script, and Nest's boot banner is longer than its output.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const prisma = app.get(PrismaService) as any;

  try {
    const rows = await prisma.attendance.findMany({
      where: {
        userId: { not: null },
        guestPhone: null,
        user: { phone: { not: null } },
      },
      select: {
        id: true,
        checkInAt: true,
        user: { select: { id: true, name: true, email: true, phone: true } },
        event: { select: { title: true } },
      },
      orderBy: { checkInAt: 'asc' },
    });

    if (rows.length === 0) {
      console.log('Nothing to backfill: no staff attendance row is missing a number its owner has.');
      return;
    }

    console.log(
      `${rows.length} attendance row(s) would take a number from the account:\n`,
    );
    for (const row of rows) {
      console.log(
        `  ${row.user.name} <${row.user.email}>  ${row.user.phone}` +
          `\n    ${row.event.title} — checked in ${row.checkInAt.toISOString()}`,
      );
    }

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to write these.');
      return;
    }

    // One row at a time rather than a single UPDATE ... FROM: the number is
    // per-user, the volume is tiny, and a failure halfway leaves the rows it
    // did reach correct rather than the whole thing ambiguous.
    let written = 0;
    for (const row of rows) {
      const phone = row.user.phone?.trim();
      if (!phone) continue;
      await prisma.attendance.update({
        where: { id: row.id },
        data: { guestPhone: phone },
      });
      written++;
    }

    console.log(`\nWrote ${written} row(s).`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
