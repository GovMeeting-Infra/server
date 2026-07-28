import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Query,
  HttpCode,
  Body,
  Param,
  UseGuards,
  Version,
} from '@nestjs/common';
import { UsersService } from './users.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import { UpdateUserDetailsDto } from './dto/update-user-details.dto';
import { SetActiveDto } from './dto/set-active.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@Controller('api/v1/admin/users')
@UseGuards(RolesGuard)
export class UsersController {
  constructor(private usersService: UsersService) {}

  @Post()
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
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
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  findAll(
    @CurrentUser() user: any,
    @Query('q') q?: string,
    @Query('role') role?: string,
    @Query('ministryId') ministryId?: string,
  ) {
    return this.usersService.findAll(user, { q, role, ministryId });
  }

  @Get(':id')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  findOne(@Param('id') id: string) {
    return this.usersService.findOne(id);
  }

  @Patch(':id/role')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  updateRole(
    @Param('id') id: string,
    @Body() dto: UpdateUserRoleDto,
    @CurrentUser() user: any,
  ) {
    return this.usersService.updateRole(id, dto, user.id, user.ministryId, user.systemRole);
  }

  @Patch(':id')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  updateDetails(
    @Param('id') id: string,
    @Body() dto: UpdateUserDetailsDto,
    @CurrentUser() user: any,
  ) {
    return this.usersService.updateDetails(
      id,
      dto,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  @Patch(':id/active')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  setActive(
    @Param('id') id: string,
    @Body() dto: SetActiveDto,
    @CurrentUser() user: any,
  ) {
    return this.usersService.setActive(
      id,
      dto.active,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  /** Re-issues an invitation, invalidating any previous link. */
  @Post(':id/invite')
  @HttpCode(200)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  reinvite(@Param('id') id: string, @CurrentUser() user: any) {
    return this.usersService.reissueInvite(
      id,
      user.id,
      user.ministryId,
      user.systemRole,
    );
  }

  @Delete(':id')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN')
  anonymize(
    @Param('id') id: string,
    @CurrentUser() user: any,
  ) {
    return this.usersService.anonymize(id, user.id, user.ministryId, user.systemRole);
  }
}
