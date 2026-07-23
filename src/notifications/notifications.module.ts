import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { EmailProcessor } from './email.processor';
import { TasksService } from './tasks.service';
import { PrismaModule } from '../prisma/prisma.module';

@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue(
      { name: 'email-queue' },
      { name: 'notification-queue' },
    ),
  ],
  providers: [NotificationsService, EmailProcessor, TasksService],
  controllers: [NotificationsController],
  exports: [NotificationsService, TasksService],
})
export class NotificationsModule {}
