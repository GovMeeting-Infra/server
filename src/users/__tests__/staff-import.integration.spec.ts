import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../../../generated/prisma/client';
import { StaffImportService } from '../staff-import.service';

/**
 * The upsert is raw SQL — the first in this codebase — so it is proved against
 * a real Postgres rather than a mock: the JSON parameters through the driver
 * adapter, created-versus-updated from xmax, the kept surname, and that a
 * second upload removes nobody.
 *
 * Opt-in, and local only. Set STAFF_IMPORT_TEST_DATABASE_URL to a localhost
 * database to run it; it refuses any other host outright, because server/.env
 * has pointed at production before and a test that writes must never follow.
 *
 *   STAFF_IMPORT_TEST_DATABASE_URL=postgresql://postgres:devpass@localhost:5432/govmeeting_dev \
 *     npx jest staff-import.integration
 */

const url = process.env.STAFF_IMPORT_TEST_DATABASE_URL;

if (url) {
  const host = new URL(url).hostname;
  if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
    throw new Error(
      `staff-import.integration refuses to run against ${host}; it writes. Use a local database.`,
    );
  }
}

const describeLocal = url ? describe : describe.skip;

describeLocal('StaffImportService against Postgres', () => {
  const tag = `it${Date.now()}`;
  const ministryId = `min_${tag}`;
  const userId = `usr_${tag}`;
  const domain = `${tag}.gov.sl`;
  const otherMinistryId = `min_${tag}_other`;

  let pool: Pool;
  let prisma: any;
  let service: StaffImportService;
  const audit = { log: jest.fn(() => Promise.resolve()) };
  const actor = { id: userId, systemRole: 'MINISTER', ministryId };

  const csv = (...lines: string[]) =>
    Buffer.from(['First Name,Last Name,Email', ...lines].join('\n'));

  const roster = () =>
    prisma.staffDirectoryEntry.findMany({
      where: { ministryId },
      orderBy: { email: 'asc' },
      select: { firstName: true, lastName: true, email: true, source: true },
    });

  beforeAll(async () => {
    pool = new Pool({ connectionString: url, max: 2 });
    prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    service = new StaffImportService(
      prisma,
      { get: () => Promise.resolve(`support@${domain}`) } as any,
      audit as any,
    );

    await prisma.ministry.createMany({
      data: [
        {
          id: ministryId,
          name: `Test ${tag}`,
          code: tag.toUpperCase(),
          emailDomain: domain,
        },
        {
          id: otherMinistryId,
          name: `Other ${tag}`,
          code: `${tag}O`.toUpperCase(),
          emailDomain: domain,
        },
      ],
    });
    // An account created before addresses were lowercased, in another ministry.
    await prisma.user.create({
      data: {
        id: userId,
        email: `Has.Account@${domain.toUpperCase()}`,
        name: 'Has Account',
        ministryId: otherMinistryId,
        updatedAt: new Date(),
      },
    });
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.user.deleteMany({ where: { id: userId } });
    // Cascades to the roster rows.
    await prisma.ministry.deleteMany({
      where: { id: { in: [ministryId, otherMinistryId] } },
    });
    await prisma.$disconnect();
    await pool.end();
  });

  it('adds, then updates, then leaves alone, and never removes', async () => {
    const first = await service.run(actor, {
      filename: 'first.csv',
      commit: true,
      body: csv(
        `Aminata,Koroma,A.Koroma@${domain}`,
        `Ibrahim,,i.sesay@${domain}`,
        `Has,Account,has.account@${domain}`,
        `Help,Desk,support@${domain}`,
      ),
    });
    expect(first.totals).toMatchObject({
      new: 2,
      updated: 0,
      unchanged: 0,
      skipped: 2,
    });
    expect(first.skippedByReason).toEqual({
      HAS_ACCOUNT: 1,
      SUPPORT_ADDRESS: 1,
    });
    expect(await roster()).toEqual([
      {
        firstName: 'Aminata',
        lastName: 'Koroma',
        email: `a.koroma@${domain}`,
        source: 'csv:first.csv',
      },
      {
        firstName: 'Ibrahim',
        lastName: null,
        email: `i.sesay@${domain}`,
        source: 'csv:first.csv',
      },
    ]);

    // Ibrahim gains a surname, Aminata's blank surname keeps hers, and a new
    // person arrives. Nobody from the first file is missing from the second
    // except Aminata's surname — and she must keep it.
    const preview = await service.run(actor, {
      filename: 'second.csv',
      commit: false,
      body: csv(
        `Aminata,,a.koroma@${domain}`,
        `Ibrahim,Sesay,i.sesay@${domain}`,
        `Fatmata,Bangura,f.bangura@${domain}`,
      ),
    });
    expect(preview.totals).toMatchObject({ new: 1, updated: 1, unchanged: 1 });
    expect((await roster()).map((r: any) => r.source)).toEqual([
      'csv:first.csv',
      'csv:first.csv',
    ]);

    const second = await service.run(actor, {
      filename: 'second.csv',
      commit: true,
      body: csv(
        `Aminata,,a.koroma@${domain}`,
        `Ibrahim,Sesay,i.sesay@${domain}`,
        `Fatmata,Bangura,f.bangura@${domain}`,
      ),
    });
    expect(second.totals).toMatchObject({ new: 1, updated: 1, unchanged: 1 });

    // A file with only one person removes nobody.
    const third = await service.run(actor, {
      filename: 'third.csv',
      commit: true,
      body: csv(`Fatmata,Bangura,f.bangura@${domain}`),
    });
    expect(third.totals).toMatchObject({ new: 0, updated: 0, unchanged: 1 });

    expect(await roster()).toEqual([
      {
        firstName: 'Aminata',
        lastName: 'Koroma',
        email: `a.koroma@${domain}`,
        source: 'csv:first.csv',
      },
      {
        firstName: 'Fatmata',
        lastName: 'Bangura',
        email: `f.bangura@${domain}`,
        source: 'csv:second.csv',
      },
      {
        firstName: 'Ibrahim',
        lastName: 'Sesay',
        email: `i.sesay@${domain}`,
        source: 'csv:second.csv',
      },
    ]);
  });

  it('writes a large file in one go', async () => {
    const lines = Array.from(
      { length: 5000 },
      (_, i) => `Person${i},Bulk,bulk${i}@${domain}`,
    );
    const started = Date.now();
    const result = await service.run(actor, {
      filename: 'bulk.csv',
      commit: true,
      body: csv(...lines),
    });
    expect(result.totals.new).toBe(5000);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(
      await prisma.staffDirectoryEntry.count({
        where: { ministryId, lastName: 'Bulk' },
      }),
    ).toBe(5000);
  });

  it('survives two identical uploads at once', async () => {
    const body = csv(
      ...Array.from(
        { length: 200 },
        (_, i) => `Race${i},Twin,race${i}@${domain}`,
      ),
    );
    const [a, b] = await Promise.all([
      service.run(actor, { filename: 'a.csv', commit: true, body }),
      service.run(actor, { filename: 'b.csv', commit: true, body }),
    ]);
    // Between them every row was created exactly once.
    expect(a.totals.new + b.totals.new).toBe(200);
    expect(
      await prisma.staffDirectoryEntry.count({
        where: { ministryId, lastName: 'Twin' },
      }),
    ).toBe(200);
  });
});
