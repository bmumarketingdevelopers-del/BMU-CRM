import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import {
  CLIENT_TEAM_ROLES,
  clientsBrandSchema,
  clientsBulkSchema,
  clientsClientQuoteSchema,
  clientsContactSchema,
  clientsConvertSchema,
  clientsCustomQuoteSchema,
  clientsDuplicateQuerySchema,
  clientsFromLeadSchema,
  clientsHealthSchema,
  clientsInternalApprovalSchema,
  clientsOffboardSchema,
  clientsOffboardTickSchema,
  clientsPastInvoiceSchema,
  clientsPauseSchema,
  clientsQuoteSchema,
  clientsRaiseRequestSchema,
  clientsSetGateSchema,
  normaliseIdentifier,
  type ClientsAccount,
  type ClientsListQuery,
  type ClientTeamRole,
  type Me,
} from '@bmu/shared';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { contactOf } from './clients-access.js';
import { ClientsCreateService } from './clients-create.service.js';
import { ClientsLifecycleService } from './clients-lifecycle.service.js';
import { ClientsManageService } from './clients-manage.service.js';
import { ClientsRequestsService } from './clients-requests.service.js';

/** v11 clients (team side). Every route checks role + scope in its service. */
@Controller('clients-actions')
export class ClientsActionsController {
  constructor(
    private readonly creator: ClientsCreateService,
    private readonly manage: ClientsManageService,
    private readonly lifecycle: ClientsLifecycleService,
    private readonly requests: ClientsRequestsService,
  ) {}

  @Get('form-options')
  formOptions(@CurrentUser() me: Me) {
    return this.creator.formOptions(me);
  }

  @Get('am-suggest')
  amSuggest(@CurrentUser() me: Me, @Query('industry') industry?: string) {
    return this.creator.amSuggest(me, industry);
  }

  @Post('duplicates')
  @HttpCode(200)
  duplicates(@CurrentUser() me: Me, @Body() body: unknown) {
    return this.creator.duplicates(me, parse(clientsDuplicateQuerySchema, body));
  }

  @Post()
  create(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creator.create(me, body, ip, { source: 'manual' });
  }

  @Get('list')
  list(@CurrentUser() me: Me, @Query() q: ClientsListQuery) {
    return this.manage.list(me, q);
  }

  @Post('bulk')
  @HttpCode(200)
  bulk(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.manage.bulk(me, parse(clientsBulkSchema, body), ip);
  }

  @Post('from-lead/:leadId')
  fromLead(@CurrentUser() me: Me, @Param('leadId') leadId: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.creator.createClientFromLead(me, leadId, parse(clientsFromLeadSchema, body), ip);
  }

  // Requests ------------------------------------------------------------------
  @Post('requests')
  raise(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.requests.raise(me, parse(clientsRaiseRequestSchema, body), ip);
  }

  @Post('requests/:id/custom-quote')
  @HttpCode(200)
  customQuote(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.requests.customQuote(me, id, parse(clientsCustomQuoteSchema, body), ip);
  }

  @Get('requests/:id/convert')
  convertPreview(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.requests.convertPreview(me, id);
  }

  @Post('requests/:id/convert')
  @HttpCode(200)
  convert(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.requests.convert(me, id, parse(clientsConvertSchema, body), ip);
  }

  @Post('internal-approval')
  internalApproval(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.requests.internalApproval(me, parse(clientsInternalApprovalSchema, body), ip);
  }

  // Quotes / engagements -------------------------------------------------------
  @Post('quotes/:id/send')
  @HttpCode(200)
  async sendQuote(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.manage.detail(me, await this.lifecycle.sendQuote(me, id, ip));
  }

  @Post('quotes/:id/cancel')
  @HttpCode(200)
  async cancelQuote(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.manage.detail(me, await this.lifecycle.cancelQuote(me, id, ip));
  }

  @Post('engagements/:id/pause')
  @HttpCode(200)
  pause(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.lifecycle.pause(me, id, parse(clientsPauseSchema, body), ip);
  }

  @Post('engagements/:id/resume')
  @HttpCode(200)
  resume(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    return this.lifecycle.resume(me, id, ip);
  }

  @Post('engagements/:id/gate')
  @HttpCode(200)
  setGate(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.lifecycle.setGate(me, id, parse(clientsSetGateSchema, body), ip);
  }

  @Post('jobs/run')
  @HttpCode(200)
  runJobs(@CurrentUser() me: Me) {
    if (!this.lifecycle.canRunJobs(me)) throw new ForbiddenException('Leadership only');
    return this.lifecycle.sweep(new Date(), me.orgId);
  }

  // One client -----------------------------------------------------------------
  @Get(':id')
  detail(@CurrentUser() me: Me, @Param('id') id: string) {
    return this.manage.detail(me, id);
  }

  @Patch(':id')
  edit(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.manage.edit(me, id, body, ip);
  }

  @Post(':id/brands')
  addBrand(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.manage.addBrand(me, id, parse(clientsBrandSchema, body), ip);
  }

  @Delete(':id/brands/:brandId')
  removeBrand(@CurrentUser() me: Me, @Param('id') id: string, @Param('brandId') brandId: string, @ClientIp() ip?: string) {
    return this.manage.removeBrand(me, id, brandId, ip);
  }

  @Post(':id/users')
  invite(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.manage.invite(me, id, body, ip);
  }

  @Post(':id/health')
  @HttpCode(200)
  health(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.manage.health(me, id, parse(clientsHealthSchema, body), ip);
  }

  @Post(':id/quotes')
  async quote(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const r = await this.lifecycle.createQuote(me, id, parse(clientsQuoteSchema, body), ip);
    return { ...(await this.manage.detail(me, id)), message: r.message };
  }

  @Post(':id/offboard')
  @HttpCode(200)
  offboard(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    return this.lifecycle.offboard(me, id, parse(clientsOffboardSchema, body), ip);
  }

  @Post(':id/offboard/checklist')
  @HttpCode(200)
  async offboardTick(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { key, done } = parse(clientsOffboardTickSchema, body);
    await this.lifecycle.tick(me, id, key, done, ip);
    return this.manage.detail(me, id);
  }

  @Post(':id/offboard/complete')
  @HttpCode(200)
  async offboardComplete(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    await this.lifecycle.complete(me, id, ip);
    return this.manage.detail(me, id);
  }

  @Post(':id/past-invoices')
  pastInvoices(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { invoices } = parse(z.object({ invoices: z.array(clientsPastInvoiceSchema).min(1, 'Add at least one invoice').max(100) }), body);
    return this.creator.importPastInvoices(me, id, invoices, ip);
  }
}

/** v11 clients (client app): the client's own account in Settings. */
@Controller('client-actions')
export class ClientAccountController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly manage: ClientsManageService,
    private readonly lifecycle: ClientsLifecycleService,
    private readonly creator: ClientsCreateService,
  ) {}

  private clientOrgId(me: Me) {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    return me.clientOrg.id;
  }

  private assertOwner(me: Me) {
    const id = this.clientOrgId(me);
    if (me.clientOrg!.role !== 'client_owner') throw new ForbiddenException('Only the account Owner can do this');
    return id;
  }

  @Get('account')
  async account(@CurrentUser() me: Me): Promise<ClientsAccount> {
    const id = this.clientOrgId(me);
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id } });
    const isOwner = me.clientOrg!.role === 'client_owner';
    const [am, brands, engagements, quotes, invites, catalogue] = await Promise.all([
      c.amUserId ? this.prisma.user.findUnique({ where: { id: c.amUserId }, select: { name: true, email: true, phone: true } }) : null,
      this.prisma.clientBrand.findMany({ where: { clientOrgId: id, deletedAt: null }, orderBy: { name: 'asc' } }),
      this.prisma.engagement.findMany({ where: { clientOrgId: id, deletedAt: null }, include: { service: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.clientServiceQuote.findMany({ where: { clientOrgId: id, status: { not: 'cancelled' } }, orderBy: { createdAt: 'desc' }, take: 20 }),
      isOwner ? this.manage.pendingInvites(me.orgId, id) : Promise.resolve([]),
      isOwner ? this.creator.catalogue(me.orgId) : Promise.resolve([]),
    ]);
    const lead = !c.primaryContact && c.leadId ? await this.prisma.lead.findUnique({ where: { id: c.leadId }, select: { contact: true } }) : null;
    const lc = (lead?.contact ?? {}) as { name?: string; phone?: string; email?: string };
    return {
      id: c.id,
      name: c.name,
      isOwner,
      readOnly: !!c.readOnlyUntil,
      readOnlyUntil: c.readOnlyUntil?.toISOString() ?? null,
      am,
      contact: c.primaryContact ? contactOf(c) : { name: lc.name ?? null, phone: lc.phone ?? null, email: lc.email ?? null },
      brands: brands.map((b) => ({ id: b.id, name: b.name, address: b.location })),
      services: engagements.map((e) => ({ id: e.id, serviceName: e.service.name, serviceId: e.serviceId, tier: e.tier, billingType: e.billingType, status: e.status })),
      quotes: await this.manage.quoteViews(quotes),
      pendingInvites: invites,
      offboarding: this.manage.offboardingView(c),
      catalogue,
    };
  }

  /** client_owner: own contact info (CM notified). Billing details use the existing Billing page. */
  @Patch('contact')
  async contact(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    const id = this.assertOwner(me);
    const input = parse(clientsContactSchema, body);
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id } });
    const before = contactOf(c);
    const next = { name: input.contactName, phone: normaliseIdentifier(input.contactPhone), email: input.contactEmail.toLowerCase() };
    await this.prisma.clientOrg.update({ where: { id }, data: { primaryContact: next } });
    await this.audit.log(me, 'client.contact_updated', 'ClientOrg', id, { contact: before }, { contact: next }, ip);
    await this.notifications.notify(me.orgId, [c.amUserId], { kind: 'client_updated', title: `${c.name} updated their contact details`, body: `${next.name} · ${next.phone} · ${next.email}`, link: `/team/clients/${id}` });
    return this.account(me);
  }

  @Post('brands')
  async addBrand(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    const id = this.assertOwner(me);
    const input = parse(clientsBrandSchema, body);
    await this.manage.saveBrand(me, id, input, ip);
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id }, select: { name: true, amUserId: true } });
    await this.notifications.notify(me.orgId, [c.amUserId], { kind: 'client_updated', title: `${c.name} added ${input.name}`, body: input.address, link: `/team/clients/${id}?tab=brands` });
    return this.account(me);
  }

  @Post('quotes')
  async requestQuote(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string) {
    await this.lifecycle.clientRequestQuote(me, parse(clientsClientQuoteSchema, body), ip);
    return this.account(me);
  }

  @Post('quotes/:id/approve')
  @HttpCode(200)
  async approveQuote(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    await this.lifecycle.clientApproveQuote(me, id, ip);
    return this.account(me);
  }

  @Post('quotes/:id/decline')
  @HttpCode(200)
  async declineQuote(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const { reason } = parse(z.object({ reason: z.string().trim().max(500).optional() }), body ?? {});
    await this.lifecycle.clientDeclineQuote(me, id, reason, ip);
    return this.account(me);
  }

  /** The existing Owner confirms (or declines) a new Owner invited by the CM. */
  @Post('owner-invites/:approvalId')
  @HttpCode(200)
  async decideInvite(@CurrentUser() me: Me, @Param('approvalId') approvalId: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const id = this.assertOwner(me);
    const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), body);
    const r = await this.prisma.approvalRequest.findFirst({ where: { id: approvalId, orgId: me.orgId, action: 'clients.owner_invite', targetId: { startsWith: `${id}:` } } });
    if (!r) throw new BadRequestException('Invite not found');
    if (r.status !== 'pending') throw new BadRequestException(`This invite is already ${r.status}`);
    const claimed = await this.prisma.approvalRequest.updateMany({ where: { id: r.id, status: 'pending' }, data: { status: decision === 'approve' ? 'approved' : 'rejected', decidedById: me.id, decidedAt: new Date(), decisionNote: decision === 'approve' ? 'Confirmed by the client Owner' : 'Declined by the client Owner' } });
    if (!claimed.count) throw new BadRequestException('Someone else just decided this');
    const invite = (r.payload as { invite: { name: string; email?: string; phone?: string; role: ClientTeamRole; brandScope?: string[] } }).invite;
    if (decision === 'approve') {
      try {
        await this.manage.addConfirmedOwner(me, id, { ...invite, role: (CLIENT_TEAM_ROLES as readonly string[]).includes(invite.role) ? invite.role : 'client_owner', brandScope: invite.brandScope ?? [] });
      } catch (e) {
        await this.prisma.approvalRequest.update({ where: { id: r.id }, data: { status: 'pending', decidedById: null, decidedAt: null, decisionNote: null } });
        throw e;
      }
    }
    await this.audit.log(me, `approval.${decision === 'approve' ? 'approved' : 'rejected'}`, 'ClientOrg', id, { status: 'pending' }, { approvalId: r.id, action: r.action, by: 'client owner' }, ip);
    await this.notifications.notify(me.orgId, [r.requestedById], { kind: 'approval_decided', title: `${me.name} ${decision === 'approve' ? 'confirmed' : 'declined'} ${invite.name} as an Owner`, link: `/team/clients/${id}?tab=users` });
    return this.account(me);
  }

  @Post('offboarding/confirm')
  @HttpCode(200)
  async confirmOffboarding(@CurrentUser() me: Me, @ClientIp() ip?: string) {
    await this.lifecycle.clientConfirm(me, ip);
    return this.account(me);
  }
}
