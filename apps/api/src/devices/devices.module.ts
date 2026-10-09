import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller.js';
import { PushService } from './push.service.js';
import { SyncService } from './sync.service.js';

/** v20 mobile parity: offline-first sync, push notifications with quick actions. */
@Module({ controllers: [DevicesController], providers: [SyncService, PushService], exports: [PushService] })
export class DevicesModule {}
