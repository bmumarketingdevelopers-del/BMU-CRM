import { Module } from '@nestjs/common';
import { OpsAnalyticsController } from './ops-analytics.controller.js';
import { OpsDeliveryService } from './delivery.service.js';
import { OpsExploreService } from './explore.service.js';
import { OpsSelfService } from './self.service.js';
import { OpsSlaService } from './sla.service.js';
import { OpsTeamService } from './team.service.js';

/** v9 operations analytics: team performance, delivery speed, SLA & response, report builder, my performance, client insights. */
@Module({ controllers: [OpsAnalyticsController], providers: [OpsTeamService, OpsDeliveryService, OpsSlaService, OpsExploreService, OpsSelfService], exports: [OpsExploreService] })
export class OpsAnalyticsModule {}
