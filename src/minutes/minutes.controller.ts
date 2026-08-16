import {
  Controller,
  Post,
  Patch,
  Get,
  Body,
  Param,
  UseGuards,
  HttpCode,
  NotFoundException,
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
import { ARCHIVE_MANAGER_ROLES, canReadArchived } from './archive.policy';

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
    return this.minutesService.publishMinutes(
      eventId,
      user.id,
      user.ministryId,
    );
  }

  /**
   * File a record away early, or take one back out.
   *
   * Limited to the roles that may read archived records — filing something
   * away that you then cannot open would make no sense.
   */
  @Post('minutes/archive')
  @HttpCode(200)
  @Roles('MINISTER', 'SUPER_ADMIN')
  async archiveMinutes(
    @Param('eventId') eventId: string,
    @CurrentUser() user: any,
  ) {
    return this.minutesService.archiveMinutes(eventId, user);
  }

  @Post('minutes/restore')
  @HttpCode(200)
  @Roles('MINISTER', 'SUPER_ADMIN')
  async restoreMinutes(
    @Param('eventId') eventId: string,
    @CurrentUser() user: any,
  ) {
    return this.minutesService.restoreMinutes(eventId, user);
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
    const permission = await this.minutesService.describeEditPermission(
      eventId,
      user.id,
      user.systemRole,
      user.ministryId,
    );

    // The capability flags travel with it so the page stops keeping its own
    // copies of the role lists. It had three — organiser-or-co-organiser for
    // publishing, MINISTER/SUPER_ADMIN for archiving, and the archive reader
    // roles on the list page — each one a place the client can drift from the
    // server without anything failing loudly.
    return {
      ...permission,
      canPublish: await this.minutesService.canPublishMinutes(
        eventId,
        user.id,
        user.systemRole,
      ),
      // Who publishing would reach. The page asks people to confirm an act
      // that emails a record it cannot recall; "Send to 14 people, 3 of them
      // outside government" is the fact that makes that confirmation mean
      // something, and it was not available to ask for.
      recipients: await this.minutesService.countPublishRecipients(eventId),
      canArchive: ARCHIVE_MANAGER_ROLES.includes(user.systemRole),
      canReadArchived: canReadArchived(user.systemRole),
    };
  }

  @Post('minutes/action-items')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async createActionItem(
    @Param('eventId') eventId: string,
    @Body() dto: CreateActionItemDto,
    @CurrentUser() user: any,
  ) {
    const minutes = await (
      this.minutesService as any
    ).prisma.minutes.findUnique({
      where: { eventId },
    });

    if (!minutes) {
      // Was a bare Error, which surfaced as a 500 for the ordinary case of an
      // event whose minutes have not been drafted yet.
      throw new NotFoundException('No minutes drafted for this event yet');
    }

    return this.actionItemsService.createActionItem(
      minutes.id,
      dto,
      user.id,
      user.ministryId,
      user.systemRole,
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
    const minutes = await (
      this.minutesService as any
    ).prisma.minutes.findUnique({
      where: { eventId },
    });

    if (!minutes) {
      throw new NotFoundException('No minutes drafted for this event yet');
    }

    return this.actionItemsService.listByMinutes(minutes.id);
  }

  @Get('action-items/:actionItemId')
  @Roles('STAFF', 'MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getActionItem(@Param('actionItemId') actionItemId: string) {
    return this.actionItemsService.getActionItem(actionItemId);
  }
}
