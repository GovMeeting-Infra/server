import { Module } from '@nestjs/common';
import { MinutesService } from './minutes.service';
import { ActionItemsService } from './action-items.service';
import { MinutesController } from './minutes.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';

@Module({
  imports: [PrismaModule, AuditModule],
  providers: [MinutesService, ActionItemsService],
  controllers: [MinutesController],
  exports: [MinutesService, ActionItemsService],
})
export class MinutesModule {}
