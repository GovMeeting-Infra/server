import {
  ministryScope,
  assertSameMinistry,
  eventVisibilityScope,
  canSeeEvent,
} from '../ministry-scope.util';

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

/**
 * Staff see the meetings they are part of and nothing else in the ministry;
 * leadership and the platform roles see everything within their reach.
 */
describe('event visibility', () => {
  const staff = { id: 'u1', systemRole: 'STAFF' };
  const base = {
    isPublic: false,
    organizerId: 'other',
    coOrganizers: [{ userId: 'other-2' }],
    attendees: [{ userId: 'other-3' }, { userId: null }],
  };

  it.each(['MINISTER', 'MINISTRY_ADMIN', 'SUPER_ADMIN', 'PLATFORM_ADMIN'])(
    'lets %s see every event',
    (systemRole) => {
      expect(eventVisibilityScope({ id: 'x', systemRole })).toEqual({});
      expect(canSeeEvent({ id: 'x', systemRole }, base)).toBe(true);
    },
  );

  it('hides an event from staff who have no part in it', () => {
    expect(canSeeEvent(staff, base)).toBe(false);
  });

  it.each([
    ['organizer', { organizerId: 'u1' }],
    ['co-organizer', { coOrganizers: [{ userId: 'u1' }] }],
    ['attendee', { attendees: [{ userId: 'u1' }] }],
    ['anyone, when public', { isPublic: true }],
  ])('shows it to the %s', (_label, patch) => {
    expect(canSeeEvent(staff, { ...base, ...patch })).toBe(true);
  });

  it('matches nothing for staff with no id, rather than everything', () => {
    // Guest attendees have a null userId; a missing actor id must not match
    // them, and the query filter must not drop out.
    expect(canSeeEvent({ systemRole: 'STAFF' }, base)).toBe(false);
    expect(eventVisibilityScope({ systemRole: 'STAFF' })).toEqual({
      id: { in: [] },
    });
  });
});
