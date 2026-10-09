import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { ProposalsModule } from '../proposals/proposals.module.js';
import { BillingService } from '../requests/billing.service.js';
import { ClientAccountController, ClientsActionsController } from './clients-actions.controller.js';
import { ClientsCreateService } from './clients-create.service.js';
import { ClientsLifecycleService } from './clients-lifecycle.service.js';
import { ClientsManageService } from './clients-manage.service.js';
import { ClientsRequestsService } from './clients-requests.service.js';
import { ClientsTargets } from './clients-targets.js';
import { ClientReadOnlyInterceptor } from './read-only.interceptor.js';

/**
 * v11 clients: add clients by hand (and migrated clients), edit, users, brands, AM reassignment (`client_am`), request
 * reassignment (`request`), add service / change tier, pause, offboarding, health, and the request actions.
 * See docs/flows/clients-actions.md.
 */
@Module({
  imports: [ProposalsModule],
  controllers: [ClientsActionsController, ClientAccountController],
  providers: [BillingService, ClientsCreateService, ClientsManageService, ClientsLifecycleService, ClientsRequestsService, ClientsTargets, { provide: APP_INTERCEPTOR, useClass: ClientReadOnlyInterceptor }],
  exports: [ClientsCreateService],
})
export class ClientsActionsModule {}
