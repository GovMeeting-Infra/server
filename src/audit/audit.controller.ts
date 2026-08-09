import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { AuditService } from './audit.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * The activity log.
 *
 * Ministers and super-admins only. The log records who did what to whose
 * record across a whole ministry, which is oversight rather than day-to-day
 * administration — scoping happens in the service, not here.
 */
@Controller('api/v1/audit')
@UseGuards(RolesGuard)
export class AuditController {
  constructor(private auditService: AuditService) {}

  @Get()
  @Roles('MINISTER', 'SUPER_ADMIN')
  async list(
    @CurrentUser() user: any,
    @Query('q') q?: string,
    @Query('category') category?: string,
    @Query('status') status?: string,
    @Query('actorId') actorId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    // Super-admins only, and enforced in the service rather than here: a
    // minister's scope comes from their own record, so a value supplied on the
    // URL is ignored rather than obeyed.
    @Query('ministryId') ministryId?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return this.auditService.list(user, {
      q,
      category,
      ministryId,
      // Anything unrecognised is ignored rather than rejected, so a stale
      // bookmark shows everything instead of erroring.
      status:
        status === 'SUCCESS' || status === 'FAILURE' || status === 'PARTIAL'
          ? status
          : undefined,
      actorId,
      from,
      to,
      skip: skip ? parseInt(skip, 10) || 0 : 0,
      take: take ? parseInt(take, 10) || 50 : 50,
    });
  }

  @Get('categories')
  @Roles('MINISTER', 'SUPER_ADMIN')
  async categories(
    @CurrentUser() user: any,
    @Query('ministryId') ministryId?: string,
  ) {
    // Takes the same filter so the category list matches the ministry on
    // screen, rather than offering categories with no rows behind them.
    return this.auditService.categories(user, ministryId);
  }
}
