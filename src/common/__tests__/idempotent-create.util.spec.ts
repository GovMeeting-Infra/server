import { ConflictException } from '@nestjs/common';
import { idempotentCreate } from '../utils/idempotent-create.util';

/**
 * A device that writes offline retries until it gets an answer, and an answer
 * can be lost after the row is written. These cover what that must and must not
 * do — including the case where handing back the existing row would be a
 * disclosure rather than a convenience.
 */
describe('idempotentCreate', () => {
  const ID = 'clientmintedid0000000001';

  /**
   * What Prisma actually raises here, and note what is missing: `meta.target`.
   *
   * Prisma 7 with the pg driver adapter does not populate it — the meta carries
   * `modelName` and a driver error and nothing more. An earlier version of
   * these tests invented a `target`, so they passed against an implementation
   * that could never match one, and a replay came back a 500 from a real
   * database. Which constraint was hit is decided by looking for the row now,
   * which needs nothing from the error's shape.
   */
  const prismaConflict = () =>
    Object.assign(new Error('Unique constraint failed'), {
      code: 'P2002',
      meta: { modelName: 'Event' },
    });

  it('creates normally when there is no conflict', async () => {
    const create = jest.fn().mockResolvedValue({ id: ID, title: 'New' });
    const findExisting = jest.fn();

    const result = await idempotentCreate({
      id: ID,
      create,
      findExisting,
      canAccessExisting: () => true,
      label: 'thing',
    });

    expect(result).toEqual({ id: ID, title: 'New' });
    expect(findExisting).not.toHaveBeenCalled();
  });

  it('returns the existing record when the same id is written twice', async () => {
    const existing = { id: ID, title: 'Recorded in the meeting' };

    const result = await idempotentCreate({
      id: ID,
      create: jest.fn().mockRejectedValue(prismaConflict()),
      findExisting: jest.fn().mockResolvedValue(existing),
      canAccessExisting: () => true,
      label: 'thing',
    });

    expect(result).toBe(existing);
  });

  it('refuses to hand back a record the caller cannot access', async () => {
    // Somebody guessing another ministry's id and POSTing it. Without the
    // access check this helper would return that ministry's record as though
    // the caller had just created it.
    const findExisting = jest
      .fn()
      .mockResolvedValue({ id: ID, ministryId: 'someone-elses' });

    await expect(
      idempotentCreate({
        id: ID,
        create: jest.fn().mockRejectedValue(prismaConflict()),
        findExisting,
        canAccessExisting: () => false,
        label: 'event',
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('says nothing about whether the id existed when refusing', async () => {
    // The refusal must read the same whether the id was taken or invented,
    // otherwise it answers the question someone probing for ids is asking.
    const refused = idempotentCreate({
      id: ID,
      create: jest.fn().mockRejectedValue(prismaConflict()),
      findExisting: jest.fn().mockResolvedValue({ id: ID }),
      canAccessExisting: () => false,
      label: 'event',
    });

    await expect(refused).rejects.toThrow('That record could not be created');
  });

  it('rethrows a conflict on some other unique index', async () => {
    // A duplicate ministry name is a real disagreement with the caller, not a
    // replay. Nothing exists under the supplied id, which is how that case is
    // told apart now that the error does not say which constraint was hit.
    const error = prismaConflict();

    await expect(
      idempotentCreate({
        id: ID,
        create: jest.fn().mockRejectedValue(error),
        findExisting: jest.fn().mockResolvedValue(null),
        canAccessExisting: () => true,
        label: 'ministry',
      }),
    ).rejects.toBe(error);
  });

  it('rethrows when no client id was supplied', async () => {
    // Without a client-minted id a P2002 cannot be a replay of this request.
    const error = prismaConflict();

    await expect(
      idempotentCreate({
        create: jest.fn().mockRejectedValue(error),
        findExisting: jest.fn(),
        canAccessExisting: () => true,
        label: 'thing',
      }),
    ).rejects.toBe(error);
  });

  it('rethrows when the conflicting row has since disappeared', async () => {
    const error = prismaConflict();

    await expect(
      idempotentCreate({
        id: ID,
        create: jest.fn().mockRejectedValue(error),
        findExisting: jest.fn().mockResolvedValue(null),
        canAccessExisting: () => true,
        label: 'thing',
      }),
    ).rejects.toBe(error);
  });

  it('leaves any other failure alone', async () => {
    // A dead connection is not a replay, and must not be quietly turned into
    // one by looking for a row that happens to exist.
    const error = new Error('connection terminated');

    await expect(
      idempotentCreate({
        id: ID,
        create: jest.fn().mockRejectedValue(error),
        findExisting: jest.fn().mockResolvedValue({ id: ID }),
        canAccessExisting: () => true,
        label: 'thing',
      }),
    ).rejects.toBe(error);
  });

  it('runs side effects once across a create and its replay', async () => {
    // The whole point: an owner hears about an action item recorded during an
    // outage once, when the connection returns, not once per attempt.
    const notify = jest.fn();
    let stored: unknown = null;

    const attempt = () =>
      idempotentCreate({
        id: ID,
        label: 'action item',
        findExisting: async () => stored,
        canAccessExisting: () => true,
        create: async () => {
          if (stored) throw prismaConflict();
          stored = { id: ID };
          notify();
          return stored;
        },
      });

    await attempt();
    await attempt();
    await attempt();

    expect(notify).toHaveBeenCalledTimes(1);
  });
});
