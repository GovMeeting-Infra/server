import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { ApiOperation } from '@nestjs/swagger';
import { SettingsService, SettingKey } from './settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { CurrentUser } from '../decorators/current-user.decorator';

@Controller('api/v1/admin/settings')
@UseGuards(RolesGuard)
export class SettingsController {
  constructor(private settings: SettingsService) {}

  // Super-admin only, all of them: one governs how long every session lives,
  // one governs who is allowed to sign in at all, and one is the address the
  // help page offers to somebody who is stuck.
  @Get()
  @Roles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Current platform settings and their source' })
  findAll() {
    return this.settings.getAll();
  }

  @Patch()
  @Roles('SUPER_ADMIN')
  @ApiOperation({ summary: 'Change platform settings' })
  async update(@Body() dto: UpdateSettingsDto, @CurrentUser() user: any) {
    const results: Array<{ key: SettingKey; value: string }> = [];

    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue;
      results.push(
        await this.settings.set(
          key as SettingKey,
          String(value),
          user.id,
          user.ministryId,
        ),
      );
    }

    return { updated: results };
  }
}
