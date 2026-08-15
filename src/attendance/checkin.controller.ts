import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  Req,
  HttpCode,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { CheckinService } from './checkin.service';
import { RSVPService } from './rsvp.service';
import { CheckInDto } from './dto/check-in.dto';
import { GuestCheckInDto } from './dto/guest-check-in.dto';
import { GenerateCheckInCodeDto } from './dto/generate-check-in-code.dto';
import { ManualCheckInDto } from './dto/manual-check-in.dto';
import { RSVPDto } from './dto/rsvp.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CanManageEventGuard } from '../events/guards/can-manage-event.guard';
import { AllowCoOrganizers } from '../events/decorators/allow-co-organizers.decorator';
import { AllowMinistryOversight } from '../events/decorators/allow-ministry-oversight.decorator';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';

const CODE_ROLES = [
  'SUPER_ADMIN',
  'MINISTER',
  'MINISTRY_ADMIN',
  'STAFF',
] as const;

/** Client IP and user agent, for the attendance audit trail. */
function requestMeta(req: any) {
  return {
    ipAddress: req.ip || req.socket?.remoteAddress || undefined,
    userAgent: (req.headers?.['user-agent'] as string | undefined)?.slice(
      0,
      512,
    ),
  };
}

@Controller('api/v1')
export class CheckinController {
  constructor(
    private checkinService: CheckinService,
    private rsvpService: RSVPService,
  ) {}

  /**
   * Current code, if one has been generated. Deliberately a pure read: this is
   * polled by the host screen, and minting here is what previously produced an
   * endless stream of tokens from an idle browser tab.
   */
  @Get('checkin-code/:eventId')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @AllowCoOrganizers()
  @Roles(...CODE_ROLES)
  async getQRCode(@Param('eventId') eventId: string) {
    return this.checkinService.getCheckInCode(eventId);
  }

  /** Generate or rotate the code, and capture the check-in area. */
  @Post('checkin-code/:eventId')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @AllowCoOrganizers()
  @Roles(...CODE_ROLES)
  @HttpCode(200)
  async generateQRCode(
    @Param('eventId') eventId: string,
    @Body() dto: GenerateCheckInCodeDto,
    @CurrentUser() user: any,
  ) {
    return this.checkinService.issueCheckInCode(eventId, dto, user);
  }

  /** Expire every live code, closing check-in. */
  @Delete('checkin-code/:eventId')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @AllowCoOrganizers()
  @Roles(...CODE_ROLES)
  @HttpCode(204)
  async closeCheckIn(
    @Param('eventId') eventId: string,
    @CurrentUser() user: any,
  ) {
    return this.checkinService.closeCheckIn(eventId, user);
  }

  /**
   * What the scanned code can do right now. Public and read-only — the
   * check-in page calls it before showing anything.
   */
  @Get('checkin/:token/context')
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 60, windowSeconds: 60 })
  async checkInContext(@Param('token') token: string) {
    return this.checkinService.getCheckInContext(token);
  }

  /** Check-in by a signed-in member of staff. */
  @Post('checkin/:token')
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 10, perToken: 30, windowSeconds: 60 })
  @HttpCode(200)
  async checkIn(
    @Param('token') token: string,
    @Body() dto: CheckInDto,
    @Req() req: any,
    @CurrentUser() user?: any,
  ) {
    if (!user?.id) {
      throw new UnauthorizedException('Sign in to check in');
    }
    return this.checkinService.checkIn(token, dto, user, requestMeta(req));
  }

  /** Check-in by someone without an account. */
  @Post('checkin/:token/guest')
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 10, perToken: 30, windowSeconds: 60 })
  @HttpCode(200)
  async guestCheckIn(
    @Param('token') token: string,
    @Body() dto: GuestCheckInDto,
    @Req() req: any,
  ) {
    return this.checkinService.guestCheckIn(token, dto, requestMeta(req));
  }

  /**
   * Check someone in at the desk. CanManageEventGuard is what confines this to
   * the event's own people — the role list alone let any staff member check
   * anyone into any ministry's event.
   */
  @Post('checkin/:eventId/manual')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @AllowCoOrganizers()
  @Roles(...CODE_ROLES)
  @HttpCode(200)
  async manualCheckIn(
    @Param('eventId') eventId: string,
    @Body() dto: ManualCheckInDto,
    @CurrentUser() user: any,
    @Req() req: any,
  ) {
    return this.checkinService.manualCheckIn(
      eventId,
      dto,
      user.id,
      requestMeta(req),
    );
  }

  @Post('rsvp/:tokenHash')
  @HttpCode(200)
  async rsvpResponse(
    @Param('tokenHash') tokenHash: string,
    @Body() dto: RSVPDto,
  ) {
    return this.rsvpService.respond(tokenHash, dto.status);
  }

  /**
   * These three lists carry names, emails and phone numbers, so they are
   * confined to the event's own people. The role list alone let any staff
   * member of any ministry read the attendance of any event whose id they
   * had — the same hole CanManageEventGuard already closed on the writes.
   */
  @Get('events/:eventId/attendees/confirmed')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @AllowCoOrganizers()
  @AllowMinistryOversight()
  @Roles(...CODE_ROLES)
  async getConfirmedAttendees(@Param('eventId') eventId: string) {
    return this.rsvpService.getAttendeesByStatus(eventId, 'CONFIRMED');
  }

  @Get('events/:eventId/attendees/declined')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @AllowCoOrganizers()
  @AllowMinistryOversight()
  @Roles(...CODE_ROLES)
  async getDeclinedAttendees(@Param('eventId') eventId: string) {
    return this.rsvpService.getAttendeesByStatus(eventId, 'DECLINED');
  }

  /**
   * Who actually turned up. This is Attendance data (QR, manual or geo
   * check-ins) and is distinct from the RSVP lists above.
   */
  @Get('events/:eventId/checkins')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @AllowCoOrganizers()
  @AllowMinistryOversight()
  @Roles(...CODE_ROLES)
  async getCheckIns(@Param('eventId') eventId: string) {
    return this.checkinService.listCheckIns(eventId);
  }

  /**
   * Deleting an attendance record is not oversight, so ministers get no
   * blanket pass here — this stays with the people running the meeting.
   */
  @Delete('events/:eventId/checkins/:attendanceId')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @AllowCoOrganizers()
  @Roles('SUPER_ADMIN', 'MINISTRY_ADMIN', 'STAFF')
  @HttpCode(204)
  async removeCheckIn(
    @Param('eventId') eventId: string,
    @Param('attendanceId') attendanceId: string,
    @CurrentUser() user: any,
  ) {
    return this.checkinService.removeCheckIn(
      eventId,
      attendanceId,
      user.id,
      user.ministryId,
    );
  }
}
