import { Injectable, Logger } from '@nestjs/common';
import * as webpush from 'web-push';
import { PrismaService } from '../prisma/prisma.service';
import { CreatePushSubscriptionDto } from './dto/push-subscription.dto';

/** What a worker receives and shows. Mirrors the in-app notification row. */
export interface PushPayload {
  title: string;
  body: string;
  /** In-app destination, e.g. /administrative/events/abc. */
  link?: string;
  /**
   * Collapse key. The same alert arriving twice replaces itself on the device
   * rather than stacking, which matters for a reminder that several producers
   * can raise for one meeting.
   */
  tag?: string;
}

/**
 * Browser push: the one channel that reaches a phone nobody is looking at.
 *
 * Unconfigured is a supported state, the way Resend is. A deployment without
 * VAPID keys logs once at boot and then quietly does nothing — it must not
 * become a reason that publishing minutes fails, and it must not fill the log
 * with an error per recipient per notification.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);
  private readonly configured: boolean;

  constructor(private prisma: PrismaService) {
    const publicKey = process.env.VAPID_PUBLIC_KEY;
    const privateKey = process.env.VAPID_PRIVATE_KEY;
    // Identifies us to the push service so it has somebody to contact about a
    // misbehaving sender. A mailto: or an https: URL; the spec requires one.
    const subject = process.env.VAPID_SUBJECT;

    this.configured = Boolean(publicKey && privateKey && subject);

    if (this.configured) {
      webpush.setVapidDetails(subject!, publicKey!, privateKey!);
      this.logger.log('Push notifications configured');
    } else {
      this.logger.log(
        'Push notifications disabled: set VAPID_SUBJECT, VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY to enable',
      );
    }
  }

  get isConfigured(): boolean {
    return this.configured;
  }

  /**
   * Records a browser's subscription, or updates it if that endpoint is known.
   *
   * Keyed on the endpoint rather than on the user, and the update reassigns
   * userId on purpose. On a shared tablet, the second person to subscribe is
   * subscribing the same browser: the push service issues the same endpoint,
   * and the row must follow the person who now holds the device. Keeping it
   * against the first would send one person's meeting reminders to a device
   * somebody else is carrying.
   */
  async saveSubscription(
    userId: string,
    dto: CreatePushSubscriptionDto,
  ): Promise<void> {
    await (this.prisma as any).pushSubscription.upsert({
      where: { endpoint: dto.endpoint },
      create: {
        userId,
        endpoint: dto.endpoint,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: dto.userAgent ?? null,
      },
      update: {
        userId,
        p256dh: dto.keys.p256dh,
        auth: dto.keys.auth,
        userAgent: dto.userAgent ?? null,
        lastUsedAt: new Date(),
      },
    });
  }

  /**
   * Scoped to the caller's own rows.
   *
   * The endpoint is a bearer-ish string the client supplies, so without the
   * userId in the where clause this would let anyone who learned an endpoint
   * unsubscribe somebody else's device.
   */
  async removeSubscription(userId: string, endpoint: string): Promise<void> {
    await (this.prisma as any).pushSubscription.deleteMany({
      where: { userId, endpoint },
    });
  }

  /** How many devices this account currently has registered. */
  async countForUser(userId: string): Promise<number> {
    return (this.prisma as any).pushSubscription.count({ where: { userId } });
  }

  /**
   * Sends to every device this user has registered.
   *
   * Returns how many were accepted. Never throws: a notification is a side
   * effect of something else, and a push service having a bad afternoon must
   * not roll back publishing minutes.
   */
  async sendToUser(userId: string, payload: PushPayload): Promise<number> {
    if (!this.configured) return 0;

    let subscriptions: {
      id: string;
      endpoint: string;
      p256dh: string;
      auth: string;
    }[];
    try {
      subscriptions = await (this.prisma as any).pushSubscription.findMany({
        where: { userId },
        select: { id: true, endpoint: true, p256dh: true, auth: true },
      });
    } catch (error) {
      this.logger.error(
        `Could not read push subscriptions for ${userId}`,
        error,
      );
      return 0;
    }
    if (subscriptions.length === 0) return 0;

    const body = JSON.stringify(payload);
    const delivered: string[] = [];
    const dead: string[] = [];

    await Promise.all(
      subscriptions.map(async (subscription) => {
        try {
          await webpush.sendNotification(
            {
              endpoint: subscription.endpoint,
              keys: { p256dh: subscription.p256dh, auth: subscription.auth },
            },
            body,
          );
          delivered.push(subscription.id);
        } catch (error) {
          if (isGoneForever(error)) {
            dead.push(subscription.id);
          } else {
            this.logger.warn(
              `Push to ${subscription.id} failed: ${describe(error)}`,
            );
          }
        }
      }),
    );

    await this.prune(dead);
    await this.touch(delivered);

    return delivered.length;
  }

  /**
   * Deletes subscriptions the push service says are finished.
   *
   * 404 and 410 mean the endpoint will never answer again — the browser was
   * uninstalled, the site data cleared, the permission revoked. Without this
   * the table only grows and every future send retries against a corpse, which
   * is both a wasted request per device per notification and a slow leak of
   * rows that can never be used.
   */
  private async prune(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await (this.prisma as any).pushSubscription.deleteMany({
        where: { id: { in: ids } },
      });
      this.logger.log(`Pruned ${ids.length} expired push subscription(s)`);
    } catch (error) {
      this.logger.error('Failed pruning expired push subscriptions', error);
    }
  }

  private async touch(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    try {
      await (this.prisma as any).pushSubscription.updateMany({
        where: { id: { in: ids } },
        data: { lastUsedAt: new Date() },
      });
    } catch {
      // Bookkeeping only — never worth surfacing over a delivered message.
    }
  }
}

/**
 * Whether the push service is saying this endpoint is permanently gone.
 *
 * web-push throws WebPushError carrying the HTTP status. Anything else — a 429,
 * a 500, a socket that died — is temporary and the row must survive it, because
 * deleting on a transient failure silently unsubscribes a working device and
 * nobody finds out until they notice they stopped being told about meetings.
 */
function isGoneForever(error: unknown): boolean {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  return status === 404 || status === 410;
}

function describe(error: unknown): string {
  const status = (error as { statusCode?: number } | null)?.statusCode;
  const message = error instanceof Error ? error.message : String(error);
  return status ? `${status} ${message}` : message;
}
