import { Module } from '@nestjs/common';
import { AdminOrgController } from './admin-org.controller.js';
import { AttendanceService } from './attendance.service.js';
import { ClientsAdminService } from './clients-admin.service.js';
import { StructureService } from './structure.service.js';
import { OrgChartsService } from './org-charts.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';

/** Command Centre: Organisation (departments, branches, attendance, holidays, custom charts), Clients and Catalogue admin. */
@Module({ controllers: [AdminOrgController], providers: [StructureService, AttendanceService, ClientsAdminService, OrgChartsService, NotificationsService] })
export class AdminOrgModule {}
