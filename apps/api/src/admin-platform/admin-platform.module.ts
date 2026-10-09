import { Module } from '@nestjs/common';
import { ErrorsController } from './errors.controller.js';
import { PlatformController } from './platform.controller.js';
import { SopsController } from './sops.controller.js';

// Command Centre → Operations (SOPs, error log, checklist/gate/SLA rules) and Platform (integrations, branding, DPDP, tenant).
@Module({ controllers: [SopsController, ErrorsController, PlatformController], providers: [] })
export class AdminPlatformModule {}
