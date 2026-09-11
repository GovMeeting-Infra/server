import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes } from 'crypto';

@Injectable()
export class QRTokenService {
  private logger = new Logger('QRTokenService');

  constructor(private prisma: PrismaService) {}

  /**
   * Read-only lookup of the live token, or null.
   *
   * Kept strictly free of writes: the host screen polls this, and minting as a
   * side effect of a read is what previously produced an unbounded stream of
   * tokens just from leaving the page open.
   */
  async findActiveToken(
    eventId: string,
  ): Promise<{ token: string; expiresAt: Date } | null> {
    const existing = await (this.prisma as any).qRToken.findFirst({
      where: { eventId, expiresAt: { gt: new Date() } },
      orderBy: { expiresAt: 'desc' },
    });

    if (!existing) return null;
    return { token: existing.token, expiresAt: existing.expiresAt };
  }

  /**
   * The event's code, minting one the first time and whenever `force` is set.
   *
   * One code per meeting. It used to last five minutes and be replaced over and
   * over, which put the organizer in charge of a clock: anybody who arrived
   * while the screen showed a dead code could not get in, and somebody had to
   * be watching the countdown for that not to happen. The fence is what keeps a
   * photographed code from being useful elsewhere — an attendee has to be
   * inside the check-in area — so expiring the code every five minutes was
   * buying very little and costing exactly the people it was meant to admit.
   *
   * `expiresAt` is the meeting's own end, which is the moment check-in closes
   * anyway: resolveOpenEvent refuses a scan once endAt has passed, whatever the
   * token says. The token's expiry is now the same line rather than a second,
   * stricter one behind it.
   */
  async ensureActiveToken(
    eventId: string,
    expiresAt: Date,
    opts: { force?: boolean } = {},
    tx?: any,
  ): Promise<{ token: string; expiresAt: Date }> {
    const db = tx ?? this.prisma;

    if (!opts.force) {
      const existing = await db.qRToken.findFirst({
        where: { eventId, expiresAt: { gt: new Date() } },
        orderBy: { expiresAt: 'desc' },
      });
      if (existing) {
        return { token: existing.token, expiresAt: existing.expiresAt };
      }
    }

    return this.mintToken(eventId, expiresAt, db);
  }

  async mintToken(
    eventId: string,
    expiresAt: Date,
    tx?: any,
  ): Promise<{ token: string; expiresAt: Date }> {
    const db = tx ?? this.prisma;
    const token = randomBytes(24).toString('base64url');

    const qrToken = await db.qRToken.create({
      data: { eventId, token, expiresAt, rotatedAt: new Date() },
    });

    return { token: qrToken.token, expiresAt: qrToken.expiresAt };
  }

  /**
   * The token row, or null when unknown. Returns the row rather than just the
   * eventId so callers can tell "never existed" from "expired" — the check-in
   * page renders a different message for each.
   */
  async findToken(
    token: string,
  ): Promise<{ eventId: string; expiresAt: Date } | null> {
    const row = await (this.prisma as any).qRToken.findUnique({
      where: { token },
    });

    if (!row) return null;
    return { eventId: row.eventId, expiresAt: row.expiresAt };
  }

  /** Expire every live token for an event, closing check-in immediately. */
  async expireTokens(eventId: string): Promise<number> {
    const now = new Date();
    const result = await (this.prisma as any).qRToken.updateMany({
      where: { eventId, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
    return result.count;
  }
}
