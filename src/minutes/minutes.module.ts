import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MinutesService } from './minutes.service';
import { ActionItemsService } from './action-items.service';
import { MinutesAccessService } from './minutes-access.service';
import { GuestMinutesController } from './guest-minutes.controller';
import { MinutesController } from './minutes.controller';
import { MinutesListController } from './minutes-list.controller';
import { ActionItemsController } from './action-items.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CacheModule } from '../cache/cache.module';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    CacheModule,
    NotificationsModule,
    BullModule.registerQueue({ name: 'email-queue' }),
  ],
  providers: [MinutesService, ActionItemsService, MinutesAccessService],
  controllers: [
    MinutesController,
    MinutesListController,
    ActionItemsController,
    GuestMinutesController,
  ],
  exports: [MinutesService, ActionItemsService, MinutesAccessService],
})
export class MinutesModule {}
