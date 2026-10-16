import { Global, Module } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ProposalsModule } from '../proposals/proposals.module.js';
import { BillingRunService } from './billing-run.service.js';
import { DunningService } from './dunning.service.js';
import { EmailService } from './email.service.js';
import { InvoiceBrandingController } from './invoice-branding.controller.js';
import { InvoiceBrandingService } from './invoice-branding.service.js';
import { InvoiceEvents } from './invoice-events.js';
import { ServiceBillingService } from './service-billing.service.js';
import { ServiceController } from './service.controller.js';

/**
 * v10 service flows. Global so every module can send notifications (respecting templates + preferences),
 * emails (outbox / SMTP), invoice emails, and hear "invoice paid" events.
 */
@Global()
@Module({
  imports: [ProposalsModule],
  controllers: [ServiceController, InvoiceBrandingController],
  providers: [EmailService, InvoiceEvents, NotificationsService, ServiceBillingService, DunningService, BillingRunService, InvoiceBrandingService],
  exports: [EmailService, InvoiceEvents, NotificationsService, ServiceBillingService, DunningService],
})
export class ServiceModule {}
