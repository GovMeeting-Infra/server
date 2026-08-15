import {
  Controller,
  Get,
  Param,
  Query,
  Req,
  Response,
  UseGuards,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AttendanceExportService } from './attendance-export.service';
import { renderAttendancePdf } from './attendance-pdf.util';
import { ExportAttendanceDto } from './dto/export-attendance.dto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CanManageEventGuard } from '../events/guards/can-manage-event.guard';
import { AllowCoOrganizers } from '../events/decorators/allow-co-organizers.decorator';
import { AllowMinistryOversight } from '../events/decorators/allow-ministry-oversight.decorator';

const EXPORT_ROLES = [
  'SUPER_ADMIN',
  'MINISTER',
  'MINISTRY_ADMIN',
  'STAFF',
] as const;

/** A meeting title as a filename: lowercase, hyphenated, no surprises. */
export function filenameSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug || 'attendance';
}

/**
 * Downloading the register.
 *
 * Its own controller rather than more routes on CheckinController, which is
 * already long and is about taking attendance rather than reporting it.
 */
@ApiTags('Attendance')
@ApiBearerAuth()
@Controller('api/v1')
export class AttendanceExportController {
  private logger = new Logger('AttendanceExportController');

  constructor(
    private exportService: AttendanceExportService,
    private prisma: PrismaService,
    private audit: AuditService,
  ) {}

  @Get('events/:eventId/attendance/export')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @AllowCoOrganizers()
  @AllowMinistryOversight()
  @Roles(...EXPORT_ROLES)
  async exportAttendance(
    @Param('eventId') eventId: string,
    @Query() query: ExportAttendanceDto,
    @CurrentUser() user: any,
    @Req() req: any,
    @Response() res: ExpressResponse,
  ) {
    const { format, set } = query;
    const event = await this.exportService.getEvent(eventId);

    // Everything that can fail is done before a single byte is written, so a
    // failure is still a clean 500 rather than a truncated download.
    const rows = await this.exportService.buildRows(
      eventId,
      set,
      format === 'pdf',
    );

    await this.audit.log({
      action: 'ATTENDANCE_EXPORTED',
      actionCategory: 'EXPORT',
      entityType: 'Event',
      entityId: eventId,
      entityName: event.title,
      status: 'SUCCESS',
      actorId: user?.id,
      ministryId: (event as any).ministryId ?? user?.ministryId,
      description: `Exported the ${set} attendance list as ${format.toUpperCase()}`,
      metadata: { format, set, rowCount: rows.length },
      ipAddress: req.ip,
      userAgent: (req.headers?.['user-agent'] as string | undefined)?.slice(
        0,
        512,
      ),
    });

    const date = event.startAt.toISOString().slice(0, 10);
    const filename = `${filenameSlug(event.title)}-${set}-${date}.${format}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.send(this.exportService.toCsv(rows, set));
      return;
    }

    res.setHeader('Content-Type', 'application/pdf');
    renderAttendancePdf(event, rows, set, res);
  }

  /**
   * One signature, as an image.
   *
   * Served on its own rather than inlined in the check-in list: a signature
   * runs to 200kB, and a hundred of them would make listing an event's
   * attendance a 20MB response for the sake of a thumbnail.
   */
  @Get('events/:eventId/checkins/:attendanceId/signature')
  @UseGuards(RolesGuard, CanManageEventGuard)
  @AllowCoOrganizers()
  @AllowMinistryOversight()
  @Roles(...EXPORT_ROLES)
  async getSignature(
    @Param('eventId') eventId: string,
    @Param('attendanceId') attendanceId: string,
    @Response() res: ExpressResponse,
  ) {
    const attendance = await (this.prisma as any).attendance.findUnique({
      where: { id: attendanceId },
      select: { eventId: true, signature: true },
    });

    // Checking the event as well as the id keeps the guard meaningful — it
    // authorizes an event, not an attendance record from another one.
    if (!attendance || attendance.eventId !== eventId) {
      throw new NotFoundException('Attendance record not found');
    }

    const png = decodePng(attendance.signature);
    // Null (nobody signed) and '' (erased) are both legitimate states, and
    // neither is an image.
    if (!png) throw new NotFoundException('No signature on this record');

    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.end(png);
  }
}

function decodePng(dataUrl: string | null): Buffer | null {
  if (!dataUrl) return null;

  const comma = dataUrl.indexOf(',');
  if (comma === -1 || !dataUrl.slice(0, comma).includes('base64')) return null;

  try {
    const buffer = Buffer.from(dataUrl.slice(comma + 1), 'base64');
    return buffer.length > 0 ? buffer : null;
  } catch {
    return null;
  }
}
