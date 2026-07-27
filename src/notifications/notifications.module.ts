import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsService } from './notifications.service';
import { NotificationsController } from './notifications.controller';
import { EmailProcessor } from './email.processor';
import { TasksService } from './tasks.service';
import { PrismaModule } from '../prisma/prisma.module';
import { MailModule } from '../mail/mail.module';

@Module({
  // 'notification-queue' used to be registered here and injected by
  // NotificationsService, but it had no processor and nothing ever added to it.
  // In-app notifications are written directly; only email goes through a queue.
  imports: [PrismaModule, MailModule, BullModule.registerQueue({ name: 'email-queue' })],
  providers: [NotificationsService, EmailProcessor, TasksService],
  controllers: [NotificationsController],
  exports: [NotificationsService, TasksService],
})
export class NotificationsModule {}
