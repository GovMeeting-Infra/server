import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Who gets a copy of published minutes, and how someone without an account
 * opens them.
 *
 * Recipients are a union of two tables rather than one, because attendance and
 * invitation are not the same thing here: a walk-in was in the room without ever
 * appearing on the invite list, and someone who declined was on the list without
 * ever being in the room.
 */
export interface MinutesRecipient {
  /** Null for someone with no account, who is reachable only by email. */
  userId: string | null;
  email: string | null;
  name: string;
}

@Injectable()
export class MinutesAccessService {
  private logger = new Logger('MinutesAccessService');

  constructor(private prisma: PrismaService) {}

  /**
   * Only the sha256 is stored, matching InvitesService — a database read
   * yields no usable link.
   */
  private hash(token: string) {
    return createHash('sha256').update(token).digest('hex');
  }

  private linkFor(token: string) {
    const base =
      process.env.WEB_URL ??
      process.env.NEXT_PUBLIC_WEB_URL ??
      'http://localhost:3000';
    return `${base}/guest/minutes/${token}`;
  }

  /**
   * Everyone entitled to the record: invited minus declines, plus walk-ins.
   *
   * Deduped by account id where there is one and by lowercased email otherwise,
   * so somebody who was both invited and checked in is counted once.
   */
  async recipientsFor(eventId: string): Promise<MinutesRecipient[]> {
    const [invited, walkIns] = await Promise.all([
      (this.prisma as any).eventAttendee.findMany({
        where: { eventId, status: { not: 'DECLINED' } },
        select: {
          userId: true,
          externalName: true,
          externalEmail: true,
          user: { select: { id: true, name: true, email: true } },
        },
      }),
      (this.prisma as any).attendance.findMany({
        where: { eventId, isWalkIn: true },
        select: {
          userId: true,
          guestName: true,
          guestEmail: true,
          signedName: true,
          user: { select: { id: true, name: true, email: true } },
        },
      }),
    ]);

    const byKey = new Map<string, MinutesRecipient>();

    const add = (r: MinutesRecipient) => {
      const key = r.userId ?? r.email?.toLowerCase();
      if (!key) return;
      if (!byKey.has(key)) byKey.set(key, r);
    };

    for (const a of invited) {
      add({
        userId: a.user?.id ?? null,
        email: a.user?.email ?? a.externalEmail ?? null,
        name: a.user?.name ?? a.externalName ?? 'Colleague',
      });
    }

    for (const w of walkIns) {
      add({
        userId: w.user?.id ?? null,
        email: w.user?.email ?? w.guestEmail ?? null,
        name: w.user?.name ?? w.guestName ?? w.signedName ?? 'Colleague',
      });
    }

    return [...byKey.values()];
  }

  /**
   * A link for someone with no account. Reissuing returns a fresh token and
   * invalidates the previous one, so a link cannot outlive a correction to who
   * was on the list.
   */
  async issueGuestLink(minutesId: string, email: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const normalized = email.trim().toLowerCase();

    await (this.prisma as any).minutesAccessToken.upsert({
      where: { minutesId_email: { minutesId, email: normalized } },
      create: { minutesId, email: normalized, tokenHash: this.hash(token) },
      update: { tokenHash: this.hash(token) },
    });

    return this.linkFor(token);
  }

  /**
   * Resolve a guest token to the record it opens.
   *
   * Every failure — unknown token, unpublished minutes, archived minutes —
   * raises the same NotFoundException, so holding a token tells you nothing
   * about what exists. Archiving is what ends access: there is no expiry column
   * to drift out of step with the retention rule.
   */
  async resolveToken(token: string) {
    const record = await (this.prisma as any).minutesAccessToken.findUnique({
      where: { tokenHash: this.hash(token) },
      select: {
        email: true,
        minutes: {
          select: {
            id: true,
            points: { orderBy: [{ type: 'asc' }, { order: 'asc' }] },
            status: true,
            publishedAt: true,
            event: {
              select: {
                id: true,
                title: true,
                startAt: true,
                endAt: true,
                venueName: true,
                organizerId: true,
                ministry: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    if (!record || record.minutes.status !== 'PUBLISHED') {
      throw new NotFoundException('These minutes are not available');
    }

    return record;
  }
}
