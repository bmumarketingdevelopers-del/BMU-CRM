import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import type { Me, SettingsSection } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { SettingsService } from './settings.service.js';

@Controller('settings')
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  all(@CurrentUser() me: Me) {
    return this.settings.all(me);
  }

  @Put(':section')
  save(@CurrentUser() me: Me, @Param('section') section: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.settings.save(me, section as SettingsSection, body, ip);
  }
}
