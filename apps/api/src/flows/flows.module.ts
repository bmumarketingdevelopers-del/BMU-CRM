import { Module } from '@nestjs/common';
import { FlowsController } from './flows.controller.js';
import { FlowsService } from './flows.service.js';
import { JourneyService } from './journey.service.js';

/** v9 flows area: business flow map, journey timelines, projects gate strip, founder pulse. */
@Module({ controllers: [FlowsController], providers: [FlowsService, JourneyService] })
export class FlowsModule {}
