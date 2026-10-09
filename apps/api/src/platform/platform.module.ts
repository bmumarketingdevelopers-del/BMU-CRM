import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { EventsService } from './events.service.js';
import { FlagsService } from './flags.service.js';
import { RealtimeController, SystemController } from './platform.controller.js';
import { RealtimeService } from './realtime.service.js';
import { RequestContextInterceptor } from './request-context.js';
import { SearchIndexService } from './search-index.service.js';
import { SystemService } from './system.service.js';

/**
 * v13 foundation: event bus (failures and retries), live updates and presence, smart search index, feature flags
 * and System health. Global so any module can inject FlagsService or SearchIndexService. See docs/flows/platform.md.
 */
@Global()
@Module({
  controllers: [RealtimeController, SystemController],
  providers: [{ provide: APP_INTERCEPTOR, useClass: RequestContextInterceptor }, EventsService, FlagsService, RealtimeService, SearchIndexService, SystemService],
  exports: [EventsService, FlagsService, RealtimeService, SearchIndexService],
})
export class PlatformModule {}
