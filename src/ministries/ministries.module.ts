import { Module } from '@nestjs/common';
import { MinistriesService } from './ministries.service';
import { MinistriesController } from './ministries.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
// Creating a ministry can create its first administrator, who needs an invite.
import { InvitesModule } from '../invites/invites.module';

@Module({
  imports: [PrismaModule, AuditModule, InvitesModule],
  providers: [MinistriesService],
  controllers: [MinistriesController],
  exports: [MinistriesService],
})
export class MinistriesModule {}
