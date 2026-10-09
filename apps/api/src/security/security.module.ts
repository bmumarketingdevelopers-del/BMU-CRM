import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { NotificationsService } from '../notifications/notifications.service.js';
import { DpdpService } from './dpdp.service.js';
import { FieldAccessInterceptor, FieldAccessService } from './field-access.service.js';
import { PublicPrivacyController, SecurityAdminController } from './security-admin.controller.js';

/** v20 hardening: field-level permissions (global response filter), DPDP tools and the audit-chain check. */
@Global()
@Module({
  controllers: [SecurityAdminController, PublicPrivacyController],
  providers: [FieldAccessService, DpdpService, NotificationsService, { provide: APP_INTERCEPTOR, useClass: FieldAccessInterceptor }],
  exports: [FieldAccessService, DpdpService],
})
export class SecurityModule {}
