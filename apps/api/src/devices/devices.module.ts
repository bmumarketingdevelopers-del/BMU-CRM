import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller.js';
import { PushService } from './push.service.js';
import { SyncService } from './sync.service.js';
import { WebPushService } from './web-push.service.js';

/** v20 mobile parity: offline-first sync, push notifications with quick actions. v44: browser notifications. */
@Module({ controllers: [DevicesController], providers: [SyncService, PushService, WebPushService], exports: [PushService, WebPushService] })
export class DevicesModule {}
