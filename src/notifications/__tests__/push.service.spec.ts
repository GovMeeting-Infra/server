import * as webpush from 'web-push';
import { PushService } from '../push.service';

jest.mock('web-push', () => ({
  setVapidDetails: jest.fn(),
  sendNotification: jest.fn(),
}));

const sendNotification = webpush.sendNotification as jest.Mock;
const setVapidDetails = webpush.setVapidDetails as jest.Mock;

/** What web-push throws: an Error carrying the push service's HTTP status. */
function webPushError(statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(`status ${statusCode}`), { statusCode });
}

describe('PushService', () => {
  let prisma: any;
  let subscriptions: any[];
  const OLD_ENV = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...OLD_ENV,
      VAPID_SUBJECT: 'mailto:support@calendar.gov.sl',
      VAPID_PUBLIC_KEY: 'public',
      VAPID_PRIVATE_KEY: 'private',
    };
    subscriptions = [];
    prisma = {
      pushSubscription: {
        findMany: jest.fn().mockImplementation(() => subscriptions),
        deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        upsert: jest.fn().mockResolvedValue({}),
        count: jest.fn().mockResolvedValue(0),
      },
    };
  });

  afterAll(() => {
    process.env = OLD_ENV;
  });

  const build = () => new PushService(prisma);
  const sub = (id: string) => ({
    id,
    endpoint: `https://push.example/${id}`,
    p256dh: 'p',
    auth: 'a',
  });

  describe('configuration', () => {
    it('is inert, not broken, when no keys are set', async () => {
      process.env = { ...OLD_ENV };
      delete process.env.VAPID_SUBJECT;
      delete process.env.VAPID_PUBLIC_KEY;
      delete process.env.VAPID_PRIVATE_KEY;

      const service = build();
      expect(service.isConfigured).toBe(false);
      expect(setVapidDetails).not.toHaveBeenCalled();

      // The important half: it must not read the database or throw, because a
      // deployment without push keys still publishes minutes.
      expect(await service.sendToUser('u1', { title: 't', body: 'b' })).toBe(0);
      expect(prisma.pushSubscription.findMany).not.toHaveBeenCalled();
    });

    it('configures web-push when all three are present', () => {
      expect(build().isConfigured).toBe(true);
      expect(setVapidDetails).toHaveBeenCalledWith(
        'mailto:support@calendar.gov.sl',
        'public',
        'private',
      );
    });
  });

  describe('sendToUser', () => {
    it('sends to every device the user has', async () => {
      subscriptions = [sub('s1'), sub('s2')];
      sendNotification.mockResolvedValue({});

      const delivered = await build().sendToUser('u1', {
        title: 'Minutes published',
        body: 'b',
        link: '/administrative/minutes',
        tag: 'MINUTES_PUBLISHED:e1',
      });

      expect(delivered).toBe(2);
      expect(sendNotification).toHaveBeenCalledTimes(2);
      const [subscription, payload] = sendNotification.mock.calls[0];
      expect(subscription.keys).toEqual({ p256dh: 'p', auth: 'a' });
      expect(JSON.parse(payload)).toEqual({
        title: 'Minutes published',
        body: 'b',
        link: '/administrative/minutes',
        tag: 'MINUTES_PUBLISHED:e1',
      });
    });

    // 404 and 410 are the push service saying this endpoint is finished for
    // good. Without pruning, the table only grows and every later send retries
    // against an endpoint that will never answer.
    it.each([404, 410])('deletes a subscription the service reports %i for', async (status) => {
      subscriptions = [sub('dead')];
      sendNotification.mockRejectedValue(webPushError(status));

      const delivered = await build().sendToUser('u1', { title: 't', body: 'b' });

      expect(delivered).toBe(0);
      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['dead'] } },
      });
    });

    // The mirror image, and the more dangerous mistake: deleting on a
    // transient failure silently unsubscribes a working device, and nobody
    // finds out until they notice they have stopped being told about meetings.
    it.each([429, 500, 503])('keeps a subscription after a %i', async (status) => {
      subscriptions = [sub('alive')];
      sendNotification.mockRejectedValue(webPushError(status));

      await build().sendToUser('u1', { title: 't', body: 'b' });

      expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
    });

    it('keeps a subscription when the failure carries no status at all', async () => {
      subscriptions = [sub('alive')];
      sendNotification.mockRejectedValue(new Error('socket hang up'));

      await build().sendToUser('u1', { title: 't', body: 'b' });

      expect(prisma.pushSubscription.deleteMany).not.toHaveBeenCalled();
    });

    it('prunes only the dead ones when a user has both', async () => {
      subscriptions = [sub('good'), sub('gone')];
      sendNotification
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(webPushError(410));

      const delivered = await build().sendToUser('u1', { title: 't', body: 'b' });

      expect(delivered).toBe(1);
      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['gone'] } },
      });
      expect(prisma.pushSubscription.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['good'] } },
        data: { lastUsedAt: expect.any(Date) },
      });
    });

    it('does not throw when the database is unreachable', async () => {
      prisma.pushSubscription.findMany.mockRejectedValue(new Error('no db'));
      await expect(
        build().sendToUser('u1', { title: 't', body: 'b' }),
      ).resolves.toBe(0);
    });
  });

  describe('subscriptions', () => {
    // On a shared tablet the second person to subscribe gets the same endpoint
    // from the push service. The row has to follow whoever is holding the
    // device, or one person's reminders arrive on somebody else's screen.
    it('reassigns an existing endpoint to the user who just subscribed', async () => {
      await build().saveSubscription('u2', {
        endpoint: 'https://push.example/shared',
        keys: { p256dh: 'p2', auth: 'a2' },
        userAgent: 'iPad',
      });

      const call = prisma.pushSubscription.upsert.mock.calls[0][0];
      expect(call.where).toEqual({ endpoint: 'https://push.example/shared' });
      expect(call.update).toMatchObject({ userId: 'u2', p256dh: 'p2', auth: 'a2' });
      expect(call.create).toMatchObject({ userId: 'u2' });
    });

    // Without userId in the where clause, anyone who learned an endpoint could
    // unsubscribe somebody else's device.
    it('only ever deletes the caller own rows', async () => {
      await build().removeSubscription('u1', 'https://push.example/s1');
      expect(prisma.pushSubscription.deleteMany).toHaveBeenCalledWith({
        where: { userId: 'u1', endpoint: 'https://push.example/s1' },
      });
    });
  });
});
