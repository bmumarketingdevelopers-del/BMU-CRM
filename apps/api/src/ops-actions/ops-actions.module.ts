// v11 ops: leads & sales, finance, creators, files, communication and admin configuration actions.
// See docs/flows/ops-actions.md.
import { Module } from '@nestjs/common';
import { InsightsModule } from '../insights/insights.module.js';
import { ProposalsModule } from '../proposals/proposals.module.js';
import { ServiceModule } from '../service/service.module.js';
import { OpsAdminController, OpsCommsController, OpsCreatorsController, OpsFilesController, OpsFinanceController, OpsLeadsController } from './ops-actions.controller.js';
import { OpsAdminService } from './ops-admin.service.js';
import { OpsCommsService } from './ops-comms.service.js';
import { OpsCreatorsService } from './ops-creators.service.js';
import { OpsFilesService } from './ops-files.service.js';
import { OpsFinanceService } from './ops-finance.service.js';
import { OpsJobsService } from './ops-jobs.service.js';
import { OpsLeadsService } from './ops-leads.service.js';

@Module({
  imports: [ProposalsModule, InsightsModule, ServiceModule],
  controllers: [OpsLeadsController, OpsFinanceController, OpsCreatorsController, OpsFilesController, OpsCommsController, OpsAdminController],
  providers: [OpsLeadsService, OpsFinanceService, OpsCreatorsService, OpsFilesService, OpsCommsService, OpsAdminService, OpsJobsService],
  exports: [OpsLeadsService],
})
export class OpsActionsModule {}
