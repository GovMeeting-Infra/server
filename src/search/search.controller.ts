import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SearchService } from './search.service';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('api/v1/search')
@UseGuards(RolesGuard)
export class SearchController {
  constructor(private searchService: SearchService) {}

  @Get()
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  search(@CurrentUser() user: any, @Query('q') q?: string) {
    return this.searchService.search(user, q ?? '');
  }
}
