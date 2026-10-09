import { Module } from '@nestjs/common';
import { ActionsModule } from '../actions/actions.module.js';
import { OpsActionsModule } from '../ops-actions/ops-actions.module.js';
import { ApiKeysService } from './api-keys.service.js';
import { ClientAdResultsController, DeveloperController, IntegrationsController, PublicIntegrationsController } from './integrations.controller.js';
import { IntegrationsService } from './integrations.service.js';
import { MetricsSyncService } from './metrics-sync.service.js';
import { PublisherService } from './publisher.service.js';
import { PublicApiController } from './v1.controller.js';
import { WebhooksService } from './webhooks.service.js';

/** v19 integrations, publishing and public API. See docs/flows/integrations.md. */
@Module({
  imports: [ActionsModule, OpsActionsModule],
  controllers: [IntegrationsController, ClientAdResultsController, PublicIntegrationsController, DeveloperController, PublicApiController],
  providers: [IntegrationsService, PublisherService, MetricsSyncService, WebhooksService, ApiKeysService],
  exports: [IntegrationsService, PublisherService, MetricsSyncService, WebhooksService],
})
export class IntegrationsModule {}
