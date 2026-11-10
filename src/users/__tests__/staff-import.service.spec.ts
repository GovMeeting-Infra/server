import { HttpException } from '@nestjs/common';
import { StaffImportService, cleanFilename } from '../staff-import.service';

/**
 * The service's own decisions: whose ministry an upload lands in, that a
 * preview writes nothing, and what the audit entry carries. The SQL itself is
 * exercised against a real Postgres in staff-import.integration.spec.ts.
 */

const MINISTRY = {
  id: 'min_mof',
  name: 'Ministry of Finance',
  emailDomain: 'mof.gov.sl',
  active: true,
};

const CSV = Buffer.from(
  [
    'First Name,Last Name,Email',
    'Aminata,Koroma,a.koroma@mof.gov.sl',
    'Ibrahim,Sesay,i.sesay@mof.gov.sl',
    'Personal,Address,someone@gmail.com',
    'Already,Onboarded,Onboarded@mof.gov.sl',
  ].join('\n'),
);

function setup({
  ministry = MINISTRY as any,
  accounts = ['onboarded@mof.gov.sl'],
  existing = [] as any[],
  written = [] as any[],
} = {}) {
  const queryRaw = jest.fn((strings: TemplateStringsArray) =>
    Promise.resolve(
      strings.join('?').includes('INSERT INTO')
        ? written
        : accounts.map((email) => ({ email })),
    ),
  );
  const prisma = {
    ministry: {
      findUnique: jest.fn(() => Promise.resolve(ministry)),
      findMany: jest.fn(() => Promise.resolve([])),
    },
    staffDirectoryEntry: { findMany: jest.fn(() => Promise.resolve(existing)) },
    $queryRaw: queryRaw,
  };
  const settings = {
    get: jest.fn(() => Promise.resolve('support@calendar.gov.sl')),
  };
  const audit = { log: jest.fn(() => Promise.resolve()) };
  const service = new StaffImportService(
    prisma as any,
    settings as any,
    audit as any,
  );
  const inserts = () =>
    queryRaw.mock.calls.filter(([s]) => s.join('?').includes('INSERT INTO'));
  return { service, prisma, audit, inserts };
}

const status = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return {
      status: (e as HttpException).getStatus(),
      body: (e as HttpException).getResponse(),
    };
  }
  throw new Error('expected a rejection');
};

describe('StaffImportService.resolveMinistryId', () => {
  const { service } = setup();

  it.each(['SUPER_ADMIN', 'PLATFORM_ADMIN'])(
    'lets %s name any ministry',
    (systemRole) => {
      expect(
        service.resolveMinistryId(
          { id: 'u', systemRole, ministryId: null },
          'min_x',
        ),
      ).toBe('min_x');
    },
  );

  it.each(['SUPER_ADMIN', 'PLATFORM_ADMIN'])(
    'makes %s name one',
    (systemRole) => {
      expect(() =>
        service.resolveMinistryId({ id: 'u', systemRole }, '  '),
      ).toThrow('Choose which ministry');
    },
  );

  it.each(['MINISTER', 'MINISTRY_ADMIN'])(
    'locks %s to their own ministry',
    (systemRole) => {
      const user = { id: 'u', systemRole, ministryId: 'min_mof' };
      expect(service.resolveMinistryId(user)).toBe('min_mof');
      expect(service.resolveMinistryId(user, 'min_mof')).toBe('min_mof');
      expect(() => service.resolveMinistryId(user, 'min_other')).toThrow(
        'your own ministry',
      );
    },
  );

  it('refuses a ministry role with no ministry', () => {
    expect(() =>
      service.resolveMinistryId({
        id: 'u',
        systemRole: 'MINISTER',
        ministryId: null,
      }),
    ).toThrow('belongs to no ministry');
  });
});

describe('StaffImportService.run', () => {
  const minister = {
    id: 'u_min',
    systemRole: 'MINISTER',
    ministryId: 'min_mof',
  };

  it('previews without writing or auditing', async () => {
    const { service, audit, inserts } = setup();
    const result = await service.run(minister, {
      body: CSV,
      filename: 'mof.csv',
      commit: false,
    });

    expect(inserts()).toHaveLength(0);
    expect(audit.log).not.toHaveBeenCalled();
    expect(result.committed).toBe(false);
    expect(result.totals).toEqual({
      rows: 4,
      new: 2,
      updated: 0,
      unchanged: 0,
      skipped: 2,
    });
    expect(result.skippedByReason).toEqual({ WRONG_DOMAIN: 1, HAS_ACCOUNT: 1 });
    expect(result.added?.map((a) => a.email)).toEqual([
      'a.koroma@mof.gov.sl',
      'i.sesay@mof.gov.sl',
    ]);
  });

  it('commits, counting from what the database reports', async () => {
    // Two rows were sent; only one came back as created, as if the other had
    // been given the same name by a concurrent upload since the preview.
    const { service, audit, inserts } = setup({ written: [{ created: true }] });
    const result = await service.run(minister, {
      body: CSV,
      filename: '../../etc/mof.csv',
      commit: true,
      ipAddress: '10.0.0.1',
    });

    expect(inserts()).toHaveLength(1);
    expect(result.totals).toEqual({
      rows: 4,
      new: 1,
      updated: 0,
      unchanged: 1,
      skipped: 2,
    });
    expect(result.added).toBeUndefined();

    const entry = (audit.log.mock.calls[0] as any[])[0];
    expect(entry).toMatchObject({
      action: 'STAFF_ROSTER_IMPORTED',
      status: 'SUCCESS',
      entityId: 'min_mof',
      ministryId: 'min_mof',
      actorId: 'u_min',
    });
    expect(entry.description).toBe(
      'Staff list "mof.csv": 1 added, 0 updated, 1 unchanged, 2 skipped',
    );
    // No addresses anywhere in the entry.
    expect(JSON.stringify(entry)).not.toMatch(/@mof\.gov\.sl|@gmail/);
  });

  it('audits a failed write and passes the error on', async () => {
    const { service, audit, prisma } = setup();
    prisma.$queryRaw.mockImplementation((strings: TemplateStringsArray) =>
      strings.join('?').includes('INSERT INTO')
        ? Promise.reject(new Error('db down'))
        : Promise.resolve([]),
    );
    await expect(
      service.run(minister, { body: CSV, commit: true }),
    ).rejects.toThrow('db down');
    expect((audit.log.mock.calls[0] as any[])[0].status).toBe('FAILURE');
  });

  it('writes nothing when there is nothing new', async () => {
    const { service, inserts } = setup({
      existing: [
        {
          email: 'a.koroma@mof.gov.sl',
          firstName: 'Aminata',
          lastName: 'Koroma',
        },
        {
          email: 'i.sesay@mof.gov.sl',
          firstName: 'Ibrahim',
          lastName: 'Sesay',
        },
      ],
    });
    const result = await service.run(minister, { body: CSV, commit: true });
    expect(inserts()).toHaveLength(0);
    expect(result.totals.unchanged).toBe(2);
  });

  it('refuses an inactive ministry', async () => {
    const { service } = setup({ ministry: { ...MINISTRY, active: false } });
    expect(
      await status(service.run(minister, { body: CSV, commit: false })),
    ).toMatchObject({
      status: 409,
      body: { code: 'MINISTRY_INACTIVE' },
    });
  });

  it('turns a bad file into a coded HTTP error', async () => {
    const { service } = setup();
    expect(
      await status(
        service.run(minister, {
          body: Buffer.from('just,some,words\n1,2,3'),
          commit: false,
        }),
      ),
    ).toMatchObject({ status: 400, body: { code: 'MISSING_COLUMNS' } });
  });

  it('checks the ministry before reading the file', async () => {
    const { service } = setup({ ministry: null });
    expect(
      (
        await status(
          service.run(minister, { body: Buffer.alloc(0), commit: false }),
        )
      ).status,
    ).toBe(404);
  });
});

describe('cleanFilename', () => {
  it.each([
    ['C:\\Users\\hr\\Staff list.csv', 'Staff list.csv'],
    ['../../etc/passwd', 'passwd'],
    ['\u202Evsc.exe', 'vsc.exe'],
    ['', 'upload.csv'],
    [undefined, 'upload.csv'],
  ])('%s → %s', (raw, clean) => {
    expect(cleanFilename(raw)).toBe(clean);
  });

  it('bounds the length', () => {
    expect(cleanFilename('a'.repeat(500))).toHaveLength(120);
  });
});
