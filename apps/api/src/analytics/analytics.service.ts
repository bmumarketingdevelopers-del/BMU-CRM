import { Injectable } from '@nestjs/common';
import {
  isWorkingDay,
  leadStageLabels,
  type LeadStage,
  type Me,
  type SalesForecastDeal,
  type SalesForecastMonth,
  type SalesForecastView,
  type SalesFunnelBreakdown,
  type SalesFunnelView,
  type SalesInsight,
  type SalesKpi,
  type SalesMrrMovementKind,
  type SalesProfitabilityView,
  type SalesProfitRow,
  type SalesRetentionView,
  type SalesScorecardView,
} from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { DAY, isoDay, monthKey, monthLabel, startOfMonth } from '../insights/ist.js';
import { canSeeMoney } from '../insights/access.js';
import { isBillable, loadLedger, type LedgerInvoice } from '../insights/ledger.js';
import { FUNNEL, loadLeadFacts, sourceLabel, type LeadFact } from './funnel.js';
import { assertFunnel, assertSalesMoney, inRange, median, pct, resolvePeriod, round1, type Range, type ResolvedPeriod } from './period.js';
import { activeAt, inrShort, loadEngagements, mrrByClient, plural, revenueIn, revenueTotal, sumMap, type EngagementFact } from './sales-data.js';

const OPEN_STAGES = ['new', 'contacted', 'discovery', 'proposal_sent'] as const;
/** Months from now until an open lead is expected to close, by stage. */
const CLOSE_OFFSET: Record<string, number> = { proposal_sent: 1, discovery: 2, contacted: 2, new: 3 };
const ROLE_ALIASES: Record<string, string> = { qc_reviewer: 'qc' };
const MONTH_MS = 30.44 * DAY;

type Notes = { invoiceId: string; createdAt: Date; amountPaise: number }[];

/** v9 sales & money analytics. Every public method checks who may read it. */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  private notes(orgId: string): Promise<Notes> {
    return this.prisma.creditNote.findMany({ where: { orgId }, select: { invoiceId: true, createdAt: true, amountPaise: true } });
  }

  // =========================================================================
  // Sales funnel

  async funnel(me: Me, from?: string, to?: string): Promise<SalesFunnelView> {
    assertFunnel(me);
    const p = resolvePeriod(from, to);
    return this.buildFunnel(me.orgId, p, canSeeMoney(me));
  }

  private async buildFunnel(orgId: string, p: ResolvedPeriod, money: boolean): Promise<SalesFunnelView> {
    const now = new Date();
    const [facts, services] = await Promise.all([loadLeadFacts(this.prisma, orgId), this.prisma.service.findMany({ where: { orgId }, select: { key: true, name: true } })]);
    const serviceName = new Map(services.map((s) => [s.key, s.name]));
    const cohort = facts.filter((f) => inRange(f.createdAt, p.cur));
    const prevCohort = facts.filter((f) => inRange(f.createdAt, p.prev));

    const stages = FUNNEL.map((s, i) => {
      const days = cohort
        .filter((f) => f.reached >= i && i > 0 && f.times[i] && f.times[i - 1])
        .map((f) => Math.max(0, (f.times[i]!.getTime() - f.times[i - 1]!.getTime()) / DAY));
      const med = median(days);
      return {
        key: s.key,
        label: s.label,
        count: cohort.filter((f) => f.reached >= i).length,
        prevCount: prevCohort.filter((f) => f.reached >= i).length,
        medianDaysFromPrev: med === null ? null : round1(med),
      };
    });

    const decided = (r: Range) => {
      const won = facts.filter((f) => f.wonAt && inRange(f.wonAt, r)).length;
      const lost = facts.filter((f) => f.lost && inRange(f.lostAt, r) && f.reached < 4).length;
      return { won, lost, rate: pct(won, won + lost) };
    };
    const cur = decided(p.cur);
    const prev = decided(p.prev);

    // Speed to first contact.
    const touchHours = (rows: LeadFact[]) => rows.filter((f) => f.firstTouchAt).map((f) => Math.max(0, (f.firstTouchAt!.getTime() - f.createdAt.getTime()) / 3_600_000));
    const hours = touchHours(cohort);
    const prevHours = touchHours(prevCohort);
    const medH = median(hours);
    const prevMedH = median(prevHours);

    const breakdown = (keyOf: (f: LeadFact) => string[], label: (k: string) => string, valueOf: (f: LeadFact, k: string) => number): SalesFunnelBreakdown[] => {
      const m = new Map<string, LeadFact[]>();
      for (const f of cohort) for (const k of keyOf(f)) m.set(k, [...(m.get(k) ?? []), f]);
      return [...m.entries()]
        .map(([key, rows]) => {
          const won = rows.filter((f) => f.reached >= 4);
          return {
            key,
            label: label(key),
            leads: rows.length,
            proposals: rows.filter((f) => f.reached >= 3).length,
            won: won.length,
            conversionPct: pct(won.length, rows.length),
            revenuePaise: money ? won.reduce((s, f) => s + valueOf(f, key), 0) : null,
          };
        })
        .sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));
    };
    const bySource = breakdown((f) => [f.source], sourceLabel, (f) => f.wonValuePaise);
    const byService = breakdown(
      (f) => (f.serviceIds.length ? [...new Set(f.serviceIds)] : ['_none']),
      (k) => (k === '_none' ? 'No service picked' : (serviceName.get(k) ?? k)),
      (f, k) => f.wonLines.filter((l) => l.key === k).reduce((s, l) => s + l.netPaise, 0) || (f.serviceIds.length <= 1 ? f.wonValuePaise : 0),
    );

    // Lost reasons for leads in the period that were lost.
    const reasons = new Map<string, { label: string; count: number }>();
    for (const f of cohort.filter((x) => x.lost)) {
      const raw = (f.lostReason ?? '').trim() || 'No reason given';
      const key = raw.toLowerCase().replace(/[.!]+$/, '');
      const r = reasons.get(key) ?? { label: raw.charAt(0).toUpperCase() + raw.slice(1).replace(/[.!]+$/, ''), count: 0 };
      r.count++;
      reasons.set(key, r);
    }
    const sortedReasons = [...reasons.values()].sort((a, b) => b.count - a.count);
    const lostReasons = sortedReasons.length > 6 ? [...sortedReasons.slice(0, 5), { label: 'Other reasons', count: sortedReasons.slice(5).reduce((s, r) => s + r.count, 0) }] : sortedReasons;

    const winRateTrend = Array.from({ length: 12 }, (_, k) => {
      const start = startOfMonth(now, k - 11);
      const d = decided({ start, end: startOfMonth(now, k - 10) });
      return { month: monthKey(start), label: monthLabel(start), won: d.won, lost: d.lost, winRatePct: d.rate };
    });

    // ---- Insights
    const insights: SalesInsight[] = [];
    const drops = stages
      .slice(1)
      .map((s, i) => ({ from: stages[i], to: s, rate: stages[i].count >= 3 ? s.count / stages[i].count : null }))
      .filter((d) => d.rate !== null && d.to.key !== 'paid') as { from: (typeof stages)[number]; to: (typeof stages)[number]; rate: number }[];
    const worst = drops.sort((a, b) => a.rate - b.rate)[0];
    if (worst) insights.push({ tone: worst.rate < 0.4 ? 'warn' : 'default', text: `The biggest drop is from ${worst.from.label.toLowerCase()} to ${worst.to.label.toLowerCase()}: ${Math.round(worst.rate * 100)}% of ${worst.from.count} leads made it through.` });
    if (cur.rate !== null) {
      const vs = prev.rate !== null ? (cur.rate > prev.rate ? `, up from ${Math.round(prev.rate)}%` : cur.rate < prev.rate ? `, down from ${Math.round(prev.rate)}%` : ', the same as before') : '';
      insights.push({ tone: prev.rate !== null && cur.rate < prev.rate ? 'warn' : prev.rate !== null && cur.rate > prev.rate ? 'good' : 'default', text: `We won ${cur.won} of ${cur.won + cur.lost} deals decided in this period (${Math.round(cur.rate)}% win rate${vs}).` });
    }
    const ranked = bySource.filter((s) => s.leads >= 3 && s.conversionPct !== null).sort((a, b) => b.conversionPct! - a.conversionPct!);
    if (ranked.length >= 2 && ranked[0].conversionPct! > ranked.at(-1)!.conversionPct!) {
      const best = ranked[0];
      const low = ranked.at(-1)!;
      insights.push({ tone: 'good', text: `${best.label} leads convert best: ${best.won} of ${best.leads} became clients (${Math.round(best.conversionPct!)}%), against ${Math.round(low.conversionPct!)}% from ${low.label}.` });
    }
    const decidedLeads = facts.filter((f) => f.firstTouchAt && (f.wonAt || f.lost));
    const fast = decidedLeads.filter((f) => f.firstTouchAt!.getTime() - f.createdAt.getTime() <= DAY);
    const slow = decidedLeads.filter((f) => f.firstTouchAt!.getTime() - f.createdAt.getTime() > DAY);
    const winShare = (rows: LeadFact[]) => pct(rows.filter((f) => f.wonAt).length, rows.length);
    if (fast.length >= 3 && slow.length >= 3 && winShare(fast)! > winShare(slow)!) {
      insights.push({ tone: 'default', text: `Leads we called back within a day were won ${Math.round(winShare(fast)!)}% of the time, against ${Math.round(winShare(slow)!)}% when we took longer.` });
    } else if (medH !== null) {
      insights.push({ tone: medH > 24 ? 'warn' : 'default', text: `Half of new leads got a first reply within ${fmtHours(medH)}.` });
    }
    if (sortedReasons.length && insights.length < 4) insights.push({ tone: 'default', text: `Most common reason for losing a deal: "${sortedReasons[0].label}" (${plural(sortedReasons[0].count, 'lead')}).` });
    if (!cohort.length) insights.splice(0, insights.length, { tone: 'default', text: 'No new leads came in during this period.' });

    return {
      period: p.view,
      canSeeMoney: money,
      stages,
      winRatePct: cur.rate,
      prevWinRatePct: prev.rate,
      leadsCount: cohort.length,
      prevLeadsCount: prevCohort.length,
      speed: { medianHours: medH === null ? null : round1(medH), prevMedianHours: prevMedH === null ? null : round1(prevMedH), within24hPct: pct(hours.filter((h) => h <= 24).length, hours.length), measured: hours.length },
      bySource,
      byService,
      lostReasons,
      winRateTrend,
      leads: cohort
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .map((f) => ({
          id: f.id,
          name: f.name,
          company: f.company,
          source: sourceLabel(f.source),
          stage: f.stage,
          reached: FUNNEL[f.reached].key,
          lost: f.lost,
          lostReason: f.lostReason,
          owner: f.owner,
          createdAt: f.createdAt.toISOString(),
          valuePaise: money ? f.valuePaise : null,
          clientId: f.clientId,
        })),
      insights: insights.slice(0, 4),
    };
  }

  // =========================================================================
  // Revenue forecast

  async forecast(me: Me): Promise<SalesForecastView> {
    assertSalesMoney(me);
    const orgId = me.orgId;
    const now = new Date();
    const [settings, engagements, ledger, notes, facts, openProposals] = await Promise.all([
      this.settings.get(orgId, 'forecast'),
      loadEngagements(this.prisma, orgId, now),
      loadLedger(this.prisma, orgId),
      this.notes(orgId),
      loadLeadFacts(this.prisma, orgId),
      this.prisma.proposal.findMany({ where: { orgId, deletedAt: null, status: 'sent' }, orderBy: { createdAt: 'desc' }, select: { id: true, leadId: true, lines: true } }),
    ]);
    const H = 6;
    const target = settings.monthlyTargetPaise;
    const probOf = (stage: string) => Math.max(0, Math.min(100, settings.stageProbabilityPct[stage] ?? 0));

    // Committed: live retainers every month, plus project balances in the month they are expected.
    const overdue = new Map<string, number>();
    for (const i of ledger) if (i.clientOrgId && i.displayStatus === 'overdue' && i.daysOverdue > 15) overdue.set(i.clientOrgId, Math.max(overdue.get(i.clientOrgId) ?? 0, i.daysOverdue));
    const retainers = engagements
      .filter((e) => e.billingType === 'monthly' && e.live && activeAt(e, now))
      .map((e) => ({
        engagementId: e.id,
        clientId: e.clientId,
        client: e.client,
        service: e.service,
        tier: e.tier,
        monthlyPaise: e.pricePaise,
        atRisk: overdue.has(e.clientId) ? `Invoice ${overdue.get(e.clientId)} days overdue` : e.status === 'blocked' ? 'Work is blocked' : null,
      }))
      .sort((a, b) => b.monthlyPaise - a.monthlyPaise);
    const mrr = retainers.reduce((s, r) => s + r.monthlyPaise, 0);
    const atRiskMrr = retainers.filter((r) => r.atRisk).reduce((s, r) => s + r.monthlyPaise, 0);
    const monthIndex = (d: Date) => {
      const a = startOfMonth(now);
      const b = startOfMonth(d);
      return Math.round((b.getTime() - a.getTime()) / MONTH_MS);
    };
    const balances = engagements
      .filter((e) => e.billingType === 'one_time' && (e.live || e.status === 'awaiting_final_payment') && !e.hasBalanceInvoice && e.balancePaise > 0 && !e.end)
      .map((e) => {
        const k = e.status === 'awaiting_final_payment' || e.status === 'delivered' ? 1 : Math.max(1, monthIndex(new Date(e.start.getTime() + 60 * DAY)));
        return { engagementId: e.id, clientId: e.clientId, client: e.client, service: e.service, amountPaise: e.balancePaise, k };
      })
      .filter((b) => b.k <= H);

    // Pipeline: open leads with a sent proposal (value from its lines) or a budget.
    const proposalByLead = new Map<string, (typeof openProposals)[number]>();
    for (const pr of openProposals) if (!proposalByLead.has(pr.leadId)) proposalByLead.set(pr.leadId, pr);
    const dealFlows: { deal: SalesForecastDeal; flow: number[] }[] = [];
    for (const f of facts.filter((x) => (OPEN_STAGES as readonly string[]).includes(x.stage))) {
      const k0 = CLOSE_OFFSET[f.stage] ?? 3;
      const flow = Array<number>(H + 1).fill(0);
      const pr = proposalByLead.get(f.id);
      if (pr) {
        for (const l of (pr.lines ?? []) as { billingType?: string; netPaise?: number }[]) {
          const net = l.netPaise ?? 0;
          if (l.billingType === 'monthly') for (let k = k0; k <= H; k++) flow[k] += net;
          else {
            flow[k0] += Math.round(net / 2);
            if (k0 + 2 <= H) flow[k0 + 2] += net - Math.round(net / 2);
          }
        }
      } else if (f.budgetPaise) flow[k0] += f.budgetPaise;
      const value = flow.reduce((s, v) => s + v, 0);
      if (!value) continue;
      const prob = probOf(f.stage);
      dealFlows.push({
        flow,
        deal: {
          leadId: f.id,
          name: f.company ?? f.name,
          stage: f.stage,
          stageLabel: leadStageLabels[f.stage as LeadStage] ?? f.stage,
          source: sourceLabel(f.source),
          basis: pr ? 'proposal' : 'budget',
          proposalId: pr?.id ?? null,
          valuePaise: value,
          probabilityPct: prob,
          weightedPaise: Math.round((value * prob) / 100),
          expectedMonth: monthLabel(startOfMonth(now, k0), true),
        },
      });
    }

    const months: SalesForecastMonth[] = [];
    for (let k = -5; k <= H; k++) {
      const start = startOfMonth(now, k);
      const base = { month: monthKey(start), label: monthLabel(start), future: k > 0 };
      if (k <= 0) {
        const actual = revenueTotal(ledger, notes, { start, end: startOfMonth(now, k + 1) });
        months.push({ ...base, actualPaise: actual, committedPaise: k === 0 ? actual : null, weightedPaise: null, expectedPaise: k === 0 ? actual : null, bestPaise: k === 0 ? actual : null, worstPaise: k === 0 ? actual : null });
        continue;
      }
      const committed = mrr + balances.filter((b) => b.k === k).reduce((s, b) => s + b.amountPaise, 0);
      const weighted = dealFlows.reduce((s, d) => s + (d.flow[k] * d.deal.probabilityPct) / 100, 0);
      const best = dealFlows.reduce((s, d) => s + (d.flow[k] * Math.min(100, d.deal.probabilityPct * 1.5)) / 100, 0);
      months.push({
        ...base,
        actualPaise: null,
        committedPaise: committed,
        weightedPaise: Math.round(weighted),
        expectedPaise: Math.round(committed + weighted),
        bestPaise: Math.round(committed + best),
        worstPaise: Math.max(0, committed - atRiskMrr),
      });
    }
    const future = months.filter((m) => m.future);
    const sum = (f: (m: SalesForecastMonth) => number | null) => future.reduce((s, m) => s + (f(m) ?? 0), 0);
    const totals = {
      committedPaise: sum((m) => m.committedPaise),
      weightedPaise: sum((m) => m.weightedPaise),
      expectedPaise: sum((m) => m.expectedPaise),
      bestPaise: sum((m) => m.bestPaise),
      worstPaise: sum((m) => m.worstPaise),
      targetPaise: target * H,
    };
    const deals = dealFlows.map((d) => d.deal).sort((a, b) => b.weightedPaise - a.weightedPaise);

    const insights: SalesInsight[] = [];
    if (target) {
      const hit = future.filter((m) => (m.expectedPaise ?? 0) >= target);
      const first = future[0];
      insights.push({
        tone: hit.length >= 4 ? 'good' : hit.length === 0 ? 'warn' : 'default',
        text: `Expected revenue reaches the ${inrShort(target)} monthly target in ${hit.length} of the next 6 months${first ? `; ${first.label} looks like ${inrShort(first.expectedPaise ?? 0)}` : ''}.`,
      });
      const gap = target - mrr;
      if (gap > 0) insights.push({ tone: 'default', text: `Retainers alone bring in ${inrShort(mrr)} a month, ${Math.round((mrr / target) * 100)}% of target. The other ${inrShort(gap)} has to come from projects and new deals each month.` });
      else insights.push({ tone: 'good', text: `Retainers alone (${inrShort(mrr)} a month) already cover the monthly target.` });
    }
    if (deals.length) {
      const top = deals.slice(0, 3);
      const share = totals.weightedPaise ? Math.round((top.reduce((s, d) => s + d.weightedPaise, 0) / totals.weightedPaise) * 100) : 0;
      insights.push({ tone: 'default', text: `${plural(deals.length, 'open deal')} add ${inrShort(totals.weightedPaise)} after weighting by stage; the top ${top.length} (${top.map((d) => d.name).join(', ')}) are ${share}% of that.` });
    }
    if (atRiskMrr) insights.push({ tone: 'warn', text: `${inrShort(atRiskMrr)} a month of retainers is at risk (late payment or blocked work). The worst case assumes we lose it.` });

    return {
      months,
      splitAt: 6,
      targetPaise: target,
      mrrPaise: mrr,
      atRiskMrrPaise: atRiskMrr,
      totals,
      retainers,
      balances: balances.map(({ k, ...b }) => ({ ...b, month: monthLabel(startOfMonth(now, k), true) })),
      deals,
      settings: { stageProbabilityPct: settings.stageProbabilityPct, monthlyTargetPaise: target },
      canEdit: this.settings.canEdit(me, 'forecast'),
      insights: insights.slice(0, 4),
    };
  }

  // =========================================================================
  // MRR & retention

  async retention(me: Me, from?: string, to?: string): Promise<SalesRetentionView> {
    assertSalesMoney(me);
    const p = resolvePeriod(from, to);
    return this.buildRetention(me.orgId, p);
  }

  private async buildRetention(orgId: string, p: ResolvedPeriod): Promise<SalesRetentionView> {
    const now = new Date();
    const [engagements, ledger, notes] = await Promise.all([loadEngagements(this.prisma, orgId, now), loadLedger(this.prisma, orgId), this.notes(orgId)]);
    const clip = (d: Date) => (d > now ? now : d);
    const at = (d: Date) => mrrByClient(engagements, new Date(clip(d).getTime() - 1));

    const flows = (r: Range) => {
      const a = at(r.start);
      const b = at(r.end);
      const out = { startPaise: sumMap(a), newPaise: 0, expansionPaise: 0, contractionPaise: 0, churnPaise: 0, endPaise: sumMap(b) };
      const moves: SalesRetentionView['movements'] = [];
      for (const id of new Set([...a.keys(), ...b.keys()])) {
        const x = a.get(id) ?? 0;
        const y = b.get(id) ?? 0;
        if (x === y) continue;
        const kind: SalesMrrMovementKind = x === 0 ? 'new' : y === 0 ? 'churn' : y > x ? 'expansion' : 'contraction';
        if (kind === 'new') out.newPaise += y;
        else if (kind === 'churn') out.churnPaise -= x;
        else if (kind === 'expansion') out.expansionPaise += y - x;
        else out.contractionPaise -= x - y;
        moves.push({ clientId: id, client: engagements.find((e) => e.clientId === id)!.client, kind, startPaise: x, endPaise: y });
      }
      const startClients = a.size;
      const churned = [...a.keys()].filter((id) => !b.has(id)).length;
      return {
        out,
        moves,
        clients: b.size,
        startClients,
        logo: pct(churned, startClients),
        revenueChurn: out.startPaise ? round1((-(out.churnPaise + out.contractionPaise) / out.startPaise) * 100) : null,
        nrr: out.startPaise ? round1(((out.startPaise + out.expansionPaise + out.contractionPaise + out.churnPaise) / out.startPaise) * 100) : null,
      };
    };
    const cur = flows(p.cur);
    const prev = flows(p.prev);

    const mrrTrend = Array.from({ length: 12 }, (_, k) => {
      const start = startOfMonth(now, k - 11);
      const m = at(startOfMonth(now, k - 10));
      return { month: monthKey(start), label: monthLabel(start), mrrPaise: sumMap(m), clients: m.size };
    });

    // Cohorts: clients by the month their first engagement started; share still active after 1..11 months.
    const byClient = new Map<string, EngagementFact[]>();
    for (const e of engagements) byClient.set(e.clientId, [...(byClient.get(e.clientId) ?? []), e]);
    const firstStart = new Map([...byClient.entries()].map(([id, es]) => [id, new Date(Math.min(...es.map((e) => e.start.getTime())))]));
    const activeClient = (id: string, d: Date) => byClient.get(id)!.some((e) => activeAt(e, d));
    const cohorts: SalesRetentionView['cohorts'] = [];
    for (let k = -11; k <= 0; k++) {
      const cStart = startOfMonth(now, k);
      const members = [...firstStart.entries()].filter(([, d]) => d >= cStart && d < startOfMonth(now, k + 1)).map(([id]) => id);
      if (!members.length) continue;
      const values: (number | null)[] = [];
      for (let n = 1; n <= 11; n++) {
        const checkpointMonth = startOfMonth(now, k + n);
        if (checkpointMonth > now) {
          values.push(null);
          continue;
        }
        const check = clip(startOfMonth(now, k + n + 1));
        values.push(Math.round((members.filter((id) => activeClient(id, new Date(check.getTime() - 1))).length / members.length) * 100));
      }
      cohorts.push({ label: monthLabel(cStart, true), size: members.length, values });
    }

    // Lifetime of clients who have left.
    const lifetimes: number[] = [];
    for (const [id, es] of byClient) {
      if (es.some((e) => !e.end || e.end > now)) continue;
      const end = Math.max(...es.map((e) => e.end!.getTime()));
      lifetimes.push((end - firstStart.get(id)!.getTime()) / MONTH_MS);
    }
    const avgLifetime = lifetimes.length ? round1(lifetimes.reduce((s, x) => s + x, 0) / lifetimes.length) : null;

    // Lifetime revenue and concentration.
    const allTime = revenueIn(ledger, notes, { start: new Date(0), end: new Date(now.getTime() + DAY) });
    const periodRev = revenueIn(ledger, notes, p.cur);
    const byInvoice = new Map(ledger.map((i) => [i.id, i]));
    const perClient = (m: Map<string, number>) => {
      const out = new Map<string, { name: string; paise: number }>();
      for (const [invId, v] of m) {
        const inv = byInvoice.get(invId);
        if (!inv?.clientOrgId) continue;
        const cur0 = out.get(inv.clientOrgId) ?? { name: inv.clientOrg?.name ?? 'Client', paise: 0 };
        cur0.paise += v;
        out.set(inv.clientOrgId, cur0);
      }
      return [...out.entries()].map(([id, x]) => ({ id, ...x })).sort((a, b) => b.paise - a.paise);
    };
    const lifetime = perClient(allTime);
    const inPeriod = perClient(periodRev).filter((c) => c.paise > 0);
    const periodTotal = inPeriod.reduce((s, c) => s + c.paise, 0);
    const top3 = inPeriod.slice(0, 3);
    const top3Pct = periodTotal ? round1((top3.reduce((s, c) => s + c.paise, 0) / periodTotal) * 100) : null;

    const insights: SalesInsight[] = [];
    const w = cur.out;
    const net = w.endPaise - w.startPaise;
    if (w.startPaise || w.endPaise) {
      insights.push({
        tone: net > 0 ? 'good' : net < 0 ? 'warn' : 'default',
        text: `Monthly recurring revenue went from ${inrShort(w.startPaise)} to ${inrShort(w.endPaise)} in this period (${net >= 0 ? '+' : ''}${inrShort(net)}): ${inrShort(w.newPaise)} from new clients, ${inrShort(w.expansionPaise)} from upgrades, ${inrShort(-w.churnPaise - w.contractionPaise)} lost.`,
      });
    }
    if (cur.nrr !== null) insights.push({ tone: cur.nrr >= 100 ? 'good' : cur.nrr < 90 ? 'warn' : 'default', text: `Clients we already had at the start now pay ${Math.round(cur.nrr)}% of what they did (net revenue retention)${cur.nrr >= 100 ? ', so growth does not depend only on new clients' : ''}.` });
    if (top3Pct !== null && top3Pct > 50) insights.push({ tone: 'warn', text: `${top3.map((c) => c.name).join(', ')} brought in ${Math.round(top3Pct)}% of revenue this period. Losing one of them would hurt; spreading revenue across more clients lowers that risk.` });
    else if (top3Pct !== null) insights.push({ tone: 'default', text: `The top 3 clients are ${Math.round(top3Pct)}% of revenue this period, a healthy spread.` });
    if (avgLifetime !== null && insights.length < 4) insights.push({ tone: 'default', text: `Clients who left stayed ${avgLifetime} months on average (${plural(lifetimes.length, 'client')}).` });

    return {
      period: p.view,
      mrrTrend,
      waterfall: cur.out,
      prevWaterfall: prev.out,
      movements: cur.moves.sort((a, b) => Math.abs(b.endPaise - b.startPaise) - Math.abs(a.endPaise - a.startPaise)),
      retainerClients: cur.clients,
      prevRetainerClients: prev.clients,
      logoChurnPct: cur.logo,
      prevLogoChurnPct: prev.logo,
      revenueChurnPct: cur.revenueChurn,
      prevRevenueChurnPct: prev.revenueChurn,
      nrrPct: cur.nrr,
      prevNrrPct: prev.nrr,
      cohorts,
      avgLifetimeMonths: avgLifetime,
      churnedClients: lifetimes.length,
      topClients: lifetime.slice(0, 8).map((c) => {
        const es = byClient.get(c.id) ?? [];
        const first = firstStart.get(c.id);
        return { id: c.id, name: c.name, lifetimePaise: c.paise, active: es.some((e) => activeAt(e, now)), months: first ? Math.max(1, Math.round((now.getTime() - first.getTime()) / MONTH_MS)) : 0 };
      }),
      concentration: { top3Pct, totalPaise: periodTotal, top3: top3.map((c) => ({ id: c.id, name: c.name, revenuePaise: c.paise })) },
      insights: insights.slice(0, 4),
    };
  }

  // =========================================================================
  // Profitability

  async profitability(me: Me, from?: string, to?: string): Promise<SalesProfitabilityView> {
    assertSalesMoney(me);
    const p = resolvePeriod(from, to);
    const orgId = me.orgId;
    const rates = await this.settings.get(orgId, 'costRates');
    const [ledger, notes, engagements, users] = await Promise.all([
      loadLedger(this.prisma, orgId),
      this.notes(orgId),
      this.prisma.engagement.findMany({ where: { orgId }, select: { id: true, clientOrgId: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } }),
      this.prisma.user.findMany({ where: { orgId, type: 'staff' }, select: { id: true, roles: { select: { role: { select: { baseRole: true } } } } } }),
    ]);
    const ctx = await this.profitContext(orgId, ledger);
    const engById = new Map(engagements.map((e) => [e.id, e]));
    const rateFor = new Map(
      users.map((u) => {
        const keys = u.roles.map((r) => ROLE_ALIASES[r.role.baseRole] ?? r.role.baseRole).filter((k) => rates.hourlyPaise[k] !== undefined);
        const role = keys.sort((a, b) => rates.hourlyPaise[b] - rates.hourlyPaise[a])[0] ?? 'default';
        return [u.id, { role, rate: rates.hourlyPaise[role] ?? rates.hourlyPaise.default ?? 0 }];
      }),
    );
    const compute = (r: Range) => this.profit(orgId, r, { ledger, notes, engById, rateFor, defaultRate: rates.hourlyPaise.default ?? 0, overheadPct: rates.overheadPct, ctx });
    const [cur, prev] = await Promise.all([compute(p.cur), compute(p.prev)]);

    const insights: SalesInsight[] = [];
    const t = cur.totals;
    if (t.revenuePaise > 0) {
      const pm = prev.totals.marginPct;
      insights.push({
        tone: (t.marginPct ?? 0) < 30 ? 'warn' : pm !== null && (t.marginPct ?? 0) >= pm ? 'good' : 'default',
        text: `After paying for the team's time and creators, we kept ${inrShort(t.marginPaise)} of ${inrShort(t.revenuePaise)} billed (${Math.round(t.marginPct ?? 0)}% gross margin${pm !== null ? `, ${(t.marginPct ?? 0) >= pm ? 'up' : 'down'} from ${Math.round(pm)}%` : ''}).`,
      });
    }
    const losing = cur.clients.filter((c) => c.marginPaise < 0 && c.revenuePaise > 0);
    if (losing.length) insights.push({ tone: 'warn', text: `${losing.map((c) => c.name).join(', ')} cost${losing.length === 1 ? 's' : ''} more to serve than ${losing.length === 1 ? 'it pays' : 'they pay'}: ${losing.map((c) => `${inrShort(-c.marginPaise)} lost on ${c.hours} hours`).join('; ')}.` });
    const cost = cur.avgCostPerHourPaise;
    const under = cur.services
      .filter((s) => s.hours >= 5 && s.revenuePaise > 0 && ((s.marginPct ?? 0) < 25 || (cost !== null && (s.hourlyRatePaise ?? 0) < cost * 1.5)))
      .sort((a, b) => (a.marginPct ?? 0) - (b.marginPct ?? 0));
    if (under.length) {
      const s = under[0];
      insights.push({ tone: 'warn', text: `${s.name} looks underpriced: it earns ${inrShort(s.hourlyRatePaise ?? 0)} per hour of work${cost ? ` while an hour costs us about ${inrShort(cost)}` : ''}, a ${Math.round(s.marginPct ?? 0)}% margin. Raise the price or cut the hours it takes.` });
    }
    const best = cur.clients.filter((c) => c.revenuePaise > 0 && c.hours > 0).sort((a, b) => (b.hourlyRatePaise ?? 0) - (a.hourlyRatePaise ?? 0))[0];
    if (best && insights.length < 4) insights.push({ tone: 'good', text: `${best.name} is the best use of team time: ${inrShort(best.hourlyRatePaise ?? 0)} billed per hour worked, ${Math.round(best.marginPct ?? 0)}% margin.` });
    if (!t.revenuePaise && !t.hours) insights.splice(0, insights.length, { tone: 'default', text: 'No invoices or logged hours in this period yet.' });

    return {
      period: p.view,
      clients: cur.clients,
      services: cur.services,
      totals: cur.totals,
      prevTotals: prev.totals,
      byRole: cur.byRole,
      avgCostPerHourPaise: cur.avgCostPerHourPaise,
      costRates: rates,
      canEdit: this.settings.canEdit(me, 'costRates'),
      insights: insights.slice(0, 4),
    };
  }

  /** Proposal lines for first-payment invoices (to split them by service) and creator briefs (to link payouts). */
  private async profitContext(orgId: string, ledger: LedgerInvoice[]) {
    const proposalIds = [...new Set(ledger.map((i) => i.proposalId).filter((x): x is string => !!x))];
    const [proposals, briefs] = await Promise.all([
      proposalIds.length ? this.prisma.proposal.findMany({ where: { id: { in: proposalIds } }, select: { id: true, lines: true } }) : [],
      this.prisma.creatorBrief.findMany({ where: { orgId }, select: { id: true, clientOrgId: true, engagementId: true } }),
    ]);
    return { linesByProposal: new Map(proposals.map((x) => [x.id, (x.lines ?? []) as { kind?: string; name?: string; dueNowPaise?: number }[]])), briefs: new Map(briefs.map((b) => [b.id, b])) };
  }

  private async profit(
    orgId: string,
    r: Range,
    d: {
      ledger: LedgerInvoice[];
      notes: Notes;
      engById: Map<string, { clientOrgId: string; clientOrg: { name: string }; service: { name: string } }>;
      rateFor: Map<string, { role: string; rate: number }>;
      defaultRate: number;
      overheadPct: number;
      ctx: Awaited<ReturnType<AnalyticsService['profitContext']>>;
    },
  ) {
    const [tasks, payouts] = await Promise.all([
      this.prisma.task.findMany({
        where: { orgId, timeLoggedMin: { gt: 0 }, OR: [{ completedAt: { gte: r.start, lt: r.end } }, { completedAt: null, updatedAt: { gte: r.start, lt: r.end } }] },
        select: { timeLoggedMin: true, ownerId: true, engagementId: true, deliverable: { select: { cycle: { select: { engagementId: true } } } } },
      }),
      this.prisma.creatorPayout.findMany({ where: { orgId, briefId: { not: null }, createdAt: { gte: r.start, lt: r.end } }, select: { briefId: true, amountPaise: true } }),
    ]);
    type Acc = { id: string; name: string; revenue: number; collected: number; minutes: number; labour: number; creator: number };
    const clients = new Map<string, Acc>();
    const services = new Map<string, Acc>();
    const acc = (m: Map<string, Acc>, id: string, name: string) => {
      let a = m.get(id);
      if (!a) m.set(id, (a = { id, name, revenue: 0, collected: 0, minutes: 0, labour: 0, creator: 0 }));
      return a;
    };
    const split = (i: LedgerInvoice): [string, number][] => {
      if (i.engagement) return [[i.engagement.service.name, 1]];
      const lines = i.proposalId ? d.ctx.linesByProposal.get(i.proposalId) : undefined;
      if (lines?.length) {
        const total = lines.reduce((s, l) => s + (l.dueNowPaise ?? 0), 0);
        if (total > 0) {
          const m = new Map<string, number>();
          for (const l of lines) {
            const k = l.kind === 'addon' ? 'Add-ons' : (l.name ?? 'Other');
            m.set(k, (m.get(k) ?? 0) + (l.dueNowPaise ?? 0) / total);
          }
          return [...m.entries()];
        }
      }
      return [[i.kind === 'addon' ? 'Add-ons' : 'Not linked to a service', 1]];
    };
    const byInvoice = new Map(d.ledger.map((i) => [i.id, i]));
    for (const [invId, v] of revenueIn(d.ledger, d.notes, r)) {
      const i = byInvoice.get(invId)!;
      if (i.clientOrgId) acc(clients, i.clientOrgId, i.clientOrg?.name ?? 'Client').revenue += v;
      for (const [label, f] of split(i)) acc(services, label, label).revenue += v * f;
    }
    for (const i of d.ledger) {
      if (!isBillable(i) || !i.totalPaise) continue;
      const exGst = i.payments.filter((pmt) => inRange(pmt.at, r)).reduce((s, pmt) => s + (pmt.amountPaise * i.subtotalPaise) / i.totalPaise, 0);
      if (!exGst) continue;
      if (i.clientOrgId) acc(clients, i.clientOrgId, i.clientOrg?.name ?? 'Client').collected += exGst;
      for (const [label, f] of split(i)) acc(services, label, label).collected += exGst * f;
    }
    const overhead = 1 + d.overheadPct / 100;
    const roles = new Map<string, { minutes: number; cost: number; rate: number }>();
    // v10 timesheets: task time comes from the tasks as before; hand-entered client time (a client call, say)
    // counts only once that person's week is approved.
    // time_entries.date and timesheets.weekStart are plain date columns: compare on IST calendar days, not instants
    // (an instant is cut to its UTC date, which dropped a week starting on the last day of the period).
    const dateCol = (at: Date) => new Date(`${new Date(at.getTime() + 330 * 60_000).toISOString().slice(0, 10)}T00:00:00Z`);
    const approvedSheets = await this.prisma.timesheet.findMany({
      where: { orgId, status: 'approved', weekStart: { gte: new Date(dateCol(r.start).getTime() - 7 * 86_400_000), lte: dateCol(new Date(r.end.getTime() - 1)) } },
      select: { userId: true, weekStart: true },
    });
    const approvedWeek = new Set(approvedSheets.map((x) => `${x.userId}|${x.weekStart.toISOString().slice(0, 10)}`));
    const weekOf = (day: Date) => new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10);
    const manual = approvedSheets.length
      ? await this.prisma.timeEntry.findMany({
          where: { orgId, source: 'manual', engagementId: { not: null }, userId: { in: [...new Set(approvedSheets.map((x) => x.userId))] }, date: { gte: dateCol(r.start), lte: dateCol(new Date(r.end.getTime() - 1)) } },
          select: { userId: true, date: true, minutes: true, engagementId: true },
        })
      : [];
    const blocks: { timeLoggedMin: number; ownerId: string | null; engagementId: string | null; deliverable: null | { cycle: { engagementId: string } } }[] = [
      ...tasks,
      ...manual.filter((e) => approvedWeek.has(`${e.userId}|${weekOf(e.date)}`)).map((e) => ({ timeLoggedMin: e.minutes, ownerId: e.userId, engagementId: e.engagementId, deliverable: null })),
    ];
    for (const t of blocks) {
      const engId = t.engagementId ?? t.deliverable?.cycle.engagementId ?? null;
      const eng = engId ? d.engById.get(engId) : undefined;
      const who = (t.ownerId && d.rateFor.get(t.ownerId)) || { role: 'default', rate: d.defaultRate };
      const cost = (t.timeLoggedMin / 60) * who.rate * overhead;
      const ro = roles.get(who.role) ?? { minutes: 0, cost: 0, rate: who.rate };
      ro.minutes += t.timeLoggedMin;
      ro.cost += cost;
      roles.set(who.role, ro);
      if (!eng) continue;
      for (const a of [acc(clients, eng.clientOrgId, eng.clientOrg.name), acc(services, eng.service.name, eng.service.name)]) {
        a.minutes += t.timeLoggedMin;
        a.labour += cost;
      }
    }
    for (const po of payouts) {
      const b = po.briefId ? d.ctx.briefs.get(po.briefId) : undefined;
      if (!b) continue;
      const eng = b.engagementId ? d.engById.get(b.engagementId) : undefined;
      const clientId = b.clientOrgId ?? eng?.clientOrgId;
      if (clientId) {
        const known = clients.get(clientId);
        const name = known?.name ?? (eng?.clientOrgId === clientId ? eng.clientOrg.name : null) ?? (await this.prisma.clientOrg.findUnique({ where: { id: clientId }, select: { name: true } }))?.name ?? 'Client';
        acc(clients, clientId, name).creator += po.amountPaise;
      }
      if (eng) acc(services, eng.service.name, eng.service.name).creator += po.amountPaise;
    }
    const row = (a: Acc): SalesProfitRow => {
      const revenue = Math.round(a.revenue);
      const labour = Math.round(a.labour);
      const cost = labour + a.creator;
      const hours = round1(a.minutes / 60);
      return {
        id: a.id,
        name: a.name,
        revenuePaise: revenue,
        collectedPaise: Math.round(a.collected),
        hours,
        labourCostPaise: labour,
        creatorCostPaise: a.creator,
        costPaise: cost,
        marginPaise: revenue - cost,
        marginPct: revenue > 0 ? round1(((revenue - cost) / revenue) * 100) : null,
        hourlyRatePaise: a.minutes > 0 ? Math.round(revenue / (a.minutes / 60)) : null,
      };
    };
    const keep = (a: Acc) => Math.round(a.revenue) !== 0 || a.minutes > 0 || a.creator > 0 || a.collected > 0;
    const clientRows = [...clients.values()].filter(keep).map(row).sort((a, b) => b.revenuePaise - a.revenuePaise);
    const serviceRows = [...services.values()].filter(keep).map(row).sort((a, b) => b.revenuePaise - a.revenuePaise);
    const total = (rows: Acc[]) => rows.reduce((s, a) => ({ ...s, revenue: s.revenue + a.revenue, collected: s.collected + a.collected, minutes: s.minutes + a.minutes, labour: s.labour + a.labour, creator: s.creator + a.creator }), { id: 'total', name: 'All clients', revenue: 0, collected: 0, minutes: 0, labour: 0, creator: 0 });
    const totals = row(total([...clients.values()]));
    const allMinutes = [...roles.values()].reduce((s, x) => s + x.minutes, 0);
    const allCost = [...roles.values()].reduce((s, x) => s + x.cost, 0);
    return {
      clients: clientRows,
      services: serviceRows,
      totals,
      byRole: [...roles.entries()].map(([role, x]) => ({ role, hours: round1(x.minutes / 60), costPaise: Math.round(x.cost), ratePaise: x.rate })).sort((a, b) => b.costPaise - a.costPaise),
      avgCostPerHourPaise: allMinutes ? Math.round(allCost / (allMinutes / 60)) : null,
    };
  }

  // =========================================================================
  // Scorecard

  async scorecard(me: Me, from?: string, to?: string): Promise<SalesScorecardView> {
    assertSalesMoney(me);
    const orgId = me.orgId;
    const p = resolvePeriod(from, to);
    const now = new Date();
    const [forecastSettings, holidays, ledger, notes, engagements, funnel, retention, profit, forecast] = await Promise.all([
      this.settings.get(orgId, 'forecast'),
      this.settings.get(orgId, 'holidays'),
      loadLedger(this.prisma, orgId),
      this.notes(orgId),
      loadEngagements(this.prisma, orgId, now),
      this.buildFunnel(orgId, p, true),
      this.buildRetention(orgId, p),
      this.profitability(me, p.view.from, p.view.to),
      this.forecast(me),
    ]);
    const target = forecastSettings.monthlyTargetPaise;
    const holidayDates = holidays.list.map((h) => h.date);

    // ---- This month vs target, with pace.
    const mStart = startOfMonth(now);
    const mEnd = startOfMonth(now, 1);
    const revenueMonth = revenueTotal(ledger, notes, { start: mStart, end: mEnd });
    let total = 0;
    let elapsed = 0;
    const todayKey = isoDay(now);
    for (let d = new Date(mStart.getTime() + 6 * 3_600_000); d < mEnd; d = new Date(d.getTime() + DAY)) {
      if (!isWorkingDay(d, holidayDates)) continue;
      total++;
      if (isoDay(d) <= todayKey) elapsed++;
    }
    const billedThisMonth = new Set(ledger.filter((i) => isBillable(i) && i.createdAt >= mStart && i.engagementId).map((i) => i.engagementId!));
    const retainersToBill = engagements.filter((e) => e.billingType === 'monthly' && e.live && activeAt(e, now) && !billedThisMonth.has(e.id)).reduce((s, e) => s + e.pricePaise, 0);
    const retainerBilled = ledger.filter((i) => isBillable(i) && i.createdAt >= mStart && (i.kind === 'retainer' || i.engagement?.billingType === 'monthly')).reduce((s, i) => s + i.subtotalPaise, 0);
    const otherSoFar = Math.max(0, revenueMonth - retainerBilled);
    const projected = Math.round(revenueMonth + retainersToBill + (elapsed ? (otherSoFar / elapsed) * Math.max(0, total - elapsed) : 0));

    // ---- KPIs
    const revenue = revenueTotal(ledger, notes, p.cur);
    const prevRevenue = revenueTotal(ledger, notes, p.prev);
    const facts = await loadLeadFacts(this.prisma, orgId);
    const wonIn = (r: Range) => facts.filter((f) => f.wonAt && inRange(f.wonAt, r));
    const avgDeal = (r: Range) => {
      const w = wonIn(r).filter((f) => f.wonValuePaise > 0);
      return w.length ? Math.round(w.reduce((s, f) => s + f.wonValuePaise, 0) / w.length) : null;
    };
    const cycle = (r: Range) => {
      const m = median(wonIn(r).map((f) => (f.wonAt!.getTime() - f.createdAt.getTime()) / DAY));
      return m === null ? null : Math.round(m);
    };
    const collection = (r: Range) => {
      const invoiced = ledger.filter((i) => isBillable(i) && inRange(i.createdAt, r)).reduce((s, i) => s + i.totalPaise, 0);
      const collected = ledger.flatMap((i) => i.payments).filter((x) => inRange(x.at, r)).reduce((s, x) => s + x.amountPaise, 0);
      return { invoiced, collected, rate: invoiced ? round1((collected / invoiced) * 100) : null };
    };
    const outstandingAt = (d: Date) =>
      ledger
        .filter((i) => isBillable(i) && i.status !== 'credit_noted' && i.createdAt < d)
        .reduce((s, i) => s + Math.max(0, i.totalPaise - i.payments.filter((x) => x.at < d).reduce((a, x) => a + x.amountPaise, 0) - i.creditNotes.filter((n) => n.createdAt < d).reduce((a, n) => a + n.totalPaise, 0)), 0);
    const dso = (r: Range) => {
      const c = collection(r);
      const days = (r.end.getTime() - r.start.getTime()) / DAY;
      return c.invoiced ? Math.round((outstandingAt(r.end > now ? now : r.end) / c.invoiced) * days) : null;
    };
    const coll = collection(p.cur);
    const prevColl = collection(p.prev);

    // Lifetime value: average retainer × gross margin ÷ monthly churn (clients lost per client-month, last 12 months).
    let clientMonths = 0;
    const seen = new Set<string>();
    for (let k = -12; k < 0; k++) {
      const m = mrrByClient(engagements, startOfMonth(now, k));
      clientMonths += m.size;
      for (const id of m.keys()) seen.add(id);
    }
    const end12 = mrrByClient(engagements, now);
    const churned12 = [...seen].filter((id) => !end12.has(id)).length;
    const arpa = end12.size ? sumMap(end12) / end12.size : 0;
    const monthlyChurn = clientMonths && churned12 ? churned12 / clientMonths : null;
    const marginPct = profit.totals.marginPct;
    const ltv = monthlyChurn && marginPct !== null && marginPct > 0 && arpa ? Math.round((arpa * (marginPct / 100)) / monthlyChurn) : null;

    const w = retention.waterfall;
    const pw = retention.prevWaterfall;
    const kpis: SalesKpi[] = [
      { key: 'revenue', label: 'Revenue', value: revenue, previous: prevRevenue, unit: 'paise', hint: 'invoiced, before GST', href: '/admin/revenue' },
      { key: 'mrr', label: 'Monthly recurring revenue', value: w.endPaise, previous: w.startPaise, unit: 'paise', hint: `${plural(retention.retainerClients, 'retainer client')}`, href: '/admin/analytics/retention' },
      { key: 'net_new_mrr', label: 'Net new MRR', value: w.endPaise - w.startPaise, previous: pw.endPaise - pw.startPaise, unit: 'paise', hint: 'new + upgrades − losses', href: '/admin/analytics/retention' },
      { key: 'pipeline', label: 'Weighted pipeline', value: forecast.deals.reduce((s, x) => s + x.weightedPaise, 0), previous: null, unit: 'paise', hint: `${plural(forecast.deals.length, 'open deal')}, next 6 months`, href: '/admin/analytics/forecast' },
      { key: 'win_rate', label: 'Win rate', value: funnel.winRatePct, previous: funnel.prevWinRatePct, unit: 'pct', hint: 'of deals decided', href: '/admin/analytics/funnel' },
      { key: 'deal_size', label: 'Average deal size', value: avgDeal(p.cur), previous: avgDeal(p.prev), unit: 'paise', hint: 'accepted proposals, before GST', href: '/admin/analytics/funnel' },
      { key: 'cycle', label: 'Sales cycle', value: cycle(p.cur), previous: cycle(p.prev), unit: 'days', lowerIsBetter: true, hint: 'median, enquiry to acceptance', href: '/admin/analytics/funnel' },
      { key: 'collection', label: 'Collection rate', value: coll.rate, previous: prevColl.rate, unit: 'pct', hint: 'collected ÷ invoiced (incl. GST)', href: '/admin/collections' },
      { key: 'dso', label: 'Days to get paid (DSO)', value: dso(p.cur), previous: dso(p.prev), unit: 'days', lowerIsBetter: true, hint: 'unpaid ÷ invoiced × days', href: '/admin/collections' },
      { key: 'margin', label: 'Gross margin', value: marginPct, previous: profit.prevTotals.marginPct, unit: 'pct', hint: 'after team time and creators', href: '/admin/analytics/profitability' },
      { key: 'clients', label: 'Retainer clients', value: retention.retainerClients, previous: retention.prevRetainerClients, unit: 'count', hint: `${retention.movements.filter((m) => m.kind === 'churn').length} left in this period`, href: '/admin/analytics/retention' },
      { key: 'churn', label: 'Client churn', value: retention.logoChurnPct, previous: retention.prevLogoChurnPct, unit: 'pct', lowerIsBetter: true, hint: 'retainer clients lost', href: '/admin/analytics/retention' },
    ];

    const trendMonths = Array.from({ length: 12 }, (_, k) => startOfMonth(now, k - 11));
    const trend = {
      labels: trendMonths.map((m) => monthLabel(m)),
      revenuePaise: trendMonths.map((m, k) => revenueTotal(ledger, notes, { start: m, end: startOfMonth(now, k - 10) })),
      targetPaise: target,
    };

    const insights: SalesInsight[] = [];
    const onTrack = target > 0 && projected >= target;
    if (target) {
      insights.push({
        tone: onTrack ? 'good' : 'warn',
        text: `${inrShort(revenueMonth)} invoiced so far this month with ${elapsed} of ${total} working days gone. With ${inrShort(retainersToBill)} of retainers still to bill and projects at the current pace, we are on track for ${inrShort(projected)}, ${onTrack ? 'above' : `${inrShort(target - projected)} short of`} the ${inrShort(target)} target.`,
      });
    }
    const hits = trend.revenuePaise.slice(0, 11).filter((v) => target && v >= target).length;
    if (target) insights.push({ tone: hits >= 6 ? 'good' : 'default', text: `We hit the monthly target in ${hits} of the last 11 full months.` });
    if (coll.rate !== null) insights.push({ tone: coll.rate < 80 ? 'warn' : 'default', text: `We collected ${Math.round(coll.rate)}% of what we invoiced in this period${prevColl.rate !== null ? ` (${Math.round(prevColl.rate)}% before)` : ''}.` });
    if (ltv !== null)
      insights.push({ tone: 'default', text: `A retainer client is worth about ${inrShort(ltv)} in margin over their time with us (average retainer ${inrShort(arpa)} a month × ${Math.round(marginPct!)}% margin, with ${round1(monthlyChurn! * 100)}% of clients leaving each month). Acquisition spend is not tracked, so payback time is not shown.` });
    else insights.push({ tone: 'default', text: 'Acquisition spend is not tracked, so payback time is not shown; lifetime value appears once a retainer client has left in the last year.' });

    return {
      period: p.view,
      month: {
        label: monthLabel(mStart, true),
        revenuePaise: revenueMonth,
        targetPaise: target,
        pct: target ? round1((revenueMonth / target) * 100) : null,
        projectedPaise: projected,
        retainersToBillPaise: retainersToBill,
        workingDaysElapsed: elapsed,
        workingDaysTotal: total,
        onTrack,
      },
      kpis,
      trend,
      insights: insights.slice(0, 4),
    };
  }
}

function fmtHours(h: number) {
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} minutes`;
  if (h < 48) return `${Math.round(h)} hour${Math.round(h) === 1 ? '' : 's'}`;
  return `${Math.round(h / 24)} days`;
}
