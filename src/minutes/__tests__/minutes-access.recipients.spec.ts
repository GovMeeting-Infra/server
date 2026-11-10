import { MinutesAccessService } from '../minutes-access.service';

/**
 * Published minutes go to account holders as a link into the app, and to
 * everyone else as a tokenised link. An account that has never accepted its
 * invitation cannot open the app, so it counts as everyone else.
 */
describe('MinutesAccessService.recipientsFor — who can sign in', () => {
  it('marks accounts by whether they have a password', async () => {
    const prisma = {
      eventAttendee: {
        findMany: jest.fn().mockResolvedValue([
          {
            userId: 'u1',
            user: {
              id: 'u1',
              name: 'Joined',
              email: 'j@moh.gov.sl',
              accounts: [{ id: 'a' }],
            },
          },
          {
            userId: 'u2',
            user: {
              id: 'u2',
              name: 'Invited',
              email: 'i@moh.gov.sl',
              accounts: [],
            },
          },
          {
            userId: null,
            externalName: 'Guest',
            externalEmail: 'g@x.org',
            user: null,
          },
        ]),
      },
      attendance: { findMany: jest.fn().mockResolvedValue([]) },
    };

    const recipients = await new MinutesAccessService(
      prisma as any,
    ).recipientsFor('e1');

    expect(recipients.map((r) => [r.name, r.canSignIn])).toEqual([
      ['Joined', true],
      ['Invited', false],
      ['Guest', false],
    ]);
  });
});
