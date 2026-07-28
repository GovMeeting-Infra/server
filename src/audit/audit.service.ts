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
          ministryId: entry.ministryId || 'SYSTEM',
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
}
