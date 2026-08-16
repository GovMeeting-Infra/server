import {
  Controller,
  Get,
  UseGuards,
  Header,
  Response,
  Logger,
} from '@nestjs/common';
import type { Response as ExpressResponse } from 'express';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ReportsService } from './reports.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';

/**
 * Today's date for an export filename.
 *
 * All three downloads were served as a bare `events.csv` / `attendance.csv`,
 * so pulling two ministries or two dates gave someone `events.csv` and
 * `events (1).csv` in their downloads folder. These files get filed as
 * evidence; the filename should say what it is.
 */
function stamp(): string {
  return new Date().toISOString().slice(0, 10);
}

@ApiTags('Reports & Analytics')
@ApiBearerAuth()
@Controller('api/v1/reports')
@UseGuards(RolesGuard)
export class ReportsController {
  private logger = new Logger('ReportsController');

  constructor(private reportsService: ReportsService) {}

  @Get('analytics')
  @Roles('MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  async getAnalyticsDashboard(@CurrentUser() user: any) {
    return this.reportsService.getAnalyticsDashboard(user);
  }

  @Get('export/events')
  @Roles('MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  @Header('Content-Type', 'text/csv')
  async exportEventsCSV(
    @CurrentUser() user: any,
    @Response() res: ExpressResponse,
  ) {
    try {
      const csv = await this.reportsService.exportToCSV(user);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="meetings-${stamp()}.csv"`,
      );
      res.send(csv);
    } catch (error) {
      this.logger.error('Error exporting events CSV', error);
      // Drop the CSV headers the decorators already set. Left in place, the
      // browser saved the failure as a correctly-named spreadsheet whose only
      // content was this sentence, and the page showed nothing at all.
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Type');
      res.status(500).json({
        message: 'Could not build the events export. Try again in a moment.',
      });
    }
  }

  @Get('export/attendance')
  @Roles('MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  @Header('Content-Type', 'text/csv')
  async exportAttendanceCSV(
    @CurrentUser() user: any,
    @Response() res: ExpressResponse,
  ) {
    try {
      const csv = await this.reportsService.exportAttendanceToCSV(user);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="attendance-${stamp()}.csv"`,
      );
      res.send(csv);
    } catch (error) {
      this.logger.error('Error exporting attendance CSV', error);
      // Drop the CSV headers the decorators already set. Left in place, the
      // browser saved the failure as a correctly-named spreadsheet whose only
      // content was this sentence, and the page showed nothing at all.
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Type');
      res.status(500).json({
        message:
          'Could not build the attendance export. Try again in a moment.',
      });
    }
  }

  @Get('export/action-items')
  @Roles('MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  @Header('Content-Type', 'text/csv')
  async exportActionItemsCSV(
    @CurrentUser() user: any,
    @Response() res: ExpressResponse,
  ) {
    try {
      const csv = await this.reportsService.exportActionItemsToCSV(user);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="action-items-${stamp()}.csv"`,
      );
      res.send(csv);
    } catch (error) {
      this.logger.error('Error exporting action items CSV', error);
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Type');
      res.status(500).json({
        message:
          'Could not build the action items export. Try again in a moment.',
      });
    }
  }
}
