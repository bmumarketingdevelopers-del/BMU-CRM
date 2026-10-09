import { Global, Module } from '@nestjs/common';
import { CronController } from './cron.controller.js';
import { EventBridgeService } from './event-bridge.js';
import { HeartbeatService } from './heartbeat.service.js';

/**
 * v21 backend runtime: process roles (api / worker / all), the job registry, cross-process events over Postgres
 * and process heartbeats. See docs/backend.md.
 */
@Global()
@Module({
  controllers: [CronController],
  providers: [EventBridgeService, HeartbeatService],
  exports: [EventBridgeService, HeartbeatService],
})
export class RuntimeModule {}
