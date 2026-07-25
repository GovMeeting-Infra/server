import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  UseGuards,
  HttpCode,
} from '@nestjs/common';
import { MeService } from './me.service';
import { UpdateMeDto } from './dto/update-me.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { UpdatePreferencesDto } from './dto/update-preferences.dto';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * The caller's own account. Open to every role — /admin/users is admin-only,
 * so without these routes a STAFF user could not see or change their own
 * profile, preferences or password.
 */
@Controller('api/v1/me')
@UseGuards(RolesGuard)
export class MeController {
  constructor(private meService: MeService) {}

  @Get()
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  getProfile(@CurrentUser() user: any) {
    return this.meService.getProfile(user.id);
  }

  @Patch()
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  updateProfile(@CurrentUser() user: any, @Body() dto: UpdateMeDto) {
    return this.meService.updateProfile(user.id, dto);
  }

  @Post('password')
  @HttpCode(200)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  changePassword(@CurrentUser() user: any, @Body() dto: ChangePasswordDto) {
    return this.meService.changePassword(user.id, dto);
  }

  @Get('preferences')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  getPreferences(@CurrentUser() user: any) {
    return this.meService.getPreferences(user.id);
  }

  @Patch('preferences')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  updatePreferences(
    @CurrentUser() user: any,
    @Body() dto: UpdatePreferencesDto,
  ) {
    return this.meService.updatePreferences(user.id, dto);
  }
}
