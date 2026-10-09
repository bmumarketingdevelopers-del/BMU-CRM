import { Module } from '@nestjs/common';
import { ServiceModule } from '../service/service.module.js';
import { AlertsService } from './alerts.service.js';
import { ForecastService } from './forecast.service.js';
import { GoalsService } from './goals.service.js';
import { IntelligenceController } from './intelligence.controller.js';
import { IntelligenceService } from './intelligence.service.js';
import { MetricsService } from './metrics.service.js';
import { ReportsService } from './reports.service.js';

/** v20 intelligence: metric layer, forecasts with reasons, anomaly alerts, scheduled PDF reports and goals. */
@Module({
  imports: [ServiceModule],
  controllers: [IntelligenceController],
  providers: [MetricsService, ForecastService, AlertsService, ReportsService, GoalsService, IntelligenceService],
  exports: [MetricsService, IntelligenceService],
})
export class IntelligenceModule {}
