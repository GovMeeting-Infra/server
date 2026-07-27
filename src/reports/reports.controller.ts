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
  @Header('Content-Disposition', 'attachment; filename="events.csv"')
  async exportEventsCSV(
    @CurrentUser() user: any,
    @Response() res: ExpressResponse,
  ) {
    try {
      const csv = await this.reportsService.exportToCSV(user);
      res.send(csv);
    } catch (error) {
      this.logger.error('Error exporting events CSV', error);
      res.status(500).send('Failed to export events');
    }
  }

  @Get('export/attendance')
  @Roles('MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="attendance.csv"')
  async exportAttendanceCSV(
    @CurrentUser() user: any,
    @Response() res: ExpressResponse,
  ) {
    try {
      const csv = await this.reportsService.exportAttendanceToCSV(user);
      res.send(csv);
    } catch (error) {
      this.logger.error('Error exporting attendance CSV', error);
      res.status(500).send('Failed to export attendance');
    }
  }

  @Get('export/action-items')
  @Roles('MINISTRY_ADMIN', 'MINISTER', 'SUPER_ADMIN')
  @Header('Content-Type', 'text/csv')
  @Header('Content-Disposition', 'attachment; filename="action-items.csv"')
  async exportActionItemsCSV(
    @CurrentUser() user: any,
    @Response() res: ExpressResponse,
  ) {
    try {
      const csv = await this.reportsService.exportActionItemsToCSV(user);
      res.send(csv);
    } catch (error) {
      this.logger.error('Error exporting action items CSV', error);
      res.status(500).send('Failed to export action items');
    }
  }
}
