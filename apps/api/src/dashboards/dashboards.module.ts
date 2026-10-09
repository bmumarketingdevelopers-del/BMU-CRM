// v12 Dashboard Studio: edit the built-in dashboards and build new ones. See docs/flows/dashboards.md.
import { Module } from '@nestjs/common';
import { OpsAnalyticsModule } from '../ops-analytics/ops-analytics.module.js';
import { DashboardDataService } from './dashboard-data.service.js';
import { DashboardsController } from './dashboards.controller.js';
import { DashboardsService } from './dashboards.service.js';

@Module({
  imports: [OpsAnalyticsModule],
  controllers: [DashboardsController],
  providers: [DashboardsService, DashboardDataService],
})
export class DashboardsModule {}
