// v11 clients: the clients list (search, filters, tags, bulk), Client 360 extras (contact, billing, brands, users,
// quotes, approvals, offboarding), edit_client with field-level rights, add_brand_location, add_client_user (AM side
// and owner confirmation), set_client_health and archive/restore.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  CLIENT_TEAM_ROLES,
  CLIENTS_BILLING_FIELDS,
  CLIENTS_CONTACT_FIELDS,
  CLIENTS_OFFBOARD_CHECKS,
  CLIENTS_PROFILE_FIELDS,
  clientsCanAddEngagement,
  clientsCanOffboard,
  clientsCanRaiseRequest,
  clientsEditSchema,
  clientsFieldLabels,
  clientsInviteSchema,
  normaliseIdentifier,
  type ClientsBrandInput,
  type ClientsBulk,
  type ClientsDetail,
  type ClientsEdit,
  type ClientsInvite,
  type ClientsListQuery,
  type ClientsListRow,
  type ClientsOffboarding,
  type ClientsOffboardStatus,
  type ClientsPendingInvite,
  type ClientsQuote,
  type ClientTeamRole,
  type Me,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { hasRole, PeopleDirectory } from '../actions/people.js';
import { RecordsService } from '../actions/records.service.js';
import { ActionsRegistry } from '../actions/registry.js';
import { UndoService } from '../actions/undo.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { assertStaff, contactOf, hasHandoverAccess, isAdmin, isClientLead, loadClient, runsClient, seesAllClients } from './clients-access.js';
import { ClientsCreateService } from './clients-create.service.js';

const INACTIVE = ['paused', 'offboarding', 'closed', 'delivered'];
const GST = 0.18;

type QuoteRow = Prisma.ClientServiceQuoteGetPayload<object>;

@Injectable()
export class ClientsManageService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly registry: ActionsRegistry,
    private readonly records: RecordsService,
    private readonly undo: UndoService,
    private readonly people: PeopleDirectory,
    private readonly creator: ClientsCreateService,
  ) {}

  onModuleInit() {
    this.registry.registerArchiveEntity({
      entity: 'client',
      model: 'clientOrg',
      auditEntity: 'ClientOrg',
      assertCan: async (me, id) => {
        await loadClient(this.prisma, me, id);
        if (!isClientLead(me)) throw new ForbiddenException('Only the Founder, Admin or AM Lead can archive clients');
      },
      beforeArchive: async (me, id) => {
        const open = await this.prisma.engagement.count({ where: { clientOrgId: id, deletedAt: null, status: { notIn: ['closed', 'delivered', 'paused'] } } });
        if (open) throw new BadRequestException(`This client has ${open} running service${open > 1 ? 's' : ''}. Offboard the client (or pause the services) before archiving.`);
      },
    });
    this.records.visibility.set('client', async (me, id) => {
      await loadClient(this.prisma, me, id);
    });

    // AM-invited Owner: the existing Owner (client app) or an Admin confirms.
    this.registry.registerApprovalHandler({
      action: 'clients.owner_invite',
      label: 'New client Owner needs confirmation',
      href: (r) => `/team/clients/${(r.payload as { clientOrgId?: string }).clientOrgId ?? ''}`,
      apply: async ({ approver, req }) => {
        const p = req.payload as { clientOrgId: string; invite: ClientsInvite };
        return this.addConfirmedOwner(approver, p.clientOrgId, p.invite);
      },
    });
  }

  // -------------------------------------------------------------------------
  // List

  async list(me: Me, q: ClientsListQuery): Promise<ClientsListRow[]> {
    assertStaff(me);
    let where: Prisma.ClientOrgWhereInput = { orgId: me.orgId, deletedAt: null };
    if (!seesAllClients(me)) {
      if (!hasRole(me, 'account_manager', 'strategist')) throw new ForbiddenException("You don't have access to the client list");
      const handover = await this.prisma.assignment.findMany({ where: { orgId: me.orgId, targetType: 'client_am', fromUserId: me.id, readAccessUntil: { gt: new Date() } }, select: { targetId: true } });
      if (hasRole(me, 'account_manager')) where = { ...where, OR: [{ amUserId: me.id }, { id: { in: handover.map((h) => h.targetId) } }] };
      else {
        const self = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { teamId: true } });
        where = { ...where, am: { teamId: self.teamId ?? '__none__' } };
      }
    }
    where = { ...where, archivedAt: q.archived === 'only' ? { not: null } : q.archived === 'all' ? undefined : null };
    if (q.am) where = { ...where, amUserId: q.am === 'none' ? null : q.am };
    if (q.health) where = { ...where, health: q.health };
    if (q.industry) where = { ...where, industry: q.industry };
    if (q.branch) where = { ...where, branchId: q.branch };
    if (q.q?.trim()) {
      const s = q.q.trim();
      where = { AND: [where, { OR: [{ name: { contains: s, mode: 'insensitive' } }, { industry: { contains: s, mode: 'insensitive' } }, { gstin: { contains: s.toUpperCase() } }, { am: { name: { contains: s, mode: 'insensitive' } } }] }] };
    }
    if (q.tag) {
      const links = await this.prisma.tagLink.findMany({ where: { orgId: me.orgId, targetType: 'client', OR: [{ tagId: q.tag }, { tag: { name: { equals: q.tag, mode: 'insensitive' } } }] }, select: { targetId: true } });
      where = { AND: [where, { id: { in: links.map((l) => l.targetId) } }] };
    }
    const rows = await this.prisma.clientOrg.findMany({ where, include: { am: { select: { id: true, name: true } }, engagements: { where: { deletedAt: null }, include: { service: { select: { name: true } } }, orderBy: { createdAt: 'asc' } } }, orderBy: { createdAt: 'desc' }, take: 1000 });
    const branches = new Map((await this.prisma.branch.findMany({ where: { orgId: me.orgId } })).map((b) => [b.id, b.name]));
    const tags = await this.records.tagsFor(me.orgId, 'client', rows.map((r) => r.id));
    const leads = await this.prisma.lead.findMany({ where: { id: { in: rows.map((r) => r.leadId).filter((x): x is string => !!x) } }, select: { id: true, contact: true } });
    let out = rows.map((c): ClientsListRow => {
      const contact = c.primaryContact ? contactOf(c) : (() => {
        const l = (leads.find((x) => x.id === c.leadId)?.contact ?? {}) as { name?: string; phone?: string; email?: string };
        return { name: l.name ?? null, phone: l.phone ?? null, email: l.email ?? null };
      })();
      const off = (c.offboarding ?? null) as { status?: ClientsOffboardStatus } | null;
      return {
        id: c.id,
        name: c.name,
        industry: c.industry,
        health: c.health,
        am: c.am,
        branch: c.branchId ? (branches.get(c.branchId) ?? null) : null,
        contact,
        source: c.source,
        startMode: c.startMode,
        paymentStatus: c.paymentStatus,
        activeServices: c.engagements.filter((e) => !INACTIVE.includes(e.status)).length,
        services: c.engagements.map((e) => ({ id: e.id, serviceName: e.service.name, status: e.status, currentGate: e.currentGate })),
        tags: (tags.get(c.id) ?? []).map((t) => ({ id: t.id, name: t.name, color: t.color })),
        offboarding: off?.status ?? null,
        archivedAt: c.archivedAt?.toISOString() ?? null,
        createdAt: c.createdAt.toISOString(),
      };
    });
    if (q.status === 'active') out = out.filter((r) => r.activeServices > 0);
    else if (q.status === 'onboarding') out = out.filter((r) => r.services.some((s) => s.currentGate === 'G1' && !INACTIVE.includes(s.status)));
    else if (q.status === 'payment_pending') out = out.filter((r) => r.paymentStatus === 'pending');
    else if (q.status === 'offboarding') out = out.filter((r) => !!r.offboarding && r.offboarding !== 'closed');
    else if (q.status === 'no_services') out = out.filter((r) => !r.services.length);
    return out;
  }

  async bulk(me: Me, input: ClientsBulk, ip?: string) {
    assertStaff(me);
    const ids = [...new Set(input.ids)];
    const rows = await this.prisma.clientOrg.findMany({ where: { id: { in: ids }, orgId: me.orgId, deletedAt: null } });
    if (rows.length !== ids.length) throw new NotFoundException('One of the clients was not found');
    if (input.action === 'tag') {
      if (!input.tag) throw new BadRequestException('Type the tag');
      for (const c of rows) if (!runsClient(me, c) && !seesAllClients(me)) throw new ForbiddenException(`You can't tag ${c.name}`);
      const tag = await this.records.addTag(me, 'client', ids, input.tag);
      for (const c of rows) await this.audit.log(me, 'record.tagged', 'ClientOrg', c.id, null, { tag: tag.name }, ip);
      const undo = null;
      return { ok: true as const, changed: rows.length, message: `Tagged ${rows.length} client${rows.length > 1 ? 's' : ''} "${tag.name}"`, undo };
    }
    if (!isClientLead(me)) throw new ForbiddenException('Only the Founder, Admin or AM Lead can archive clients');
    if (input.action === 'archive') {
      if ((input.reason ?? '').trim().length < 3) throw new BadRequestException('Give a short reason for archiving');
      const running = await this.prisma.engagement.groupBy({ by: ['clientOrgId'], where: { clientOrgId: { in: ids }, deletedAt: null, status: { notIn: ['closed', 'delivered', 'paused'] } }, _count: true });
      if (running.length) throw new BadRequestException(`${rows.filter((r) => running.some((x) => x.clientOrgId === r.id)).map((r) => r.name).join(', ')} still ha${running.length > 1 ? 've' : 's'} running services. Offboard first.`);
      const now = new Date();
      const target = rows.filter((r) => !r.archivedAt);
      await this.prisma.clientOrg.updateMany({ where: { id: { in: target.map((r) => r.id) } }, data: { archivedAt: now, archivedReason: input.reason } });
      for (const c of target) await this.audit.log(me, 'client.archived', 'ClientOrg', c.id, { archivedAt: null }, { archivedAt: now, reason: input.reason }, ip);
      const undo = await this.undo.create(me, `Archived ${target.length} client${target.length > 1 ? 's' : ''}`, target.map((c) => ({ model: 'clientOrg', id: c.id, data: { archivedAt: null, archivedReason: null } })));
      return { ok: true as const, changed: target.length, message: `Archived ${target.length} client${target.length > 1 ? 's' : ''}`, undo };
    }
    const target = rows.filter((r) => r.archivedAt);
    await this.prisma.clientOrg.updateMany({ where: { id: { in: target.map((r) => r.id) } }, data: { archivedAt: null, archivedReason: null } });
    for (const c of target) await this.audit.log(me, 'client.restored', 'ClientOrg', c.id, { archivedAt: c.archivedAt }, { archivedAt: null }, ip);
    return { ok: true as const, changed: target.length, message: `Restored ${target.length} client${target.length > 1 ? 's' : ''}`, undo: null };
  }

  // -------------------------------------------------------------------------
  // Detail

  editableFields(me: Me, c: { amUserId: string | null }): (keyof ClientsEdit)[] {
    if (isAdmin(me)) return Object.keys(clientsFieldLabels) as (keyof ClientsEdit)[];
    const out: (keyof ClientsEdit)[] = [];
    if (hasRole(me, 'am_lead') || (hasRole(me, 'account_manager') && c.amUserId === me.id)) out.push(...CLIENTS_CONTACT_FIELDS, 'industry');
    if (hasRole(me, 'finance')) out.push(...CLIENTS_BILLING_FIELDS);
    return [...new Set(out)];
  }

  async detail(me: Me, id: string): Promise<ClientsDetail> {
    const { client: c, readOnly } = await loadClient(this.prisma, me, id);
    const [am, branch, brands, users, engagements, quotes, pendingApprovals, invites, tags] = await Promise.all([
      c.amUserId ? this.prisma.user.findUnique({ where: { id: c.amUserId }, select: { id: true, name: true, email: true } }) : null,
      c.branchId ? this.prisma.branch.findUnique({ where: { id: c.branchId }, select: { id: true, name: true } }) : null,
      this.prisma.clientBrand.findMany({ where: { clientOrgId: c.id, deletedAt: null }, orderBy: { name: 'asc' } }),
      this.prisma.clientUser.findMany({ where: { clientOrgId: c.id, user: { deletedAt: null } }, include: { user: true }, orderBy: { user: { createdAt: 'asc' } } }),
      this.prisma.engagement.findMany({ where: { clientOrgId: c.id, deletedAt: null }, include: { service: { select: { name: true } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.clientServiceQuote.findMany({ where: { clientOrgId: c.id }, orderBy: { createdAt: 'desc' }, take: 30 }),
      this.prisma.approvalRequest.findMany({ where: { orgId: me.orgId, status: 'pending', OR: [{ targetId: c.id }, { targetId: { startsWith: `${c.id}:` } }, { targetType: 'engagement', targetId: { in: (await this.prisma.engagement.findMany({ where: { clientOrgId: c.id }, select: { id: true } })).map((e) => e.id) } }] }, orderBy: { createdAt: 'desc' } }),
      this.pendingInvites(me.orgId, c.id),
      this.records.tagsFor(me.orgId, 'client', [c.id]),
    ]);
    const lead = !c.primaryContact && c.leadId ? await this.prisma.lead.findUnique({ where: { id: c.leadId }, select: { contact: true } }) : null;
    const lc = (lead?.contact ?? {}) as { name?: string; phone?: string; email?: string };
    const contact = c.primaryContact ? contactOf(c) : { name: lc.name ?? null, phone: lc.phone ?? null, email: lc.email ?? null };
    const runs = !readOnly && runsClient(me, c);
    const fields = readOnly ? [] : this.editableFields(me, c);
    const off = this.offboardingView(c);
    const closed = off?.status === 'closed';
    const trail = await this.prisma.assignment.findMany({ where: { orgId: me.orgId, targetType: 'client_am', targetId: c.id }, orderBy: { at: 'desc' }, take: 20 });
    const names = await this.people.names(trail.flatMap((a) => [a.fromUserId, a.toUserId, a.byId]).filter((x): x is string => !!x));
    const amHistory = trail.map((a) => ({ id: a.id, at: a.at.toISOString(), from: a.fromUserId ? (names.get(a.fromUserId) ?? null) : null, to: a.toUserId ? (names.get(a.toUserId) ?? null) : null, by: names.get(a.byId) ?? 'Someone', reason: a.reason, note: a.note, handoverNote: a.handoverNote }));
    return {
      id: c.id,
      name: c.name,
      industry: c.industry,
      health: c.health,
      healthReason: c.healthReason,
      branch,
      am,
      source: c.source,
      startMode: c.startMode,
      paymentStatus: c.paymentStatus,
      contact,
      billing: { billingName: c.legalName, gstin: c.gstin, billingAddress: c.billingAddress, billingEmail: c.billingEmail, placeOfSupply: c.placeOfSupply },
      brands: brands.map((b) => ({ id: b.id, name: b.name, address: b.location })),
      users: users.map((u) => ({ id: u.userId, name: u.user.name, email: u.user.email, phone: u.user.phone, role: ((CLIENT_TEAM_ROLES as readonly string[]).includes(u.clientRole) ? u.clientRole : 'client_viewer') as ClientTeamRole, status: u.user.status, brandScope: u.brandScope })),
      pendingInvites: invites,
      services: engagements.map((e) => ({ id: e.id, serviceName: e.service.name, serviceId: e.serviceId, tier: e.tier, billingType: e.billingType, status: e.status, currentGate: e.currentGate, migrated: e.migrated, paymentPending: e.paymentPending, pausedUntil: e.pausedUntil?.toISOString() ?? null, pauseReason: e.pauseReason, startMonth: e.startMonth })),
      quotes: await this.quoteViews(quotes),
      pendingApprovals: pendingApprovals.map((a) => ({ id: a.id, action: a.action, summary: a.summary, status: a.status, createdAt: a.createdAt.toISOString() })),
      offboarding: off,
      tags: (tags.get(c.id) ?? []).map((t) => ({ id: t.id, name: t.name, color: t.color })),
      archivedAt: c.archivedAt?.toISOString() ?? null,
      readOnlyAccess: readOnly,
      amHistory,
      can: {
        edit: fields.length > 0 && !closed,
        editFields: fields,
        reassignAm: isClientLead(me) && !closed,
        inviteUser: runs && !closed,
        addBrand: runs && !closed,
        addService: runs && clientsCanAddEngagement(me) && !off,
        changeTier: runs && !off,
        pause: runs && !off,
        setGate: runs && engagements.some((e) => e.migrated),
        offboard: clientsCanOffboard(me) && !off,
        health: runs || hasRole(me, 'am_lead'),
        archive: isClientLead(me),
        raiseRequest: runs && clientsCanRaiseRequest(me) && !closed,
      },
    };
  }

  offboardingView(c: { offboarding: unknown; readOnlyUntil: Date | null }): ClientsOffboarding | null {
    const o = c.offboarding as (Omit<ClientsOffboarding, 'checklist' | 'readOnlyUntil'> & { checklist?: Partial<ClientsOffboarding['checklist']> }) | null;
    if (!o) return null;
    const checklist = Object.fromEntries(CLIENTS_OFFBOARD_CHECKS.map((k) => [k.key, o.checklist?.[k.key] ?? { done: false, by: null, at: null }])) as ClientsOffboarding['checklist'];
    return { ...o, checklist, readOnlyUntil: c.readOnlyUntil?.toISOString() ?? null };
  }

  async quoteViews(rows: QuoteRow[]): Promise<ClientsQuote[]> {
    const [services, people, invoices] = await Promise.all([
      this.prisma.service.findMany({ where: { id: { in: rows.map((r) => r.serviceId) } }, select: { id: true, name: true } }),
      this.people.names(rows.map((r) => r.requestedById)),
      this.prisma.invoice.findMany({ where: { id: { in: rows.map((r) => r.invoiceId).filter((x): x is string => !!x) } }, select: { id: true, number: true, status: true, totalPaise: true } }),
    ]);
    return rows.map((q) => ({
      id: q.id,
      kind: q.kind as ClientsQuote['kind'],
      serviceName: services.find((s) => s.id === q.serviceId)?.name ?? 'Service',
      tier: q.tier,
      fromTier: q.fromTier,
      startMonth: q.startMonth,
      effective: q.effective as ClientsQuote['effective'],
      amountPaise: q.amountPaise,
      gstPaise: Math.round(q.amountPaise * GST),
      monthlyDiffPaise: q.monthlyDiffPaise,
      status: q.status as ClientsQuote['status'],
      note: q.note,
      requestedBy: people.get(q.requestedById) ?? 'Client',
      requestedByClient: q.requestedByClient,
      invoice: invoices.find((i) => i.id === q.invoiceId) ?? null,
      engagementId: q.resultEngagementId ?? q.engagementId,
      createdAt: q.createdAt.toISOString(),
    }));
  }

  async pendingInvites(orgId: string, clientOrgId: string): Promise<ClientsPendingInvite[]> {
    const rows = await this.prisma.approvalRequest.findMany({ where: { orgId, action: 'clients.owner_invite', status: 'pending', targetId: { startsWith: `${clientOrgId}:` } }, orderBy: { createdAt: 'asc' } });
    const names = await this.people.names(rows.map((r) => r.requestedById));
    return rows.map((r) => {
      const i = (r.payload as { invite: ClientsInvite }).invite;
      return { approvalId: r.id, name: i.name, email: i.email || null, phone: i.phone || null, role: i.role as ClientTeamRole, requestedBy: names.get(r.requestedById) ?? 'Someone', at: r.createdAt.toISOString() };
    });
  }

  // -------------------------------------------------------------------------
  // Edit (field-level permissions)

  async edit(me: Me, id: string, body: unknown, ip?: string) {
    const { client: c, readOnly } = await loadClient(this.prisma, me, id, { write: true });
    if (readOnly) throw new ForbiddenException('You only have read access to this client');
    const parsed = clientsEditSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Check the form');
    const input = parsed.data;
    const allowed = new Set(this.editableFields(me, c));
    const asked = (Object.keys(input) as (keyof ClientsEdit)[]).filter((k) => input[k] !== undefined);
    if (!asked.length) throw new BadRequestException('Nothing to change');
    const refused = asked.filter((k) => !allowed.has(k));
    if (refused.length === asked.length) throw new ForbiddenException(`You can't change ${refused.map((k) => clientsFieldLabels[k].toLowerCase()).join(', ')}. ${hasRole(me, 'finance') ? 'Finance edits billing fields only.' : hasRole(me, 'account_manager') ? 'Account Managers edit contact details; billing is for Finance.' : ''}`.trim());
    if (refused.length) throw new ForbiddenException(`You can't change ${refused.map((k) => clientsFieldLabels[k].toLowerCase()).join(', ')}`);
    if (input.branchId && !(await this.prisma.branch.findFirst({ where: { id: input.branchId, orgId: me.orgId } }))) throw new BadRequestException('Pick a branch');
    const { data, before, after } = this.applyEdit(c, input);
    if (!Object.keys(data).length) throw new BadRequestException('Nothing changed');
    await this.prisma.clientOrg.update({ where: { id: c.id }, data });
    await this.audit.log(me, 'client.updated', 'ClientOrg', c.id, before, after, ip);
    const undo = await this.undo.create(me, `Edited ${c.name}`, [{ model: 'clientOrg', id: c.id, data: Object.fromEntries(Object.keys(data).map((k) => [k, (c as Record<string, unknown>)[k] ?? null])) }]);
    if (c.amUserId && c.amUserId !== me.id) await this.notifications.notify(me.orgId, [c.amUserId], { kind: 'client_updated', title: `${me.name} updated ${c.name}`, body: Object.keys(after).map((k) => clientsFieldLabels[k as keyof ClientsEdit] ?? k).join(', '), link: `/team/clients/${c.id}` });
    return { ...(await this.detail(me, c.id)), undo, ignored: [] as string[] };
  }

  /** Maps edit fields onto the client row; returns the update and before/after for the audit. */
  applyEdit(c: Prisma.ClientOrgGetPayload<object>, input: ClientsEdit) {
    const data: Prisma.ClientOrgUncheckedUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const set = (field: keyof ClientsEdit, col: string, value: unknown, current: unknown) => {
      if (value === undefined || value === current) return;
      (data as Record<string, unknown>)[col] = value;
      before[field] = current ?? null;
      after[field] = value;
    };
    set('businessName', 'name', input.businessName, c.name);
    set('industry', 'industry', input.industry, c.industry);
    set('branchId', 'branchId', input.branchId, c.branchId);
    set('billingName', 'legalName', input.billingName, c.legalName);
    set('gstin', 'gstin', input.gstin === '' ? null : input.gstin, c.gstin);
    set('billingAddress', 'billingAddress', input.billingAddress, c.billingAddress);
    set('billingEmail', 'billingEmail', input.billingEmail === '' ? null : input.billingEmail, c.billingEmail);
    set('placeOfSupply', 'placeOfSupply', input.placeOfSupply === '' ? null : input.placeOfSupply, c.placeOfSupply);
    if (input.gstin && !c.placeOfSupply && input.placeOfSupply === undefined) data.placeOfSupply = input.gstin.slice(0, 2);
    const contact = contactOf(c);
    const next = { name: input.contactName ?? contact.name, phone: input.contactPhone ? normaliseIdentifier(input.contactPhone) : contact.phone, email: input.contactEmail?.toLowerCase() ?? contact.email };
    if (next.name !== contact.name || next.phone !== contact.phone || next.email !== contact.email) {
      data.primaryContact = next;
      before.contact = contact;
      after.contact = next;
    }
    return { data, before, after };
  }

  // -------------------------------------------------------------------------
  // Brands / locations

  async addBrand(me: Me, clientOrgId: string, input: ClientsBrandInput, ip?: string) {
    const { client: c } = await loadClient(this.prisma, me, clientOrgId, { write: true });
    if (!runsClient(me, c)) throw new ForbiddenException("Only the client's Account Manager or an Admin can add brands");
    const b = await this.saveBrand(me, c.id, input, ip);
    void b;
    return this.detail(me, c.id);
  }

  async saveBrand(me: Me, clientOrgId: string, input: ClientsBrandInput, ip?: string) {
    const dup = await this.prisma.clientBrand.findFirst({ where: { clientOrgId, deletedAt: null, name: { equals: input.name, mode: 'insensitive' } } });
    if (dup) throw new BadRequestException(`${input.name} is already on this account`);
    const b = await this.prisma.clientBrand.create({ data: { orgId: me.orgId, clientOrgId, name: input.name, location: input.address } });
    await this.audit.log(me, 'client.brand_added', 'ClientOrg', clientOrgId, null, { brand: input.name, address: input.address }, ip);
    return b;
  }

  async removeBrand(me: Me, clientOrgId: string, brandId: string, ip?: string) {
    const { client: c } = await loadClient(this.prisma, me, clientOrgId, { write: true });
    if (!runsClient(me, c)) throw new ForbiddenException("Only the client's Account Manager or an Admin can remove brands");
    const b = await this.prisma.clientBrand.findFirst({ where: { id: brandId, clientOrgId: c.id, deletedAt: null } });
    if (!b) throw new NotFoundException('Brand not found');
    await this.prisma.clientBrand.update({ where: { id: b.id }, data: { deletedAt: new Date() } });
    await this.audit.log(me, 'client.brand_removed', 'ClientOrg', c.id, { brand: b.name }, null, ip);
    return this.detail(me, c.id);
  }

  // -------------------------------------------------------------------------
  // Client users (AM side: Client 360 → Users → Invite)

  async invite(me: Me, clientOrgId: string, body: unknown, ip?: string) {
    const { client: c } = await loadClient(this.prisma, me, clientOrgId, { write: true });
    if (!runsClient(me, c)) throw new ForbiddenException("Only the client's Account Manager or an Admin can invite client users");
    if (c.readOnlyUntil || c.archivedAt) throw new BadRequestException('This client is offboarded or archived');
    const parsed = clientsInviteSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Check the form');
    await this.creator.checkInvites(me.orgId, [parsed.data]);
    const res = await this.prisma.$transaction((tx) => this.creator.createInvitesTx(tx, me, c.id, [parsed.data]));
    if (res.created.length) await this.creator.welcome(me, c.id, res.created, c.amUserId);
    if (res.pending.length) await this.creator.requestOwnerConfirmations(me, c.id, c.name, res.pending);
    await this.audit.log(me, res.pending.length ? 'client_user.owner_requested' : 'client_user.added', 'ClientOrg', c.id, null, { name: parsed.data.name, role: parsed.data.role, pendingConfirmation: res.pending.length > 0 }, ip);
    const message = res.pending.length ? `${parsed.data.name} will become an Owner once the client's Owner or an Admin confirms` : `${parsed.data.name} invited. A welcome message was sent`;
    return { ...(await this.detail(me, c.id)), message };
  }

  /** Approved Owner invite (by an Admin in "Needs you", or by the client's Owner in the app). */
  async addConfirmedOwner(by: Me, clientOrgId: string, invite: ClientsInvite) {
    const c = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: by.orgId } });
    if (!c) throw new NotFoundException('Client not found');
    await this.creator.checkInvites(by.orgId, [invite]);
    const u = await this.prisma.$transaction((tx) => this.creator.createUserTx(tx, by.orgId, c.id, { ...invite, role: 'client_owner' }));
    await this.creator.welcome(by, c.id, [u], c.amUserId);
    await this.audit.log(by, 'client_user.owner_confirmed', 'ClientOrg', c.id, null, { name: u.name }, undefined);
    return { userId: u.id };
  }

  // -------------------------------------------------------------------------
  // Health

  async health(me: Me, clientOrgId: string, input: { status: string; reason: string }, ip?: string) {
    const { client: c } = await loadClient(this.prisma, me, clientOrgId, { write: true });
    if (!(runsClient(me, c) || hasRole(me, 'am_lead'))) throw new ForbiddenException("Only the client's Account Manager or the AM Lead can change client health");
    if (c.health === input.status && c.healthReason === input.reason) throw new BadRequestException('Nothing changed');
    await this.prisma.clientOrg.update({ where: { id: c.id }, data: { health: input.status, healthReason: input.reason, healthOverriddenAt: new Date(), healthOverriddenBy: me.id } });
    await this.audit.log(me, 'client.health_set', 'ClientOrg', c.id, { health: c.health, reason: c.healthReason }, { health: input.status, reason: input.reason }, ip);
    if (input.status === 'red') {
      const leads = await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'am_lead' } } } }, select: { id: true } });
      await this.notifications.notify(me.orgId, leads.map((l) => l.id).filter((x) => x !== me.id), { kind: 'client_health', title: `${c.name} marked at risk by ${me.name}`, body: input.reason, link: `/team/clients/${c.id}`, critical: true });
    }
    return this.detail(me, c.id);
  }

  async handoverAccess(me: Me, clientOrgId: string) {
    return hasHandoverAccess(this.prisma, me, clientOrgId);
  }
}
