import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
  Version,
} from '@nestjs/common';
import { MinistriesService } from './ministries.service';
import { CreateMinistryDto } from './dto/create-ministry.dto';
import { UpdateMinistryDto } from './dto/update-ministry.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('api/v1/admin/ministries')
@UseGuards(RolesGuard)
export class MinistriesController {
  constructor(private ministriesService: MinistriesService) {}

  @Post()
  @Roles('SUPER_ADMIN', 'PLATFORM_ADMIN')
  create(@Body() dto: CreateMinistryDto, @CurrentUser() user: any) {
    return this.ministriesService.create(dto, user.id, user.ministryId);
  }

  @Get()
  @Roles('SUPER_ADMIN', 'PLATFORM_ADMIN', 'MINISTRY_ADMIN')
  findAll(@CurrentUser() user: any) {
    return this.ministriesService.findAll(user);
  }

  @Get(':id')
  @Roles('SUPER_ADMIN', 'PLATFORM_ADMIN', 'MINISTRY_ADMIN')
  findOne(@Param('id') id: string) {
    return this.ministriesService.findOne(id);
  }

  @Patch(':id')
  @Roles('SUPER_ADMIN', 'PLATFORM_ADMIN')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateMinistryDto,
    @CurrentUser() user: any,
  ) {
    return this.ministriesService.update(id, dto, user.id, user.ministryId);
  }

  @Delete(':id')
  @Roles('SUPER_ADMIN')
  delete(@Param('id') id: string, @CurrentUser() user: any) {
    return this.ministriesService.delete(id, user.id, user.ministryId);
  }
}
