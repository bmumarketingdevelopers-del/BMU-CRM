import { Module } from '@nestjs/common';
import { CatalogueService } from '../catalogue/catalogue.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { SellController } from '../sell/sell.controller.js';
import { SellScheduler } from '../sell/sell.scheduler.js';
import { SellService } from '../sell/sell.service.js';
import { DiscountApprovalsService } from './discounts.service.js';
import { OnboardingService } from './onboarding.service.js';
import { PaymentsService } from './payments.service.js';
import { ProposalsController, PublicProposalsController } from './proposals.controller.js';
import { ProposalsService } from './proposals.service.js';

@Module({
  controllers: [ProposalsController, PublicProposalsController, SellController],
  providers: [ProposalsService, CatalogueService, PaymentsService, OnboardingService, NotificationsService, DiscountApprovalsService, SellService, SellScheduler],
  exports: [PaymentsService, ProposalsService, OnboardingService, SellService],
})
export class ProposalsModule {}
