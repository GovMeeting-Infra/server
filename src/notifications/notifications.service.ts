import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { InjectQueue } from '@nestjs/bullmq';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class NotificationsService {
  private logger = new Logger('NotificationsService');

  constructor(
    private prisma: PrismaService,
    @InjectQueue('notification-queue') private notificationQueue: Queue,
  ) {}

  async createNotification(
    userId: string,
    title: string,
    body: string,
    type: string,
    relatedEntityId?: string,
  ) {
    try {
      const notification = await (this.prisma as any).notification.create({
        data: {
          userId,
          title,
          body,
          type,
          relatedEntityId,
          read: false,
        },
      });

      this.logger.log(`Created notification for user ${userId}: ${title}`);
      return notification;
    } catch (error) {
      this.logger.error('Error creating notification', error);
      throw error;
    }
  }

  async getUserNotifications(
    userId: string,
    limit = 20,
    includeRead = false,
  ) {
    const where: any = { userId };

    if (!includeRead) {
      where.read = false;
    }

    return await (this.prisma as any).notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async markAsRead(notificationId: string) {
    return await (this.prisma as any).notification.update({
      where: { id: notificationId },
      data: { read: true, readAt: new Date() },
    });
  }

  async markAllAsRead(userId: string) {
    return await (this.prisma as any).notification.updateMany({
      where: { userId, read: false },
      data: { read: true, readAt: new Date() },
    });
  }

  async queueMeetingInvitation(eventId: string, userIds: string[]) {
    this.logger.log(
      `Queueing meeting invitations for event ${eventId} to ${userIds.length} users`,
    );
    await (this.prisma as any).emailQueue.add('send-meeting-invitation', {
      eventId,
      userIds,
    });
  }

  async queueActionItemAssigned(actionItemId: string, ownerId: string) {
    this.logger.log(
      `Queueing action item assigned notification for item ${actionItemId}`,
    );

    const actionItem = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
    });

    if (!actionItem) {
      this.logger.warn(`Action item ${actionItemId} not found`);
      return;
    }

    await this.createNotification(
      ownerId,
      'Action Item Assigned',
      `You've been assigned: ${actionItem.title}`,
      'ACTION_ITEM_ASSIGNED',
      actionItemId,
    );
  }

  async queueActionItemStatusChanged(actionItemId: string, newStatus: string) {
    this.logger.log(
      `Queueing action item status change for item ${actionItemId}: ${newStatus}`,
    );

    const actionItem = await (this.prisma as any).actionItem.findUnique({
      where: { id: actionItemId },
      include: { owner: true },
    });

    if (!actionItem) {
      this.logger.warn(`Action item ${actionItemId} not found`);
      return;
    }

    if (actionItem.owner) {
      await this.createNotification(
        actionItem.owner.id,
        'Action Item Status Updated',
        `Status of "${actionItem.title}" changed to ${newStatus}`,
        'ACTION_ITEM_STATUS_CHANGED',
        actionItemId,
      );
    }
  }

  async queueMinutesPublished(eventId: string) {
    this.logger.log(
      `Queueing minutes published notification for event ${eventId}`,
    );

    const event = await (this.prisma as any).event.findUnique({
      where: { id: eventId },
      include: { attendees: { include: { user: true } } },
    });

    if (!event) {
      this.logger.warn(`Event ${eventId} not found`);
      return;
    }

    for (const attendee of event.attendees) {
      if (attendee.user) {
        await this.createNotification(
          attendee.user.id,
          'Minutes Published',
          `Minutes for "${event.title}" have been published`,
          'MINUTES_PUBLISHED',
          eventId,
        );
      }
    }
  }

  async deleteNotification(notificationId: string) {
    return await (this.prisma as any).notification.delete({
      where: { id: notificationId },
    });
  }

  async deleteAllUserNotifications(userId: string) {
    return await (this.prisma as any).notification.deleteMany({
      where: { userId },
    });
  }
}
