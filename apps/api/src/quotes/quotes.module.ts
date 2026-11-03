import { Module } from '@nestjs/common';
import { ClientQuotesController, QuotesController } from './quotes.controller.js';
import { QuotesService } from './quotes.service.js';

/** v45 quotations: made by the team, accepted by the client; the advance invoice follows. */
@Module({
  controllers: [QuotesController, ClientQuotesController],
  providers: [QuotesService],
})
export class QuotesModule {}
