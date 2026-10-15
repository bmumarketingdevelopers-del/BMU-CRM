// v11 clients: add_client (manual, no lead), Merge into an existing client, existing-client migration, CSV import,
// convert a lead by hand (sales manager, payment proof), CM suggestion and the Finance payment confirmation.
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  CLIENT_TEAM_ROLES,
  CLIENTS_INDUSTRIES,
  clientsCanAdd,
  clientsCreateSchema,
  clientsDueNowPaise,
  clientsNormName,
  clientRoleLabels,
  normaliseIdentifier,
  SERVICE_GSTIN_RE,
  TIERS,
  type ClientsAmSuggestion,
  type ClientsCreate,
  type ClientsCreateResult,
  type ClientsDuplicate,
  type ClientsDuplicateQuery,
  type ClientsFormOptions,
  type ClientsFromLead,
  type ClientsInvite,
  type ClientsPastInvoice,
  type ClientTeamRole,
  type Me,
} from '@bmu/shared';
import type { Prisma, Tier } from '../generated/prisma/client.js';
import { ApprovalsService } from '../actions/approvals.service.js';
import { hasRole, PeopleDirectory } from '../actions/people.js';
import { ReassignService } from '../actions/reassign.service.js';
import { ActionsRegistry } from '../actions/registry.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { BillingService } from '../requests/billing.service.js';
import { InvoiceEvents } from '../service/invoice-events.js';
import { ServiceBillingService } from '../service/service-billing.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AM_BASE_ROLES, assertStaff, contactOf, isAdmin, loadClient } from './clients-access.js';
import { createEngagementTx, requirementsFor } from './clients-engagements.js';

type Tx = Prisma.TransactionClient;
type Parsed = ReturnType<typeof clientsCreateSchema.parse>;
const MANUAL_FIRST = 'manual_first_payment';

@Injectable()
export class ClientsCreateService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly registry: ActionsRegistry,
    private readonly approvals: ApprovalsService,
    private readonly people: PeopleDirectory,
    private readonly reassign: ReassignService,
    private readonly billing: BillingService,
    private readonly events: InvoiceEvents,
    private readonly serviceBilling: ServiceBillingService,
  ) {}

  onModuleInit() {
    // Manual client without online payment: Finance confirms the money arrived (approval_matrix).
    this.registry.registerApprovalHandler({
      action: 'clients.confirm_payment',
      label: 'Confirm payment received (manual client)',
      href: (r) => `/team/clients/${r.targetId}`,
      apply: async ({ approver, req }) => {
        if (!hasRole(approver, 'finance', 'founder', 'admin')) throw new ForbiddenException('Only Finance can confirm that the money arrived');
        const p = req.payload as { invoiceId?: string; reference?: string; amountPaise?: number };
        if (p.invoiceId) {
          const inv = await this.prisma.invoice.findUnique({ where: { id: p.invoiceId }, include: { payments: true } });
          if (inv && inv.status !== 'paid') {
            const due = inv.totalPaise - inv.payments.reduce((s, x) => s + x.amountPaise, 0);
            await this.billing.recordPayment(inv.id, p.amountPaise && p.amountPaise < due ? p.amountPaise : due, 'offline', p.reference ?? `offline_${req.id}`);
          }
        }
        await this.clearPaymentHold(req.targetId, approver.id);
        return { confirmed: true };
      },
      onReject: async ({ approver, req }) => {
        const c = await this.prisma.clientOrg.findUnique({ where: { id: req.targetId }, select: { name: true, amUserId: true } });
        await this.notifications.notify(approver.orgId, [c?.amUserId], { kind: 'payment_not_confirmed', title: `Finance could not confirm the payment from ${c?.name ?? 'the client'}`, body: 'Work stays on hold at Gate 1 until the payment is confirmed.', link: `/team/clients/${req.targetId}`, critical: true });
      },
    });

    // Paying the first invoice of a manual client (online, or recorded by Finance) releases the payment hold.
    this.events.onPaid(async (inv) => {
      if (inv.kind !== MANUAL_FIRST) return;
      const row = await this.prisma.invoice.findUnique({ where: { id: inv.id }, select: { clientOrgId: true } });
      if (!row?.clientOrgId) return;
      await this.clearPaymentHold(row.clientOrgId, null);
      // A pending Finance confirmation is no longer needed.
      await this.prisma.approvalRequest.updateMany({ where: { orgId: inv.orgId, action: 'clients.confirm_payment', targetId: row.clientOrgId, status: 'pending' }, data: { status: 'approved', decidedAt: new Date(), decisionNote: 'Paid: the invoice was settled' } });
    });

    this.registry.registerImportEntity({
      entity: 'clients',
      label: 'Clients',
      fields: [
        { key: 'business_name', label: 'Business name', required: true },
        { key: 'contact_name', label: 'Contact name', required: true },
        { key: 'contact_phone', label: 'Contact phone', required: true },
        { key: 'contact_email', label: 'Contact email', required: true },
        { key: 'industry', label: 'Industry', required: true },
        { key: 'billing_name', label: 'Billing name', required: true },
        { key: 'billing_address', label: 'Billing address', required: true },
        { key: 'branch', label: 'Branch', required: true, hint: 'Branch name or city' },
        { key: 'gstin', label: 'GSTIN', required: false },
        { key: 'am', label: 'Client manager', required: false, hint: 'Email or full name; empty = suggested by load' },
      ],
      sampleCsv: 'Business name,Contact name,Contact phone,Contact email,Industry,Billing name,Billing address,Branch,GSTIN,Client manager\nAroma Bakes,Kavya Rao,9876500011,kavya@aromabakes.in,Restaurants & cafes,Aroma Bakes LLP,"12 MG Road, Bengaluru",Bengaluru,29ABCDE1234F1Z5,am@bmu.demo\n',
      canImport: (me) => hasRole(me, 'founder', 'admin', 'am_lead'),
      validate: (me, rows) => this.validateImport(me, rows),
      commit: async (me, rows, ip) => {
        const resolved = await this.resolveImport(me, rows);
        const ids: string[] = [];
        for (const r of resolved) {
          const res = await this.create(me, { ...r.input, confirmDuplicate: true }, ip, { source: 'import' });
          ids.push(res.client.id);
        }
        return ids;
      },
    });
  }

  // -------------------------------------------------------------------------
  // Options, CM suggestion, duplicates

  async formOptions(me: Me): Promise<ClientsFormOptions> {
    assertStaff(me);
    const [branches, book, used, ams] = await Promise.all([
      this.prisma.branch.findMany({ where: { orgId: me.orgId, deletedAt: null }, orderBy: { name: 'asc' } }),
      this.activeBook(me.orgId),
      this.prisma.clientOrg.findMany({ where: { orgId: me.orgId, deletedAt: null, industry: { not: null } }, select: { industry: true }, distinct: ['industry'] }),
      this.amSuggest(me),
    ]);
    const industries = [...new Set([...CLIENTS_INDUSTRIES, ...used.map((u) => u.industry!).filter(Boolean)])];
    return {
      branches: branches.map((b) => ({ id: b.id, name: b.name, city: b.city })),
      industries,
      services: this.bookServices(book),
      ams,
      roles: CLIENT_TEAM_ROLES.map((r) => ({ key: r, label: clientRoleLabels[r].name })),
      canMigrate: clientsCanAdd(me),
    };
  }

  /** The live price book's services (also shown to client Owners asking for a new service). */
  async catalogue(orgId: string): Promise<ClientsFormOptions['services']> {
    return this.bookServices(await this.activeBook(orgId));
  }

  private bookServices(book: Awaited<ReturnType<ClientsCreateService['activeBook']>>): ClientsFormOptions['services'] {
    return (book?.services ?? []).map((s) => ({ id: s.id, key: s.key, name: s.name, billingType: s.billingType, tiers: s.tiers.sort((a, b) => TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier)).map((t) => ({ tier: t.tier, pricePaise: t.pricePaise, isFromPrice: t.isFromPrice })) }));
  }

  private activeBook(orgId: string) {
    return this.prisma.priceBook.findFirst({ where: { orgId, status: 'active' }, orderBy: { effectiveFrom: 'desc' }, include: { services: { include: { tiers: true }, orderBy: { name: 'asc' } } } });
  }

  /** CMs ranked: not on leave, already looking after this industry, then fewest active engagements and lowest load. */
  async amSuggest(me: Me, industry?: string): Promise<ClientsAmSuggestion[]> {
    assertStaff(me);
    const where: Prisma.UserWhereInput = { roles: { some: { role: { baseRole: { in: AM_BASE_ROLES } } } } };
    const [loads, clients] = await Promise.all([
      this.people.loads(me.orgId, where),
      this.prisma.clientOrg.findMany({ where: { orgId: me.orgId, deletedAt: null, archivedAt: null }, select: { amUserId: true, industry: true, engagements: { where: { deletedAt: null, status: { notIn: ['paused', 'offboarding', 'closed', 'delivered'] } }, select: { id: true } } } }),
    ]);
    const ind = (industry ?? '').trim().toLowerCase();
    const rows = loads.map((p) => {
      const mine = clients.filter((c) => c.amUserId === p.id);
      return {
        id: p.id,
        name: p.name,
        role: p.roles.includes('am_lead') ? 'CM Lead' : 'Client Manager',
        clients: mine.length,
        activeEngagements: mine.reduce((s, c) => s + c.engagements.length, 0),
        industryMatch: ind ? mine.filter((c) => (c.industry ?? '').toLowerCase() === ind).length : 0,
        loadPct: p.loadPct,
        suggested: false,
        onLeaveToday: p.onLeaveToday,
        lead: p.roles.includes('am_lead'),
      };
    });
    rows.sort((a, b) => Number(a.onLeaveToday) - Number(b.onLeaveToday) || Number(a.lead) - Number(b.lead) || Number(b.industryMatch > 0) - Number(a.industryMatch > 0) || a.activeEngagements - b.activeEngagements || a.loadPct - b.loadPct || a.name.localeCompare(b.name));
    if (rows[0]) rows[0].suggested = true;
    return rows.map(({ lead: _l, ...r }) => r);
  }

  async duplicates(me: Me, q: ClientsDuplicateQuery, excludeId?: string): Promise<ClientsDuplicate[]> {
    assertStaff(me);
    const name = q.businessName ? clientsNormName(q.businessName) : '';
    const phone = q.phone && q.phone.replace(/\D/g, '').length >= 8 ? normaliseIdentifier(q.phone) : '';
    const email = q.email?.includes('@') ? q.email.trim().toLowerCase() : '';
    const gstin = q.gstin && q.gstin.trim().length >= 10 ? q.gstin.trim().toUpperCase() : '';
    if (!name && !phone && !gstin && !email) return [];
    const rows = await this.prisma.clientOrg.findMany({
      where: { orgId: me.orgId, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
      select: { id: true, name: true, gstin: true, primaryContact: true, archivedAt: true, am: { select: { name: true } }, users: { select: { user: { select: { email: true, phone: true } } } }, leadId: true },
    });
    const leads = await this.prisma.lead.findMany({ where: { id: { in: rows.map((r) => r.leadId).filter((x): x is string => !!x) } }, select: { id: true, contact: true } });
    const out: ClientsDuplicate[] = [];
    for (const r of rows) {
      const why: string[] = [];
      const contact = contactOf(r);
      const lead = (leads.find((l) => l.id === r.leadId)?.contact ?? {}) as { phone?: string; email?: string };
      const phones = [contact.phone, lead.phone, ...r.users.map((u) => u.user.phone)].filter(Boolean).map((p) => normaliseIdentifier(p!));
      const emails = [contact.email, lead.email, ...r.users.map((u) => u.user.email)].filter(Boolean).map((e) => e!.toLowerCase());
      if (gstin && r.gstin?.toUpperCase() === gstin) why.push('Same GSTIN');
      if (phone && phones.includes(phone)) why.push('Same phone');
      if (email && emails.includes(email)) why.push('Same email');
      const n = clientsNormName(r.name);
      if (name && n && (n === name || (name.length >= 5 && (n.includes(name) || name.includes(n))))) why.push('Similar business name');
      if (why.length) out.push({ id: r.id, name: r.name, why, am: r.am?.name ?? null, archived: !!r.archivedAt });
    }
    return out.sort((a, b) => b.why.length - a.why.length).slice(0, 5);
  }

  // -------------------------------------------------------------------------
  // Create

  async create(me: Me, body: unknown, ip?: string, opts: { source?: 'manual' | 'lead' | 'import'; leadId?: string; allowSalesManagerOnly?: boolean } = {}): Promise<ClientsCreateResult> {
    assertStaff(me);
    if (!clientsCanAdd(me)) throw new ForbiddenException('Only the Founder, Branch Manager, Sales Manager or CM Lead can add clients');
    const parsed = clientsCreateSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Check the form');
    const input = parsed.data;
    if (input.startMode === 'migration' && !hasRole(me, 'founder', 'admin', 'am_lead', 'sales_manager')) throw new ForbiddenException('Only leadership can migrate an existing client');

    const branch = await this.prisma.branch.findFirst({ where: { id: input.branchId, orgId: me.orgId, deletedAt: null } });
    if (!branch) throw new BadRequestException('Pick a branch');
    const book = await this.activeBook(me.orgId);
    const lines = input.engagements.map((l) => {
      const service = book?.services.find((s) => s.id === l.serviceId);
      if (!service) throw new BadRequestException('One of the services is not in the live price book');
      const tier = service.tiers.find((t) => t.tier === l.tier);
      if (!tier) throw new BadRequestException(`${service.name} has no ${l.tier} tier`);
      return { ...l, service, pricePaise: tier.pricePaise };
    });
    if (new Set(lines.map((l) => l.serviceId)).size !== lines.length) throw new BadRequestException('Each service can be added once');

    // CM: chosen (must be an active CM) or suggested by load and industry.
    let amId = input.amUserId ?? null;
    if (amId) {
      const ok = await this.prisma.user.findFirst({ where: { id: amId, orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: { in: AM_BASE_ROLES } } } } } });
      if (!ok) throw new BadRequestException('Choose an active client manager');
    } else amId = (await this.amSuggest(me, input.industry)).find((a) => a.suggested)?.id ?? null;

    // Merge into an existing client, or check for duplicates first.
    let merged: Awaited<ReturnType<typeof loadClient>>['client'] | null = null;
    if (input.mergeIntoId) {
      merged = (await loadClient(this.prisma, me, input.mergeIntoId, { write: true })).client;
      if (merged.archivedAt) throw new BadRequestException(`${merged.name} is archived. Restore it before merging into it.`);
    } else if (!input.confirmDuplicate) {
      const dups = await this.duplicates(me, { businessName: input.businessName, phone: input.contactPhone, email: input.contactEmail, gstin: input.gstin || undefined });
      if (dups.length) throw new ConflictException(`Possible duplicate: ${dups.map((d) => `${d.name} (${d.why.join(', ').toLowerCase()})`).join('; ')}. Merge into it, or continue to add a new client.`);
    }
    await this.checkInvites(me.orgId, input.inviteNow ? input.invites : []);
    for (const p of input.pastInvoices) if (await this.prisma.invoice.findFirst({ where: { orgId: me.orgId, number: p.number } })) throw new BadRequestException(`Invoice number ${p.number} already exists`);

    const migration = input.startMode === 'migration';
    const needsPayment = !migration && lines.length > 0 && input.payment !== 'none';
    const gst = input.gstin || null;
    const contact = { name: input.contactName, phone: normaliseIdentifier(input.contactPhone), email: input.contactEmail };
    const result = await this.prisma.$transaction(async (tx) => {
      let clientId: string;
      if (merged) {
        clientId = merged.id;
        const c = merged;
        await tx.clientOrg.update({
          where: { id: c.id },
          data: {
            industry: c.industry ?? input.industry,
            gstin: c.gstin ?? gst,
            billingAddress: c.billingAddress ?? input.billingAddress,
            legalName: c.legalName ?? input.billingName,
            billingEmail: c.billingEmail ?? (input.billingEmail || null),
            placeOfSupply: c.placeOfSupply ?? (gst ? gst.slice(0, 2) : null),
            primaryContact: c.primaryContact ?? contact,
            branchId: c.branchId ?? branch.id,
            amUserId: c.amUserId ?? amId,
            ...(needsPayment ? { paymentStatus: 'pending' } : {}),
          },
        });
        amId = c.amUserId ?? amId;
      } else {
        const c = await tx.clientOrg.create({
          data: {
            orgId: me.orgId,
            leadId: opts.leadId ?? null,
            name: input.businessName,
            industry: input.industry,
            gstin: gst,
            billingAddress: input.billingAddress,
            legalName: input.billingName,
            billingEmail: input.billingEmail || null,
            placeOfSupply: gst ? gst.slice(0, 2) : null,
            primaryContact: contact,
            branchId: branch.id,
            amUserId: amId,
            tenureStart: new Date(),
            source: opts.source ?? 'manual',
            startMode: input.startMode,
            paymentStatus: needsPayment ? 'pending' : 'confirmed',
          },
        });
        clientId = c.id;
      }
      if (!(await tx.thread.findFirst({ where: { clientOrgId: clientId, type: 'client_am' } }))) await tx.thread.create({ data: { orgId: me.orgId, clientOrgId: clientId, type: 'client_am' } });
      if (input.brands.length) await tx.clientBrand.createMany({ data: input.brands.map((b) => ({ orgId: me.orgId, clientOrgId: clientId, name: b.name, location: b.address })) });

      const engagementIds: string[] = [];
      for (const l of lines) {
        engagementIds.push(
          await createEngagementTx(tx, {
            orgId: me.orgId,
            clientOrgId: clientId,
            service: l.service,
            tier: l.tier as Tier,
            amId,
            startMonth: l.startMonth ?? null,
            migrate: migration ? { gate: l.currentGate!, reason: l.gateReason ?? input.migrationReason ?? '' } : null,
            paymentPending: needsPayment,
            requirements: await requirementsFor(this.settings, me.orgId, l.service.key),
            byUserId: me.id,
          }),
        );
      }

      // First invoice for the new services: paid online in the client app, or confirmed by Finance (offline).
      let invoice: { id: string; number: string; totalPaise: number } | null = null;
      if (needsPayment) {
        const inv = await this.billing.issue(tx, {
          orgId: me.orgId,
          clientOrgId: clientId,
          kind: MANUAL_FIRST,
          engagementId: engagementIds.length === 1 ? engagementIds[0] : undefined,
          lines: lines.map((l) => ({ label: `${l.service.name} (${l.tier}) · ${l.service.billingType === 'monthly' ? 'First month, in advance' : '50% advance'}`, amountPaise: clientsDueNowPaise(l.service.billingType, l.pricePaise) })),
        });
        invoice = { id: inv.id, number: inv.number, totalPaise: inv.totalPaise };
      }
      const pastCount = migration ? await this.pastInvoicesTx(tx, me, clientId, input.pastInvoices) : 0;
      const invites = input.inviteNow ? await this.createInvitesTx(tx, me, clientId, input.invites, { creating: !merged }) : { created: [], pending: [] };
      return { clientId, engagementIds, invoice, pastCount, invites };
    });

    const client = await this.prisma.clientOrg.findUniqueOrThrow({ where: { id: result.clientId } });
    const action = merged ? 'client.merged_details' : migration ? 'client.migrated' : opts.source === 'lead' ? 'client.converted_from_lead' : 'client.created';
    await this.audit.log(me, action, 'ClientOrg', client.id, merged ? { name: merged.name } : null, { name: client.name, source: client.source, startMode: input.startMode, branch: branch.name, amUserId: amId, services: lines.map((l) => `${l.service.name} (${l.tier})`), brands: input.brands.length, migrationReason: input.migrationReason ?? null }, ip);
    for (const [i, id] of result.engagementIds.entries()) {
      const l = lines[i];
      await this.audit.log(me, migration ? 'engagement.migrated' : 'engagement.created', 'Engagement', id, null, { service: l.service.name, tier: l.tier, gate: migration ? l.currentGate : 'G1', reason: migration ? (l.gateReason ?? null) : null, paymentPending: needsPayment }, ip);
    }
    if (result.pastCount) await this.audit.log(me, 'client.past_invoices_imported', 'ClientOrg', client.id, null, { count: result.pastCount }, ip);
    if (result.invoice) await this.serviceBilling.invoiceIssued(result.invoice.id).catch(() => 0);

    // CM handover form: who handed the client over and what they need to know.
    if (amId && (!merged || !merged.amUserId)) {
      await this.reassign.record(me, 'client_am', [{ id: client.id, fromUserId: null, toUserId: amId }], 'other', input.handoverNote ? `Handover: ${input.handoverNote}` : 'New client');
      if (input.handoverNote) await this.threadNote(me, client.id, `Handover from ${me.name}: ${input.handoverNote}`, true);
    }

    let approval: ClientsCreateResult['approval'] = null;
    if (needsPayment && input.payment === 'offline') {
      const req = await this.approvals.create(
        me,
        {
          action: 'clients.confirm_payment',
          targetType: 'client_org',
          targetId: client.id,
          summary: `Confirm the payment from ${client.name}${result.invoice ? ` for ${result.invoice.number}` : ''}`,
          payload: { invoiceId: result.invoice?.id ?? null, reference: input.paymentReference ?? null, amountPaise: input.paymentAmountPaise ?? null },
          reason: `Paid offline. Reference: ${input.paymentReference}`,
          approverId: null,
          approverRoles: ['finance'],
          diff: [{ field: 'Payment', before: 'Not confirmed', after: 'Received' }],
        },
        ip,
      );
      approval = { id: req.id, summary: req.summary };
    }

    // Notify CM, CM Lead, Finance; welcome the invited users.
    const leads = await this.roleHolders(me.orgId, ['am_lead']);
    const finance = await this.roleHolders(me.orgId, ['finance']);
    const services = lines.length ? `${lines.length} service${lines.length > 1 ? 's' : ''}` : 'no services yet';
    const link = `/team/clients/${client.id}`;
    await this.notifications.notify(me.orgId, [amId].filter((x) => x !== me.id), { kind: 'client_assigned', title: merged ? `${client.name}: details added by ${me.name}` : `New client: ${client.name} is yours`, body: [migration ? 'Existing client migrated at its current gates.' : `Added by ${me.name} with ${services}.`, input.handoverNote ? `Handover: ${input.handoverNote}` : null].filter(Boolean).join(' '), link });
    await this.notifications.notify(me.orgId, leads.filter((x) => x !== me.id && x !== amId), { kind: 'client_created', title: `${me.name} added ${client.name}`, body: `${migration ? 'Migrated client' : 'New client'} · ${services}`, link });
    if (needsPayment || result.pastCount) await this.notifications.notify(me.orgId, finance.filter((x) => x !== me.id), { kind: 'client_created', title: `New client ${client.name}${input.payment === 'offline' ? ': confirm the offline payment' : ''}`, body: result.invoice ? `First invoice ${result.invoice.number} issued.` : `${result.pastCount} past invoice(s) imported.`, link: input.payment === 'offline' ? '/team/approvals' : link, critical: input.payment === 'offline' });
    if (result.invites.created.length) await this.welcome(me, client.id, result.invites.created, amId);
    if (result.invites.pending.length) await this.requestOwnerConfirmations(me, client.id, client.name, result.invites.pending);

    const message = merged
      ? `Details added to ${client.name}`
      : `${client.name} added${approval ? '. Finance will confirm the payment before work starts' : result.invoice ? '. The first invoice is waiting for payment in the client app' : ''}`;
    return {
      client: { id: client.id, name: client.name },
      merged: !!merged,
      engagementIds: result.engagementIds,
      invoice: result.invoice,
      approval,
      invited: result.invites.created.length,
      pendingOwnerInvites: result.invites.pending.length,
      message,
    };
  }

  private roleHolders(orgId: string, roles: string[]) {
    return this.prisma.user.findMany({ where: { orgId, type: 'staff', deletedAt: null, status: 'active', roles: { some: { role: { baseRole: { in: roles } } } } }, select: { id: true } }).then((r) => r.map((x) => x.id));
  }

  /** Releases the Gate 1 payment hold on every engagement of the client. */
  async clearPaymentHold(clientOrgId: string, byId: string | null) {
    const c = await this.prisma.clientOrg.findUnique({ where: { id: clientOrgId }, select: { orgId: true, name: true, amUserId: true, paymentStatus: true } });
    if (!c) return;
    const held = await this.prisma.engagement.updateMany({ where: { clientOrgId, paymentPending: true }, data: { paymentPending: false } });
    if (c.paymentStatus === 'confirmed' && !held.count) return;
    await this.prisma.clientOrg.update({ where: { id: clientOrgId }, data: { paymentStatus: 'confirmed' } });
    await this.audit.logSystem(c.orgId, 'client.payment_confirmed', 'ClientOrg', clientOrgId, { engagements: held.count, by: byId });
    await this.notifications.notify(c.orgId, [c.amUserId], { kind: 'payment_received', title: `${c.name}: payment confirmed`, body: 'Onboarding can pass Gate 1 once the requirements are in.', link: `/team/clients/${clientOrgId}` });
  }

  // -------------------------------------------------------------------------
  // Client users (shared with the CM / owner invite flows)

  async checkInvites(orgId: string, invites: ClientsInvite[]) {
    const seen = new Set<string>();
    for (const i of invites) {
      const email = i.email ? i.email.toLowerCase() : null;
      const phone = i.phone ? normaliseIdentifier(i.phone) : null;
      for (const k of [email, phone].filter(Boolean) as string[]) {
        if (seen.has(k)) throw new BadRequestException(`${k} is listed twice`);
        seen.add(k);
      }
      const clash = await this.prisma.user.findFirst({ where: { orgId, OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] }, select: { name: true } });
      if (clash) throw new BadRequestException(`${email ?? phone} already has an account (${clash.name}). Use a different email or phone.`);
    }
  }

  /**
   * Creates client users. An Owner invited by someone who is not an Branch Manager/Founder, on an account that already has an
   * Owner, waits for the existing Owner or a Branch Manager to confirm (returned as `pending`).
   */
  async createInvitesTx(tx: Tx, me: Me, clientOrgId: string, invites: ClientsInvite[], opts: { creating?: boolean } = {}) {
    const created: { id: string; name: string; role: ClientTeamRole }[] = [];
    const pending: ClientsInvite[] = [];
    const hasOwner = opts.creating ? false : (await tx.clientUser.count({ where: { clientOrgId, clientRole: 'client_owner', user: { deletedAt: null, status: { not: 'suspended' } } } })) > 0;
    let ownerSeen = hasOwner;
    for (const i of invites) {
      if (i.role === 'client_owner' && me.type === 'staff' && !isAdmin(me) && ownerSeen) {
        pending.push(i);
        continue;
      }
      if (i.role === 'client_owner') ownerSeen = true;
      created.push(await this.createUserTx(tx, me.orgId, clientOrgId, i));
    }
    return { created, pending };
  }

  async createUserTx(tx: Tx, orgId: string, clientOrgId: string, i: ClientsInvite) {
    const role = await tx.role.findFirstOrThrow({ where: { orgId, baseRole: i.role, isCustom: false } });
    const brands = i.brandScope?.length ? await tx.clientBrand.findMany({ where: { clientOrgId, id: { in: i.brandScope }, deletedAt: null }, select: { id: true } }) : [];
    const u = await tx.user.create({ data: { orgId, type: 'client', name: i.name, email: i.email ? i.email.toLowerCase() : null, phone: i.phone ? normaliseIdentifier(i.phone) : null, status: 'invited' } });
    await tx.clientUser.create({ data: { userId: u.id, orgId, clientOrgId, clientRole: i.role, brandScope: brands.map((b) => b.id) } });
    await tx.userRole.create({ data: { userId: u.id, roleId: role.id } });
    return { id: u.id, name: u.name, role: i.role };
  }

  /** Welcome message in the client thread (from the CM) and a bell notification for each new user. */
  async welcome(me: Me, clientOrgId: string, users: { id: string; name: string }[], amId: string | null) {
    const am = amId ? await this.prisma.user.findUnique({ where: { id: amId }, select: { id: true, name: true } }) : null;
    const names = users.map((u) => u.name.split(' ')[0]).join(', ');
    await this.threadNote(am ? { ...me, id: am.id, name: am.name } : me, clientOrgId, `Welcome to BMU, ${names}! I'm ${am?.name ?? me.name}${am ? ', your client manager' : ''}. Sign in with your email or mobile number to see your services, share onboarding items and message us here any time.`, false);
    await this.notifications.notify(me.orgId, users.map((u) => u.id), { kind: 'welcome', title: 'Welcome to BMU! Your account is ready', body: `${am?.name ?? 'Your client manager'} will help you get started.`, link: '/client' });
    for (const u of users) await this.audit.log(me, 'client_user.invited', 'User', u.id, null, { clientOrgId, name: u.name }, undefined);
  }

  async requestOwnerConfirmations(me: Me, clientOrgId: string, clientName: string, invites: ClientsInvite[]) {
    for (const i of invites) {
      const ref = (i.email || i.phone || i.name).toLowerCase();
      await this.approvals.create(me, {
        action: 'clients.owner_invite',
        targetType: 'client_org',
        targetId: `${clientOrgId}:${ref}`,
        summary: `Make ${i.name} an Owner of ${clientName}`,
        payload: { clientOrgId, invite: i },
        reason: `Invited by ${me.name}. An existing Owner or a Branch Manager must confirm a new Owner.`,
        approverId: null,
        approverRoles: ['admin', 'founder'],
        diff: [{ field: 'Owner', before: null, after: i.name }],
      });
      const owners = await this.prisma.clientUser.findMany({ where: { clientOrgId, clientRole: 'client_owner', user: { deletedAt: null, status: { not: 'suspended' } } }, select: { userId: true } });
      await this.notifications.notify(me.orgId, owners.map((o) => o.userId), { kind: 'approval_needed', title: `Confirm ${i.name} as an Owner of your account`, body: `${me.name} invited them. Confirm or decline in Settings.`, link: '/client/settings', critical: true });
    }
  }

  async threadNote(author: Me, clientOrgId: string, body: string, internal: boolean) {
    const thread = (await this.prisma.thread.findFirst({ where: { clientOrgId, type: 'client_am' } })) ?? (await this.prisma.thread.create({ data: { orgId: author.orgId, clientOrgId, type: 'client_am' } }));
    await this.prisma.message.create({ data: { orgId: author.orgId, threadId: thread.id, authorId: author.id, body, isInternal: internal } });
  }

  // -------------------------------------------------------------------------
  // Past invoices (migration)

  private async pastInvoicesTx(tx: Tx, me: Me, clientOrgId: string, rows: ClientsPastInvoice[]) {
    for (const p of rows) {
      const amount = p.amountPaise;
      const at = new Date(`${p.date}T12:00:00+05:30`);
      const inv = await tx.invoice.create({
        data: { orgId: me.orgId, clientOrgId, number: p.number, kind: 'migrated', lines: [{ label: p.description || 'Past invoice (migrated)', amountPaise: amount }], subtotalPaise: amount, gstPaise: 0, totalPaise: amount, dueDate: at, status: p.status ?? 'paid', createdAt: at, migrated: true },
      });
      if ((p.status ?? 'paid') === 'paid') await tx.payment.create({ data: { orgId: me.orgId, invoiceId: inv.id, amountPaise: amount, method: 'migrated', ref: `migrated_${inv.id}`, at } });
    }
    return rows.length;
  }

  async importPastInvoices(me: Me, clientOrgId: string, rows: ClientsPastInvoice[], ip?: string) {
    const { client } = await loadClient(this.prisma, me, clientOrgId, { write: true });
    if (!hasRole(me, 'founder', 'admin', 'am_lead', 'finance')) throw new ForbiddenException('Only leadership or Finance can import past invoices');
    if (client.startMode !== 'migration') throw new BadRequestException('Past invoices can be imported for migrated clients only');
    for (const p of rows) if (await this.prisma.invoice.findFirst({ where: { orgId: me.orgId, number: p.number } })) throw new BadRequestException(`Invoice number ${p.number} already exists`);
    const created = await this.prisma.$transaction((tx) => this.pastInvoicesTx(tx, me, client.id, rows));
    await this.audit.log(me, 'client.past_invoices_imported', 'ClientOrg', client.id, null, { count: created }, ip);
    return { ok: true as const, created };
  }

  // -------------------------------------------------------------------------
  // Lead conversion by hand (the leads area calls this)

  /**
   * convert_to_client: a Sales Manager turns a lead into a client without an online payment, with payment proof.
   * Uses the lead's contact; the payment goes to Finance to confirm (the work waits at Gate 1 until then).
   */
  async createClientFromLead(me: Me, leadId: string, input: ClientsFromLead, ip?: string): Promise<ClientsCreateResult> {
    if (!hasRole(me, 'sales_manager', 'founder', 'admin')) throw new ForbiddenException('Only a Sales Manager (or Branch Manager) can convert a lead to a client by hand');
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId: me.orgId, deletedAt: null } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (await this.prisma.clientOrg.findUnique({ where: { leadId } })) throw new BadRequestException('This lead is already a client');
    const contact = (lead.contact ?? {}) as { name?: string; email?: string; phone?: string; company?: string };
    if (!contact.email || !contact.phone) throw new BadRequestException('The lead needs a contact email and phone before it can become a client');
    const branchId = input.branchId ?? (await this.prisma.branch.findFirst({ where: { orgId: me.orgId, deletedAt: null }, orderBy: { name: 'asc' } }))?.id;
    if (!branchId) throw new BadRequestException('Add a branch first');
    const name = contact.company || contact.name || 'New client';
    const res = await this.create(
      me,
      {
        businessName: name,
        contactName: contact.name || name,
        contactPhone: contact.phone,
        contactEmail: contact.email,
        industry: input.industry || 'Other',
        billingName: input.billingName || name,
        billingAddress: input.billingAddress || 'To be confirmed',
        gstin: input.gstin ?? '',
        branchId,
        engagements: (input.engagements ?? []).map((e) => ({ serviceId: e.serviceId, tier: e.tier, startMonth: e.startMonth })),
        amUserId: input.amUserId ?? null,
        inviteNow: true,
        invites: [{ name: contact.name || name, email: contact.email, phone: contact.phone, role: 'client_owner', brandScope: [] }],
        startMode: 'onboarding',
        payment: (input.engagements ?? []).length ? 'offline' : 'none',
        paymentReference: input.paymentReference,
        paymentAmountPaise: input.paymentAmountPaise,
        confirmDuplicate: true,
      },
      ip,
      { source: 'lead', leadId },
    );
    const before = lead.stage;
    await this.prisma.lead.update({ where: { id: leadId }, data: { stage: 'won' } });
    await this.audit.log(me, 'lead.won', 'Lead', leadId, { stage: before }, { stage: 'won', clientOrgId: res.client.id, via: 'manual conversion', paymentReference: input.paymentReference }, ip);
    await this.notifications.notify(me.orgId, [lead.ownerId].filter((x) => x !== me.id), { kind: 'deal_won', title: `${name} is now a client`, body: `Converted by ${me.name}. Finance will confirm the payment.`, link: `/team/leads/${leadId}` });
    return res;
  }

  // -------------------------------------------------------------------------
  // CSV import

  private async resolveImport(me: Me, rows: Record<string, string>[]) {
    const [branches, ams] = await Promise.all([
      this.prisma.branch.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, name: true, city: true } }),
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: { in: AM_BASE_ROLES } } } } }, select: { id: true, name: true, email: true } }),
    ]);
    const lc = (s: string | undefined) => (s ?? '').trim().toLowerCase();
    return rows.map((r) => {
      const branch = branches.find((b) => lc(b.name) === lc(r.branch) || lc(b.city) === lc(r.branch)) ?? null;
      const am = r.am ? (ams.find((a) => lc(a.email ?? '') === lc(r.am)) ?? ams.find((a) => lc(a.name) === lc(r.am)) ?? null) : null;
      const input: ClientsCreate = {
        businessName: (r.business_name ?? '').trim(),
        contactName: (r.contact_name ?? '').trim(),
        contactPhone: (r.contact_phone ?? '').trim(),
        contactEmail: (r.contact_email ?? '').trim(),
        industry: (r.industry ?? '').trim(),
        billingName: (r.billing_name ?? '').trim(),
        billingAddress: (r.billing_address ?? '').trim(),
        branchId: branch?.id ?? '',
        gstin: (r.gstin ?? '').trim(),
        amUserId: am?.id ?? null,
        payment: 'none',
      };
      return { input, branch, am, amGiven: !!r.am?.trim() };
    });
  }

  private async validateImport(me: Me, rows: Record<string, string>[]) {
    const resolved = await this.resolveImport(me, rows);
    const out: { errors: string[]; duplicate: string | null }[] = [];
    const seenNames = new Set<string>();
    for (const [i, r] of resolved.entries()) {
      const errors: string[] = [];
      const parsed = clientsCreateSchema.safeParse(r.input);
      if (!parsed.success) for (const issue of parsed.error.issues) if (!(issue.path[0] === 'branchId' && rows[i].branch)) errors.push(issue.message);
      if (rows[i].branch && !r.branch) errors.push(`Unknown branch "${rows[i].branch}"`);
      if (r.amGiven && !r.am) errors.push(`No active client manager matches "${rows[i].am}"`);
      if (r.input.gstin && !SERVICE_GSTIN_RE.test(r.input.gstin.toUpperCase())) errors.push('GSTIN should look like 29ABCDE1234F1Z5');
      const n = clientsNormName(r.input.businessName);
      if (n && seenNames.has(n)) errors.push('This business is listed twice in the file');
      seenNames.add(n);
      const dups = r.input.businessName ? await this.duplicates(me, { businessName: r.input.businessName, phone: r.input.contactPhone, email: r.input.contactEmail, gstin: r.input.gstin || undefined }) : [];
      out.push({ errors: [...new Set(errors)], duplicate: dups[0] ? `${dups[0].name} (${dups[0].why.join(', ').toLowerCase()})` : null });
    }
    return out;
  }
}
