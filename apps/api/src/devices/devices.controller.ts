import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { PushService } from './push.service.js';
import { SyncService } from './sync.service.js';

/** v20 phone app: offline sync, push tokens and push quick actions. */
@Controller()
export class DevicesController {
  constructor(
    private readonly sync: SyncService,
    private readonly push: PushService,
  ) {}

  @Post('sync/push')
  @HttpCode(200)
  syncPush(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.sync.push(me, body, ip);
  }

  @Get('sync/pull')
  syncPull(@CurrentUser() me: Me, @Query('since') since?: string) {
    return this.sync.pull(me, since);
  }

  @Post('devices/push-token')
  @HttpCode(200)
  register(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.push.register(me, body);
  }

  @Delete('devices/push-token/:token')
  unregister(@CurrentUser() me: Me, @Param('token') token: string) {
    return this.push.unregister(me, token);
  }

  @Post('devices/quick-action')
  @HttpCode(200)
  quickAction(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.push.quickAction(me, body, ip);
  }
}
