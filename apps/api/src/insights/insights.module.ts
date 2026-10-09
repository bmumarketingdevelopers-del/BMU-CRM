import { Module } from '@nestjs/common';
import { FinanceService } from './finance.service.js';
import { FinanceController, InsightsController } from './insights.controller.js';
import { InsightsService } from './insights.service.js';

/** Command Centre analytics (Weekly Review, Revenue, Collections, Capacity, Quality, Client Health) and the Finance desk. */
@Module({ controllers: [InsightsController, FinanceController], providers: [InsightsService, FinanceService], exports: [FinanceService] })
export class InsightsModule {}
