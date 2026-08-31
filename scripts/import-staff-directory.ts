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

    // The export is the source of truth for a name; a person who has since
    // been given a surname should get it. Nothing else about the row changes.
    const source = `csv:${csvPath.split('/').pop()}`;
    let created = 0;
    let updated = 0;

    console.log(
      `${ministry.name} (@${domain}) — ${onDomain.length} rows to import${dryRun ? ' [dry run]' : ''}`,
    );

    if (!dryRun) {
      for (const row of onDomain) {
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
