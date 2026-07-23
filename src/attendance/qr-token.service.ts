import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { randomBytes } from 'crypto';

@Injectable()
export class QRTokenService {
  private logger = new Logger('QRTokenService');

  constructor(private prisma: PrismaService) {}

  async getActiveToken(eventId: string): Promise<{ token: string; expiresAt: Date }> {
    const now = new Date();
    const thirtySecondsFromNow = new Date(now.getTime() + 30 * 1000);

    const existing = await (this.prisma as any).qRToken.findFirst({
      where: {
        eventId,
        expiresAt: { gt: thirtySecondsFromNow },
      },
    });

    if (existing) {
      return { token: existing.token, expiresAt: existing.expiresAt };
    }

    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes

    const qrToken = await (this.prisma as any).qRToken.create({
      data: { eventId, token, expiresAt },
    });

    return { token: qrToken.token, expiresAt: qrToken.expiresAt };
  }

  async validateToken(token: string): Promise<string | null> {
    const qrToken = await (this.prisma as any).qRToken.findUnique({
      where: { token },
    });

    if (!qrToken) return null;
    if (qrToken.expiresAt < new Date()) return null;

    return qrToken.eventId;
  }

  async rotateToken(eventId: string): Promise<{ token: string; expiresAt: Date }> {
    const now = new Date();
    const token = randomBytes(24).toString('base64url');
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000);

    const qrToken = await (this.prisma as any).qRToken.create({
      data: { eventId, token, expiresAt },
    });

    return { token: qrToken.token, expiresAt: qrToken.expiresAt };
  }
}
