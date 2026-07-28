import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  // Deliberately does not import AuthModule for RolesGuard: AuthModule imports
  // AuditModule, so that would be a cycle. The guard only needs Reflector,
  // which is global, so @UseGuards(RolesGuard) resolves without the import —
  // the same way UsersModule and the others use it.
  imports: [PrismaModule],
  providers: [AuditService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}
