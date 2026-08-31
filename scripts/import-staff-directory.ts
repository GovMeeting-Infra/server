/**
 * Imports a ministry's staff export into StaffDirectoryEntry.
 *
 * Run by hand, never from a deploy. .github/workflows/deploy.yml forbids a
 * seed step for good reason — accounts on this platform are created
 * deliberately, and an import that runs itself on every push is the same
 * mistake wearing a different hat. This script creates no accounts at all,
 * but it still only runs when somebody decides to run it.
 *
 *   npx ts-node scripts/import-staff-directory.ts \
 *     --csv ./Users_27_08_2026_16.10.csv --ministry MOCTI [--dry-run]
 *
 * Expected columns: First Name, Last Name, Email address, Role, Last login
 * time. The last two are read only to check the shape of the row and are then
 * discarded — Role is the *exporting system's* notion of a role, not this
 * platform's, and mapping it to systemRole would silently mint administrators.
 */
import { readFileSync } from 'node:fs';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client';

const SOURCE_COLUMNS = 5;

type Row = { firstName: string; lastName: string | null; email: string };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

/**
 * Splits one CSV line. Deliberately not a CSV library: nothing in this project
 * parses CSV, the exports seen so far contain no quoted fields, and a row that
 * does not split into exactly five columns is rejected below rather than
 * guessed at. If an export ever arrives with embedded commas this will refuse
 * it loudly, which is the outcome we want.
 */
function splitLine(line: string): string[] {
  return line.split(',').map((c) => c.trim());
}

function parse(csv: string): { rows: Row[]; skipped: string[] } {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) throw new Error('CSV has no data rows.');

  const header = splitLine(lines[0]).map((h) => h.toLowerCase());
  const expected = ['first name', 'last name', 'email address'];
  expected.forEach((name, i) => {
    if (header[i] !== name) {
      throw new Error(
        `Unexpected column ${i + 1}: found "${header[i]}", expected "${name}".`,
      );
    }
  });

  const rows: Row[] = [];
  const skipped: string[] = [];

  lines.slice(1).forEach((line, i) => {
    const lineNo = i + 2;
    const cols = splitLine(line);

    if (cols.length !== SOURCE_COLUMNS) {
      skipped.push(`line ${lineNo}: expected ${SOURCE_COLUMNS} columns, found ${cols.length}`);
      return;
    }

    const [firstName, lastName, email] = cols;

    if (!firstName) {
      skipped.push(`line ${lineNo}: no first name`);
      return;
    }
    if (!email.includes('@')) {
      skipped.push(`line ${lineNo}: "${email}" is not an address`);
      return;
    }

    rows.push({
      firstName,
      // Some people in the export have only one name. Null, not an empty
      // string, so the reader can tell "no surname" from "surname erased".
      lastName: lastName || null,
      email: email.toLowerCase(),
    });
  });

  return { rows, skipped };
}

/**
 * The platform's support address, as the app resolves it: a stored override
 * first, then the environment. Mirrors SettingsService, which this script
 * cannot reach without standing up the Nest container.
 */
async function supportAddress(prisma: any): Promise<string | null> {
  const row = await prisma.platformSetting.findUnique({
    where: { key: 'SUPPORT_EMAIL' },
    select: { value: true },
  });
  const value = (row?.value ?? process.env.SUPPORT_EMAIL ?? '').trim().toLowerCase();
  return value || null;
}

async function main() {
  const csvPath = arg('csv');
  const ministryCode = arg('ministry');
  const dryRun = process.argv.includes('--dry-run');

  if (!csvPath || !ministryCode) {
    console.error(
      'Usage: --csv <path> --ministry <code> [--dry-run]',
    );
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error('DATABASE_URL is not set.');

  // Same driver adapter the app uses (see PrismaService). A short-lived script
  // needs a small pool, not the app's ten connections.
  const pool = new Pool({ connectionString, max: 2 });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  try {
    const ministry = await prisma.ministry.findUnique({
      where: { code: ministryCode },
      select: { id: true, name: true, emailDomain: true },
    });

    if (!ministry) {
      throw new Error(
        `No ministry with code "${ministryCode}". Create it before importing its staff.`,
      );
    }

    const domain = ministry.emailDomain.toLowerCase().trim();
    const { rows, skipped } = parse(readFileSync(csvPath, 'utf8'));

    // Same rule as ministries.service.ts:31-38. An address outside the
    // ministry's own domain is either a mistake in the export or somebody who
    // does not belong on this roster; either way it is not ours to guess.
    const onDomain: Row[] = [];
    for (const row of rows) {
      if (
        row.email.endsWith(`@${domain}`) ||
        row.email.endsWith(`.${domain}`)
      ) {
        onDomain.push(row);
      } else {
        skipped.push(`${row.email}: not on @${domain}`);
      }
    }

    // Somebody who already holds an account is not a candidate for onboarding
    // — they are onboarded. Importing them would put the same person in the
    // picker twice, and deleting the leftover row by hand would only last
    // until the next run of this script.
    const accounts = await prisma.user.findMany({
      where: {
        deletedAt: null,
        OR: onDomain.map((r) => ({
          email: { equals: r.email, mode: 'insensitive' as const },
        })),
      },
      select: { email: true },
    });
    const held = new Set(accounts.map((a) => a.email.toLowerCase()));

    // A shared mailbox is not a person. info@ and support@ belong on the help
    // page, where somebody is expected to be reading them, not in a picker
    // that offers them as a meeting attendee or an action-item owner.
    const support = await supportAddress(prisma);

    const toImport = onDomain.filter((r) => {
      if (held.has(r.email)) {
        skipped.push(`${r.email}: already has an account`);
        return false;
      }
      if (support && r.email === support) {
        skipped.push(`${r.email}: the support address, not a person`);
        return false;
      }
      return true;
    });

    // Reconcile, rather than only add. A roster row for somebody who has since
    // been given an account is a leftover, and the endpoint already hides it —
    // but a hidden row is still a row, and leaving it means the two lists drift
    // apart until nobody trusts either.
    const stale = await prisma.staffDirectoryEntry.findMany({
      where: {
        ministryId: ministry.id,
        email: {
          in: [...held, ...(support ? [support] : [])],
        },
      },
      select: { id: true, email: true },
    });

    if (stale.length > 0 && !dryRun) {
      await prisma.staffDirectoryEntry.deleteMany({
        where: { id: { in: stale.map((e: { id: string }) => e.id) } },
      });
    }

    // The export is the source of truth for a name; a person who has since
    // been given a surname should get it. Nothing else about the row changes.
    const source = `csv:${csvPath.split('/').pop()}`;
    let created = 0;
    let updated = 0;

    console.log(
      `${ministry.name} (@${domain}) — ${toImport.length} rows to import${dryRun ? ' [dry run]' : ''}`,
    );

    if (!dryRun) {
      for (const row of toImport) {
        const existing = await prisma.staffDirectoryEntry.findUnique({
          where: { ministryId_email: { ministryId: ministry.id, email: row.email } },
          select: { id: true },
        });

        await prisma.staffDirectoryEntry.upsert({
          where: { ministryId_email: { ministryId: ministry.id, email: row.email } },
          create: { ...row, ministryId: ministry.id, source },
          update: { firstName: row.firstName, lastName: row.lastName, source },
        });

        existing ? updated++ : created++;
      }
    }

    console.log(`  created: ${dryRun ? '—' : created}`);
    console.log(`  updated: ${dryRun ? '—' : updated}`);
    console.log(`  removed: ${dryRun ? `${stale.length} (would)` : stale.length}`);
    stale.forEach((e: { email: string }) => console.log(`    - ${e.email}`));
    console.log(`  skipped: ${skipped.length}`);
    skipped.forEach((s) => console.log(`    - ${s}`));

    const total = await prisma.staffDirectoryEntry.count({
      where: { ministryId: ministry.id },
    });
    console.log(`  roster now holds: ${total}`);
  } finally {
    await prisma.$disconnect();
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
