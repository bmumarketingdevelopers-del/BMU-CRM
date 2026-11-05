import { Module } from '@nestjs/common';
import { ProposalsModule } from '../proposals/proposals.module.js';
import { BillingService } from '../requests/billing.service.js';
import { ClientQuotesController, QuotesController } from './quotes.controller.js';
import { QuotesService } from './quotes.service.js';

/** v45 quotations: made by the team, signed by the client; the invoices follow once the client has paid. */
@Module({
  imports: [ProposalsModule],
  controllers: [QuotesController, ClientQuotesController],
  providers: [BillingService, QuotesService],
})
export class QuotesModule {}
