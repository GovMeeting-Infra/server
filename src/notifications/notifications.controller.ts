import {
  Controller,
  Get,
  Patch,
  Delete,
  Param,
  Query,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('Notifications')
@ApiBearerAuth()
@Controller('api/v1/notifications')
@UseGuards(RolesGuard)
export class NotificationsController {
  constructor(private notificationsService: NotificationsService) {}

  @Get()
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getNotifications(
    @CurrentUser() user: any,
    @Query('limit') limit?: string,
    @Query('includeRead') includeRead?: string,
    @Query('skip') skip?: string,
  ) {
    // Clamped rather than trusted: limit reaches Prisma's `take` directly, and
    // an unbounded one from the query string is a way to ask for every
    // notification a busy account has ever received.
    const parsedLimit = limit ? parseInt(limit, 10) : 20;
    const limitNum =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(parsedLimit, 100)
        : 20;

    const parsedSkip = skip ? parseInt(skip, 10) : 0;
    const skipNum =
      Number.isFinite(parsedSkip) && parsedSkip > 0 ? parsedSkip : 0;

    return this.notificationsService.getUserNotifications(
      user.id,
      limitNum,
      includeRead === 'true',
      skipNum,
    );
  }

  /** Declared before ':notificationId' routes so it is not read as an id. */
  @Get('unread-count')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getUnreadCount(@CurrentUser() user: any) {
    return { unread: await this.notificationsService.countUnread(user.id) };
  }

  @Patch(':notificationId/read')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async markAsRead(
    @Param('notificationId') notificationId: string,
    @CurrentUser() user: any,
  ) {
    return this.notificationsService.markAsRead(notificationId, user.id);
  }

  @Patch('mark-all-read')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async markAllAsRead(@CurrentUser() user: any) {
    return this.notificationsService.markAllAsRead(user.id);
  }

  @Delete(':notificationId')
  @HttpCode(204)
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async deleteNotification(
    @Param('notificationId') notificationId: string,
    @CurrentUser() user: any,
  ) {
    await this.notificationsService.deleteNotification(notificationId, user.id);
  }

  @Delete()
  @HttpCode(204)
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async deleteAllNotifications(@CurrentUser() user: any) {
    await this.notificationsService.deleteAllUserNotifications(user.id);
  }
}
