import { Module } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ActivityService } from './activity.service.js';
import { CoverService } from './cover.service.js';
import { PeopleService } from './people.service.js';
import { SearchService } from './search.service.js';
import { TeamFlowsController } from './team-flows.controller.js';
import { TimesheetsService } from './timesheets.service.js';

/** v10 team flows: onboarding/offboarding, timesheets, leave cover, global search, activity feed, branding. */
@Module({ controllers: [TeamFlowsController], providers: [PeopleService, TimesheetsService, CoverService, SearchService, ActivityService, NotificationsService], exports: [PeopleService] })
export class TeamFlowsModule {}
