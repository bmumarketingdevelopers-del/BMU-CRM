import { Module } from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service.js';
import { CraftManagerController } from './craft-manager.controller.js';
import { CraftManagerService } from './craft-manager.service.js';
import { CraftController } from './craft.controller.js';
import { CraftService } from './craft.service.js';

/** v10 craft area: specialist dashboards (video, script, social, web, UX/UI, graphic design) and the Manager workspace. */
@Module({ controllers: [CraftManagerController, CraftController], providers: [CraftService, CraftManagerService, NotificationsService] })
export class CraftModule {}
