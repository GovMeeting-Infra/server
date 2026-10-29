import { Job } from 'bullmq';
import { jobId } from '../job-id.util';

/**
 * Checked against BullMQ's own validation rather than a copy of its rule, so
 * an upgrade that tightens the rule fails here instead of in production. The
 * queue specs mock add(), which is how five malformed ids went unnoticed.
 */
function bullmqAccepts(id: string): boolean {
  const queue = {
    opts: {},
    qualifiedName: 'bull:test',
    keys: {},
    toKey: (k: string) => k,
    trace: (_a: unknown, _b: unknown, _c: unknown, fn: () => unknown) => fn(),
  } as unknown as ConstructorParameters<typeof Job>[0];
  const job = new Job(queue, 'test', {}, { jobId: id }) as unknown as {
    validateOptions: (json: object) => void;
  };
  try {
    job.validateOptions({});
    return true;
  } catch {
    return false;
  }
}

describe('jobId', () => {
  it('keeps the three-part shape existing ids already use', () => {
    expect(jobId('meeting-reminder', 'evt1', 'usr1')).toBe(
      'meeting-reminder:evt1:usr1',
    );
  });

  it('joins extra detail with a dash instead of a fourth colon', () => {
    expect(jobId('coorganizer-added', 'evt1', 'usr1', 1761736054000)).toBe(
      'coorganizer-added:evt1:usr1-1761736054000',
    );
  });

  it('replaces a colon inside a part', () => {
    expect(jobId('push', 'MEETING:CHANGED', 'a:b')).toBe(
      'push:MEETING-CHANGED:a-b',
    );
  });

  it.each([
    ['the old four-part shape', 'coorganizer-added:evt1:usr1:1761736054000'],
    ['the old two-part shape', 'action-item-overdue:item1'],
  ])('confirms BullMQ refuses %s', (_label, id) => {
    expect(bullmqAccepts(id)).toBe(false);
  });

  it.each([
    [jobId('coorganizer-added', 'evt1', 'usr1', Date.now())],
    [jobId('meeting-changed', 'evt1', 'a@moh.gov.sl', Date.now())],
    [jobId('meeting-invitation', 'evt1', 'usr1', '2026-10-29T19:27:34.000Z')],
    [jobId('action-item-overdue', 'item1', '2026-10-29')],
    [jobId('push', 'COORGANIZER_ADDED', 'evt1', 'usr1')],
  ])('produces an id BullMQ accepts: %s', (id) => {
    expect(bullmqAccepts(id)).toBe(true);
  });
});
