import { ministryScope, assertSameMinistry } from '../ministry-scope.util';

/**
 * This helper decides how much of the platform a query can see, so the failure
 * that matters is the one that returns too much rather than too little.
 */
describe('ministryScope', () => {
  it('scopes an ordinary user to their own ministry', () => {
    expect(ministryScope({ systemRole: 'STAFF', ministryId: 'min_1' })).toEqual(
      {
        ministryId: 'min_1',
      },
    );
  });

  it('leaves the top role unscoped', () => {
    expect(
      ministryScope({ systemRole: 'SUPER_ADMIN', ministryId: null }),
    ).toEqual({});
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
  ])(
    'gives a ministry-less %s user a filter that matches nothing',
    (_label, ministryId) => {
      // The bug this guards: Prisma drops an undefined filter key, so
      // { ministryId: undefined } is the same query as {} — every ministry.
      // Anyone reading the result would see cross-ministry data with no code
      // anywhere having granted it.
      const scope = ministryScope({ systemRole: 'MINISTER', ministryId });

      expect(scope).toEqual({ ministryId: null });
      expect(scope.ministryId).not.toBeUndefined();
      expect(Object.keys(scope)).toHaveLength(1);
    },
  );
});

describe('assertSameMinistry', () => {
  it('allows a match and the top role', () => {
    expect(() =>
      assertSameMinistry({ systemRole: 'STAFF', ministryId: 'a' }, 'a'),
    ).not.toThrow();
    expect(() =>
      assertSameMinistry({ systemRole: 'SUPER_ADMIN', ministryId: null }, 'a'),
    ).not.toThrow();
  });

  it('refuses across ministries, and refuses a ministry-less ordinary user', () => {
    expect(() =>
      assertSameMinistry({ systemRole: 'STAFF', ministryId: 'a' }, 'b'),
    ).toThrow();
    expect(() =>
      assertSameMinistry({ systemRole: 'MINISTER', ministryId: null }, 'b'),
    ).toThrow();
  });
});
