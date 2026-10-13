// v11 clients: add_engagement and change_tier quotes (client Owner approves in the app, pays, then it applies),
// pause_engagement (AM Lead approval; tasks paused, clocks paused, invoices skipped), set the gate of a migrated
// service, and cancel/offboard a client (Branch Manager approval, checklist, client confirms receipt, users read-only 90 days).
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  addWorkingDays,
  CLIENTS_GATES,
  CLIENTS_OFFBOARD_CHECKS,
  CLIENTS_READ_ONLY_DAYS,
  clientsCanAddEngagement,
  clientsCanOffboard,
  clientsDueNowPaise,
  clientsProRataPaise,
  clientsTierRank,
  WORK_END_MIN,
  WORK_START_MIN,
  workingMinutesBetween,
  type ClientsGate,
  type ClientsOffboardCheck,
  type ClientsQuoteInput,
  type Me,
} from '@bmu/shared';
import type { Prisma, Tier } from '../generated/prisma/client.js';
import { ApprovalsService } from '../actions/approvals.service.js';
import { hasRole, OPEN_TASK } from '../actions/people.js';
import { ActionsRegistry } from '../actions/registry.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { BillingService } from '../requests/billing.service.js';
import { InvoiceEvents } from '../service/invoice-events.js';
import { ServiceBillingService } from '../service/service-billing.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { isAdmin, isClientLead, istMonth, loadClient, runsClient } from './clients-access.js';
import { createEngagementTx, gateIndex, requirementsFor, statusForGate } from './clients-engagements.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const QUOTE_INVOICE = 'service_quote';
const STOPPED = ['paused', 'offboarding', 'closed', 'delivered'];
const DAY_MS = 86_400_000;
type PauseState = { status: string; tasks: { id: string; status: string; deadline: string | null }[]; deliverables: { id: string; dueAt: string | null }[]; pausedAt: string };
type Offboarding = { status: string; reason: string; lastCycle: string; checklist: Record<string, { done: boolean; by: string | null; at: string | null }>; requestedBy: string | null; requestedAt: string; approvedAt: string | null; completedAt: string | null; clientConfirmedAt: string | null };

@Injectable()
export class ClientsLifecycleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('ClientsJobs');
  private job?: JobHandle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly registry: ActionsRegistry,
    private readonly approvals: ApprovalsService,
    private readonly billing: BillingService,
    private readonly events: InvoiceEvents,
    private readonly serviceBilling: ServiceBillingService,
  ) {}

  onModuleInit() {
    this.registry.registerApprovalHandler({
      action: 'clients.pause',
      label: 'Pause a service',
      href: (r) => `/team/projects/${r.targetId}`,
      apply: async ({ approver, requester, req }) => {
        if (!hasRole(approver, 'am_lead', 'admin', 'founder')) throw new ForbiddenException('Only the AM Lead (or a Branch Manager) can approve a pause');
        const p = req.payload as { reason: string; until: string };
        return this.pauseNow(requester ?? approver, req.targetId, p.reason, p.until, approver);
      },
    });
    this.registry.registerApprovalHandler({
      action: 'clients.offboard',
      label: 'Offboard a client',
      href: (r) => `/team/clients/${r.targetId}`,
      apply: async ({ approver, req }) => {
        if (!isAdmin(approver)) throw new ForbiddenException('Only a Branch Manager can approve offboarding a client');
        return this.startOffboarding(approver, req.targetId);
      },
      onReject: async ({ approver, req }) => {
        await this.prisma.clientOrg.update({ where: { id: req.targetId }, data: { offboarding: null as never } });
        await this.audit.log(approver, 'client.offboarding_rejected', 'ClientOrg', req.targetId, null, { note: req.decisionNote }, undefined);
      },
    });
    this.events.onPaid(async (inv) => {
      if (inv.kind !== QUOTE_INVOICE) return;
      const q = await this.prisma.clientServiceQuote.findFirst({ where: { invoiceId: inv.id, status: 'approved' } });
      if (q) await this.applyQuote(q.id, null);
    });
    this.job = startJob({ name: 'clients.lifecycle', hint: 'Resumes paused services and finishes client offboarding when due', everyMs: 10 * 60_000, flags: ['ACTIONS_JOBS_DISABLED'], run: () => this.sweep() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  /** Background: resume pauses that ended, archive offboarded clients after 90 days read-only. */
  async sweep(now = new Date(), orgId?: string) {
    const ended = await this.prisma.engagement.findMany({ where: { status: 'paused', pausedUntil: { lt: now }, ...(orgId ? { orgId } : {}) }, select: { id: true, orgId: true } });
    for (const e of ended) await this.resumeNow(null, e.id, 'The pause ended');
    const expired = await this.prisma.clientOrg.findMany({ where: { readOnlyUntil: { lt: now }, archivedAt: null, ...(orgId ? { orgId } : {}) }, select: { id: true, orgId: true } });
    for (const c of expired) {
      await this.prisma.clientOrg.update({ where: { id: c.id }, data: { archivedAt: now, archivedReason: `Offboarded: archived after ${CLIENTS_READ_ONLY_DAYS} days read-only` } });
      const users = await this.prisma.clientUser.findMany({ where: { clientOrgId: c.id }, select: { userId: true } });
      await this.prisma.user.updateMany({ where: { id: { in: users.map((u) => u.userId) } }, data: { status: 'suspended' } });
      await this.audit.logSystem(c.orgId, 'client.archived', 'ClientOrg', c.id, { reason: 'read-only period ended' });
    }
    return { resumed: ended.length, archived: expired.length };
  }

  // -------------------------------------------------------------------------
  // Quotes: add service / change tier

  private async liveService(orgId: string, key: string) {
    const book = await this.prisma.priceBook.findFirst({ where: { orgId, status: 'active' }, orderBy: { effectiveFrom: 'desc' }, include: { services: { where: { key }, include: { tiers: true } } } });
    return book?.services[0] ?? null;
  }

  /** Works out the amounts for a quote. Throws with a plain reason when it can't be offered. */
  private async price(orgId: string, clientOrgId: string, input: ClientsQuoteInput) {
    if (input.kind === 'add_service') {
      const service = await this.prisma.service.findFirst({ where: { id: input.serviceId, orgId, priceBook: { status: 'active' } }, include: { tiers: true } });
      if (!service) throw new BadRequestException('Pick a service from the live price book');
      const tier = service.tiers.find((t) => t.tier === input.tier);
      if (!tier) throw new BadRequestException(`${service.name} has no ${input.tier} tier`);
      const running = await this.prisma.engagement.findFirst({ where: { clientOrgId, deletedAt: null, status: { notIn: ['closed', 'delivered'] }, service: { key: service.key } } });
      if (running) throw new BadRequestException(`${service.name} is already running for this client. Change its tier instead.`);
      if (input.startMonth < istMonth()) throw new BadRequestException('The start month is in the past');
      return { serviceId: service.id, serviceName: service.name, tier: input.tier as Tier, fromTier: null, engagementId: null, startMonth: input.startMonth, effective: 'next_cycle', amountPaise: clientsDueNowPaise(service.billingType, tier.pricePaise), monthlyDiffPaise: null as number | null, downgrade: false };
    }
    const e = await this.prisma.engagement.findFirst({ where: { id: input.engagementId, clientOrgId, deletedAt: null }, include: { service: true } });
    if (!e) throw new NotFoundException('Service not found');
    if (STOPPED.includes(e.status)) throw new BadRequestException(`${e.service.name} is ${e.status.replace(/_/g, ' ')}; its tier can't change now`);
    if (e.tier === input.tier) throw new BadRequestException(`${e.service.name} is already on ${input.tier}`);
    const live = (await this.liveService(orgId, e.service.key)) ?? (await this.prisma.service.findUnique({ where: { id: e.serviceId }, include: { tiers: true } }));
    const from = live?.tiers.find((t) => t.tier === e.tier)?.pricePaise ?? 0;
    const to = live?.tiers.find((t) => t.tier === input.tier)?.pricePaise;
    if (to === undefined) throw new BadRequestException(`${e.service.name} has no ${input.tier} tier`);
    const diff = to - from;
    const downgrade = clientsTierRank[input.tier as Tier] < clientsTierRank[e.tier];
    const effective = input.effective ?? 'next_cycle';
    if (downgrade && effective === 'now_prorata') throw new BadRequestException('A downgrade applies from the next cycle');
    if (effective === 'now_prorata' && e.billingType !== 'monthly') throw new BadRequestException('Pro-rata applies to monthly retainers only');
    const amountPaise = downgrade ? 0 : e.billingType === 'monthly' ? (effective === 'now_prorata' ? clientsProRataPaise(Math.max(0, diff)) : 0) : Math.max(0, diff);
    return { serviceId: e.serviceId, serviceName: e.service.name, tier: input.tier as Tier, fromTier: e.tier, engagementId: e.id, startMonth: null, effective, amountPaise, monthlyDiffPaise: e.billingType === 'monthly' ? diff : null, downgrade };
  }

  async createQuote(me: Me, clientOrgId: string, input: ClientsQuoteInput, ip?: string) {
    const { client: c } = await loadClient(this.prisma, me, clientOrgId, { write: true });
    if (input.kind === 'add_service' && !(clientsCanAddEngagement(me) && (runsClient(me, c) || hasRole(me, 'sales_manager')))) throw new ForbiddenException("Only the client's Account Manager, a Sales Manager or a Branch Manager can add a service");
    if (input.kind === 'change_tier' && !runsClient(me, c)) throw new ForbiddenException("Only the client's Account Manager or a Branch Manager can change a tier");
    if (c.offboarding) throw new BadRequestException('This client is being offboarded');
    const p = await this.price(me.orgId, c.id, input);
    const q = await this.prisma.clientServiceQuote.create({
      data: { orgId: me.orgId, clientOrgId: c.id, kind: input.kind, engagementId: p.engagementId, serviceId: p.serviceId, tier: p.tier, fromTier: p.fromTier, startMonth: p.startMonth, effective: p.effective, amountPaise: p.amountPaise, monthlyDiffPaise: p.monthlyDiffPaise, status: 'sent', note: input.note ?? null, requestedById: me.id, sentById: me.id },
    });
    const what = input.kind === 'add_service' ? `Add ${p.serviceName} (${p.tier})` : `${p.serviceName}: ${p.fromTier} → ${p.tier}`;
    await this.audit.log(me, input.kind === 'add_service' ? 'client.service_quoted' : 'engagement.tier_quoted', input.kind === 'add_service' ? 'ClientOrg' : 'Engagement', input.kind === 'add_service' ? c.id : p.engagementId!, null, { quoteId: q.id, what, amountPaise: p.amountPaise, effective: p.effective }, ip);
    await this.notifications.notify(me.orgId, await this.owners(c.id), { kind: 'quote_ready', title: `Quote ready: ${what}`, body: p.amountPaise ? `To pay now: ₹${Math.round((p.amountPaise * 1.18) / 100).toLocaleString('en-IN')} incl. GST` : 'Nothing to pay now. Approve it in the app.', link: '/client/settings', critical: true });
    return { quoteId: q.id, message: `Quote sent to ${c.name}: ${what}` };
  }

  /** client_owner (request): the client asks; the AM checks and sends it. */
  async clientRequestQuote(me: Me, input: ClientsQuoteInput, ip?: string) {
    const clientOrgId = this.assertOwner(me);
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId } });
    if (c.offboarding) throw new BadRequestException('Your account is being closed');
    const p = await this.price(me.orgId, c.id, input);
    const q = await this.prisma.clientServiceQuote.create({
      data: { orgId: me.orgId, clientOrgId: c.id, kind: input.kind, engagementId: p.engagementId, serviceId: p.serviceId, tier: p.tier, fromTier: p.fromTier, startMonth: p.startMonth, effective: p.effective, amountPaise: p.amountPaise, monthlyDiffPaise: p.monthlyDiffPaise, status: 'requested', note: input.note ?? null, requestedById: me.id, requestedByClient: true },
    });
    const what = input.kind === 'add_service' ? `add ${p.serviceName} (${p.tier})` : `move ${p.serviceName} from ${p.fromTier} to ${p.tier}`;
    await this.audit.log(me, 'client.quote_requested', 'ClientOrg', c.id, null, { quoteId: q.id, what }, ip);
    await this.notifications.notify(me.orgId, [c.amUserId], { kind: 'quote_requested', title: `${c.name} wants to ${what}`, body: 'Check it and send the quote from Client 360 → Services.', link: `/team/clients/${c.id}?tab=services`, critical: true });
  }

  private async quoteFor(me: Me, id: string) {
    const q = await this.prisma.clientServiceQuote.findFirst({ where: { id, orgId: me.orgId } });
    if (!q) throw new NotFoundException('Quote not found');
    return q;
  }

  async sendQuote(me: Me, id: string, ip?: string) {
    const q = await this.quoteFor(me, id);
    const { client: c } = await loadClient(this.prisma, me, q.clientOrgId, { write: true });
    if (!runsClient(me, c) && !hasRole(me, 'sales_manager')) throw new ForbiddenException("Only the client's Account Manager can send this quote");
    if (q.status !== 'requested') throw new BadRequestException('This quote was already sent');
    const fresh = await this.price(me.orgId, c.id, q.kind === 'add_service' ? { kind: 'add_service', serviceId: q.serviceId, tier: q.tier, startMonth: q.startMonth ?? istMonth() } : { kind: 'change_tier', engagementId: q.engagementId!, tier: q.tier, effective: q.effective as 'next_cycle' | 'now_prorata' });
    await this.prisma.clientServiceQuote.update({ where: { id }, data: { status: 'sent', sentById: me.id, amountPaise: fresh.amountPaise, monthlyDiffPaise: fresh.monthlyDiffPaise } });
    await this.audit.log(me, 'client.quote_sent', 'ClientOrg', c.id, { status: 'requested' }, { quoteId: id, status: 'sent', amountPaise: fresh.amountPaise }, ip);
    await this.notifications.notify(me.orgId, await this.owners(c.id), { kind: 'quote_ready', title: `Your quote is ready: ${fresh.serviceName}`, body: 'Approve it in Settings → Services.', link: '/client/settings', critical: true });
    return c.id;
  }

  async cancelQuote(me: Me, id: string, ip?: string) {
    const q = await this.quoteFor(me, id);
    const { client: c } = await loadClient(this.prisma, me, q.clientOrgId, { write: true });
    if (!runsClient(me, c) && q.requestedById !== me.id) throw new ForbiddenException("Only the client's Account Manager can cancel this quote");
    if (!['requested', 'sent'].includes(q.status)) throw new BadRequestException(`This quote is already ${q.status}`);
    await this.prisma.clientServiceQuote.update({ where: { id }, data: { status: 'cancelled' } });
    await this.audit.log(me, 'client.quote_cancelled', 'ClientOrg', c.id, { status: q.status }, { quoteId: id, status: 'cancelled' }, ip);
    return c.id;
  }

  private assertOwner(me: Me) {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    if (me.clientOrg.role !== 'client_owner') throw new ForbiddenException('Only the account Owner can do this');
    return me.clientOrg.id;
  }

  private async owners(clientOrgId: string) {
    const rows = await this.prisma.clientUser.findMany({ where: { clientOrgId, clientRole: 'client_owner', user: { deletedAt: null, status: { not: 'suspended' } } }, select: { userId: true } });
    return rows.map((r) => r.userId);
  }

  /** Client Owner's written approval. Something to pay now → invoice (applies when paid); otherwise applies now. */
  async clientApproveQuote(me: Me, id: string, ip?: string) {
    const clientOrgId = this.assertOwner(me);
    const q = await this.prisma.clientServiceQuote.findFirst({ where: { id, clientOrgId } });
    if (!q) throw new NotFoundException('Quote not found');
    if (q.status !== 'sent') throw new BadRequestException(q.status === 'requested' ? 'Your account manager is still preparing this quote' : `This quote is already ${q.status}`);
    const service = await this.prisma.service.findUniqueOrThrow({ where: { id: q.serviceId } });
    const now = new Date();
    let invoiceId: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      await tx.approval.create({ data: { orgId: me.orgId, targetType: 'client_quote', targetId: q.id, userId: me.id, at: now } });
      if (q.amountPaise > 0) {
        const label = q.kind === 'add_service' ? `${service.name} (${q.tier}) · ${service.billingType === 'monthly' ? 'First month, in advance' : '50% advance'}` : `${service.name}: ${q.fromTier} → ${q.tier}${q.effective === 'now_prorata' ? ' (pro-rata for this month)' : ' (difference)'}`;
        const inv = await this.billing.issue(tx, { orgId: me.orgId, clientOrgId, engagementId: q.engagementId ?? undefined, kind: QUOTE_INVOICE, lines: [{ label, amountPaise: q.amountPaise }] });
        invoiceId = inv.id;
      }
      await tx.clientServiceQuote.update({ where: { id: q.id }, data: { status: 'approved', approvedById: me.id, approvedAt: now, invoiceId } });
    });
    await this.audit.log(me, 'client.quote_approved', q.kind === 'change_tier' ? 'Engagement' : 'ClientOrg', q.kind === 'change_tier' ? q.engagementId! : clientOrgId, { status: 'sent' }, { quoteId: q.id, status: 'approved', invoiceId }, ip);
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId }, select: { name: true, amUserId: true } });
    await this.notifications.notify(me.orgId, [c.amUserId], { kind: 'quote_approved', title: `${c.name} approved: ${service.name} ${q.kind === 'add_service' ? `(${q.tier})` : `→ ${q.tier}`}`, body: invoiceId ? 'Invoice issued; it applies once paid.' : 'It applies now.', link: `/team/clients/${clientOrgId}?tab=services` });
    if (q.kind === 'change_tier' && q.fromTier && clientsTierRank[q.tier] < clientsTierRank[q.fromTier]) {
      const leads = await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'am_lead' } } } }, select: { id: true } });
      await this.notifications.notify(me.orgId, leads.map((l) => l.id), { kind: 'tier_downgrade', title: `${c.name} is downgrading ${service.name} to ${q.tier}`, body: `From the next cycle (was ${q.fromTier}).`, link: `/team/clients/${clientOrgId}?tab=services`, critical: true });
    }
    if (invoiceId) await this.serviceBilling.invoiceIssued(invoiceId).catch(() => 0);
    else await this.applyQuote(q.id, me);
  }

  async clientDeclineQuote(me: Me, id: string, reason: string | undefined, ip?: string) {
    const clientOrgId = this.assertOwner(me);
    const q = await this.prisma.clientServiceQuote.findFirst({ where: { id, clientOrgId } });
    if (!q) throw new NotFoundException('Quote not found');
    if (!['sent', 'requested'].includes(q.status)) throw new BadRequestException(`This quote is already ${q.status}`);
    await this.prisma.clientServiceQuote.update({ where: { id }, data: { status: 'declined', note: reason ? `${q.note ? `${q.note} · ` : ''}Declined: ${reason}` : q.note } });
    await this.audit.log(me, 'client.quote_declined', 'ClientOrg', clientOrgId, { status: q.status }, { quoteId: id, reason: reason ?? null }, ip);
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId }, select: { name: true, amUserId: true } });
    await this.notifications.notify(me.orgId, [c.amUserId], { kind: 'quote_declined', title: `${c.name} declined a service quote`, body: reason, link: `/team/clients/${clientOrgId}?tab=services` });
  }

  /** Applies an approved (and paid) quote: a new engagement at G1 with its own checklist, or the new tier. */
  async applyQuote(quoteId: string, by: Me | null) {
    const q = await this.prisma.clientServiceQuote.findUniqueOrThrow({ where: { id: quoteId } });
    if (q.status !== 'approved') return;
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: q.clientOrgId } });
    const service = await this.prisma.service.findUniqueOrThrow({ where: { id: q.serviceId } });
    let engagementId = q.engagementId;
    if (q.kind === 'add_service') {
      const reqs = await requirementsFor(this.settings, q.orgId, service.key);
      engagementId = await this.prisma.$transaction((tx) => createEngagementTx(tx, { orgId: q.orgId, clientOrgId: c.id, service, tier: q.tier, amId: c.amUserId, startMonth: q.startMonth, paymentPending: false, requirements: reqs, byUserId: by?.id ?? q.approvedById ?? q.requestedById }));
      await this.audit.logSystem(q.orgId, 'engagement.created', 'Engagement', engagementId, { service: service.name, tier: q.tier, gate: 'G1', quoteId: q.id });
    } else {
      const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id: q.engagementId! } });
      await this.prisma.engagement.update({ where: { id: e.id }, data: { tier: q.tier } });
      await this.audit.logSystem(q.orgId, 'engagement.tier_changed', 'Engagement', e.id, { from: e.tier, to: q.tier, effective: q.effective, quoteId: q.id });
    }
    await this.prisma.clientServiceQuote.update({ where: { id: q.id }, data: { status: 'applied', appliedAt: new Date(), resultEngagementId: engagementId } });
    const body = q.kind === 'add_service' ? `${service.name} starts with its onboarding checklist (Gate 1).` : `${service.name} is now on ${q.tier}${q.effective === 'next_cycle' ? ' from the next cycle' : ''}.`;
    await this.notifications.notify(q.orgId, [c.amUserId], { kind: 'service_added', title: `${c.name}: ${q.kind === 'add_service' ? `${service.name} added` : `tier changed to ${q.tier}`}`, body, link: q.kind === 'add_service' ? `/team/projects/${engagementId}` : `/team/clients/${c.id}?tab=services` });
    await this.notifications.notify(q.orgId, await this.owners(c.id), { kind: 'service_added', title: q.kind === 'add_service' ? `${service.name} is confirmed` : `${service.name} moves to ${q.tier}`, body: q.kind === 'add_service' ? 'Share the items on your onboarding checklist to get started.' : body, link: q.kind === 'add_service' ? '/client/onboarding' : '/client' });
  }

  // -------------------------------------------------------------------------
  // Pause / resume

  private async engagementFor(me: Me, id: string) {
    const e = await this.prisma.engagement.findFirst({ where: { id, orgId: me.orgId, deletedAt: null }, include: { service: { select: { name: true } } } });
    if (!e) throw new NotFoundException('Service not found');
    const { client } = await loadClient(this.prisma, me, e.clientOrgId, { write: true });
    return { e, client };
  }

  async pause(me: Me, id: string, input: { reason: string; until: string }, ip?: string) {
    const { e, client } = await this.engagementFor(me, id);
    if (!runsClient(me, client)) throw new ForbiddenException("Only the client's Account Manager or a Branch Manager can pause a service");
    if (STOPPED.includes(e.status) || e.status === 'pending_payment') throw new BadRequestException(`${e.service.name} is ${e.status.replace(/_/g, ' ')}`);
    const until = new Date(`${input.until}T23:59:00+05:30`);
    if (until.getTime() < Date.now() + DAY_MS / 2) throw new BadRequestException('The pause must end on a future date');
    if (until.getTime() > Date.now() + 366 * DAY_MS) throw new BadRequestException('Pause for a year at most');
    if (hasRole(me, 'am_lead', 'admin', 'founder')) {
      await this.pauseNow(me, id, input.reason, input.until, me, ip);
      return { ok: true as const, message: `${e.service.name} paused until ${input.until}`, approval: null };
    }
    const req = await this.approvals.create(
      me,
      { action: 'clients.pause', targetType: 'engagement', targetId: id, summary: `Pause ${client.name} · ${e.service.name} until ${input.until}`, payload: { reason: input.reason, until: input.until }, reason: input.reason, approverId: null, approverRoles: ['am_lead'], diff: [{ field: 'Status', before: e.status.replace(/_/g, ' '), after: `Paused until ${input.until}` }] },
      ip,
    );
    return { ok: true as const, message: 'Sent to the AM Lead for approval', approval: { id: req.id, summary: req.summary } };
  }

  /** Pauses: open tasks wait (deadlines lifted), deliverable due dates lifted (SLA clock stops), billing run skips it. */
  async pauseNow(me: Me, id: string, reason: string, untilDay: string, approver: Me, ip?: string) {
    const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id }, include: { service: { select: { name: true } }, clientOrg: { select: { id: true, name: true, amUserId: true } } } });
    if (STOPPED.includes(e.status)) throw new BadRequestException(`${e.service.name} is already ${e.status.replace(/_/g, ' ')}`);
    const tasks = await this.prisma.task.findMany({ where: { orgId: e.orgId, status: { in: ['todo', 'in_progress', 'blocked', 'waiting'] }, archivedAt: null, OR: [{ engagementId: id }, { deliverable: { cycle: { engagementId: id } } }] }, select: { id: true, status: true, deadline: true, ownerId: true } });
    const deliverables = await this.prisma.deliverable.findMany({ where: { cycle: { engagementId: id }, dueAt: { not: null }, status: { notIn: ['approved', 'scheduled', 'published'] } }, select: { id: true, dueAt: true } });
    const state: PauseState = { status: e.status, tasks: tasks.map((t) => ({ id: t.id, status: t.status, deadline: t.deadline?.toISOString() ?? null })), deliverables: deliverables.map((d) => ({ id: d.id, dueAt: d.dueAt?.toISOString() ?? null })), pausedAt: new Date().toISOString() };
    const until = new Date(`${untilDay}T23:59:00+05:30`);
    await this.prisma.$transaction([
      this.prisma.engagement.update({ where: { id }, data: { status: 'paused', pausedUntil: until, pauseReason: reason, pauseState: state } }),
      this.prisma.task.updateMany({ where: { id: { in: tasks.map((t) => t.id) } }, data: { status: 'waiting', deadline: null } }),
      this.prisma.deliverable.updateMany({ where: { id: { in: deliverables.map((d) => d.id) } }, data: { dueAt: null } }),
    ]);
    await this.audit.log(approver, 'engagement.paused', 'Engagement', id, { status: e.status }, { status: 'paused', until: untilDay, reason, tasksPaused: tasks.length, requestedBy: me.id === approver.id ? null : me.name }, ip);
    const owners = [...new Set(tasks.map((t) => t.ownerId).filter((x): x is string => !!x))];
    await this.notifications.notify(e.orgId, [e.clientOrg.amUserId, ...owners].filter((x) => x !== approver.id), { kind: 'engagement_status', title: `${e.clientOrg.name} · ${e.service.name} is paused until ${untilDay}`, body: `${reason}. Tasks are on hold and deadlines are paused.`, link: `/team/projects/${id}` });
    await this.notifications.notify(e.orgId, await this.owners(e.clientOrg.id), { kind: 'engagement_status', title: `${e.service.name} is paused until ${untilDay}`, body: 'No invoices for the paused months. Work resumes after the pause.', link: '/client' });
    return { paused: true, tasks: tasks.length };
  }

  async resume(me: Me, id: string, ip?: string) {
    const { e, client } = await this.engagementFor(me, id);
    if (!runsClient(me, client)) throw new ForbiddenException("Only the client's Account Manager or a Branch Manager can resume a service");
    if (e.status !== 'paused') throw new BadRequestException(`${e.service.name} is not paused`);
    await this.resumeNow(me, id, 'Resumed', ip);
    return { ok: true as const, message: `${e.service.name} resumed` };
  }

  /** Restores task statuses, and moves deadlines and due dates later by the working days the service was paused. */
  async resumeNow(me: Me | null, id: string, why: string, ip?: string) {
    const e = await this.prisma.engagement.findUniqueOrThrow({ where: { id }, include: { service: { select: { name: true } }, clientOrg: { select: { id: true, name: true, amUserId: true } } } });
    if (e.status !== 'paused') return;
    const st = (e.pauseState ?? null) as PauseState | null;
    const cal = await calendarFor(this.prisma, e.orgId);
    const shiftDays = st ? Math.max(0, Math.round(workingMinutesBetween(new Date(st.pausedAt), new Date(), cal) / (WORK_END_MIN - WORK_START_MIN))) : 0;
    const shift = (iso: string | null) => (iso ? (shiftDays ? addWorkingDays(new Date(iso), shiftDays, cal) : new Date(iso)) : null);
    const restored = (st?.status ?? (e.billingType === 'monthly' ? 'active_retainer' : 'in_production')) as never;
    await this.prisma.$transaction([
      this.prisma.engagement.update({ where: { id }, data: { status: restored, pausedUntil: null, pauseReason: null, pauseState: null as never } }),
      ...(st?.tasks ?? []).map((t) => this.prisma.task.updateMany({ where: { id: t.id, status: 'waiting' }, data: { status: t.status as never, deadline: shift(t.deadline) } })),
      ...(st?.deliverables ?? []).map((d) => this.prisma.deliverable.updateMany({ where: { id: d.id, dueAt: null }, data: { dueAt: shift(d.dueAt) } })),
    ]);
    const after = { status: restored, reason: why, deadlinesMovedByWorkingDays: shiftDays };
    if (me) await this.audit.log(me, 'engagement.resumed', 'Engagement', id, { status: 'paused' }, after, ip);
    else await this.audit.logSystem(e.orgId, 'engagement.resumed', 'Engagement', id, after);
    await this.notifications.notify(e.orgId, [e.clientOrg.amUserId].filter((x) => x !== me?.id), { kind: 'engagement_status', title: `${e.clientOrg.name} · ${e.service.name} resumed`, body: `${why}. Deadlines moved by ${shiftDays} working day${shiftDays === 1 ? '' : 's'}.`, link: `/team/projects/${id}` });
  }

  // -------------------------------------------------------------------------
  // Migrated service: set the current gate (with a reason)

  async setGate(me: Me, id: string, input: { gate: string; reason: string }, ip?: string) {
    const { e, client } = await this.engagementFor(me, id);
    if (!runsClient(me, client)) throw new ForbiddenException("Only the client's Account Manager or a Branch Manager can set the gate");
    if (!e.migrated) throw new BadRequestException('Only migrated services can have their gate set by hand. New services move through the gates as the work happens.');
    if (STOPPED.includes(e.status)) throw new BadRequestException(`${e.service.name} is ${e.status.replace(/_/g, ' ')}`);
    const gate = input.gate as ClientsGate;
    if (gate === e.currentGate) throw new BadRequestException(`${e.service.name} is already at ${gate}`);
    const cycle = await this.prisma.cycle.findFirst({ where: { engagementId: id }, orderBy: { createdAt: 'desc' } });
    const have = await this.prisma.approval.findMany({ where: { targetType: 'engagement', targetId: id, gate: { not: null } }, select: { gate: true } });
    const missing = CLIENTS_GATES.slice(0, gateIndex(gate)).filter((g) => !have.some((h) => h.gate === g));
    await this.prisma.$transaction([
      this.prisma.engagement.update({ where: { id }, data: { currentGate: gate, status: statusForGate(gate, e.billingType), migrationReason: input.reason } }),
      ...(cycle && gateIndex(gate) > 0 && !cycle.rcdAt ? [this.prisma.cycle.update({ where: { id: cycle.id }, data: { rcdAt: new Date(), status: gate === 'G2' ? 'planning' : 'production' } })] : []),
      ...(missing.length ? [this.prisma.approval.createMany({ data: missing.map((g) => ({ orgId: me.orgId, targetType: 'engagement', targetId: id, gate: g, userId: me.id, migrated: true })) })] : []),
    ]);
    await this.audit.log(me, 'engagement.gate_set', 'Engagement', id, { gate: e.currentGate }, { gate, reason: input.reason, migrated: true }, ip);
    return { ok: true as const, message: `${e.service.name} is now at ${gate}` };
  }

  // -------------------------------------------------------------------------
  // Offboarding

  async offboard(me: Me, clientOrgId: string, input: { reason: string; lastCycle: string }, ip?: string) {
    const { client: c } = await loadClient(this.prisma, me, clientOrgId, { write: true });
    if (!clientsCanOffboard(me)) throw new ForbiddenException('Only a Branch Manager or the AM Lead can offboard a client');
    if (c.offboarding) throw new BadRequestException('Offboarding has already started for this client');
    const o: Offboarding = { status: 'requested', reason: input.reason, lastCycle: input.lastCycle, checklist: {}, requestedBy: me.name, requestedAt: new Date().toISOString(), approvedAt: null, completedAt: null, clientConfirmedAt: null };
    await this.prisma.clientOrg.update({ where: { id: c.id }, data: { offboarding: o } });
    await this.audit.log(me, 'client.offboarding_requested', 'ClientOrg', c.id, null, { reason: input.reason, lastCycle: input.lastCycle }, ip);
    if (isAdmin(me)) {
      await this.startOffboarding(me, c.id);
      return { ok: true as const, message: `Offboarding started for ${c.name}`, approval: null };
    }
    try {
      const req = await this.approvals.create(me, { action: 'clients.offboard', targetType: 'client_org', targetId: c.id, summary: `Offboard ${c.name} (last cycle ${input.lastCycle})`, payload: input, reason: input.reason, approverId: null, approverRoles: ['admin'], diff: [{ field: 'Client', before: 'Active', after: 'Offboarding' }] }, ip);
      return { ok: true as const, message: 'Sent to a Branch Manager for approval', approval: { id: req.id, summary: req.summary } };
    } catch (err) {
      await this.prisma.clientOrg.update({ where: { id: c.id }, data: { offboarding: null as never } });
      throw err;
    }
  }

  async startOffboarding(by: Me, clientOrgId: string) {
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId } });
    const o = c.offboarding as Offboarding | null;
    if (!o || o.status !== 'requested') throw new BadRequestException('This client is not waiting for offboarding approval');
    const next: Offboarding = { ...o, status: 'in_progress', approvedAt: new Date().toISOString() };
    const moved = await this.prisma.engagement.updateMany({ where: { clientOrgId, deletedAt: null, status: { notIn: ['closed', 'delivered'] } }, data: { status: 'offboarding' } });
    await this.prisma.clientOrg.update({ where: { id: clientOrgId }, data: { offboarding: next } });
    await this.audit.log(by, 'client.offboarding_started', 'ClientOrg', clientOrgId, { status: 'requested' }, { status: 'in_progress', engagements: moved.count }, undefined);
    await this.notifications.notify(c.orgId, [c.amUserId].filter((x) => x !== by.id), { kind: 'engagement_status', title: `Offboarding ${c.name}`, body: 'Work through the offboarding checklist on Client 360.', link: `/team/clients/${clientOrgId}`, critical: true });
    await this.notifications.notify(c.orgId, await this.owners(clientOrgId), { kind: 'engagement_status', title: 'We have started closing your account', body: `Last cycle: ${o.lastCycle}. Your account manager will hand over your final files.`, link: '/client/settings' });
    return { started: true };
  }

  async tick(me: Me, clientOrgId: string, key: ClientsOffboardCheck, done: boolean, ip?: string) {
    const { client: c } = await loadClient(this.prisma, me, clientOrgId, { write: true });
    if (!(runsClient(me, c) || (hasRole(me, 'finance') && key === 'dues_cleared'))) throw new ForbiddenException("Only the client's Account Manager, AM Lead or a Branch Manager can tick the checklist");
    const o = c.offboarding as Offboarding | null;
    if (!o || o.status !== 'in_progress') throw new BadRequestException(o?.status === 'requested' ? 'Offboarding is waiting for Branch Manager approval' : 'Offboarding is not in progress');
    if (key === 'dues_cleared' && done) {
      const unpaid = await this.prisma.invoice.findMany({ where: { clientOrgId, status: { in: ['issued', 'partially_paid', 'overdue'] } }, select: { number: true } });
      if (unpaid.length) throw new BadRequestException(`Still unpaid: ${unpaid.map((u) => u.number).join(', ')}. Collect or credit-note first.`);
    }
    const next: Offboarding = { ...o, checklist: { ...o.checklist, [key]: { done, by: done ? me.name : null, at: done ? new Date().toISOString() : null } } };
    await this.prisma.clientOrg.update({ where: { id: clientOrgId }, data: { offboarding: next } });
    await this.audit.log(me, 'client.offboarding_check', 'ClientOrg', clientOrgId, null, { key, done }, ip);
  }

  async complete(me: Me, clientOrgId: string, ip?: string) {
    const { client: c } = await loadClient(this.prisma, me, clientOrgId, { write: true });
    if (!runsClient(me, c)) throw new ForbiddenException("Only the client's Account Manager, AM Lead or a Branch Manager can finish offboarding");
    const o = c.offboarding as Offboarding | null;
    if (!o || o.status !== 'in_progress') throw new BadRequestException('Offboarding is not in progress');
    const open = CLIENTS_OFFBOARD_CHECKS.filter((k) => !o.checklist[k.key]?.done);
    if (open.length) throw new BadRequestException(`Finish the checklist first: ${open.map((k) => k.label.toLowerCase()).join('; ')}`);
    await this.prisma.clientOrg.update({ where: { id: clientOrgId }, data: { offboarding: { ...o, status: 'awaiting_client', completedAt: new Date().toISOString() } } });
    await this.audit.log(me, 'client.offboarding_completed', 'ClientOrg', clientOrgId, { status: 'in_progress' }, { status: 'awaiting_client' }, ip);
    await this.notifications.notify(me.orgId, await this.owners(clientOrgId), { kind: 'approval_needed', title: 'Please confirm you received everything', body: 'Your final files and handover are ready. Confirm receipt in Settings.', link: '/client/settings', critical: true });
  }

  /** The client confirms receipt: services close and client users become read-only for 90 days. */
  async clientConfirm(me: Me, ip?: string) {
    const clientOrgId = this.assertOwner(me);
    const c = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: clientOrgId } });
    const o = c.offboarding as Offboarding | null;
    if (!o || o.status !== 'awaiting_client') throw new BadRequestException('There is nothing to confirm yet');
    const now = new Date();
    const until = new Date(now.getTime() + CLIENTS_READ_ONLY_DAYS * DAY_MS);
    await this.prisma.$transaction([
      this.prisma.clientOrg.update({ where: { id: clientOrgId }, data: { offboarding: { ...o, status: 'closed', clientConfirmedAt: now.toISOString() }, readOnlyUntil: until } }),
      this.prisma.engagement.updateMany({ where: { clientOrgId, deletedAt: null, status: { not: 'closed' } }, data: { status: 'closed', endDate: now } }),
      this.prisma.approval.create({ data: { orgId: me.orgId, targetType: 'client_offboarding', targetId: clientOrgId, userId: me.id, at: now } }),
    ]);
    await this.audit.log(me, 'client.offboarded', 'ClientOrg', clientOrgId, { status: 'awaiting_client' }, { status: 'closed', readOnlyUntil: until.toISOString() }, ip);
    await this.notifications.notify(me.orgId, [c.amUserId], { kind: 'engagement_status', title: `${c.name} confirmed receipt. Offboarding is complete`, body: `Their users are read-only until ${until.toISOString().slice(0, 10)}.`, link: `/team/clients/${clientOrgId}` });
  }

  /** Read-only client accounts (offboarded) can't change anything. */
  async isReadOnly(clientOrgId: string) {
    const c = await this.prisma.clientOrg.findUnique({ where: { id: clientOrgId }, select: { readOnlyUntil: true } });
    return !!c?.readOnlyUntil;
  }

  // Leadership check used by the controller for the job trigger.
  canRunJobs(me: Me) {
    return isClientLead(me);
  }
}

export type ClientsTx = Prisma.TransactionClient;
export { OPEN_TASK };
