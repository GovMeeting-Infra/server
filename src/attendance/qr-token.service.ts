import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes } from 'crypto';

/** How long a scannable token stays valid. */
const TOKEN_TTL_MS = 5 * 60 * 1000;

/**
 * Reuse an existing token only while it has comfortably more life than this.
 * Handing back a token about to expire means the attendee's scan dies mid-form.
 */
const REUSE_MIN_REMAINING_MS = 60 * 1000;

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
   * Return the live token, minting a fresh one when there is none, when the
   * current one is nearly dead, or when `force` is set. Only ever reached from
   * an explicit POST.
   */
  async ensureActiveToken(
    eventId: string,
    opts: { force?: boolean } = {},
    tx?: any,
  ): Promise<{ token: string; expiresAt: Date }> {
    const db = tx ?? this.prisma;

    if (!opts.force) {
      const cutoff = new Date(Date.now() + REUSE_MIN_REMAINING_MS);
      const existing = await (db as any).qRToken.findFirst({
        where: { eventId, expiresAt: { gt: cutoff } },
        orderBy: { expiresAt: 'desc' },
      });
      if (existing) {
        return { token: existing.token, expiresAt: existing.expiresAt };
      }
    }

    return this.mintToken(eventId, db);
  }

  async mintToken(
    eventId: string,
    tx?: any,
  ): Promise<{ token: string; expiresAt: Date }> {
    const db = tx ?? this.prisma;
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);

    const qrToken = await (db as any).qRToken.create({
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
