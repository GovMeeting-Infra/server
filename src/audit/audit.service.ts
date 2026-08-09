import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string;
  entityName?: string;
  status: 'SUCCESS' | 'FAILURE' | 'PARTIAL';
  ministryId?: string;
  actorId?: string;
  actionCategory?: string;
  description?: string;
  changes?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

@Injectable()
export class AuditService {
  private logger = new Logger('AuditService');

  constructor(private prisma: PrismaService) {}

  async log(entry: AuditEntry): Promise<void> {
    try {
      await (this.prisma as any).auditLog.create({
        data: {
          action: entry.action,
          actionCategory: entry.actionCategory || entry.action,
          entityType: entry.entityType,
          entityId: entry.entityId,
          entityName: entry.entityName,
          status: entry.status,
          // null, not 'SYSTEM'. There is no ministry with that id, so the
          // insert violated the foreign key and was swallowed by the catch
          // below — failed sign-ins, password changes and accepted invitations
          // were never recorded once.
          ministryId: entry.ministryId || null,
          actorId: entry.actorId,
          description: entry.description,
          changes: entry.changes as any,
          metadata: entry.metadata as any,
          ipAddress: entry.ipAddress,
          userAgent: entry.userAgent,
          requestId: entry.requestId,
        },
      });
    } catch (error) {
      this.logger.error(`Audit log failed: ${(error as Error).message}`);
    }
  }

  /**
   * The activity log.
   *
   * Ministers see their own ministry. Super-admins see everything, including
   * the platform-level entries that belong to no ministry — a failed sign-in
   * for an unknown address has no ministry to file it under, and those are
   * precisely the entries worth surfacing to whoever runs the platform.
   */
  async list(
    viewer: { systemRole: string; ministryId?: string | null },
    opts: {
      q?: string;
      category?: string;
      status?: string;
      actorId?: string;
      from?: string;
      to?: string;
      /** Super-admins only. 'none' isolates entries belonging to no ministry. */
      ministryId?: string;
      skip?: number;
      take?: number;
    } = {},
  ) {
    const isPlatformWide = viewer.systemRole === 'SUPER_ADMIN';
    const take = Math.min(opts.take ?? 50, 200);
    const skip = opts.skip ?? 0;
    const term = opts.q?.trim();

    const createdAt: Record<string, Date> = {};
    if (opts.from && !Number.isNaN(Date.parse(opts.from))) {
      createdAt.gte = new Date(opts.from);
    }
    if (opts.to && !Number.isNaN(Date.parse(opts.to))) {
      createdAt.lte = new Date(opts.to);
    }

    const where: any = {
      // Never `undefined` here: Prisma drops an undefined filter, which would
      // turn "a minister with no ministry" into "every ministry". null matches
      // nothing, which is the safe reading.
      //
      // A minister's clause is derived from their own record and a ministryId
      // on the URL is discarded — otherwise editing the query string would read
      // another ministry's log. Only the platform-wide view honours it.
      ...(isPlatformWide
        ? this.ministryFilter(opts.ministryId)
        : { ministryId: viewer.ministryId ?? null }),
      ...(opts.category ? { actionCategory: opts.category } : {}),
      ...(opts.status ? { status: opts.status } : {}),
      ...(opts.actorId ? { actorId: opts.actorId } : {}),
      ...(Object.keys(createdAt).length ? { createdAt } : {}),
      ...(term
        ? {
            OR: [
              { action: { contains: term, mode: 'insensitive' } },
              { description: { contains: term, mode: 'insensitive' } },
              { entityName: { contains: term, mode: 'insensitive' } },
              { entityType: { contains: term, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      (this.prisma as any).auditLog.findMany({
        where,
        select: {
          id: true,
          createdAt: true,
          action: true,
          actionCategory: true,
          entityType: true,
          entityId: true,
          entityName: true,
          status: true,
          description: true,
          ipAddress: true,
          actor: { select: { id: true, name: true, email: true } },
          ministry: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      (this.prisma as any).auditLog.count({ where }),
    ]);

    return { data, total, scope: isPlatformWide ? 'all' : 'ministry' };
  }

  /**
   * The ministry clause for a platform-wide viewer.
   *
   * Nothing selected means every ministry, as before. 'none' means the entries
   * that belong to none — a failed sign-in for an unknown address has no
   * ministry to file it under, and those are worth being able to isolate.
   */
  private ministryFilter(ministryId?: string): Record<string, unknown> {
    if (!ministryId) return {};
    if (ministryId === 'none') return { ministryId: null };
    return { ministryId };
  }

  /** The distinct categories present, for the filter control. */
  async categories(
    viewer: { systemRole: string; ministryId?: string | null },
    ministryId?: string,
  ) {
    const rows = await (this.prisma as any).auditLog.findMany({
      where:
        viewer.systemRole === 'SUPER_ADMIN'
          ? this.ministryFilter(ministryId)
          : { ministryId: viewer.ministryId ?? null },
      select: { actionCategory: true },
      distinct: ['actionCategory'],
      orderBy: { actionCategory: 'asc' },
    });

    return rows.map((r: { actionCategory: string }) => r.actionCategory);
  }
}
