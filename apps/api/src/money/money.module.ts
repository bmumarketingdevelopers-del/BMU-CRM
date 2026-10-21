import { Module } from '@nestjs/common';
import { ProposalsModule } from '../proposals/proposals.module.js';
import { BillingService } from '../requests/billing.service.js';
import { CapacityService } from './capacity.service.js';
import { CashflowService } from './cashflow.service.js';
import { ExpensesService } from './expenses.service.js';
import { CapacityController, MoneyController, PublicMoneyController, TimerController } from './money.controller.js';
import { PaymentsHubService } from './payments-hub.service.js';
import { ProfitService } from './profit.service.js';
import { SchedulesService } from './schedules.service.js';
import { TaskPassService } from './task-pass.service.js';
import { TimerService } from './timer.service.js';

/** v18 finance 2.0 and capacity. See docs/flows/finance-capacity.md. */
@Module({
  imports: [ProposalsModule],
  controllers: [MoneyController, TimerController, CapacityController, PublicMoneyController],
  providers: [BillingService, PaymentsHubService, SchedulesService, ExpensesService, TimerService, ProfitService, CashflowService, CapacityService, TaskPassService],
  exports: [PaymentsHubService, CapacityService, ProfitService, SchedulesService],
})
export class MoneyModule {}
