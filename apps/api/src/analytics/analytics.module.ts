import { Module } from '@nestjs/common';
import { AnalyticsController } from './analytics.controller.js';
import { AnalyticsService } from './analytics.service.js';

/** v9 sales & money analytics: Scorecard, Sales Funnel, Revenue Forecast, MRR & Retention, Profitability. */
@Module({ controllers: [AnalyticsController], providers: [AnalyticsService] })
export class AnalyticsModule {}
