import { Module } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service.js';
import { HrIssuesController } from './hr-issues.controller.js';
import { HrIssuesService } from './hr-issues.service.js';

/** v50: Raise an issue with HR. */
@Module({ controllers: [HrIssuesController], providers: [HrIssuesService, NotificationsService] })
export class HrIssuesModule {}
