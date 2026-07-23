import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import {
  ministryScope,
  assertSameMinistry,
} from '../common/utils/ministry-scope.util';
import { auth } from '../auth/auth.config';
import { hashPassword } from 'better-auth/crypto';
import { v4 as uuid } from 'uuid';

@Injectable()
export class UsersService {
  private logger = new Logger('UsersService');

  constructor(
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  async create(
    dto: CreateUserDto,
    ministryId: string,
    userId: string,
    userMinistryId?: string,
  ) {
    if (dto.systemRole === 'SUPER_ADMIN' && userMinistryId) {
      throw new ForbiddenException(
        'Only SUPER_ADMIN can create SUPER_ADMIN users',
      );
    }

    const tempPassword = this.generateTempPassword();
    const hashedPassword = await hashPassword(tempPassword);

    try {
      const user = await (this.prisma as any).user.create({
        data: {
          email: dto.email.toLowerCase(),
          name: dto.name,
          jobTitle: dto.jobTitle,
          systemRole: dto.systemRole,
          ministryId: dto.systemRole === 'SUPER_ADMIN' ? null : ministryId,
          active: true,
        },
      });

      await (this.prisma as any).account.create({
        data: {
          userId: user.id,
          accountId: uuid(),
          providerId: 'credential',
          password: hashedPassword,
        },
      });

      await (this.prisma as any).userPreferences.create({
        data: {
          userId: user.id,
        },
      });

      await this.audit.log({
        action: 'USER_CREATED',
        actionCategory: 'USER_MANAGEMENT',
        entityType: 'User',
        entityId: user.id,
        entityName: user.email,
        status: 'SUCCESS',
        ministryId: userMinistryId || 'SYSTEM',
        actorId: userId,
        description: `Created user: ${user.email}`,
      });

      return {
        id: user.id,
        email: user.email,
        name: user.name,
        systemRole: user.systemRole,
        tempPassword,
      };
    } catch (error: any) {
      if (error.code === 'P2002') {
        throw new ConflictException('Email already exists');
      }
      throw error;
    }
  }

  async findAll(user: { systemRole: string; ministryId?: string }) {
    const where = ministryScope(user);

    return (this.prisma as any).user.findMany({
      where: {
        ...where,
        deletedAt: null,
      },
      select: {
        id: true,
        email: true,
        name: true,
        jobTitle: true,
        systemRole: true,
        ministryId: true,
        active: true,
        createdAt: true,
      },
      orderBy: { email: 'asc' },
    });
  }

  async findOne(id: string) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        name: true,
        jobTitle: true,
        systemRole: true,
        ministryId: true,
        active: true,
      },
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    return user;
  }

  async updateRole(
    id: string,
    dto: UpdateUserRoleDto,
    actorId: string,
    actorMinistryId?: string,
  ) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    assertSameMinistry(
      { systemRole: 'SUPER_ADMIN', ministryId: actorMinistryId },
      user.ministryId,
    );

    const updated = await (this.prisma as any).user.update({
      where: { id },
      data: { systemRole: dto.systemRole },
      select: {
        id: true,
        email: true,
        systemRole: true,
      },
    });

    await this.audit.log({
      action: 'USER_ROLE_UPDATED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description: `Updated user role to ${dto.systemRole}`,
      changes: { systemRole: dto.systemRole },
    });

    return updated;
  }

  async deactivate(
    id: string,
    actorId: string,
    actorMinistryId?: string,
  ) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    assertSameMinistry(
      { systemRole: 'SUPER_ADMIN', ministryId: actorMinistryId },
      user.ministryId,
    );

    const updated = await (this.prisma as any).user.update({
      where: { id },
      data: { active: false },
      select: {
        id: true,
        email: true,
        active: true,
      },
    });

    await this.audit.log({
      action: 'USER_DEACTIVATED',
      actionCategory: 'USER_MANAGEMENT',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description: `Deactivated user: ${user.email}`,
      changes: { active: false },
    });

    return updated;
  }

  async anonymize(id: string, actorId: string, actorMinistryId?: string) {
    const user = await (this.prisma as any).user.findUnique({
      where: { id },
    });

    if (!user) {
      throw new NotFoundException(`User ${id} not found`);
    }

    assertSameMinistry(
      { systemRole: 'SUPER_ADMIN', ministryId: actorMinistryId },
      user.ministryId,
    );

    const anonEmail = `anonymous-${uuid()}@ministry.local`;

    const updated = await (this.prisma as any).user.update({
      where: { id },
      data: {
        email: anonEmail,
        name: 'Anonymous',
        jobTitle: '',
        deletedAt: new Date(),
      },
    });

    await (this.prisma as any).account.deleteMany({
      where: { userId: id },
    });

    await (this.prisma as any).attendance.updateMany({
      where: { userId: id },
      data: {
        signedName: 'Anonymous',
        signature: '',
        lat: null,
        lng: null,
      },
    });

    await (this.prisma as any).notification.deleteMany({
      where: { userId: id },
    });

    await this.audit.log({
      action: 'USER_ANONYMIZED',
      actionCategory: 'GDPR_COMPLIANCE',
      entityType: 'User',
      entityId: user.id,
      entityName: user.email,
      status: 'SUCCESS',
      ministryId: actorMinistryId || 'SYSTEM',
      actorId,
      description: `Anonymized user data (GDPR right-to-be-forgotten): ${user.email}`,
    });

    return {
      id: updated.id,
      anonymized: true,
      timestamp: updated.deletedAt,
    };
  }

  private generateTempPassword(): string {
    const chars =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%';
    let password = '';
    for (let i = 0; i < 12; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }
}
