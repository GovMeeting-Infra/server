import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { MinutesService } from './minutes.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * Minutes across every meeting, for the Minutes section in the sidebar.
 *
 * Separate controller because MinutesController is mounted under
 * api/v1/events/:eventId — everything there needs an event in the path, and
 * this deliberately does not.
 */
@Controller('api/v1/minutes')
export class MinutesListController {
  constructor(private minutesService: MinutesService) {}

  @Get()
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  async list(
    @CurrentUser() user: any,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.minutesService.listMinutes(user, {
      q,
      // Anything else is ignored rather than rejected, so a stale bookmark
      // shows everything instead of erroring.
      status: status === 'DRAFT' || status === 'PUBLISHED' ? status : undefined,
      skip: skip ? parseInt(skip, 10) || 0 : 0,
      take: take ? parseInt(take, 10) || 25 : 25,
    });
  }
}
