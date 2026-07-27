import { Module } from '@nestjs/common';
import { MinutesService } from './minutes.service';
import { ActionItemsService } from './action-items.service';
import { MinutesController } from './minutes.controller';
import { ActionItemsController } from './action-items.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CacheModule } from '../cache/cache.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [PrismaModule, AuditModule, CacheModule, NotificationsModule],
  providers: [MinutesService, ActionItemsService],
  controllers: [MinutesController, ActionItemsController],
  exports: [MinutesService, ActionItemsService],
})
export class MinutesModule {}
