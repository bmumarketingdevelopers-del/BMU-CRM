import { Injectable } from '@nestjs/common';
import { formatINR, GATES, type FlowEdge, type FlowGateStrip, type FlowMap, type FlowNode, type FlowPulse, type FlowStageKey, type Me } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { visibleEngagementWhere } from '../engagements/engagement-access.js';
import { GATE_KEYS, loadSnapshot, STAGE_META, type EngagementFacts, type GateKey, type Snapshot } from './flow-snapshot.js';
import { assertRoles, avg, DAY_MS, daysSince, inWindow, istDate, MAP_ROLES, pct, PULSE_ROLES, windows, type Window } from './flow-util.js';

const ORDER: FlowStageKey[] = ['leads', 'proposals', 'won', 'g1', 'g2', 'g3', 'g4', 'g5', 'retainer', 'offboarding'];
const daysBetween = (a: Date, b: Date) => (b.getTime() - a.getTime()) / DAY_MS;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

@Injectable()
export class FlowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  // ---------------------------------------------------------------- map

  async map(me: Me, from?: string, to?: string): Promise<FlowMap> {
    assertRoles(me, MAP_ROLES, 'business flow map');
    const { cur, prev } = windows(from, to);
    const snap = await loadSnapshot(this.prisma, me.orgId);
    const edges = this.edges(snap, cur, prev);
    const nodes = ORDER.map((key) => this.node(snap, key, cur));
    const health = {
      inFlow: nodes.filter((n) => n.key !== 'retainer').reduce((s, n) => s + n.count, 0),
      stuck: nodes.reduce((s, n) => s + n.stuckCount, 0),
      avgLeadToPaidDays: this.leadToPaid(snap, cur),
      avgPaidToG5Days: this.paidToG5(snap, cur),
      prev: { avgLeadToPaidDays: this.leadToPaid(snap, prev), avgPaidToG5Days: this.paidToG5(snap, prev) },
    };
    return { from: cur.fromIso, to: cur.toIso, nodes, edges, health, insights: this.insights(nodes, edges, health) };
  }

  private node(snap: Snapshot, key: FlowStageKey, w: Window): FlowNode {
    const meta = STAGE_META[key];
    const items = snap.stages[key];
    const stuck = items.filter((i) => i.severity !== 'ok');
    const sumValue = items.reduce((s, i) => s + (i.valuePaise ?? 0), 0);
    let periodCount = 0;
    let periodLabel = '';
    let periodValuePaise: number | null = null;
    if (key === 'leads') {
      periodCount = snap.leads.filter((l) => inWindow(l.createdAt, w)).length;
      periodLabel = 'new enquiries in period';
    } else if (key === 'proposals') {
      const sent = snap.proposals.filter((p) => inWindow(p.sentAt, w));
      periodCount = sent.length;
      periodValuePaise = sent.reduce((s, p) => s + p.netPaise, 0);
      periodLabel = 'sent in period';
    } else if (key === 'won') {
      const paid = snap.firstPayments.filter((p) => inWindow(p.at, w));
      periodCount = paid.length;
      periodValuePaise = paid.reduce((s, p) => s + p.amountPaise, 0);
      periodLabel = 'advances paid in period';
    } else if ((GATE_KEYS as readonly string[]).includes(key)) {
      periodCount = snap.engagements.filter((e) => inWindow(e.passed[key as GateKey], w)).length;
      periodLabel = 'passed in period';
    } else if (key === 'retainer') {
      periodCount = snap.engagements.filter((e) => e.billingType === 'monthly' && inWindow(e.passed.g4, w)).length;
      periodLabel = 'moved to steady retainer in period';
    } else {
      periodCount = snap.engagements.filter((e) => inWindow(e.offboardedAt, w)).length;
      periodLabel = 'started offboarding in period';
    }
    return {
      key,
      label: meta.label,
      tag: meta.tag,
      hint: meta.hint,
      count: items.length,
      valuePaise: items.some((i) => i.valuePaise !== null) ? sumValue : null,
      avgDays: avg(items.map((i) => i.days)),
      stuckCount: stuck.length,
      severity: stuck.some((i) => i.severity === 'red') ? 'red' : stuck.length ? 'amber' : 'ok',
      stuckRule: meta.stuckRule,
      periodCount,
      periodLabel,
      periodValuePaise,
      items,
    };
  }

  private edges(snap: Snapshot, cur: Window, prev: Window): FlowEdge[] {
    const edge = (from: FlowStageKey, to: FlowStageKey, label: string, calc: (w: Window) => { throughput: number; conversionPct: number | null }): FlowEdge => {
      const c = calc(cur);
      return { from, to, label, throughput: c.throughput, conversionPct: c.conversionPct, prevConversionPct: calc(prev).conversionPct };
    };
    // Gate k: of engagements that entered stage k in the window, the share that has since passed it.
    const entered = (e: EngagementFacts, k: number) => (k === 0 ? e.started : e.passed[GATE_KEYS[k - 1]]);
    const gate = (k: number) => (w: Window) => {
      const cohort = snap.engagements.filter((e) => inWindow(entered(e, k), w));
      return { throughput: snap.engagements.filter((e) => inWindow(e.passed[GATE_KEYS[k]], w)).length, conversionPct: pct(cohort.filter((e) => e.passed[GATE_KEYS[k]]).length, cohort.length) };
    };
    return [
      edge('leads', 'proposals', 'Proposal sent', (w) => {
        const cohort = snap.leads.filter((l) => inWindow(l.createdAt, w));
        return { throughput: snap.proposals.filter((p) => inWindow(p.sentAt, w)).length, conversionPct: pct(cohort.filter((l) => l.proposalSentAt).length, cohort.length) };
      }),
      edge('proposals', 'won', 'Accepted', (w) => {
        const cohort = snap.proposals.filter((p) => inWindow(p.sentAt, w));
        return { throughput: snap.proposals.filter((p) => inWindow(p.acceptedAt, w)).length, conversionPct: pct(cohort.filter((p) => p.status === 'accepted').length, cohort.length) };
      }),
      edge('won', 'g1', 'Advance paid', (w) => {
        const cohort = snap.proposals.filter((p) => inWindow(p.acceptedAt, w));
        const paid = new Set(snap.firstPayments.map((p) => p.proposalId));
        return { throughput: snap.firstPayments.filter((p) => inWindow(p.at, w)).length, conversionPct: pct(cohort.filter((p) => paid.has(p.id)).length, cohort.length) };
      }),
      edge('g1', 'g2', 'Requirements complete', gate(0)),
      edge('g2', 'g3', 'Plan approved', gate(1)),
      edge('g3', 'g4', 'First drafts sent', gate(2)),
      edge('g4', 'g5', 'All work approved', gate(3)),
      edge('g5', 'retainer', 'Continues on retainer', (w) => ({ throughput: snap.engagements.filter((e) => e.billingType === 'monthly' && inWindow(e.passed.g4, w)).length, conversionPct: null })),
      edge('g5', 'offboarding', 'Delivered or offboarding', (w) => ({
        throughput: snap.engagements.filter((e) => inWindow(e.passed.g5, w) || inWindow(e.offboardedAt, w)).length,
        conversionPct: null,
      })),
    ];
  }

  private leadToPaid(snap: Snapshot, w: Window) {
    return avg(snap.firstPayments.filter((p) => inWindow(p.at, w)).map((p) => daysBetween(p.leadCreatedAt, p.at)));
  }

  private paidToG5(snap: Snapshot, w: Window) {
    return avg(snap.engagements.filter((e) => inWindow(e.passed.g5, w)).map((e) => daysBetween(e.started, e.passed.g5!)));
  }

  private insights(nodes: FlowNode[], edges: FlowEdge[], health: FlowMap['health']): FlowMap['insights'] {
    const out: FlowMap['insights'] = [];
    const work = nodes.filter((n) => n.key !== 'retainer' && n.count > 0);
    const worst = [...work].sort((a, b) => b.stuckCount - a.stuckCount || (b.avgDays ?? 0) - (a.avgDays ?? 0))[0];
    if (worst && worst.stuckCount > 0) {
      const late = worst.items.filter((i) => i.reason?.startsWith('Past')).length;
      out.push({
        tone: 'warn',
        text: `Biggest bottleneck: ${worst.tag !== 'Sell' ? `${worst.tag} ` : ''}${worst.label}. ${plural(worst.count, 'item')} sit here for ${Math.round(worst.avgDays ?? 0)} days on average and ${worst.stuckCount} ${worst.stuckCount === 1 ? 'is' : 'are'} stuck${late ? ` (${late} past deadline)` : ''}.`,
      });
    } else if (work.length) {
      out.push({ tone: 'good', text: 'Nothing is stuck right now: every item is moving within its usual time.' });
    }
    const conv = edges.find((e) => e.from === 'proposals');
    if (conv?.conversionPct !== null && conv?.conversionPct !== undefined) {
      const p = conv.prevConversionPct;
      const trend = p === null ? '' : conv.conversionPct > p ? `, up from ${p}% in the previous period` : conv.conversionPct < p ? `, down from ${p}% in the previous period` : ', the same as the previous period';
      out.push({ tone: p !== null && conv.conversionPct < p ? 'warn' : 'default', text: `Proposals sent in this period convert at ${conv.conversionPct}%${trend}.` });
    }
    const proposals = nodes.find((n) => n.key === 'proposals');
    if (proposals && proposals.count) {
      const oldest = proposals.items.reduce((m, i) => Math.max(m, i.days), 0);
      out.push({ tone: 'default', text: `${formatINR(proposals.valuePaise ?? 0)} (ex GST) is waiting on ${plural(proposals.count, 'client decision')}; the oldest proposal has been out ${Math.round(oldest)} days.` });
    }
    if (health.avgLeadToPaidDays !== null) {
      const p = health.prev.avgLeadToPaidDays;
      out.push({
        tone: p !== null && health.avgLeadToPaidDays > p ? 'warn' : p !== null ? 'good' : 'default',
        text: `A lead takes ${Math.round(health.avgLeadToPaidDays)} days on average from first enquiry to advance paid${p !== null ? ` (previous period: ${Math.round(p)} days)` : ''}.`,
      });
    }
    const leakiest = edges.filter((e) => e.conversionPct !== null && e.from.startsWith('g')).sort((a, b) => (a.conversionPct ?? 100) - (b.conversionPct ?? 100))[0];
    if (leakiest && (leakiest.conversionPct ?? 100) < 60) {
      const from = nodes.find((n) => n.key === leakiest.from)!;
      out.push({ tone: 'warn', text: `Only ${leakiest.conversionPct}% of projects that reached ${from.tag} ${from.label} in this period have passed it so far.` });
    }
    return out;
  }

  // --------------------------------------------------------- gate strip

  /** Count and average days in gate for the projects board columns (engagements the user can see). */
  async gateStrip(me: Me): Promise<FlowGateStrip> {
    const visible = await this.prisma.engagement.findMany({ where: await visibleEngagementWhere(this.prisma, me), select: { id: true } });
    const snap = await loadSnapshot(this.prisma, me.orgId, { engagementIds: visible.map((v) => v.id) });
    const live = snap.engagements.filter((e) => !['delivered', 'closed', 'offboarding'].includes(e.status));
    const allItems = new Map(Object.values(snap.stages).flat().map((i) => [i.id, i]));
    return GATES.map((g) => {
      const rows = live.filter((e) => e.currentGate === g.id);
      const idx = GATES.findIndex((x) => x.id === g.id);
      const sinceFor = (e: EngagementFacts) => (idx === 0 ? e.started : (e.passed[GATE_KEYS[idx - 1]] ?? e.since));
      return {
        gate: g.id,
        count: rows.length,
        avgDays: avg(rows.map((e) => daysSince(sinceFor(e), snap.now))),
        stuck: rows.filter((e) => (allItems.get(e.id)?.severity ?? 'ok') !== 'ok').length,
      };
    });
  }

  // -------------------------------------------------------------- pulse

  async pulse(me: Me): Promise<FlowPulse> {
    assertRoles(me, PULSE_ROLES, 'founder pulse');
    const orgId = me.orgId;
    const now = new Date();
    const month = istDate(now).slice(0, 7);
    const monthStart = new Date(`${month}-01T00:00:00+05:30`);
    const [snap, issued, payments, open, requestsLate, tasksOverdue, forecast, discounts] = await Promise.all([
      loadSnapshot(this.prisma, orgId),
      this.prisma.invoice.findMany({ where: { orgId, createdAt: { gte: monthStart }, status: { notIn: ['draft', 'void', 'credit_noted'] } }, select: { subtotalPaise: true } }),
      this.prisma.payment.findMany({ where: { orgId, at: { gte: monthStart } }, select: { amountPaise: true } }),
      this.prisma.invoice.findMany({
        where: { orgId, status: { in: ['issued', 'partially_paid', 'overdue'] } },
        include: { payments: { select: { amountPaise: true } }, clientOrg: { select: { name: true } } },
        orderBy: { dueDate: 'asc' },
      }),
      this.prisma.request.findMany({
        where: { orgId, firstReplyAt: null, slaDue: { lt: now }, status: { notIn: ['done', 'declined'] } },
        include: { engagement: { include: { clientOrg: { select: { name: true } } } } },
        orderBy: { slaDue: 'asc' },
      }),
      this.prisma.task.count({ where: { orgId, deadline: { lt: now }, status: { in: ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] } } }),
      this.settings.get(orgId, 'forecast'),
      this.prisma.proposal.findMany({ where: { orgId, deletedAt: null, discountNeedsApproval: true, discountApprovedById: null, discountStatus: { not: 'rejected' }, status: { in: ['draft', 'sent'] } }, include: { lead: true } }),
    ]);
    const overdue = open.filter((i) => i.status === 'overdue' || i.dueDate < now);
    const stuck = ORDER.flatMap((k) => snap.stages[k].filter((i) => i.severity !== 'ok').map((i) => ({ ...i, stage: k })));
    const needsYou: FlowPulse['needsYou'] = [];
    for (const p of discounts.slice(0, 3))
      needsYou.push({ id: `disc-${p.id}`, title: `Approve discount for ${(p.lead.contact as { company?: string; name?: string }).company ?? 'a proposal'}`, detail: `${p.extraDiscountPct}% extra discount is above the limit`, tone: 'warn', href: '/team/approvals' });
    for (const i of stuck.filter((x) => x.severity === 'red').slice(0, 4))
      needsYou.push({ id: `stuck-${i.id}`, title: `${i.title}: stuck at ${STAGE_META[i.stage].tag !== 'Sell' ? `${STAGE_META[i.stage].tag} ` : ''}${STAGE_META[i.stage].label}`, detail: i.reason ?? `${Math.round(i.days)} days`, tone: 'bad', href: i.href });
    for (const inv of overdue.slice(0, 3)) {
      const due = inv.totalPaise - inv.payments.reduce((s, p) => s + p.amountPaise, 0);
      needsYou.push({ id: `inv-${inv.id}`, title: `${inv.clientOrg?.name ?? 'Client'} owes ${formatINR(due)}`, detail: `Invoice ${inv.number}, ${Math.max(1, Math.ceil((now.getTime() - inv.dueDate.getTime()) / DAY_MS))} days overdue`, tone: 'bad', href: '/admin/collections' });
    }
    for (const r of requestsLate.slice(0, 3))
      needsYou.push({ id: `req-${r.id}`, title: `${r.engagement.clientOrg.name} is waiting for a reply`, detail: `${r.description.slice(0, 70)} · first reply was due ${istDate(r.slaDue!)}`, tone: 'warn', href: `/team/requests/${r.id}` });

    return {
      asOf: now.toISOString(),
      month,
      revenueMonthPaise: issued.reduce((s, i) => s + i.subtotalPaise, 0),
      targetPaise: forecast.monthlyTargetPaise || null,
      collectedMonthPaise: payments.reduce((s, p) => s + p.amountPaise, 0),
      outstandingPaise: open.reduce((s, i) => s + i.totalPaise - i.payments.reduce((t, p) => t + p.amountPaise, 0), 0),
      overdueInvoices: overdue.length,
      openLeads: snap.leads.filter((l) => ['new', 'contacted', 'discovery', 'proposal_sent'].includes(l.stage)).length,
      stuckItems: stuck.length,
      requestsPastSla: requestsLate.length,
      tasksOverdue,
      stages: ORDER.map((k) => ({ key: k, label: STAGE_META[k].label, tag: STAGE_META[k].tag, count: snap.stages[k].length, stuck: snap.stages[k].filter((i) => i.severity !== 'ok').length })),
      needsYou,
    };
  }
}
