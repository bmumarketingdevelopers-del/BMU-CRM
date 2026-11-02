import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { PushService } from './push.service.js';
import { SyncService } from './sync.service.js';
import { WebPushService } from './web-push.service.js';

/** v20 phone app: offline sync, push tokens and push quick actions. v44: browser notifications (Web Push). */
@Controller()
export class DevicesController {
  constructor(
    private readonly sync: SyncService,
    private readonly push: PushService,
    private readonly webPush: WebPushService,
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

  @Get('devices/web-push')
  webPushConfig(@CurrentUser() me: Me) {
    return this.webPush.config(me);
  }

  @Post('devices/web-push')
  @HttpCode(200)
  webPushSubscribe(@CurrentUser() me: Me, @Body() body: unknown, @Headers('user-agent') userAgent?: string) {
    return this.webPush.subscribe(me, body, userAgent);
  }

  @Post('devices/web-push/remove')
  @HttpCode(200)
  webPushUnsubscribe(@CurrentUser() me: Me, @Body() body: { endpoint?: unknown }) {
    return this.webPush.unsubscribe(me, typeof body?.endpoint === 'string' ? body.endpoint : '');
  }

  @Post('devices/web-push/test')
  @HttpCode(200)
  webPushTest(@CurrentUser() me: Me) {
    return this.webPush.test(me);
  }
}
