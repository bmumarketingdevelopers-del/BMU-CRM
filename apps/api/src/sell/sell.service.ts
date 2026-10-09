import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  sellActivityLabels,
  sellLeadScore,
  sellOutcomeLabels,
  type LeadRow,
  type Me,
  type SellActivityInput,
  type SellFollowUp,
  type SellLeadDetail,
  type SellRenewal,
  type SellTimelineItem,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { logLeadActivity } from '../proposals/lead-activity.js';
import { ProposalsService } from '../proposals/proposals.service.js';

const DAY = 86_400_000;
const OPEN_STAGES = ['new', 'contacted', 'discovery', 'proposal_sent'] as const;
const include = { owner: { select: { id: true, name: true } } } as const;
type LeadWithOwner = Prisma.LeadGetPayload<{ include: typeof include }>;
type Contact = { name: string; email?: string; phone?: string; company?: string; clientOrgId?: string };

const nameOf = (c: unknown) => {
  const x = (c ?? {}) as Contact;
  return x.company || x.name || 'Lead';
};

export const sellLeadRow = (l: LeadWithOwner): LeadRow => ({
  id: l.id,
  source: l.source,
  contact: l.contact as LeadRow['contact'],
  need: l.need,
  budgetPaise: l.budgetPaise,
  score: l.score,
  stage: l.stage,
  owner: l.owner,
  lostReason: l.lostReason,
  serviceIds: l.serviceIds,
  createdAt: l.createdAt.toISOString(),
  nextFollowUpAt: l.nextFollowUpAt?.toISOString() ?? null,
  duplicateOfId: l.duplicateOfId,
  lastActivityAt: l.lastActivityAt?.toISOString() ?? null,
});

/** End of today in IST, as a UTC instant. */
export function endOfIstDay(now = new Date()) {
  const ist = new Date(now.getTime() + 5.5 * 3_600_000);
  const end = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate(), 23, 59, 59, 999);
  return new Date(end - 5.5 * 3_600_000);
}

const addMonths = (d: Date, m: number) => {
  const x = new Date(d);
  x.setMonth(x.getMonth() + m);
  return x;
};
const dFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });

@Injectable()
export class SellService {
  private readonly log = new Logger('Sell');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly proposals: ProposalsService,
  ) {}

  private scope(me: Me): Prisma.LeadWhereInput {
    return this.proposals.leadScope(me);
  }

  private isManager(me: Me) {
    return me.permissions.leads_pipeline?.scope === 'all';
  }

  private async findLead(me: Me, id: string) {
    const lead = await this.prisma.lead.findFirst({ where: { ...this.scope(me), id }, include });
    if (!lead) throw new NotFoundException('Lead not found');
    return lead;
  }

  // ------------------------------------------------------------ Lead detail

  async detail(me: Me, id: string): Promise<SellLeadDetail> {
    const lead = await this.findLead(me, id);
    const [activities, audits, proposals, original, duplicates, client] = await Promise.all([
      this.prisma.leadActivity.findMany({ where: { leadId: id }, orderBy: { at: 'desc' }, take: 300 }),
      this.prisma.auditEvent.findMany({ where: { orgId: me.orgId, entity: 'Lead', entityId: id, action: { startsWith: 'lead.' } }, orderBy: { at: 'desc' }, take: 100 }),
      this.prisma.proposal.findMany({ where: { leadId: id, deletedAt: null }, orderBy: { createdAt: 'desc' } }),
      lead.duplicateOfId ? this.prisma.lead.findFirst({ where: { id: lead.duplicateOfId, orgId: me.orgId, deletedAt: null } }) : null,
      this.prisma.lead.findMany({ where: { orgId: me.orgId, duplicateOfId: id, deletedAt: null } }),
      this.prisma.clientOrg.findFirst({ where: { orgId: me.orgId, OR: [{ leadId: id }, ...((lead.contact as Contact).clientOrgId ? [{ id: (lead.contact as Contact).clientOrgId }] : [])] }, select: { id: true, name: true } }),
    ]);
    const people = new Map(
      (await this.prisma.user.findMany({ where: { id: { in: [...new Set([...activities.map((a) => a.userId), ...audits.map((a) => a.actorId)].filter((x): x is string => !!x))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]),
    );
    const timeline: SellTimelineItem[] = activities.map((a) => ({
      id: a.id,
      kind: a.kind,
      title: a.kind === 'system' ? 'Update' : `${sellActivityLabels[a.kind] ?? a.kind}${a.outcome && sellOutcomeLabels[a.outcome] ? ` · ${sellOutcomeLabels[a.outcome]}` : ''}`,
      body: a.body,
      outcome: a.outcome,
      at: a.at.toISOString(),
      by: a.userId ? (people.get(a.userId) ?? null) : null,
      nextFollowUpAt: a.nextFollowUpAt?.toISOString() ?? null,
      href: null,
    }));
    // Older history (before the activity log existed) lives in the audit log only.
    const systemTimes = activities.filter((a) => a.kind === 'system').map((a) => a.at.getTime());
    for (const e of audits) {
      if (systemTimes.some((t) => Math.abs(t - e.at.getTime()) < 15_000)) continue;
      const stage = e.action.slice(5);
      if (['updated', 'duplicate_detected', 'merged'].includes(stage)) continue;
      timeline.push({ id: e.id, kind: 'stage', title: 'Stage changed', body: `Moved to ${stage.replace('_', ' ')}`, outcome: null, at: e.at.toISOString(), by: e.actorId ? (people.get(e.actorId) ?? null) : null, nextFollowUpAt: null, href: null });
    }
    if (!activities.some((a) => a.kind === 'enquiry' && Math.abs(a.at.getTime() - lead.createdAt.getTime()) < 60_000)) {
      timeline.push({ id: `created-${lead.id}`, kind: 'enquiry', title: lead.source === 'website' ? 'Website enquiry' : `Lead added (${lead.source})`, body: lead.need, outcome: null, at: lead.createdAt.toISOString(), by: null, nextFollowUpAt: null, href: null });
    }
    timeline.sort((a, b) => b.at.localeCompare(a.at));
    const c = lead.contact as Contact;
    const brief = (l: { id: string; contact: unknown; stage: LeadRow['stage']; createdAt: Date }) => ({ id: l.id, name: nameOf(l.contact), stage: l.stage, createdAt: l.createdAt.toISOString() });
    return {
      lead: sellLeadRow(lead),
      nextFollowUpAt: lead.nextFollowUpAt?.toISOString() ?? null,
      followUpDue: !!lead.nextFollowUpAt && lead.nextFollowUpAt <= endOfIstDay(),
      lastActivityAt: lead.lastActivityAt?.toISOString() ?? null,
      score: sellLeadScore(lead.budgetPaise, lead.serviceIds.length, !!c.company),
      duplicateOf: original ? brief(original) : null,
      duplicates: duplicates.map(brief),
      proposals: proposals.map((p) => ({ id: p.id, version: p.version, status: p.status, totalPaise: p.totalPaise, sentAt: p.sentAt?.toISOString() ?? null, viewCount: p.viewCount, createdAt: p.createdAt.toISOString(), discountStatus: p.discountStatus })),
      timeline,
      client,
      canAssign: this.isManager(me),
    };
  }

  async logActivity(me: Me, id: string, input: SellActivityInput, ip?: string) {
    const lead = await this.findLead(me, id);
    if (lead.stage === 'won' && input.kind !== 'note') throw new BadRequestException('This lead is already a client. Log the conversation in Client 360.');
    const at = input.at ? new Date(input.at) : new Date();
    if (at.getTime() > Date.now() + 5 * 60_000) throw new BadRequestException("An activity can't be in the future. Set a follow-up date instead.");
    const next = input.nextFollowUpAt ? new Date(input.nextFollowUpAt) : input.nextFollowUpAt === null ? null : undefined;
    if (next && next.getTime() < Date.now() - DAY) throw new BadRequestException('Pick a follow-up date from today onwards');
    // v11 ops: a call, meeting, WhatsApp or email needs its outcome and the next follow-up (unless they said no).
    const conversation = input.kind === 'call' || input.kind === 'meeting' || input.kind === 'whatsapp' || input.kind === 'email';
    if (conversation && lead.stage !== 'won' && lead.stage !== 'lost') {
      // A message we sent (email / WhatsApp) has no outcome yet; calls and meetings do.
      if (!input.outcome && (input.kind === 'call' || input.kind === 'meeting')) throw new BadRequestException('Pick the outcome of the conversation');
      if (!next && input.outcome !== 'not_interested') throw new BadRequestException('Set the next follow-up date');
    }
    await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: id, kind: input.kind, outcome: input.outcome, body: input.body, userId: me.id, at, nextFollowUpAt: next ?? null });
    const data: Prisma.LeadUpdateInput = {};
    if (next !== undefined) {
      data.nextFollowUpAt = next;
      data.followUpNotifiedAt = null;
    }
    // A first real conversation moves a new lead to "Contacted" (counts in the funnel's first-touch numbers).
    const touched = lead.stage === 'new' && (input.kind === 'call' || input.kind === 'meeting' || input.kind === 'whatsapp' || input.kind === 'email') && input.outcome !== 'no_answer';
    if (touched) data.stage = 'contacted';
    // v11 ops: the first real touch stops the first-reply timer.
    if (conversation && !lead.firstReplyAt && input.outcome !== 'no_answer') data.firstReplyAt = new Date();
    if (input.outcome === 'meeting_booked' && (lead.stage === 'new' || lead.stage === 'contacted')) data.stage = 'discovery';
    if (Object.keys(data).length) await this.prisma.lead.update({ where: { id }, data });
    if (data.stage) await this.audit.log(me, `lead.${data.stage as string}`, 'Lead', id, { stage: lead.stage }, { stage: data.stage }, ip);
    await this.audit.log(me, 'lead.activity_logged', 'LeadActivity', id, undefined, { kind: input.kind, outcome: input.outcome, nextFollowUpAt: input.nextFollowUpAt }, ip);
    return this.detail(me, id);
  }

  async setFollowUp(me: Me, id: string, nextFollowUpAt: string | null, ip?: string) {
    const lead = await this.findLead(me, id);
    const next = nextFollowUpAt ? new Date(nextFollowUpAt) : null;
    if (next && next.getTime() < Date.now() - DAY) throw new BadRequestException('Pick a follow-up date from today onwards');
    await this.prisma.lead.update({ where: { id }, data: { nextFollowUpAt: next, followUpNotifiedAt: null } });
    await this.audit.log(me, 'lead.follow_up_set', 'Lead', id, { nextFollowUpAt: lead.nextFollowUpAt }, { nextFollowUpAt: next }, ip);
    await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: id, kind: 'system', userId: me.id, body: next ? `${me.name} set a follow-up for ${dFmt.format(next)}` : `${me.name} cleared the follow-up` });
    return this.detail(me, id);
  }

  async followUps(me: Me): Promise<SellFollowUp[]> {
    const end = endOfIstDay(new Date(Date.now() + 7 * DAY));
    const rows = await this.prisma.lead.findMany({
      where: { ...this.scope(me), ...(this.isManager(me) ? { OR: [{ ownerId: me.id }, { ownerId: null }] } : {}), stage: { in: [...OPEN_STAGES] }, nextFollowUpAt: { not: null, lte: end } },
      include,
      orderBy: { nextFollowUpAt: 'asc' },
      take: 100,
    });
    const today = endOfIstDay();
    const startToday = new Date(today.getTime() - DAY + 1);
    return rows.map((l) => ({ leadId: l.id, name: nameOf(l.contact), stage: l.stage, nextFollowUpAt: l.nextFollowUpAt!.toISOString(), overdue: l.nextFollowUpAt! < startToday, owner: l.owner?.name ?? null }));
  }

  /** Daily follow-up reminders: one notification per lead on the follow-up day (or when overdue). */
  async sendFollowUpReminders() {
    const end = endOfIstDay();
    const due = await this.prisma.lead.findMany({
      where: { deletedAt: null, stage: { in: [...OPEN_STAGES] }, nextFollowUpAt: { not: null, lte: end }, followUpNotifiedAt: null },
      take: 200,
    });
    for (const l of due) {
      const res = await this.prisma.lead.updateMany({ where: { id: l.id, followUpNotifiedAt: null }, data: { followUpNotifiedAt: new Date() } });
      if (!res.count) continue;
      let who = l.ownerId ? [l.ownerId] : [];
      if (!who.length) {
        who = (await this.prisma.user.findMany({ where: { orgId: l.orgId, deletedAt: null, status: 'active', roles: { some: { role: { baseRole: 'sales_manager' } } } }, select: { id: true } })).map((u) => u.id);
      }
      await this.notifications.notify(l.orgId, who, {
        kind: 'lead_follow_up',
        title: `Follow up with ${nameOf(l.contact)} today`,
        body: l.need.slice(0, 140),
        link: `/team/leads/${l.id}`,
        critical: l.nextFollowUpAt! < new Date(end.getTime() - DAY),
      });
    }
    return due.length;
  }

  // ------------------------------------------------------------ Duplicates

  async merge(me: Me, id: string, ip?: string) {
    const dup = await this.findLead(me, id);
    if (!dup.duplicateOfId) throw new BadRequestException('This lead is not marked as a duplicate');
    const target = await this.prisma.lead.findFirst({ where: { id: dup.duplicateOfId, orgId: me.orgId, deletedAt: null } });
    if (!target) throw new BadRequestException('The original lead no longer exists. Keep this one separate.');
    if (dup.stage === 'won') throw new BadRequestException('A lead that became a client cannot be merged');
    if (target.stage === 'won' || target.stage === 'lost') throw new BadRequestException(`The original lead is ${target.stage}. Keep this enquiry as its own lead instead.`);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.leadActivity.updateMany({ where: { leadId: dup.id }, data: { leadId: target.id } });
      await tx.proposal.updateMany({ where: { leadId: dup.id }, data: { leadId: target.id } });
      await tx.lead.updateMany({ where: { duplicateOfId: dup.id }, data: { duplicateOfId: target.id } });
      await tx.lead.update({
        where: { id: target.id },
        data: {
          serviceIds: [...new Set([...target.serviceIds, ...dup.serviceIds])],
          budgetPaise: Math.max(target.budgetPaise ?? 0, dup.budgetPaise ?? 0) || null,
          ownerId: target.ownerId ?? dup.ownerId,
          lastActivityAt: now,
        },
      });
      await tx.lead.update({ where: { id: dup.id }, data: { deletedAt: now } });
      await tx.leadActivity.create({ data: { orgId: me.orgId, leadId: target.id, kind: 'system', userId: me.id, body: `${me.name} merged a repeat enquiry into this lead: “${dup.need}”`, at: now } });
    });
    await this.audit.log(me, 'lead.merged', 'Lead', dup.id, { duplicateOf: target.id }, { mergedInto: target.id }, ip);
    return { mergedInto: target.id };
  }

  async keepSeparate(me: Me, id: string, ip?: string) {
    const lead = await this.findLead(me, id);
    if (!lead.duplicateOfId) return this.detail(me, id);
    await this.prisma.lead.update({ where: { id }, data: { duplicateOfId: null } });
    await this.audit.log(me, 'lead.kept_separate', 'Lead', id, { duplicateOf: lead.duplicateOfId }, { duplicateOf: null }, ip);
    await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: id, kind: 'system', userId: me.id, body: `${me.name} kept this as a separate lead (not a duplicate)` });
    return this.detail(me, id);
  }

  // ------------------------------------------------------------ Renewals

  private assertRenewals(me: Me) {
    if (!this.isManager(me)) throw new ForbiddenException('Only sales managers and leadership manage renewals');
  }

  async renewals(me: Me): Promise<SellRenewal[]> {
    this.assertRenewals(me);
    const now = new Date();
    const engagements = await this.prisma.engagement.findMany({
      where: { orgId: me.orgId, deletedAt: null, status: { notIn: ['offboarding', 'pending_payment'] }, clientOrg: { deletedAt: null } },
      include: { clientOrg: { select: { id: true, name: true } }, service: { include: { tiers: true } }, am: { select: { name: true } } },
    });
    const open = await this.prisma.proposal.findMany({
      where: { orgId: me.orgId, kind: 'renewal', deletedAt: null, status: { in: ['draft', 'sent', 'expired'] } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, status: true, version: true, renewalEngagementIds: true },
    });
    const out: SellRenewal[] = [];
    for (const e of engagements) {
      let due: Date | null = null;
      let reason = '';
      if (e.endDate && e.endDate.getTime() >= now.getTime() - 30 * DAY && e.endDate.getTime() <= now.getTime() + 45 * DAY) {
        due = e.endDate;
        reason = e.endDate < now ? `Ended on ${dFmt.format(e.endDate)}` : `Ends on ${dFmt.format(e.endDate)}`;
      } else if (e.billingType === 'monthly' && e.startDate && !e.endDate) {
        for (let m = 6; m <= 60; m += 6) {
          const at = addMonths(e.startDate, m);
          if (at.getTime() < now.getTime() - 30 * DAY) continue;
          if (at.getTime() > now.getTime() + 30 * DAY) break;
          if (e.renewedAt && e.renewedAt.getTime() >= at.getTime() - 60 * DAY) break;
          due = at;
          reason = m % 12 === 0 ? `${m / 12}-year anniversary on ${dFmt.format(at)}` : `${m}-month review on ${dFmt.format(at)}`;
          break;
        }
      }
      if (!due) continue;
      const months = e.startDate ? Math.max(0, Math.floor((now.getTime() - e.startDate.getTime()) / (30.44 * DAY))) : 0;
      const proposal = open.find((p) => p.renewalEngagementIds.includes(e.id));
      out.push({
        engagementId: e.id,
        clientOrgId: e.clientOrgId,
        client: e.clientOrg.name,
        service: e.service.name,
        serviceKey: e.service.key,
        tier: e.tier,
        billingType: e.billingType,
        startDate: e.startDate?.toISOString() ?? null,
        endDate: e.endDate?.toISOString() ?? null,
        monthsActive: months,
        dueDate: due.toISOString(),
        reason,
        urgency: due < now ? 'overdue' : due.getTime() - now.getTime() < 14 * DAY ? 'soon' : 'upcoming',
        monthlyPaise: e.billingType === 'monthly' ? (e.service.tiers.find((t) => t.tier === e.tier)?.pricePaise ?? null) : null,
        am: e.am?.name ?? null,
        openProposal: proposal ? { id: proposal.id, status: proposal.status, version: proposal.version } : null,
        renewalCount: e.renewalCount,
      });
    }
    return out.sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  async createRenewal(me: Me, clientOrgId: string, engagementIds: string[], ip?: string) {
    this.assertRenewals(me);
    const client = await this.prisma.clientOrg.findFirst({
      where: { id: clientOrgId, orgId: me.orgId, deletedAt: null },
      include: { users: { where: { clientRole: 'client_owner' }, include: { user: true } } },
    });
    if (!client) throw new NotFoundException('Client not found');
    const engagements = await this.prisma.engagement.findMany({ where: { id: { in: engagementIds }, clientOrgId, deletedAt: null }, include: { service: true } });
    if (engagements.length !== new Set(engagementIds).size) throw new BadRequestException('Some services do not belong to this client');
    const busy = await this.prisma.proposal.findFirst({ where: { orgId: me.orgId, kind: 'renewal', deletedAt: null, status: { in: ['draft', 'sent'] }, renewalEngagementIds: { hasSome: engagementIds } } });
    if (busy) throw new BadRequestException('There is already an open renewal proposal for these services. Open it from the Renewals list.');
    const original = client.leadId ? await this.prisma.lead.findUnique({ where: { id: client.leadId } }) : null;
    const owner = client.users[0]?.user;
    const oc = (original?.contact ?? {}) as Contact;
    const contact: Contact = { name: owner?.name ?? oc.name ?? client.name, email: owner?.email ?? oc.email, phone: owner?.phone ?? oc.phone, company: client.name, clientOrgId: client.id };
    const lines = [...new Map(engagements.map((e) => [e.service.key, { serviceKey: e.service.key, tier: e.tier }])).values()];
    let lead = await this.prisma.lead.findFirst({ where: { orgId: me.orgId, deletedAt: null, source: 'renewal', stage: { in: [...OPEN_STAGES] }, contact: { path: ['clientOrgId'], equals: client.id } } });
    if (!lead) {
      lead = await this.prisma.lead.create({
        data: {
          orgId: me.orgId,
          source: 'renewal',
          contact,
          need: `Renewal: ${engagements.map((e) => e.service.name).join(', ')}`,
          stage: 'contacted',
          serviceIds: lines.map((l) => l.serviceKey),
          ownerId: original?.ownerId ?? me.id,
          score: sellLeadScore(null, lines.length, true).score,
        },
      });
      await this.audit.log(me, 'lead.contacted', 'Lead', lead.id, undefined, { stage: 'contacted', source: 'renewal', clientOrgId: client.id }, ip);
      await logLeadActivity(this.prisma, { orgId: me.orgId, leadId: lead.id, kind: 'system', userId: me.id, body: `${me.name} started a renewal for ${client.name}` });
    }
    const previous = await this.prisma.proposal.count({ where: { leadId: lead.id } });
    const view = await this.proposals.createFor(
      me,
      lead,
      { lines, addOns: [], extraDiscountPct: 0, validDays: 14 },
      { version: previous + 1, kind: 'renewal', renewalClientOrgId: client.id, renewalEngagementIds: engagements.map((e) => e.id), changeNote: 'Renewal of current services' },
      ip,
    );
    this.log.log(`Renewal proposal ${view.id} drafted for ${client.name}`);
    return view;
  }
}
