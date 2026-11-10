import {
  Controller,
  Get,
  HttpCode,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { RateLimitGuard } from '../common/guards/rate-limit.guard';
import { RateLimit } from '../common/decorators/rate-limit.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { CsvBodyInterceptor } from './csv-body.interceptor';
import { StaffImportService } from './staff-import.service';

/**
 * Uploading a ministry's staff list to its roster.
 *
 * Separate from DirectoryController on purpose: that one is meeting-facing and
 * is kept closed to PLATFORM_ADMIN (auth/__tests__/platform-admin-access.spec.ts),
 * while loading a new ministry's people is provisioning, which is theirs.
 * STAFF is on no route here.
 *
 * Both POSTs take the file as the raw request body (Content-Type: text/csv).
 * Two routes rather than a dryRun flag, so that dropping a query parameter can
 * never turn a preview into a write, and so each has its own rate budget.
 *
 * @Roles sits on every handler: RolesGuard reads handler metadata only, and a
 * handler without it is open to anybody signed in.
 */
@Controller('api/v1/admin/staff-directory')
@UseGuards(RolesGuard)
export class StaffImportController {
  constructor(private staffImport: StaffImportService) {}

  @Get('ministries')
  @Roles('SUPER_ADMIN', 'PLATFORM_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  ministries(@CurrentUser() user: any) {
    return this.staffImport.ministryOptions(user);
  }

  @Post('preview')
  @HttpCode(200)
  @Roles('SUPER_ADMIN', 'PLATFORM_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 30, windowSeconds: 900 })
  @UseInterceptors(CsvBodyInterceptor)
  preview(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('ministryId') ministryId?: string,
    @Query('filename') filename?: string,
  ) {
    return this.staffImport.run(user, {
      ministryId,
      filename,
      body: req.csvBody,
      commit: false,
    });
  }

  @Post('import')
  @HttpCode(200)
  @Roles('SUPER_ADMIN', 'PLATFORM_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  @UseGuards(RateLimitGuard)
  @RateLimit({ perIp: 10, windowSeconds: 900 })
  @UseInterceptors(CsvBodyInterceptor)
  import(
    @CurrentUser() user: any,
    @Req() req: any,
    @Query('ministryId') ministryId?: string,
    @Query('filename') filename?: string,
  ) {
    return this.staffImport.run(user, {
      ministryId,
      filename,
      body: req.csvBody,
      commit: true,
      ipAddress: req.ip,
      userAgent: req.headers?.['user-agent'],
    });
  }
}
