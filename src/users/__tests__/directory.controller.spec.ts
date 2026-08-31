import { DirectoryController } from '../directory.controller';

/**
 * The roster is a staging list, not a second copy of the ministry. These cover
 * the rule that makes it one: an entry disappears the moment its address
 * belongs to a live account, so nobody is offered twice and the list shrinks
 * as staff are onboarded.
 */

const MINISTRY = 'min_mocti';

const STAFF = (over: Partial<any> = {}) => ({
  id: 'sd_1',
  firstName: 'Abdul',
  lastName: 'Mansaray',
  email: 'abdul.mansaray@mocti.gov.sl',
  ...over,
});

/**
 * Stands in for the Prisma proxy. `user.findMany` is asked two different
 * questions — for the accounts half, and for which roster addresses are
 * already onboarded — so it answers on the shape of the query.
 */
function prismaWith({
  accounts = [] as any[],
  onboarded = [] as string[],
  entries = [] as any[],
}) {
  const userFindMany = jest.fn(({ where }: any) =>
    Promise.resolve(
      where.OR?.[0]?.email?.equals
        ? onboarded.map((email) => ({ email }))
        : accounts,
    ),
  );
  const entryFindMany = jest.fn(() => Promise.resolve(entries));
  return {
    prisma: { user: { findMany: userFindMany }, staffDirectoryEntry: { findMany: entryFindMany } } as any,
    userFindMany,
    entryFindMany,
  };
}

const STAFF_USER = { systemRole: 'STAFF', ministryId: MINISTRY };

describe('DirectoryController.people', () => {
  it('returns roster entries alone when only staff are asked for', async () => {
    const { prisma, userFindMany } = prismaWith({
      accounts: [{ id: 'u1', name: 'Should Not Appear', email: 'a@mocti.gov.sl', jobTitle: null }],
      entries: [STAFF()],
    });

    const result = await new DirectoryController(prisma).people(STAFF_USER, undefined, 'staff');

    expect(result).toEqual([
      {
        id: 'sd_1',
        name: 'Abdul Mansaray',
        email: 'abdul.mansaray@mocti.gov.sl',
        jobTitle: null,
        kind: 'staff',
      },
    ]);
    // The accounts half was never queried, rather than queried and discarded.
    expect(userFindMany).toHaveBeenCalledTimes(1);
    expect(userFindMany.mock.calls[0][0].where.OR[0].email.mode).toBe('insensitive');
  });

  it('hides a roster entry once that address holds an account', async () => {
    const { prisma } = prismaWith({
      entries: [STAFF(), STAFF({ id: 'sd_2', firstName: 'Salima', lastName: 'Bah', email: 'salima.bah@mocti.gov.sl' })],
      onboarded: ['salima.bah@mocti.gov.sl'],
    });

    const result = await new DirectoryController(prisma).people(STAFF_USER, undefined, 'staff');

    expect(result.map((p) => p.email)).toEqual(['abdul.mansaray@mocti.gov.sl']);
  });

  it('hides it even when the account row is cased differently', async () => {
    // Addresses are lowercased on write on both sides now, but accounts
    // created before that rule are not, and a duplicate is exactly what this
    // endpoint exists to prevent.
    const { prisma } = prismaWith({
      entries: [STAFF()],
      onboarded: ['Abdul.Mansaray@MOCTI.gov.sl'],
    });

    const result = await new DirectoryController(prisma).people(STAFF_USER, undefined, 'staff');

    expect(result).toEqual([]);
  });

  it('puts accounts before roster entries when both are asked for', async () => {
    const { prisma } = prismaWith({
      accounts: [{ id: 'u1', name: 'Salima Bah', email: 'salima.bah@mocti.gov.sl', jobTitle: 'Minister' }],
      entries: [STAFF()],
    });

    const result = await new DirectoryController(prisma).people(STAFF_USER, undefined, 'accounts,staff');

    expect(result.map((p) => p.kind)).toEqual(['account', 'staff']);
  });

  it('defaults to both halves when sources is omitted', async () => {
    const { prisma } = prismaWith({
      accounts: [{ id: 'u1', name: 'Salima Bah', email: 'salima.bah@mocti.gov.sl', jobTitle: null }],
      entries: [STAFF()],
    });

    const result = await new DirectoryController(prisma).people(STAFF_USER);

    expect(result).toHaveLength(2);
  });

  it('joins a single-name roster entry without a trailing space', async () => {
    const { prisma } = prismaWith({ entries: [STAFF({ lastName: null, firstName: 'INFO', email: 'info@mocti.gov.sl' })] });

    const [person] = await new DirectoryController(prisma).people(STAFF_USER, undefined, 'staff');

    expect(person.name).toBe('INFO');
  });

  it('scopes a staff member to their own ministry and a super admin to none', async () => {
    const { prisma, entryFindMany } = prismaWith({ entries: [] });
    const controller = new DirectoryController(prisma);

    await controller.people(STAFF_USER, undefined, 'staff');
    expect(entryFindMany.mock.calls[0][0].where.ministryId).toBe(MINISTRY);

    await controller.people({ systemRole: 'SUPER_ADMIN', ministryId: null }, undefined, 'staff');
    expect(entryFindMany.mock.calls[1][0].where.ministryId).toBeUndefined();
  });

  it('caps a merged result at the picker limit', async () => {
    const accounts = Array.from({ length: 20 }, (_, i) => ({
      id: `u${i}`, name: `Account ${i}`, email: `a${i}@mocti.gov.sl`, jobTitle: null,
    }));
    const entries = Array.from({ length: 20 }, (_, i) => STAFF({ id: `sd${i}`, email: `s${i}@mocti.gov.sl` }));
    const { prisma } = prismaWith({ accounts, entries });

    const result = await new DirectoryController(prisma).people(STAFF_USER, undefined, 'accounts,staff');

    expect(result).toHaveLength(25);
  });

  it('searches the roster on either name or address', async () => {
    const { prisma, entryFindMany } = prismaWith({ entries: [] });

    await new DirectoryController(prisma).people(STAFF_USER, ' abdul ', 'staff');

    const or = entryFindMany.mock.calls[0][0].where.OR;
    expect(or.map((c: any) => Object.keys(c)[0])).toEqual(['firstName', 'lastName', 'email']);
    // Trimmed, so a stray space from a paste does not match nothing.
    expect(or[0].firstName.contains).toBe('abdul');
  });
});
