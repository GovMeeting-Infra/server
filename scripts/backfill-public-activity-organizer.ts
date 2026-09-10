/**
 * Gives the events created without an organizer back to whoever wrote them.
 *
 *   npx ts-node -r dotenv/config scripts/backfill-public-activity-organizer.ts [--apply]
 *
 * Public activities used to be created with `organizerId: null`, on the
 * reasoning that they belong to the ministry rather than a person. Nothing then
 * tied one to the person who wrote it — the Event row has no creator column —
 * so the member of staff who submitted an activity for approval could not
 * correct a typo in it afterwards, while an administrator who had done nothing
 * but approve it was the only account that could.
 *
 * They are created under their author now. These are the rows from before that,
 * and the audit log is the only place their author survives: EVENT_CREATED
 * records the acting user. That trail is out of reach of the staff it concerns
 * — the audit API is ministers and super admins only — which is why this has to
 * be a script rather than something the interface could offer.
 *
 * Skips anything it cannot answer confidently: no creation record, a creator
 * whose account is gone, or an event filed under a different ministry from the
 * one that account belongs to. Guessing an owner is worse than leaving a row
 * for a human, because ownership is what the permission checks read.
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
    const orphans = await prisma.event.findMany({
      where: { organizerId: null },
      select: {
        id: true,
        title: true,
        isPublic: true,
        status: true,
        ministryId: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'asc' },
    });

    if (orphans.length === 0) {
      console.log('Nothing to backfill: every event has an organizer.');
      return;
    }

    const claimable: { id: string; title: string; actorId: string; actorName: string }[] = [];
    const skipped: { title: string; why: string }[] = [];

    for (const event of orphans) {
      // Oldest creation record, so a replayed or duplicated audit line cannot
      // hand the event to whoever touched it most recently.
      const creation = await prisma.auditLog.findFirst({
        where: {
          action: 'EVENT_CREATED',
          entityId: event.id,
          actorId: { not: null },
        },
        select: { actorId: true },
        orderBy: { createdAt: 'asc' },
      });

      if (!creation?.actorId) {
        skipped.push({ title: event.title, why: 'no creation record names an author' });
        continue;
      }

      const actor = await prisma.user.findUnique({
        where: { id: creation.actorId },
        select: { id: true, name: true, email: true, active: true, deletedAt: true, ministryId: true },
      });

      if (!actor || !actor.active || actor.deletedAt !== null) {
        skipped.push({ title: event.title, why: 'the author no longer has an account' });
        continue;
      }

      // An organizer from another ministry would fail assertSameMinistry on
      // every route that reads it, which is a worse state than ownerless.
      if (actor.ministryId !== event.ministryId) {
        skipped.push({
          title: event.title,
          why: `the author is now filed under a different ministry`,
        });
        continue;
      }

      claimable.push({
        id: event.id,
        title: event.title,
        actorId: actor.id,
        actorName: `${actor.name} <${actor.email}>`,
      });
    }

    if (claimable.length > 0) {
      console.log(`${claimable.length} event(s) would go back to their author:\n`);
      for (const row of claimable) {
        console.log(`  ${row.title}\n    → ${row.actorName}`);
      }
    }

    if (skipped.length > 0) {
      console.log(
        `\n${skipped.length} left ownerless for a human to decide on:\n`,
      );
      for (const row of skipped) {
        console.log(`  ${row.title} — ${row.why}`);
      }
      console.log(
        '\nMinistry admins can still manage these; that fallback is deliberately kept.',
      );
    }

    if (claimable.length === 0) return;

    if (!apply) {
      console.log('\nDry run. Re-run with --apply to write these.');
      return;
    }

    for (const row of claimable) {
      await prisma.event.update({
        where: { id: row.id },
        data: { organizerId: row.actorId },
      });
    }

    console.log(`\nWrote ${claimable.length} event(s).`);
  } finally {
    await app.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
