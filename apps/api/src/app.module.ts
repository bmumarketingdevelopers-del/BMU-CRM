import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module.js';
import { AuthModule } from './auth/auth.module.js';
import { CatalogueController } from './catalogue/catalogue.controller.js';
import { CatalogueService } from './catalogue/catalogue.service.js';
import { ClientPortalController, ClientsController } from './clients/clients.controller.js';
import { EngagementsController } from './engagements/engagements.controller.js';
import { EngagementsService } from './engagements/engagements.service.js';
import { HealthController } from './health/health.controller.js';
import { LeadsController } from './leads/leads.controller.js';
import { OrgModule } from './org/org.module.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { ProposalsModule } from './proposals/proposals.module.js';
import { SettingsModule } from './settings/settings.module.js';
import { InsightsModule } from './insights/insights.module.js';
import { AdminOrgModule } from './admin-org/admin-org.module.js';
import { AdminPlatformModule } from './admin-platform/admin-platform.module.js';
import { WorkspaceModule } from './workspace/workspace.module.js';
import { FlowsModule } from './flows/flows.module.js';
import { OpsAnalyticsModule } from './ops-analytics/ops-analytics.module.js';
import { AnalyticsModule } from './analytics/analytics.module.js';
import { AutomationsModule } from './automations/automations.module.js';
import { ServiceModule } from './service/service.module.js';
import { CraftModule } from './craft/craft.module.js';
import { AiModule } from './ai/ai.module.js';
import { TeamFlowsModule } from './team-flows/team-flows.module.js';
import { ActionsModule } from './actions/actions.module.js';
import { ClientsActionsModule } from './clients-actions/clients-actions.module.js';
import { PeopleActionsModule } from './people-actions/people-actions.module.js';
import { OpsActionsModule } from './ops-actions/ops-actions.module.js';
import { DashboardsModule } from './dashboards/dashboards.module.js';
import { PlatformModule } from './platform/platform.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { CustomiseModule } from './customise/customise.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { CreativeModule } from './creative/creative.module.js';
import { CommsModule } from './comms/comms.module.js';
import { MoneyModule } from './money/money.module.js';
import { IntegrationsModule } from './integrations/integrations.module.js';
import { SecurityModule } from './security/security.module.js';
import { IntelligenceModule } from './intelligence/intelligence.module.js';
import { DevicesModule } from './devices/devices.module.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { StorageModule } from './storage/uploads.js';
import {
  ClientReviewsController,
  DeliverablesController,
  FilesController,
  MyDayController,
  QcController,
  TasksController,
} from './production/production.controller.js';
import { ProductionService } from './production/production.service.js';
import { TemplatesController } from './production/templates.controller.js';
import { NotificationsController } from './notifications/notifications.service.js';
import { BillingService } from './requests/billing.service.js';
import { DeliveryService } from './requests/delivery.service.js';
import { MessagesService } from './requests/messages.service.js';
import { ClientDeskController, RequestsController, ThreadFilesController, ThreadsController } from './requests/requests.controller.js';
import { RequestsService } from './requests/requests.service.js';
import { DeliverController } from './deliver/deliver.controller.js';
import { DeliverApprovalsService } from './deliver/deliver-approvals.service.js';
import { DeliverCalendarService } from './deliver/deliver-calendar.service.js';
import { DeliverCyclesService } from './deliver/deliver-cycles.service.js';
import { DeliverHandoverService } from './deliver/deliver-handover.service.js';
import { DeliverJobsService } from './deliver/deliver-jobs.service.js';
import { DeliverSlaService } from './deliver/deliver-sla.service.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RuntimeModule, StorageModule, AuditModule, AuthModule, OrgModule, ProposalsModule, SettingsModule, InsightsModule, AdminOrgModule, AdminPlatformModule, WorkspaceModule, AutomationsModule, AnalyticsModule, OpsAnalyticsModule, FlowsModule, ServiceModule, CraftModule, AiModule, TeamFlowsModule, ActionsModule, ClientsActionsModule, PeopleActionsModule, OpsActionsModule, DashboardsModule, PlatformModule, CustomiseModule, WorkflowsModule, AgentsModule, CreativeModule, CommsModule, MoneyModule, IntegrationsModule, SecurityModule, IntelligenceModule, DevicesModule],
  controllers: [
    HealthController,
    CatalogueController,
    LeadsController,
    ClientReviewsController,
    ClientPortalController,
    ClientsController,
    EngagementsController,
    TasksController,
    MyDayController,
    DeliverablesController,
    QcController,
    FilesController,
    TemplatesController,
    NotificationsController,
    RequestsController,
    ClientDeskController,
    ThreadsController,
    ThreadFilesController,
    DeliverController,
  ],
  providers: [CatalogueService, EngagementsService, ProductionService, BillingService, RequestsService, DeliveryService, MessagesService, DeliverCyclesService, DeliverCalendarService, DeliverApprovalsService, DeliverSlaService, DeliverHandoverService, DeliverJobsService],
})
export class AppModule {}
