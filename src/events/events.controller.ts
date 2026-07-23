import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { EventsService } from './events.service';
import { CreateEventDto } from './dto/create-event.dto';
import { UpdateEventDto } from './dto/update-event.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CanManageEventGuard } from './guards/can-manage-event.guard';

@Controller('api/v1/events')
@UseGuards(RolesGuard)
export class EventsController {
  constructor(private eventsService: EventsService) {}

  @Get()
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  list(
    @CurrentUser() user: any,
    @Query('page') page: number = 1,
    @Query('isPublic') isPublic?: string,
  ) {
    return this.eventsService.listEvents(
      user.ministryId,
      user,
      { page, isPublic: isPublic === 'true' ? true : isPublic === 'false' ? false : undefined },
    );
  }

  @Get(':id')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  getOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.eventsService.getOne(id, user);
  }

  @Post()
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  create(
    @Body() dto: CreateEventDto,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.createEvent(dto, user.id, user.ministryId);
  }

  @Patch(':id')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.updateEvent(id, dto, user.id, user.ministryId);
  }

  @Delete(':id')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  @HttpCode(204)
  delete(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.deleteEvent(id, user.id, user.ministryId);
  }

  @Post(':id/publish')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  publish(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.publishEvent(id, user.id, user.ministryId);
  }

  @Post(':id/co-organizers')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  addCoOrganizer(
    @Param('id') id: string,
    @Body() { userId }: { userId: string },
    @CurrentUser() user: any,
  ) {
    return this.eventsService.addCoOrganizer(id, userId, user.id, user.ministryId);
  }
}
