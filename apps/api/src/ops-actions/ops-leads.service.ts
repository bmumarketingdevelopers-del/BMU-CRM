// v11 ops: lead actions inside the CRM. Add lead (duplicate check, round-robin or manual owner, first-reply SLA,
// owner notified), CSV import, the `lead_owner` reassign target, mark lost, merge any two leads, bulk actions,
// archive, notes/meetings on a lead and manual conversion to a client with payment proof (Finance approves).
import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  addWorkingMinutes,
  formatINR,
  OPS_LEAD_FIRST_REPLY_MINUTES,
  OPS_LEAD_SOURCES,
  opsCanAddLead,
  opsIsSalesManager,
  opsLeadConvertSchema,
  opsLeadCreateSchema,
  opsLeadReferralOnly,
  opsLeadSourceLabels,
  sellLeadScore,
  services as catalogue,
  type LeadRow,
  type Me,
  type OpsDuplicateMatch,
  type OpsLeadBulk,
  type OpsLeadCreate,
  type OpsLeadCreated,
  type OpsMaybeApproval,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { ApprovalsService } from '../actions/approvals.service.js';
import { ActionsRegistry, type UndoRow } from '../actions/registry.js';
import { UndoService } from '../actions/undo.service.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { logLeadActivity } from '../proposals/lead-activity.js';
import { OnboardingService } from '../proposals/onboarding.service.js';
import { ProposalsService } from '../proposals/proposals.service.js';
import { sellLeadRow, SellService } from '../sell/sell.service.js';
import { opsCreateClientFromLead } from './ops-convert.js';
import { PipelinesService } from '../customise/pipelines.service.js';
import { dayTime, hasRole, lc, phoneDigits } from './ops-util.js';

const include = { owner: { select: { id: true, name: true } } } as const;
const OPEN = ['new', 'contacted', 'discovery', 'proposal_sent'] as const;
type Contact = { name: string; email?: string; phone?: string; company?: string; referredBy?: string };
const nameOf = (c: unknown) => ((c ?? {}) as Contact).company || ((c ?? {}) as Contact).name || 'Lead';
const SALES_ROLES = ['sales_executive', 'sales_manager'];

@Injectable()
export class OpsLeadsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly registry: ActionsRegistry,
    private readonly approvals: ApprovalsService,
    private readonly undo: UndoService,
    private readonly proposals: ProposalsService,
    private readonly onboarding: OnboardingService,
    private readonly sell: SellService,
    private readonly pipelines: PipelinesService,
  ) {}

  onModuleInit() {
    this.registerOwnerTarget();
    this.registerImport();
    this.registry.registerArchiveEntity({
      entity: 'lead',
      model: 'lead',
      auditEntity: 'Lead',
      assertCan: async (me, id) => {
        const lead = await this.findLead(me, id, true);
        if (!opsIsSalesManager(me) && lead.ownerId !== me.id) throw new ForbiddenException('Only the lead owner or a sales manager can archive a lead');
      },
      beforeArchive: async (me, id) => {
        const lead = await this.findLead(me, id, true);
        if (lead.stage === 'won') throw new BadRequestException('This lead became a client. It stays for the record.');
      },
    });
    this.registry.registerApprovalHandler({
      action: 'lead.convert',
      label: 'Make a lead a client (offline payment)',
      href: (r) => `/team/leads/${r.targetId}`,
      apply: async ({ approver, req }) => this.applyConvert(approver, req.targetId, req.payload as ConvertPayload, req.requestedById),
      onReject: async ({ approver, req }) => {
        await logLeadActivity(this.prisma, { orgId: approver.orgId, leadId: req.targetId, kind: 'system', userId: approver.id, body: `${approver.name} did not approve the offline conversion${req.decisionNote ? `: ${req.decisionNote}` : ''}` });
      },
    });
  }

  // -------------------------------------------------------------------------
  // Access

  private scope(me: Me): Prisma.LeadWhereInput {
    return this.proposals.leadScope(me);
  }

  private async findLead(me: Me, id: string, withArchived = false) {
    const lead = await this.prisma.lead.findFirst({ where: { ...this.scope(me), id, ...(withArchived ? {} : { archivedAt: null }) }, include });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  private assertManager(me: Me, what = 'do this') {
    if (!opsIsSalesManager(me)) throw new ForbiddenException(`Only a sales manager can ${what}`);
  }

  // -------------------------------------------------------------------------
  // Duplicates and owners

  /** Leads with the same phone or email (or the same business name). Archived and merged leads are skipped. */
  async duplicates(me: Me, q: { phone?: string; email?: string; company?: string; excludeId?: string }): Promise<OpsDuplicateMatch[]> {
    if (!opsCanAddLead(me) && (me.permissions.leads_pipeline?.scope ?? 'none') === 'none') throw new ForbiddenException('Leads are for the sales team');
    const p = phoneDigits(q.phone);
    const e = lc(q.email);
    const c = lc(q.company);
    if (!p && !e && c.length < 3) return [];
    const rows = await this.prisma.lead.findMany({ where: { orgId: me.orgId, deletedAt: null, ...(q.excludeId ? { id: { not: q.excludeId } } : {}) }, include, orderBy: { createdAt: 'desc' }, take: 2000 });
    const canOpen = (l: { ownerId: string | null }) => (me.permissions.leads_pipeline?.scope ?? 'none') === 'all' || ((me.permissions.leads_pipeline?.scope ?? 'none') === 'own' && l.ownerId === me.id);
    const out: OpsDuplicateMatch[] = [];
    for (const l of rows) {
      const ct = (l.contact ?? {}) as Contact;
      const on: OpsDuplicateMatch['matchedOn'] = [];
      if (p && phoneDigits(ct.phone) === p) on.push('phone');
      if (e && lc(ct.email) === e) on.push('email');
      if (c.length >= 3 && lc(ct.company) === c) on.push('name');
      if (!on.length) continue;
      out.push({ id: l.id, name: nameOf(l.contact), stage: l.archivedAt ? 'archived' : l.stage, owner: l.owner?.name ?? null, matchedOn: on, href: canOpen(l) ? `/team/leads/${l.id}` : null });
    }
    return out.slice(0, 5);
  }

  /** Sales people who may own leads (executives first). */
  private async salesTeam(orgId: string) {
    return this.prisma.user.findMany({
      where: { orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: { in: SALES_ROLES } } } } },
      select: { id: true, name: true, roles: { select: { role: { select: { baseRole: true } } } } },
      orderBy: { name: 'asc' },
    });
  }

  /** Round-robin: the sales executive who was given a lead longest ago (managers only when there are no executives). */
  async nextOwner(orgId: string): Promise<{ id: string; name: string } | null> {
    const team = await this.salesTeam(orgId);
    const execs = team.filter((u) => u.roles.some((r) => r.role.baseRole === 'sales_executive'));
    const pool = execs.length ? execs : team;
    if (!pool.length) return null;
    const last = await this.prisma.lead.groupBy({ by: ['ownerId'], where: { orgId, ownerId: { in: pool.map((u) => u.id) } }, _max: { createdAt: true } });
    const when = (id: string) => last.find((l) => l.ownerId === id)?._max.createdAt?.getTime() ?? 0;
    const pick = [...pool].sort((a, b) => when(a.id) - when(b.id) || a.name.localeCompare(b.name))[0];
    return { id: pick.id, name: pick.name };
  }

  /** What the Add lead drawer needs: who can own leads and whether this person may pick the owner. */
  async addOptions(me: Me) {
    if (!opsCanAddLead(me)) throw new ForbiddenException('Only the sales team, Founders, Branch Managers and client managers (referrals) can add leads');
    const team = await this.salesTeam(me.orgId);
    const next = await this.nextOwner(me.orgId);
    return {
      team: team.map((u) => ({ id: u.id, name: u.name, manager: u.roles.some((r) => r.role.baseRole === 'sales_manager') })),
      canPickOwner: opsIsSalesManager(me),
      referralOnly: opsLeadReferralOnly(me),
      nextOwner: next?.name ?? null,
      firstReplyMinutes: OPS_LEAD_FIRST_REPLY_MINUTES,
    };
  }

  /** Proposals a lead can be converted on (sent or accepted), for the Convert drawer. */
  async convertOptions(me: Me, id: string) {
    await this.findLead(me, id);
    const rows = await this.prisma.proposal.findMany({ where: { leadId: id, deletedAt: null, status: { in: ['sent', 'accepted'] } }, orderBy: { createdAt: 'desc' } });
    const out = [];
    for (const p of rows) {
      const v = await this.proposals.get(me, p.id);
      out.push({ id: p.id, label: `v${p.version} · ${p.status}`, firstPaymentPaise: v.firstPayment.totalPaise });
    }
    return out;
  }

  async firstReplyDue(orgId: string, from = new Date()) {
    return addWorkingMinutes(from, OPS_LEAD_FIRST_REPLY_MINUTES, await calendarFor(this.prisma, orgId));
  }

  // -------------------------------------------------------------------------
  // Add lead

  async create(me: Me, body: unknown, ip?: string): Promise<OpsLeadCreated> {
    if (!opsCanAddLead(me)) throw new ForbiddenException('Only the sales team, Founders, Branch Managers and client managers (referrals) can add leads');
    const input = parse(opsLeadCreateSchema, body);
    const referralOnly = opsLeadReferralOnly(me);
    if (referralOnly && input.source !== 'referral') throw new ForbiddenException('Client managers can add referrals only. Set the source to Referral.');
    const unknown = input.serviceIds.filter((k) => !catalogue.some((s) => s.id === k));
    if (unknown.length) throw new BadRequestException(`Unknown service: ${unknown.join(', ')}`);
    const dupes = await this.duplicates(me, { phone: input.phone, email: input.email || undefined, company: input.company });
    if (dupes.length && !input.confirmDuplicate) {
      throw new ConflictException({ message: `Possible duplicate: ${dupes[0].name} (${dupes[0].stage}${dupes[0].owner ? `, owned by ${dupes[0].owner}` : ''}) has the same ${dupes[0].matchedOn.join(' and ')}. Open it, or choose Continue to add anyway.`, duplicates: dupes });
    }
    // Owner: a manager picks anyone (or auto); a sales executive owns what they add unless they choose auto;
    // referrals from client managers are always auto-assigned.
    let owner: { id: string; name: string } | null = null;
    const wantAuto = !input.ownerId || input.ownerId === 'auto' || referralOnly;
    if (!wantAuto) {
      if (input.ownerId !== me.id && !opsIsSalesManager(me)) throw new ForbiddenException('Only a sales manager can give a lead to someone else');
      const team = await this.salesTeam(me.orgId);
      const u = team.find((x) => x.id === input.ownerId) ?? (input.ownerId === me.id && hasRole(me, 'founder', 'admin') ? { id: me.id, name: me.name } : null);
      if (!u) throw new BadRequestException('Pick someone from the sales team as the owner');
      owner = { id: u.id, name: u.name };
    } else if (!referralOnly && hasRole(me, 'sales_executive') && !opsIsSalesManager(me) && input.ownerId !== 'auto') {
      owner = { id: me.id, name: me.name };
    } else owner = await this.nextOwner(me.orgId);

    const budgetPaise = input.budgetRupees === undefined ? null : input.budgetRupees * 100;
    const now = new Date();
    const firstReplyDueAt = await this.firstReplyDue(me.orgId, now);
    const sameContact = dupes.find((d) => d.matchedOn.includes('phone') || d.matchedOn.includes('email'));
    const services = input.serviceIds.map((k) => catalogue.find((s) => s.id === k)?.name ?? k);
    const contact: Contact = { name: input.name, phone: input.phone, company: input.company, ...(input.email ? { email: input.email.toLowerCase() } : {}), ...(input.referredBy ? { referredBy: input.referredBy } : {}) };
    const lead = await this.prisma.lead.create({
      data: {
        orgId: me.orgId,
        source: input.source,
        contact,
        need: input.need?.trim() || `Interested in ${services.join(', ')}`,
        budgetPaise,
        serviceIds: input.serviceIds,
        score: sellLeadScore(budgetPaise, input.serviceIds.length, true).score,
        ownerId: owner?.id ?? null,
        duplicateOfId: sameContact?.id ?? null,
        firstReplyDueAt,
        createdById: me.id,
      },
      include,
    });
    const how = opsLeadSourceLabels[input.source] ?? input.source;
    await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: lead.id, kind: 'enquiry', userId: me.id, body: `${me.name} added this lead (${how}${input.referredBy ? `, referred by ${input.referredBy}` : ''})${owner ? ` and it went to ${owner.name}${wantAuto && !referralOnly && owner.id !== me.id ? ' (round-robin)' : referralOnly ? ' (round-robin)' : ''}` : ''}.` });
    await this.audit.log(me, 'lead.created', 'Lead', lead.id, undefined, { source: input.source, ownerId: owner?.id ?? null, serviceIds: input.serviceIds, duplicateOf: sameContact?.id ?? null, firstReplyDueAt }, ip);
    if (owner && owner.id !== me.id) {
      await this.notifications.notify(me.orgId, [owner.id], {
        kind: 'lead_assigned',
        title: `New lead for you: ${input.company}`,
        body: `${how} · reply by ${dayTime(firstReplyDueAt)}. ${lead.need.slice(0, 100)}`,
        link: `/team/leads/${lead.id}`,
      });
    }
    return {
      lead: sellLeadRow(lead),
      firstReplyDueAt: firstReplyDueAt.toISOString(),
      message: referralOnly ? `Referral added. ${owner ? `${owner.name} will reply by ${dayTime(firstReplyDueAt)}.` : 'A sales manager will assign it.'}` : `Lead added${owner ? ` for ${owner.id === me.id ? 'you' : owner.name}` : ''}. First reply due by ${dayTime(firstReplyDueAt)}.`,
    };
  }

  /** First reply SLA: alert the owner and the sales managers once when a new lead has had no reply in time. */
  async firstReplyAlerts(now = new Date(), orgId?: string) {
    const late = await this.prisma.lead.findMany({
      where: { ...(orgId ? { orgId } : {}), deletedAt: null, archivedAt: null, stage: 'new', firstReplyAt: null, firstReplyAlertedAt: null, firstReplyDueAt: { not: null, lt: now } },
      take: 200,
    });
    for (const l of late) {
      const claimed = await this.prisma.lead.updateMany({ where: { id: l.id, firstReplyAlertedAt: null }, data: { firstReplyAlertedAt: now } });
      if (!claimed.count) continue;
      const managers = await this.prisma.user.findMany({ where: { orgId: l.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'sales_manager' } } } }, select: { id: true } });
      await this.notifications.notify(l.orgId, [l.ownerId, ...managers.map((m) => m.id)], { kind: 'lead_follow_up', title: `No reply yet: ${nameOf(l.contact)}`, body: `The first reply was due ${dayTime(l.firstReplyDueAt!)}.`, link: `/team/leads/${l.id}`, critical: true });
      await this.audit.logSystem(l.orgId, 'lead.first_reply_missed', 'Lead', l.id, { dueAt: l.firstReplyDueAt });
    }
    return late.length;
  }

  /** Holidays or working hours changed: move the first-reply due time of leads still waiting for a reply. */
  async recalcFirstReply(orgId: string) {
    const rows = await this.prisma.lead.findMany({ where: { orgId, deletedAt: null, firstReplyAt: null, firstReplyDueAt: { not: null }, stage: 'new' }, select: { id: true, createdAt: true } });
    const cal = await calendarFor(this.prisma, orgId);
    for (const r of rows) await this.prisma.lead.update({ where: { id: r.id }, data: { firstReplyDueAt: addWorkingMinutes(r.createdAt, OPS_LEAD_FIRST_REPLY_MINUTES, cal) } });
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // Lost, merge, bulk, notes

  async markLost(me: Me, id: string, reason: string, ip?: string): Promise<LeadRow> {
    const lead = await this.findLead(me, id);
    if (!opsIsSalesManager(me) && lead.ownerId !== me.id) throw new ForbiddenException('Only the lead owner or a sales manager can mark a lead lost');
    if (lead.stage === 'won') throw new BadRequestException('A won lead has become a client and cannot be marked lost');
    if (lead.stage === 'lost') throw new BadRequestException('This lead is already marked lost');
    const saved = await this.prisma.lead.update({ where: { id }, data: { stage: 'lost', lostReason: reason }, include });
    await this.audit.log(me, 'lead.lost', 'Lead', id, { stage: lead.stage, lostReason: null }, { stage: 'lost', lostReason: reason }, ip);
    await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: id, kind: 'system', userId: me.id, body: `${me.name} marked the lead lost: ${reason}` });
    return sellLeadRow(saved);
  }

  /** Merge any lead into another (activity, proposals and services move over; the merged lead is removed). */
  async merge(me: Me, id: string, intoId: string, ip?: string) {
    if (!hasRole(me, 'founder', 'admin', 'sales_manager')) throw new ForbiddenException('Only a sales manager or an admin can merge leads');
    if (id === intoId) throw new BadRequestException('Pick a different lead to merge into');
    const [dup, into] = await Promise.all([this.findLead(me, id), this.findLead(me, intoId)]);
    if (dup.stage === 'won') throw new BadRequestException('A lead that became a client cannot be merged into another');
    if (into.stage === 'won' || into.stage === 'lost') throw new BadRequestException(`${nameOf(into.contact)} is ${into.stage}. Merge into an open lead.`);
    if (dup.duplicateOfId !== into.id) await this.prisma.lead.update({ where: { id }, data: { duplicateOfId: into.id } });
    const r = await this.sell.merge(me, id, ip);
    return { ...r, message: `Merged into ${nameOf(into.contact)}` };
  }

  async bulk(me: Me, input: OpsLeadBulk, ip?: string) {
    const ids = [...new Set(input.ids)];
    const rows = await this.prisma.lead.findMany({ where: { ...this.scope(me), id: { in: ids }, archivedAt: null } });
    if (rows.length !== ids.length) throw new NotFoundException('Some of these leads are not yours or no longer exist');
    const mine = (l: { ownerId: string | null }) => opsIsSalesManager(me) || l.ownerId === me.id;
    if (rows.some((l) => !mine(l))) throw new ForbiddenException('You can only change your own leads');
    const undoRows: UndoRow[] = [];
    let message = '';
    if (input.action === 'stage') {
      if (!input.stage) throw new BadRequestException('Pick the stage');
      const movable = rows.filter((l) => l.stage !== 'won' && l.stage !== input.stage);
      // v14: required fields for the stage (Pipelines settings) are checked for every lead before any moves.
      for (const l of movable) {
        const missing = await this.pipelines.leadMissing(me.orgId, l.id, input.stage);
        if (missing.length) throw new BadRequestException(`${nameOf(l.contact)} can't move yet. Fill in: ${missing.join(', ')}`);
      }
      for (const l of movable) {
        undoRows.push({ model: 'lead', id: l.id, data: { stage: l.stage, lostReason: l.lostReason } });
        await this.prisma.lead.update({ where: { id: l.id }, data: { stage: input.stage, lostReason: null } });
        await this.audit.log(me, `lead.${input.stage}`, 'Lead', l.id, { stage: l.stage }, { stage: input.stage, bulk: true }, ip);
      }
      message = `${movable.length} lead${movable.length === 1 ? '' : 's'} moved`;
    } else if (input.action === 'lost') {
      const reason = (input.reason ?? '').trim();
      if (reason.length < 3) throw new BadRequestException('Give the lost reason');
      const movable = rows.filter((l) => l.stage !== 'won' && l.stage !== 'lost');
      for (const l of movable) {
        undoRows.push({ model: 'lead', id: l.id, data: { stage: l.stage, lostReason: l.lostReason } });
        await this.prisma.lead.update({ where: { id: l.id }, data: { stage: 'lost', lostReason: reason } });
        await this.audit.log(me, 'lead.lost', 'Lead', l.id, { stage: l.stage }, { stage: 'lost', lostReason: reason, bulk: true }, ip);
        await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: l.id, kind: 'system', userId: me.id, body: `${me.name} marked the lead lost: ${reason}` });
      }
      message = `${movable.length} lead${movable.length === 1 ? '' : 's'} marked lost`;
    } else if (input.action === 'archive') {
      const reason = (input.reason ?? '').trim();
      if (reason.length < 3) throw new BadRequestException('Give a short reason (at least 3 characters)');
      const movable = rows.filter((l) => l.stage !== 'won');
      const at = new Date();
      for (const l of movable) {
        undoRows.push({ model: 'lead', id: l.id, data: { archivedAt: null, archivedReason: null } });
        await this.prisma.lead.update({ where: { id: l.id }, data: { archivedAt: at, archivedReason: reason } });
        await this.audit.log(me, 'lead.archived', 'Lead', l.id, { archivedAt: null }, { archivedAt: at, reason, bulk: true }, ip);
      }
      message = `${movable.length} lead${movable.length === 1 ? '' : 's'} archived${movable.length < rows.length ? ' (won leads stay)' : ''}`;
    } else {
      const tag = (input.tag ?? '').trim();
      if (!tag) throw new BadRequestException('Type a tag');
      // Tags reuse the shared tag store (TagLink type "lead").
      const t = (await this.prisma.tag.findFirst({ where: { orgId: me.orgId, name: { equals: tag, mode: 'insensitive' } } })) ?? (await this.prisma.tag.create({ data: { orgId: me.orgId, name: tag } }));
      for (const l of rows) {
        await this.prisma.tagLink.upsert({ where: { tagId_targetType_targetId: { tagId: t.id, targetType: 'lead', targetId: l.id } }, create: { orgId: me.orgId, tagId: t.id, targetType: 'lead', targetId: l.id, byId: me.id }, update: {} });
        await this.audit.log(me, 'record.tagged', 'Lead', l.id, null, { tag: t.name, bulk: true }, ip);
      }
      message = `Tagged ${rows.length} lead${rows.length === 1 ? '' : 's'} "${t.name}"`;
    }
    const undo = undoRows.length ? await this.undo.create(me, message, undoRows) : null;
    return { ok: true as const, message, undo };
  }

  /** "+ New → Note / Meeting" against a lead: a note on the timeline, or a meeting (booked as the next follow-up). */
  async note(me: Me, id: string, input: { kind: 'note' | 'meeting'; body: string; at?: string }, ip?: string) {
    const lead = await this.findLead(me, id);
    if (!opsIsSalesManager(me) && lead.ownerId !== me.id) throw new ForbiddenException('Only the lead owner or a sales manager can add notes here');
    if (input.kind === 'meeting') {
      if (!input.at) throw new BadRequestException('Pick when the meeting is');
      const at = new Date(input.at);
      if (at.getTime() < Date.now() - 3_600_000) throw new BadRequestException('Pick a meeting time from now on (log past meetings as an activity)');
      await this.sell.logActivity(me, id, { kind: 'note', body: `Meeting on ${dayTime(at)}: ${input.body}`, nextFollowUpAt: at.toISOString() }, ip);
      if (lead.stage === 'new' || lead.stage === 'contacted') {
        await this.prisma.lead.update({ where: { id }, data: { stage: 'discovery' } });
        await this.audit.log(me, 'lead.discovery', 'Lead', id, { stage: lead.stage }, { stage: 'discovery' }, ip);
      }
      return { ok: true as const, message: `Meeting saved for ${dayTime(at)}. You get a reminder that day.` };
    }
    await this.sell.logActivity(me, id, { kind: 'note', body: input.body }, ip);
    return { ok: true as const, message: 'Note added to the lead' };
  }

  // -------------------------------------------------------------------------
  // Convert to client (manual, with payment proof) — Finance approves

  async convert(me: Me, id: string, body: unknown, ip?: string): Promise<OpsMaybeApproval> {
    if (!hasRole(me, 'founder', 'admin', 'sales_manager')) throw new ForbiddenException('Only a sales manager can make a lead a client by hand');
    const input = parse(opsLeadConvertSchema, body);
    const lead = await this.findLead(me, id);
    if (lead.stage === 'won') throw new BadRequestException('This lead is already a client');
    if (lead.stage === 'lost') throw new BadRequestException('This lead is marked lost. Move it back to an open stage first.');
    const p = await this.prisma.proposal.findFirst({ where: { id: input.proposalId, leadId: id, deletedAt: null } });
    if (!p) throw new BadRequestException('Pick a proposal of this lead');
    if (!['sent', 'accepted'].includes(p.status)) throw new BadRequestException(p.status === 'draft' ? 'Send the proposal first (the client needs to have seen the offer)' : `This proposal is ${p.status}. Use the current version.`);
    const view = await this.proposals.get(me, p.id);
    if (input.amountPaise < view.firstPayment.totalPaise) throw new BadRequestException(`The first payment is ${formatINR(view.firstPayment.totalPaise)}. Record at least that much, or ask Finance to handle a part payment.`);
    const proof = await this.prisma.file.findFirst({ where: { id: input.proofFileId, orgId: me.orgId } });
    if (!proof) throw new BadRequestException('Upload the payment proof again');
    const payload: ConvertPayload = { ...input, note: input.note ?? null };
    const req = await this.approvals.create(
      me,
      {
        action: 'lead.convert',
        targetType: 'lead',
        targetId: id,
        summary: `Make ${nameOf(lead.contact)} a client (offline ${formatINR(input.amountPaise)})`,
        payload,
        reason: input.note || `Paid by ${input.method}, reference ${input.ref} on ${input.paidOn}`,
        approverId: null,
        approverRoles: ['finance'],
        diff: [
          { field: 'Lead', before: lead.stage, after: 'won (client account created)' },
          { field: 'Payment', before: null, after: `${formatINR(input.amountPaise)} · ${input.method} · ${input.ref}` },
        ],
      },
      ip,
    );
    await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: id, kind: 'system', userId: me.id, body: `${me.name} recorded an offline payment of ${formatINR(input.amountPaise)} (${input.method}, ${input.ref}) and asked Finance to confirm before the client account is created.` });
    return { applied: false, approvalId: req.id, message: 'Sent to Finance to confirm the payment. The client account is created once they approve.' };
  }

  private async applyConvert(approver: Me, leadId: string, p: ConvertPayload, requestedById: string) {
    const requester = await this.prisma.user.findUnique({ where: { id: requestedById }, select: { name: true } });
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId: approver.orgId, deletedAt: null } });
    if (!lead) throw new NotFoundException('Lead not found');
    if (lead.stage === 'won') throw new BadRequestException('This lead is already a client');
    const r = await opsCreateClientFromLead({ prisma: this.prisma, proposals: this.proposals, onboarding: this.onboarding }, approver, { leadId, proposalId: p.proposalId, amountPaise: p.amountPaise, method: p.method, ref: p.ref, paidOn: p.paidOn, proofFileId: p.proofFileId, requestedByName: requester?.name ?? 'sales' });
    await this.audit.log(approver, 'lead.converted', 'Lead', leadId, { stage: lead.stage }, { stage: 'won', clientOrgId: r.clientOrgId, offline: true, amountPaise: p.amountPaise, method: p.method, ref: p.ref }, undefined);
    await this.notifications.notify(approver.orgId, [requestedById], { kind: 'deal_won', title: `${nameOf(lead.contact)} is now a client`, body: `${approver.name} confirmed the payment.`, link: `/team/clients/${r.clientOrgId}` });
    return r;
  }

  // -------------------------------------------------------------------------
  // Reassign target: the lead's sales owner

  private registerOwnerTarget() {
    this.registry.registerReassignTarget({
      type: 'lead_owner',
      label: 'Lead',
      auditEntity: 'Lead',
      href: (i) => `/team/leads/${i.id}`,
      load: async (me, ids) => {
        const rows = await this.prisma.lead.findMany({ where: { ...this.scope(me), id: { in: ids }, archivedAt: null } });
        if (rows.length !== new Set(ids).size) throw new NotFoundException('Lead not found');
        for (const l of rows) if (l.stage === 'won' || l.stage === 'lost') throw new BadRequestException(`${nameOf(l.contact)} is ${l.stage} and can't be reassigned`);
        return rows.map((l) => ({ id: l.id, title: nameOf(l.contact), ownerId: l.ownerId, deadline: l.nextFollowUpAt, status: l.stage, inProgress: l.stage !== 'new', hours: 1, href: `/team/leads/${l.id}` }));
      },
      assertCanReassign: async (me) => this.assertManager(me, 'assign or move leads'),
      eligibility: async () => ({ where: { roles: { some: { role: { baseRole: { in: [...SALES_ROLES, 'founder'] } } } } } }),
      snapshot: async (items) => items.map((i) => ({ model: 'lead', id: i.id, data: { ownerId: i.ownerId } })),
      apply: async (me, items, { to }) => {
        await this.prisma.lead.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { ownerId: to.id } });
        for (const i of items) await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: i.id, kind: 'system', userId: me.id, body: `${me.name} ${i.ownerId ? 'reassigned' : 'assigned'} the lead to ${to.name}` });
      },
      openWorkOf: async (orgId, userId) => {
        const rows = await this.prisma.lead.findMany({ where: { orgId, ownerId: userId, deletedAt: null, archivedAt: null, stage: { in: [...OPEN] } }, orderBy: { createdAt: 'desc' }, take: 300 });
        return rows.map((l) => ({ id: l.id, title: nameOf(l.contact), deadline: l.nextFollowUpAt, status: l.stage, client: null }));
      },
    });
    this.registry.registerUndoModel('lead');
  }

  // -------------------------------------------------------------------------
  // CSV import

  private registerImport() {
    this.registry.registerImportEntity({
      entity: 'leads',
      label: 'Leads',
      fields: [
        { key: 'name', label: 'Contact name', required: true },
        { key: 'phone', label: 'Phone', required: true, hint: '10-digit mobile number' },
        { key: 'company', label: 'Business name', required: true },
        { key: 'source', label: 'Source', required: true, hint: OPS_LEAD_SOURCES.join(', ') },
        { key: 'services', label: 'Services', required: true, hint: 'Service names separated by ;' },
        { key: 'email', label: 'Email', required: false },
        { key: 'need', label: 'What they need', required: false },
        { key: 'budget', label: 'Monthly budget (₹)', required: false },
        { key: 'owner', label: 'Owner', required: false, hint: 'Email or name; empty = round-robin' },
      ],
      sampleCsv: 'Contact name,Phone,Business name,Source,Services,Email,What they need,Monthly budget (₹),Owner\nRavi Kumar,9876500011,Kumar Sweets,referral,Social Media Management,ravi@kumarsweets.in,Instagram for Diwali,40000,\n',
      canImport: (me) => hasRole(me, 'founder', 'admin', 'sales_manager', 'sales_executive'),
      validate: (me, rows) => this.validateImport(me, rows),
      commit: async (me, rows, ip) => {
        const ids: string[] = [];
        for (const r of await this.resolveImport(me, rows)) {
          const res = await this.create(me, { ...r.input, confirmDuplicate: true }, ip);
          ids.push(res.lead.id);
        }
        return ids;
      },
    });
  }

  private async resolveImport(me: Me, rows: Record<string, string>[]) {
    const team = await this.salesTeam(me.orgId);
    const people = await this.prisma.user.findMany({ where: { id: { in: team.map((t) => t.id) } }, select: { id: true, name: true, email: true } });
    return rows.map((r) => {
      const source = lc(r.source).replace(/[\s-]+/g, '_');
      const src = (OPS_LEAD_SOURCES as readonly string[]).includes(source) ? source : Object.entries(opsLeadSourceLabels).find(([, label]) => lc(label) === lc(r.source))?.[0] ?? source;
      const svcNames = (r.services ?? '').split(/[;|]/).map((s) => s.trim()).filter(Boolean);
      const serviceIds = svcNames.map((n) => catalogue.find((s) => lc(s.name) === lc(n) || s.id === lc(n))?.id ?? `?${n}`);
      const owner = r.owner?.trim() ? (people.find((p) => lc(p.email) === lc(r.owner)) ?? people.find((p) => lc(p.name) === lc(r.owner)) ?? null) : null;
      const budget = r.budget?.trim() ? Number(r.budget.replace(/[,₹\s]/g, '')) : undefined;
      const input: OpsLeadCreate = {
        name: (r.name ?? '').trim(),
        phone: (r.phone ?? '').replace(/[\s-]/g, ''),
        company: (r.company ?? '').trim(),
        source: src as OpsLeadCreate['source'],
        serviceIds,
        email: (r.email ?? '').trim(),
        need: r.need?.trim() || undefined,
        budgetRupees: budget !== undefined && Number.isFinite(budget) ? Math.round(budget) : undefined,
        ownerId: owner?.id ?? 'auto',
      };
      return { input, ownerMissing: !!r.owner?.trim() && !owner, budgetBad: budget !== undefined && !Number.isFinite(budget) };
    });
  }

  private async validateImport(me: Me, rows: Record<string, string>[]) {
    const resolved = await this.resolveImport(me, rows);
    const seen = new Map<string, number>();
    const out: { errors: string[]; duplicate: string | null }[] = [];
    for (const [i, r] of resolved.entries()) {
      const errors: string[] = [];
      const parsed = opsLeadCreateSchema.safeParse({ ...r.input, serviceIds: r.input.serviceIds.filter((s) => !s.startsWith('?')) });
      if (!parsed.success) for (const issue of parsed.error.issues) errors.push(issue.message);
      const badSvc = r.input.serviceIds.filter((s) => s.startsWith('?')).map((s) => s.slice(1));
      if (badSvc.length) errors.push(`Unknown service: ${badSvc.join(', ')}`);
      if (r.ownerMissing) errors.push(`Nobody in sales matches "${rows[i].owner}"`);
      if (r.ownerMissing === false && r.input.ownerId !== 'auto' && r.input.ownerId !== me.id && !opsIsSalesManager(me)) errors.push('Only a sales manager can give leads to someone else');
      if (r.budgetBad) errors.push('Budget must be a number of rupees');
      let duplicate: string | null = null;
      const key = phoneDigits(r.input.phone);
      if (key && seen.has(key)) duplicate = `Same phone as row ${seen.get(key)! + 1}`;
      if (key) seen.set(key, i);
      if (!duplicate && (key || r.input.email)) {
        const d = await this.duplicates(me, { phone: r.input.phone, email: r.input.email || undefined });
        if (d.length) duplicate = `Same ${d[0].matchedOn.join(' and ')} as ${d[0].name}`;
      }
      out.push({ errors: [...new Set(errors)], duplicate });
    }
    return out;
  }
}

type ConvertPayload = { proposalId: string; amountPaise: number; method: string; ref: string; paidOn: string; proofFileId: string; note: string | null };
