import {
  Controller,
  Get,
  Post,
  Delete,
  Body,
  Param,
  HttpCode,
  UseGuards,
  Optional,
} from '@nestjs/common';
import { CheckinService } from './checkin.service';
import { RSVPService } from './rsvp.service';
import { QRTokenService } from './qr-token.service';
import { CheckInDto } from './dto/check-in.dto';
import { RSVPDto } from './dto/rsvp.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CanManageEventGuard } from '../events/guards/can-manage-event.guard';

@Controller('api/v1')
export class CheckinController {
  constructor(
    private checkinService: CheckinService,
    private rsvpService: RSVPService,
    private qrTokenService: QRTokenService,
  ) {}

  @Get('checkin-code/:eventId')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  async getQRCode(@Param('eventId') eventId: string) {
    const { token, expiresAt } = await this.qrTokenService.getActiveToken(
      eventId,
    );

    // Geofence entry is the alternative to scanning; the operator screen needs
    // to know whether it is configured and how wide the radius is.
    const event = await this.checkinService.getGeofence(eventId);

    // Attendees scan this, so it must point at the web frontend that serves
    // /checkin/[token] — not at APP_URL, which is this API's own origin.
    const webUrl =
      process.env.WEB_URL || process.env.NEXT_PUBLIC_WEB_URL || 'http://localhost:3000';
    const qrCodeUrl = `${webUrl}/checkin/${token}`;

    return {
      token,
      qrCodeUrl,
      expiresAt,
      refreshAt: new Date(Date.now() + 4 * 60 * 1000),
      venueLat: event?.venueLat ?? null,
      venueLng: event?.venueLng ?? null,
      geofenceRadius: event?.geofenceRadius ?? null,
      geofenceEnabled: !!(event?.venueLat && event?.venueLng),
    };
  }

  @Post('checkin/:token')
  @HttpCode(200)
  async checkIn(
    @Param('token') token: string,
    @Body() dto: CheckInDto,
    @Optional() @CurrentUser() user?: any,
  ) {
    return this.checkinService.checkIn(token, dto, user?.id);
  }

  @Post('checkin/:eventId/manual')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'MINISTRY_ADMIN', 'STAFF')
  @HttpCode(200)
  async manualCheckIn(
    @Param('eventId') eventId: string,
    @Body() dto: { userId: string; signedName: string; signature: string },
    @CurrentUser() user: any,
  ) {
    return this.checkinService.manualCheckIn(
      eventId,
      dto.userId,
      {
        signedName: dto.signedName,
        signature: dto.signature,
      },
      user.id,
      user.ministryId,
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

  @Get('events/:eventId/attendees/confirmed')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  async getConfirmedAttendees(@Param('eventId') eventId: string) {
    return this.rsvpService.getAttendeesByStatus(eventId, 'CONFIRMED');
  }

  @Get('events/:eventId/attendees/declined')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  async getDeclinedAttendees(@Param('eventId') eventId: string) {
    return this.rsvpService.getAttendeesByStatus(eventId, 'DECLINED');
  }

  /**
   * Who actually turned up. This is Attendance data (QR, manual or geo
   * check-ins) and is distinct from the RSVP lists above.
   */
  @Get('events/:eventId/checkins')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  async getCheckIns(@Param('eventId') eventId: string) {
    return this.checkinService.listCheckIns(eventId);
  }

  @Delete('events/:eventId/checkins/:attendanceId')
  @UseGuards(RolesGuard)
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
