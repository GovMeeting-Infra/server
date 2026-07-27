import {
  Controller,
  Post,
  Patch,
  Get,
  Body,
  Param,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { MinutesService } from './minutes.service';
import { ActionItemsService } from './action-items.service';
import { CreateMinutesDto } from './dto/create-minutes.dto';
import { UpdateMinutesDto } from './dto/update-minutes.dto';
import { CreateActionItemDto } from './dto/create-action-item.dto';
import { UpdateActionItemDto } from './dto/update-action-item.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

@ApiTags('Minutes & Action Items')
@ApiBearerAuth()
@Controller('api/v1/events/:eventId')
@UseGuards(RolesGuard)
export class MinutesController {
  constructor(
    private minutesService: MinutesService,
    private actionItemsService: ActionItemsService,
  ) {}

  @Post('minutes')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async draftMinutes(
    @Param('eventId') eventId: string,
    @Body() dto: CreateMinutesDto,
    @CurrentUser() user: any,
  ) {
    return this.minutesService.draftMinutes(
      eventId,
      dto,
      user.id,
      user.ministryId,
    );
  }

  @Patch('minutes')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async updateMinutes(
    @Param('eventId') eventId: string,
    @Body() dto: UpdateMinutesDto,
    @CurrentUser() user: any,
  ) {
    return this.minutesService.updateMinutes(
      eventId,
      dto,
      user.id,
      user.systemRole,
      user.ministryId,
    );
  }

  @Post('minutes/publish')
  @HttpCode(200)
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async publishMinutes(
    @Param('eventId') eventId: string,
    @CurrentUser() user: any,
  ) {
    return this.minutesService.publishMinutes(eventId, user.id, user.ministryId);
  }

  @Get('minutes')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getMinutes(
    @Param('eventId') eventId: string,
    @CurrentUser() user: any,
  ) {
    return this.minutesService.getMinutes(eventId, user?.systemRole);
  }

  /**
   * Whether the caller may edit these minutes right now. The rules (2-day
   * window after the event, overridable by ministry-level roles) live in
   * minutesService.canEditMinutes; exposing them keeps the UI honest instead
   * of re-deriving the window client-side.
   */
  @Get('minutes/can-edit')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getCanEditMinutes(
    @Param('eventId') eventId: string,
    @CurrentUser() user: any,
  ) {
    const canEdit = await this.minutesService.canEditMinutes(
      eventId,
      user.id,
      user.systemRole,
      user.ministryId,
    );

    return { canEdit };
  }

  @Post('minutes/action-items')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async createActionItem(
    @Param('eventId') eventId: string,
    @Body() dto: CreateActionItemDto,
    @CurrentUser() user: any,
  ) {
    const minutes = await (this.minutesService as any).prisma.minutes.findUnique({
      where: { eventId },
    });

    if (!minutes) {
      throw new Error('Minutes not found for event');
    }

    return this.actionItemsService.createActionItem(
      minutes.id,
      dto,
      user.id,
      user.ministryId,
    );
  }

  @Patch('action-items/:actionItemId')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async updateActionItem(
    @Param('actionItemId') actionItemId: string,
    @Body() dto: UpdateActionItemDto,
    @CurrentUser() user: any,
  ) {
    return this.actionItemsService.updateStatus(
      actionItemId,
      dto,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  @Get('action-items')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async listActionItems(@Param('eventId') eventId: string) {
    const minutes = await (this.minutesService as any).prisma.minutes.findUnique({
      where: { eventId },
    });

    if (!minutes) {
      throw new Error('Minutes not found for event');
    }

    return this.actionItemsService.listByMinutes(minutes.id);
  }

  @Get('action-items/:actionItemId')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getActionItem(@Param('actionItemId') actionItemId: string) {
    return this.actionItemsService.getActionItem(actionItemId);
  }
}
