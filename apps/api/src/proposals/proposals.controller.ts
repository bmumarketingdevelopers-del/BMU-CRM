import { Body, Controller, Get, Headers, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { acceptProposalSchema, createProposalSchema, sellChangeRequestSchema, type Me } from '@bmu/shared';
import { ClientIp, CurrentUser, Public, RequireCapability } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { CatalogueService } from '../catalogue/catalogue.service.js';
import { ProposalsService } from './proposals.service.js';

@Controller('proposals')
@RequireCapability('leads_pipeline')
export class ProposalsController {
  constructor(
    private readonly proposals: ProposalsService,
    private readonly catalogue: CatalogueService,
  ) {}

  /** Active price book for the proposal builder (sales can't open the pricing engine itself). */
  @Get('pricing')
  pricing(@CurrentUser() me: Me) {
    return this.catalogue.pricing(me.orgId);
  }

  @Get()
  list(@CurrentUser() me: Me) {
    return this.proposals.list(me);
  }

  @Get(':id')
  get(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.proposals.get(me, id);
  }

  @Post()
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.proposals.create(me, parse(createProposalSchema, body), ip);
  }

  @Post(':id/send')
  @HttpCode(200)
  send(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.proposals.send(me, id, ip);
  }

  @Post(':id/approve-discount')
  @HttpCode(200)
  approve(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.proposals.approveDiscount(me, id, ip);
  }
}

const razorpaySchema = z.object({
  razorpay_order_id: z.string(),
  razorpay_payment_id: z.string(),
  razorpay_signature: z.string(),
});

/** The branded proposal link a client opens: view, accept + e-sign, pay. No sign-in needed. */
@Public()
@Controller('public/proposals')
export class PublicProposalsController {
  constructor(private readonly proposals: ProposalsService) {}

  /** Each open counts as a view (the team's own preview passes ?preview=1 and is not counted). */
  @Get(':token')
  view(@Param('token') token: string, @Query('preview') preview?: string) {
    return this.proposals.viewPublic(token, preview === '1');
  }

  @Get(':token/agreement')
  agreement(@Param('token') token: string) {
    return this.proposals.agreement(token);
  }

  @Post(':token/accept')
  @HttpCode(200)
  accept(@Param('token') token: string, @Body() body: unknown, @ClientIp() ip?: string, @Headers('user-agent') ua?: string) {
    return this.proposals.accept(token, parse(acceptProposalSchema, body), ip, ua);
  }

  @Post(':token/request-changes')
  @HttpCode(200)
  requestChanges(@Param('token') token: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.proposals.requestChanges(token, parse(sellChangeRequestSchema, body), ip);
  }

  @Post(':token/checkout')
  @HttpCode(200)
  checkout(@Param('token') token: string) {
    return this.proposals.checkout(token);
  }

  @Post(':token/verify')
  @HttpCode(200)
  verify(@Param('token') token: string, @Body() body: unknown) {
    const b = parse(razorpaySchema, body);
    return this.proposals.verifyRazorpay(token, b.razorpay_order_id, b.razorpay_payment_id, b.razorpay_signature);
  }

  @Post(':token/pay-test')
  @HttpCode(200)
  payTest(@Param('token') token: string) {
    return this.proposals.payTest(token);
  }
}
