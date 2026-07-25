import { Module } from '@nestjs/common';
import { EventsService } from './events.service';
import { EventsRepository } from './events.repository';
import { EventSeriesService } from './event-series.service';
import { EventsController } from './events.controller';
import { PublicEventsController } from './public-events.controller';
import { CanManageEventGuard } from './guards/can-manage-event.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { AuditModule } from '../audit/audit.module';
import { CacheModule } from '../cache/cache.module';

@Module({
  imports: [PrismaModule, AuditModule, CacheModule],
  providers: [
    EventsService,
    EventsRepository,
    EventSeriesService,
    CanManageEventGuard,
  ],
  // PublicEventsController is listed before EventsController only for clarity;
  // they occupy different path prefixes so order is not significant.
  controllers: [PublicEventsController, EventsController],
  exports: [EventsService, EventSeriesService],
})
export class EventsModule {}
