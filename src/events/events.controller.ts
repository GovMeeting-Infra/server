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
import { AddAttendeesDto } from './dto/add-attendees.dto';
import { CreateEventSeriesDto } from './dto/create-event-series.dto';
import { SelfRsvpDto } from './dto/self-rsvp.dto';
import { EventSeriesService } from './event-series.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CanManageEventGuard } from './guards/can-manage-event.guard';

@Controller('api/v1/events')
@UseGuards(RolesGuard)
export class EventsController {
  constructor(
    private eventsService: EventsService,
    private eventSeriesService: EventSeriesService,
  ) {}

  @Get()
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  list(
    @CurrentUser() user: any,
    @Query('page') page: number = 1,
    @Query('isPublic') isPublic?: string,
    @Query('sortBy') sortBy?: string,
    @Query('order') order?: string,
    @Query('timeframe') timeframe?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('roomId') roomId?: string,
  ) {
    return this.eventsService.listEvents(user.ministryId, user, {
      page,
      isPublic:
        isPublic === 'true' ? true : isPublic === 'false' ? false : undefined,
      sortBy,
      order,
      timeframe,
      from,
      to,
      roomId,
    });
  }

  /**
   * Colleagues the caller can name as co-organizers or invitees. Declared
   * before @Get(':id') so it isn't matched as an event id. Exists because
   * /admin/users is admin-only, and STAFF need to populate these pickers.
   */
  /**
   * Assignees for this meeting's action items. Declared before ':id' routes so
   * a literal path segment is not swallowed as an event id.
   */
  @Get(':eventId/attendee-candidates')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  listAttendeeCandidates(
    @Param('eventId') eventId: string,
    @CurrentUser() user: any,
    @Query('q') q?: string,
  ) {
    return this.eventsService.listAttendeeCandidates(eventId, user, q);
  }

  @Get('co-organizer-candidates')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  listCandidates(@CurrentUser() user: any) {
    return this.eventsService.listCoOrganizerCandidates(user);
  }

  /**
   * Active ministries, for the invited-ministries picker on public activities.
   * Same reason as the candidates route above: /admin/ministries is limited to
   * SUPER_ADMIN and MINISTRY_ADMIN, so MINISTER and STAFF could not populate
   * the picker. Returns names only, no ministry settings.
   */
  @Get('ministry-options')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  listMinistryOptions() {
    return this.eventsService.listMinistryOptions();
  }

  @Get(':id')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  getOne(@Param('id') id: string, @CurrentUser() user: any) {
    return this.eventsService.getOne(id, user);
  }

  @Post()
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  create(@Body() dto: CreateEventDto, @CurrentUser() user: any) {
    return this.eventsService.createEvent(
      dto,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  // No CanManageEventGuard here: that guard is organizer-or-super-admin only,
  // and editing is deliberately wider (co-organizers and ministry admins too).
  // updateEvent performs the authorization itself.
  @Patch(':id')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateEventDto,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.updateEvent(
      id,
      dto,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  @Delete(':id')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  @HttpCode(204)
  delete(@Param('id') id: string, @CurrentUser() user: any) {
    return this.eventsService.deleteEvent(
      id,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  @Post(':id/publish')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  publish(@Param('id') id: string, @CurrentUser() user: any) {
    return this.eventsService.publishEvent(
      id,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  /**
   * Turns an existing event into the first occurrence of a recurring series.
   * EventSeriesService was written but never routed, so recurring events were
   * unreachable over HTTP.
   */
  @Post(':id/series')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  async createSeries(
    @Param('id') id: string,
    @Body() dto: CreateEventSeriesDto,
    @CurrentUser() user: any,
  ) {
    const baseEvent = await this.eventsService.getOne(id, user);
    return this.eventSeriesService.createSeries(
      dto,
      baseEvent,
      user.ministryId,
      user.id,
    );
  }

  @Post(':id/cancel')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  cancel(@Param('id') id: string, @CurrentUser() user: any) {
    return this.eventsService.cancelEvent(
      id,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  /**
   * STAFF is included because the real rule lives in the service: only the
   * event's own organizer may add a co-organizer. Excluding staff here meant a
   * staff member who organizes a meeting could name co-organizers while
   * creating it and then never again — and CanManageEventGuard already keeps
   * them out of other people's events.
   */
  @Post(':id/co-organizers')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  addCoOrganizer(
    @Param('id') id: string,
    @Body() { userId }: { userId: string },
    @CurrentUser() user: any,
  ) {
    return this.eventsService.addCoOrganizer(
      id,
      userId,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  /** Gated identically to adding one — see addCoOrganizer above. */
  @Delete(':id/co-organizers/:userId')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  removeCoOrganizer(
    @Param('id') id: string,
    @Param('userId') userId: string,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.removeCoOrganizer(
      id,
      userId,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  @Post(':id/attendees')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  addAttendees(
    @Param('id') id: string,
    @Body() dto: AddAttendeesDto,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.addAttendees(
      id,
      dto,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  /**
   * Re-send everyone still awaiting a reply. Declared before the
   * :attendeeId route below so 'invite-all' is not captured as an id.
   */
  @Post(':id/attendees/invite-all')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  @HttpCode(200)
  resendInvitationsToAwaiting(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.resendInvitationsToAwaiting(
      id,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  /** Re-send one attendee's invitation, on request. */
  @Post(':id/attendees/:attendeeId/invite')
  @UseGuards(CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  @HttpCode(200)
  resendInvitation(
    @Param('id') id: string,
    @Param('attendeeId') attendeeId: string,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.resendInvitation(
      id,
      attendeeId,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  /**
   * RSVP to your own invitation. Deliberately has no CanManageEventGuard — any
   * invitee acts on their own row here, not on the event.
   */
  @Post(':id/rsvp')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  @HttpCode(200)
  selfRsvp(
    @Param('id') id: string,
    @Body() dto: SelfRsvpDto,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.selfRsvp(
      id,
      dto.status,
      user.id,
      user.ministryId,
    );
  }

  @Delete(':id/attendees/:attendeeId')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  @HttpCode(204)
  removeAttendee(
    @Param('id') id: string,
    @Param('attendeeId') attendeeId: string,
    @CurrentUser() user: any,
  ) {
    return this.eventsService.removeAttendee(
      id,
      attendeeId,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }
}
