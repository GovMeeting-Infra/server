import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { InvitesService } from '../invites/invites.service';
import { CreateMinistryDto } from './dto/create-ministry.dto';
import { UpdateMinistryDto } from './dto/update-ministry.dto';
import { ministryScope } from '../common/utils/ministry-scope.util';

@Injectable()
export class MinistriesService {
  private logger = new Logger('MinistriesService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
    private invites: InvitesService,
  ) {}

  async create(dto: CreateMinistryDto, userId: string, ministryId?: string) {
    const emailDomain = dto.emailDomain.toLowerCase().trim();
    const firstAdminEmail = dto.firstAdmin?.email.toLowerCase().trim();

    // Checked before the ministry is written, so a bad address does not leave
    // an adminless ministry behind.
    if (
      firstAdminEmail &&
      !firstAdminEmail.endsWith(`@${emailDomain}`) &&
      !firstAdminEmail.endsWith(`.${emailDomain}`)
    ) {
      throw new BadRequestException(
        `The first administrator's email must be on the ministry's own domain (@${emailDomain})`,
      );
    }

    let ministry: any;

    try {
      ministry = await (this.prisma as any).ministry.create({
        data: {
          name: dto.name.trim(),
          // PRD §8: codes are uppercase. Normalising here rather than trusting
          // the caller keeps the unique index from holding both MOH and moh.
          code: dto.code.toUpperCase().trim(),
          emailDomain,
          // compoundMaxGpsAccuracy is left at its schema default. Nothing reads
          // it — the geofence is fixed platform-wide in
          // attendance/geofence.constants.ts.
          ...(dto.logoUrl !== undefined && { logoUrl: dto.logoUrl }),
        },
      });
    } catch (error: any) {
      if (error.code === 'P2002') {
        const target = error.meta?.target?.[0];
        throw new ConflictException(`Ministry ${target} already exists`);
      }
      throw error;
    }

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

    if (!dto.firstAdmin) {
      return ministry;
    }

    const firstAdmin = await this.createFirstAdmin(
      ministry,
      { ...dto.firstAdmin, email: firstAdminEmail! },
      userId,
    );

    return { ...ministry, firstAdmin };
  }

  /**
   * Creates the ministry's first MINISTRY_ADMIN and sends their invitation.
   *
   * Deliberately not inside a transaction with the ministry: issuing the invite
   * sends mail, and a rollback cannot unsend it. If this fails the ministry
   * still exists and an administrator can be added from the users page, so the
   * error is reported rather than swallowed but the ministry is not lost.
   */
  private async createFirstAdmin(
    ministry: { id: string; name: string },
    admin: { email: string; name: string; jobTitle: string },
    actorId: string,
  ) {
    try {
      const user = await (this.prisma as any).user.create({
        data: {
          email: admin.email,
          name: admin.name,
          jobTitle: admin.jobTitle,
          systemRole: 'MINISTRY_ADMIN',
          ministryId: ministry.id,
          active: true,
        },
      });

      await (this.prisma as any).userPreferences.create({
        data: { userId: user.id },
      });

      await this.audit.log({
        action: 'USER_CREATED',
        actionCategory: 'USER_MANAGEMENT',
        entityType: 'User',
        entityId: user.id,
        entityName: user.email,
        status: 'SUCCESS',
        ministryId: ministry.id,
        actorId,
        description: `Created first administrator for ${ministry.name}: ${user.email}`,
      });

      const invite = await this.invites.issue(user.id, actorId, ministry.id);

      return { id: user.id, email: user.email, invite };
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new ConflictException(
          `${ministry.name} was created, but ${admin.email} already exists — add the administrator from the users page`,
        );
      }
      throw error;
    }
  }

  async findAll(user: { systemRole: string; ministryId?: string }) {
    const where = ministryScope(user);
    return (this.prisma as any).ministry.findMany({
      where,
      // The admin page shows how many accounts a ministry holds, which is what
      // makes deactivating it a decision rather than a guess.
      include: { _count: { select: { users: true, events: true } } },
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

      // Sign-in already refuses a deactivated ministry, and getSession refuses
      // one on every request. Cutting the sessions here is what makes it
      // immediate rather than "at some point": deactivating a ministry is
      // usually a response to something, not routine housekeeping.
      if (dto.active === false && ministry.active) {
        const { count } = await (this.prisma as any).session.deleteMany({
          where: { user: { ministryId: id } },
        });
        this.logger.log(
          `Deactivated ${ministry.name}: ended ${count} session(s)`,
        );
      }

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
