import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { ministryScope } from '../common/utils/ministry-scope.util';

/** Enough to fill a picker without becoming a data dump. */
const MAX_RESULTS = 25;

/**
 * A read-only colleague lookup for assigning work.
 *
 * Deliberately separate from /api/v1/admin/users, which is administrative and
 * restricted to admin roles. Assigning an action item is ordinary staff work,
 * so staff need to see who they can assign to — but only names and job titles
 * within their own ministry, not the full administrative record.
 */
@Controller('api/v1/users')
export class DirectoryController {
  constructor(private prisma: PrismaService) {}

  @Get('directory')
  @UseGuards(RolesGuard)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  async directory(@CurrentUser() user: any, @Query('q') q?: string) {
    const term = q?.trim();

    return (this.prisma as any).user.findMany({
      where: {
        ...ministryScope(user),
        active: true,
        deletedAt: null,
        ...(term
          ? {
              OR: [
                { name: { contains: term, mode: 'insensitive' } },
                { email: { contains: term, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      select: { id: true, name: true, email: true, jobTitle: true },
      orderBy: { name: 'asc' },
      take: MAX_RESULTS,
    });
  }
}
