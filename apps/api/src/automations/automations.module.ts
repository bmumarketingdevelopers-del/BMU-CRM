import { Module } from '@nestjs/common';
import { AutomationsController } from './automations.controller.js';
import { AutomationsService } from './automations.service.js';
import { AutomationsEngine } from './engine.js';

/** v9 automations: rules, templates, the 60-second sweep engine and the run log. */
@Module({ controllers: [AutomationsController], providers: [AutomationsService, AutomationsEngine], exports: [AutomationsEngine] })
export class AutomationsModule {}
