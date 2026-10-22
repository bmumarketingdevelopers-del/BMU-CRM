import { Body, Controller, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  sellActivitySchema,
  sellDecisionSchema,
  sellExtendSchema,
  sellFollowUpSchema,
  sellRejectSchema,
  sellRenewalCreateSchema,
  sellReviseSchema,
  type Me,
} from '@bmu/shared';
import { CatalogueService } from '../catalogue/catalogue.service.js';
import { ClientIp, CurrentUser, Public, RequireCapability } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DiscountApprovalsService } from '../proposals/discounts.service.js';
import { ProposalsService } from '../proposals/proposals.service.js';
import { SellService } from './sell.service.js';

/** v10 sell flows: lead detail + activity, follow-ups, duplicates, negotiation, discount approvals, renewals. */
@Controller('sell')
export class SellController {
  constructor(
    private readonly sell: SellService,
    private readonly proposals: ProposalsService,
    private readonly discounts: DiscountApprovalsService,
    private readonly catalogue: CatalogueService,
    private readonly prisma: PrismaService,
  ) {}

  /** Live price book for the website package builder (same prices and bundle rules as proposals). */
  @Public()
  @Get('public/pricing')
  async publicPricing() {
    const org = await this.prisma.organisation.findFirstOrThrow({ orderBy: { createdAt: 'asc' } });
    return this.catalogue.pricing(org.id);
  }

  @Get('leads/:id')
  @RequireCapability('leads_pipeline')
  lead(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.sell.detail(me, id);
  }

  @Post('leads/:id/activities')
  @RequireCapability('leads_pipeline')
  activity(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.sell.logActivity(me, id, parse(sellActivitySchema, body), ip);
  }

  @Patch('leads/:id/follow-up')
  @RequireCapability('leads_pipeline')
  followUp(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.sell.setFollowUp(me, id, parse(sellFollowUpSchema, body).nextFollowUpAt, ip);
  }

  @Post('leads/:id/merge')
  @HttpCode(200)
  @RequireCapability('leads_pipeline')
  merge(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.sell.merge(me, id, ip);
  }

  @Post('leads/:id/keep-separate')
  @HttpCode(200)
  @RequireCapability('leads_pipeline')
  keepSeparate(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.sell.keepSeparate(me, id, ip);
  }

  @Get('follow-ups')
  @RequireCapability('leads_pipeline')
  followUps(@CurrentUser() me: Me) {
    return this.sell.followUps(me);
  }

  @Post('proposals/:id/revise')
  @RequireCapability('leads_pipeline')
  revise(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.proposals.revise(me, id, parse(sellReviseSchema, body), ip);
  }

  @Post('proposals/:id/extend')
  @HttpCode(200)
  @RequireCapability('leads_pipeline')
  extend(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.proposals.extend(me, id, parse(sellExtendSchema, body).days, ip);
  }

  /** Discount approvals inbox (sales managers, admins, Founder). Others get an empty inbox. */
  @Get('approvals')
  approvals(@CurrentUser() me: Me) {
    return this.discounts.inbox(me);
  }

  /** Discounts on the signed-in person's own proposals (pending, approved, history). Never anyone else's. */
  @Get('approvals/mine')
  myDiscounts(@CurrentUser() me: Me) {
    return this.discounts.mine(me);
  }

  @Post('approvals/:id/approve')
  @HttpCode(200)
  approve(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.discounts.decide(me, id, true, parse(sellDecisionSchema, body ?? {}).note, ip);
  }

  @Post('approvals/:id/reject')
  @HttpCode(200)
  reject(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.discounts.decide(me, id, false, parse(sellRejectSchema, body).note, ip);
  }

  @Get('renewals')
  @RequireCapability('leads_pipeline')
  renewals(@CurrentUser() me: Me) {
    return this.sell.renewals(me);
  }

  @Post('renewals')
  @RequireCapability('leads_pipeline')
  createRenewal(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    const input = parse(sellRenewalCreateSchema, body);
    return this.sell.createRenewal(me, input.clientOrgId, input.engagementIds, ip);
  }
}
