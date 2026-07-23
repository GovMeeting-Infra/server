import {
  Injectable,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateMinistryDto } from './dto/create-ministry.dto';
import { UpdateMinistryDto } from './dto/update-ministry.dto';
import { ministryScope } from '../common/utils/ministry-scope.util';

@Injectable()
export class MinistriesService {
  private logger = new Logger('MinistriesService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async create(dto: CreateMinistryDto, userId: string, ministryId?: string) {
    try {
      const ministry = await (this.prisma as any).ministry.create({
        data: {
          name: dto.name,
          code: dto.code,
          emailDomain: dto.emailDomain,
        },
      });

      await this.audit.log({
        action: 'MINISTRY_CREATED',
        actionCategory: 'MINISTRY_MANAGEMENT',
        entityType: 'Ministry',
        entityId: ministry.id,
        entityName: ministry.name,
        status: 'SUCCESS',
        ministryId: ministryId || 'SYSTEM',
        actorId: userId,
        description: `Created ministry: ${ministry.name}`,
      });

      return ministry;
    } catch (error: any) {
      if (error.code === 'P2002') {
        const target = error.meta?.target?.[0];
        throw new ConflictException(
          `Ministry ${target} already exists`,
        );
      }
      throw error;
    }
  }

  async findAll(user: { systemRole: string; ministryId?: string }) {
    const where = ministryScope(user);
    return (this.prisma as any).ministry.findMany({
      where,
      orderBy: { name: 'asc' },
    });
  }

  async findOne(id: string) {
    const ministry = await (this.prisma as any).ministry.findUnique({
      where: { id },
    });

    if (!ministry) {
      throw new NotFoundException(`Ministry ${id} not found`);
    }

    return ministry;
  }

  async update(
    id: string,
    dto: UpdateMinistryDto,
    userId: string,
    userMinistryId?: string,
  ) {
    const ministry = await this.findOne(id);

    try {
      const updated = await (this.prisma as any).ministry.update({
        where: { id },
        data: dto,
      });

      await this.audit.log({
        action: 'MINISTRY_UPDATED',
        actionCategory: 'MINISTRY_MANAGEMENT',
        entityType: 'Ministry',
        entityId: ministry.id,
        entityName: updated.name,
        status: 'SUCCESS',
        ministryId: userMinistryId || 'SYSTEM',
        actorId: userId,
        description: `Updated ministry: ${ministry.name}`,
        changes: dto as unknown as Record<string, unknown>,
      });

      return updated;
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new ConflictException('Ministry code or name already exists');
      }
      throw error;
    }
  }

  async delete(id: string, userId: string, userMinistryId?: string) {
    const ministry = await this.findOne(id);

    await (this.prisma as any).ministry.delete({
      where: { id },
    });

    await this.audit.log({
      action: 'MINISTRY_DELETED',
      actionCategory: 'MINISTRY_MANAGEMENT',
      entityType: 'Ministry',
      entityId: ministry.id,
      entityName: ministry.name,
      status: 'SUCCESS',
      ministryId: userMinistryId || 'SYSTEM',
      actorId: userId,
      description: `Deleted ministry: ${ministry.name}`,
    });

    return { success: true };
  }
}
