import {
  Controller,
  Get,
  Patch,
  Post,
  Body,
  UseGuards,
  HttpCode,
  Req,
  Res,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { extractToken } from '../auth/extract-token';
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

  /** Everything held about the caller, as a downloadable file. */
  @Get('export')
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  async exportData(@CurrentUser() user: any, @Res() res: Response) {
    const data = await this.meService.exportMyData(user.id);
    const stamp = new Date().toISOString().slice(0, 10);

    res.setHeader('Content-Type', 'application/json');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="smart-meeting-data-${stamp}.json"`,
    );
    res.send(JSON.stringify(data, null, 2));
  }

  @Patch()
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  updateProfile(@CurrentUser() user: any, @Body() dto: UpdateMeDto) {
    return this.meService.updateProfile(user.id, dto);
  }

  @Post('password')
  @HttpCode(200)
  @Roles('SUPER_ADMIN', 'MINISTER', 'MINISTRY_ADMIN', 'STAFF')
  changePassword(
    @CurrentUser() user: any,
    @Body() dto: ChangePasswordDto,
    @Req() req: Request,
  ) {
    // The token identifies the session doing the changing, so it can be spared
    // when the rest are revoked.
    return this.meService.changePassword(user.id, dto, extractToken(req));
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
