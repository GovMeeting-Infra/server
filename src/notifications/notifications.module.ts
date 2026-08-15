import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { EmailProcessor } from './email.processor';
import { TasksService } from './tasks.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';
import { MinutesAccessService } from '../minutes/minutes-access.service';
import { UnsubscribeController } from './unsubscribe.controller';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { CacheModule } from '../cache/cache.module';

@Module({
  // 'notification-queue' used to be registered here and injected by
  // NotificationsService, but it had no processor and nothing ever added to it.
  // In-app notifications are written directly; only email goes through a queue.
  imports: [
    PrismaModule,
    MailModule,
    // CacheModule backs the rate limiter on the public unsubscribe route.
    CacheModule,
    BullModule.registerQueue({ name: 'email-queue' }),
  ],
  // MinutesAccessService is provided here rather than imported from
  // MinutesModule, which already imports this module — taking it the other way
  // would be circular. It holds no state and depends only on Prisma, so a
  // second instance costs nothing and avoids a forwardRef.
  providers: [
    NotificationsService,
    EmailProcessor,
    TasksService,
    MinutesAccessService,
    RateLimitGuard,
  ],
  controllers: [NotificationsController, UnsubscribeController],
  exports: [NotificationsService, TasksService],
})
export class NotificationsModule {}
