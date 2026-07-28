import {
  Controller,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ActionItemsService } from './action-items.service';
import { UpdateActionItemDto } from './dto/update-action-item.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * Cross-event action items, for the task board.
 *
 * The existing routes live under api/v1/events/:eventId, which cannot serve a
 * board spanning every event. These sit at the top level instead; the nested
 * PATCH already ignored its :eventId param, so nothing is lost by preferring
 * this one.
 */
@Controller('api/v1/action-items')
@UseGuards(RolesGuard)
export class ActionItemsController {
  constructor(private actionItemsService: ActionItemsService) {}

  @Get()
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  list(@CurrentUser() user: any, @Query('owner') owner?: string) {
    return this.actionItemsService.listForMinistry(user, owner || undefined);
  }

  @Patch(':actionItemId')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  update(
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
}
