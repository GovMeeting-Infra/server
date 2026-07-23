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
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('api/v1/admin/users')
@UseGuards(RolesGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Post()
  @Roles('SUPER_ADMIN', 'MINISTRY_ADMIN')
  create(
    @Body() dto: CreateUserDto,
    @CurrentUser() user: any,
  ) {
    const ministryId = user.ministryId || '';
    return this.usersService.create(
      dto,
      ministryId,
      user.id,
      user.ministryId,
    );
  }

  @Get()
  @Roles('SUPER_ADMIN', 'MINISTRY_ADMIN')
  findAll(@CurrentUser() user: any) {
    return this.usersService.findAll(user);
  }

  @Get(':id')
  @Roles('SUPER_ADMIN', 'MINISTRY_ADMIN')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id/role')
  @Roles('SUPER_ADMIN')
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser() user: any,
  ) {
    return this.usersService.updateRole(id, dto, user.id, user.ministryId);
  }

  @Patch(':id/deactivate')
  @Roles('SUPER_ADMIN', 'MINISTRY_ADMIN')
  deactivate(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.usersService.deactivate(id, user.id, user.ministryId);
  }

  @Delete(':id')
  @Roles('SUPER_ADMIN')
  anonymize(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.usersService.anonymize(id, user.id, user.ministryId);
  }
}
