// v20 forecasts with reasons: revenue (next three months), client churn risk, deal win probability, task slip risk
// and capacity shortfall per skill. Computed in TypeScript; when FORECAST_URL points at the optional Python service
// (services/forecast) the revenue and churn models run there instead, with the TypeScript rules as the fallback.
// Results are stored in the forecasts table, refreshed nightly and on demand.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { churnRisk, formatINR, holtForecast, leadStageLabels, slipRisk, winProbability, type ChurnSignals, type ForecastReason, type ForecastView, type Me } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeService } from '../auth/me.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { InsightsService } from '../insights/insights.service.js';
import { CapacityService } from '../money/capacity.service.js';
import { addDays, DAY, mondayOf, todayIst } from '../money/dates.js';
import { MetricsService, windowOf } from './metrics.service.js';
import { systemActor } from './actor.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

type Row = { kind: ForecastView['kind']; subjectType: string; subjectId: string; period?: string; value: number; score?: number | null; reasons: ForecastReason[]; source?: 'ts' | 'python'; meta?: Record<string, unknown> };
const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const short = (paise: number) => formatINR(paise).replace(/\.00$/, '');

/** Calls the optional Python forecasting service; null when it is not configured or not reachable. */
export async function callPython<T>(path: string, body: unknown): Promise<T | null> {
  const base = process.env.FORECAST_URL?.replace(/\/$/, '');
  if (!base) return null;
  try {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

@Injectable()
export class ForecastService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Forecasts');
  private job?: JobHandle;
  private lastRunDay = '';

  constructor(
    private readonly prisma: PrismaService,
    private readonly meService: MeService,
    private readonly metrics: MetricsService,
    private readonly ref: ModuleRef,
  ) {}

  private get<T>(cls: new (...args: never[]) => T): T {
    return this.ref.get(cls as never, { strict: false }) as T;
  }

  onModuleInit() {
    this.job = startJob({ name: 'intelligence.forecast', hint: 'Nightly revenue forecast and churn risk (after 01:00 IST)', everyMs: 30 * 60_000, run: () => this.nightly() });
    // Nightly after 01:00 IST (checked every 30 minutes), and once shortly after start-up if nothing is stored yet.
    if (this.job) setTimeout(() => void this.nightly(true).catch((e: Error) => this.log.error(e.message)), 20_000).unref?.();
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  private async nightly(startup = false) {
    const day = todayIst();
    const hourIst = new Date(Date.now() + 330 * 60_000).getUTCHours();
    const orgs = await this.prisma.organisation.findMany({ select: { id: true } });
    for (const o of orgs) {
      if (startup) {
        if (await this.prisma.forecast.count({ where: { orgId: o.id } })) continue;
      } else if (this.lastRunDay === day || hourIst < 1) continue;
      await this.refresh(o.id);
    }
    if (!startup && hourIst >= 1) this.lastRunDay = day;
  }

  /** Recomputes every forecast for the organisation. Returns how many rows were written per kind. */
  async refresh(orgId: string): Promise<Record<string, number>> {
    const actor = await systemActor(this.prisma, this.meService, orgId);
    if (!actor) return {};
    const out: Record<string, number> = {};
    const steps: [ForecastView['kind'], () => Promise<Row[]>][] = [
      ['revenue', () => this.revenue(actor)],
      ['churn', () => this.churn(actor)],
      ['win', () => this.win(actor)],
      ['slip', () => this.slip(orgId)],
      ['capacity', () => this.capacity(orgId)],
    ];
    for (const [kind, run] of steps) {
      try {
        const rows = await run();
        await this.store(orgId, kind, rows);
        out[kind] = rows.length;
      } catch (e) {
        this.log.error(`${kind} forecast failed: ${(e as Error).message}`);
        out[kind] = -1;
      }
    }
    return out;
  }

  private async store(orgId: string, kind: string, rows: Row[]) {
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.forecast.deleteMany({ where: { orgId, kind } }),
      this.prisma.forecast.createMany({
        data: rows.map((r) => ({ orgId, kind, subjectType: r.subjectType, subjectId: r.subjectId, period: r.period ?? '', value: r.value, score: r.score ?? null, reasons: r.reasons as never, meta: (r.meta ?? undefined) as never, source: r.source ?? 'ts', computedAt: now })),
        skipDuplicates: true,
      }),
    ]);
  }

  // ---------------------------------------------------------------------------------------------- revenue

  /** Next three months: the sales forecast (retainers + weighted pipeline) blended with the trend of past revenue. */
  async revenue(actor: Me): Promise<Row[]> {
    const f = await this.get(AnalyticsService).forecast(actor);
    const past = f.months.filter((m) => !m.future && m.actualPaise !== null).map((m) => m.actualPaise!);
    const future = f.months.filter((m) => m.future).slice(0, 3);
    const committed = future.map((m) => m.committedPaise ?? 0);
    const pipeline = future.map((m) => m.expectedPaise ?? 0);
    type Py = { expected: number[]; low: number[]; high: number[]; method: string };
    const py = await callPython<Py>('/revenue', { history: past, committed, pipeline, horizon: future.length });
    const trend = holtForecast(past, future.length);
    const retainers = f.retainers.length;
    const deals = f.deals.length;
    return future.map((m, i) => {
      const blended = pipeline[i] > 0 ? Math.round(0.7 * pipeline[i] + 0.3 * trend[i]) : Math.round(trend[i]);
      const expected = py ? Math.round(py.expected[i]) : Math.max(committed[i], blended);
      const low = py ? Math.round(py.low[i]) : Math.min(expected, m.worstPaise ?? committed[i]);
      const high = py ? Math.round(py.high[i]) : Math.max(expected, m.bestPaise ?? expected);
      const reasons: ForecastReason[] = [
        { label: `Live retainers: ${short(committed[i])} a month from ${retainers} client${retainers === 1 ? '' : 's'}`, impact: committed[i] },
        { label: `Open deals: ${short(Math.max(0, (m.weightedPaise ?? 0)))} weighted by stage (${deals} deal${deals === 1 ? '' : 's'})`, impact: m.weightedPaise ?? 0 },
      ];
      if (past.length >= 3) {
        const last = past[past.length - 1] || 1;
        const pct = Math.round(((trend[i] - last) / last) * 100);
        reasons.push({ label: `Trend of the last ${past.length} months points to ${short(Math.round(trend[i]))} (${pct >= 0 ? '+' : ''}${pct}%)`, impact: Math.round(trend[i]) });
      }
      if (f.atRiskMrrPaise > 0) reasons.push({ label: `${short(f.atRiskMrrPaise)} a month is at risk (overdue invoices or blocked work)`, impact: -f.atRiskMrrPaise });
      if (py) reasons.push({ label: `Modelled by the forecasting service (${py.method})`, impact: 0 });
      return { kind: 'revenue', subjectType: 'org', subjectId: actor.orgId, period: m.month, value: expected, score: null, reasons, source: py ? 'python' : 'ts', meta: { lowPaise: low, highPaise: high, trendPaise: Math.round(trend[i]), label: m.label, targetPaise: f.targetPaise } } as Row;
    });
  }

  // ---------------------------------------------------------------------------------------------- churn

  async churn(actor: Me): Promise<Row[]> {
    const orgId = actor.orgId;
    const now = new Date();
    const [health, clients, engagements, renewals, cur, prev, mrrTotal] = await Promise.all([
      this.get(InsightsService).clientHealth(actor),
      this.prisma.clientOrg.findMany({ where: { orgId, deletedAt: null, archivedAt: null }, select: { id: true, name: true, tenureStart: true, createdAt: true } }),
      this.prisma.engagement.findMany({ where: { orgId, deletedAt: null, status: { notIn: ['closed', 'pending_payment'] } }, select: { clientOrgId: true, billingType: true, endDate: true } }),
      this.prisma.proposal.findMany({ where: { orgId, kind: 'renewal', deletedAt: null, status: { notIn: ['rejected', 'expired'] as never } }, select: { renewalClientOrgId: true } }),
      this.metrics.clientActivity(orgId, windowOf(30)),
      this.metrics.clientActivity(orgId, { from: addDays(windowOf(30).from, -30), to: addDays(windowOf(30).from, -1) }),
      this.metrics.mrr(orgId),
    ]);
    const renewing = new Set(renewals.map((r) => r.renewalClientOrgId));
    const active = new Set(engagements.map((e) => e.clientOrgId));
    const mrrBy = new Map<string, number>();
    for (const c of clients) if (active.has(c.id)) mrrBy.set(c.id, await this.metrics.mrr(orgId, c.id));
    const signals = clients
      .filter((c) => active.has(c.id))
      .map((c) => {
        const h = health.find((x) => x.id === c.id);
        const ends = engagements.filter((e) => e.clientOrgId === c.id && e.billingType === 'monthly' && e.endDate && e.endDate > now).map((e) => e.endDate!.getTime());
        const endsInDays = ends.length && !renewing.has(c.id) ? Math.ceil((Math.max(...ends) - now.getTime()) / DAY) : null;
        const a = cur.get(c.id) ?? 0;
        const b = prev.get(c.id) ?? 0;
        const s: ChurnSignals = {
          healthScore: h?.score ?? 100,
          healthReasons: h?.reasons ?? [],
          endsInDays,
          activityChangePct: b >= 3 ? Math.round(((a - b) / b) * 100) : null,
          tenureDays: Math.floor((now.getTime() - (c.tenureStart ?? c.createdAt).getTime()) / DAY),
          mrrSharePct: mrrTotal ? Math.round(((mrrBy.get(c.id) ?? 0) / mrrTotal) * 100) : 0,
        };
        return { id: c.id, name: c.name, s };
      });
    type Py = { results: { id: string; score: number; reasons: ForecastReason[] }[]; method: string };
    const py = await callPython<Py>('/churn', { clients: signals.map((x) => ({ id: x.id, ...x.s })) });
    return signals.map((x) => {
      const r = py?.results.find((p) => p.id === x.id) ?? churnRisk(x.s);
      const mrr = mrrBy.get(x.id) ?? 0;
      const reasons = [...r.reasons];
      if (mrr) reasons.push({ label: `Pays ${short(mrr)} a month (${x.s.mrrSharePct}% of recurring revenue)`, impact: 0 });
      // value = monthly revenue at risk.
      return { kind: 'churn', subjectType: 'client', subjectId: x.id, value: Math.round((mrr * r.score) / 100), score: r.score, reasons, source: py ? 'python' : 'ts' };
    });
  }

  // ---------------------------------------------------------------------------------------------- deals

  async win(actor: Me): Promise<Row[]> {
    const f = await this.get(AnalyticsService).forecast(actor);
    if (!f.deals.length) return [];
    const now = Date.now();
    const leads = await this.prisma.lead.findMany({ where: { id: { in: f.deals.map((d) => d.leadId) } }, select: { id: true, score: true, lastActivityAt: true, createdAt: true, nextFollowUpAt: true, proposals: { select: { viewCount: true }, orderBy: { createdAt: 'desc' }, take: 1 } } });
    return f.deals.map((d) => {
      const l = leads.find((x) => x.id === d.leadId);
      const r = winProbability({
        stageProbabilityPct: d.probabilityPct,
        stageLabel: leadStageLabels[d.stage as keyof typeof leadStageLabels] ?? d.stageLabel,
        leadScore: l?.score ?? 0,
        daysSinceActivity: Math.floor((now - (l?.lastActivityAt ?? l?.createdAt ?? new Date()).getTime()) / DAY),
        proposalViews: l?.proposals[0]?.viewCount ?? 0,
        followUpOverdue: !!l?.nextFollowUpAt && l.nextFollowUpAt.getTime() < now,
        ageDays: Math.floor((now - (l?.createdAt ?? new Date()).getTime()) / DAY),
      });
      return { kind: 'win', subjectType: 'lead', subjectId: d.leadId, value: Math.round((d.valuePaise * r.score) / 100), score: r.score, reasons: [...r.reasons, { label: `Deal value ${short(d.valuePaise)} (${d.basis === 'proposal' ? 'from the proposal' : 'from the budget'})`, impact: 0 }] };
    });
  }

  // ---------------------------------------------------------------------------------------------- tasks

  async slip(orgId: string): Promise<Row[]> {
    const now = new Date();
    const tasks = await this.prisma.task.findMany({
      where: { orgId, archivedAt: null, isDraft: false, status: { in: [...OPEN_TASK] }, deadline: { not: null, lt: new Date(now.getTime() + 14 * DAY) } },
      select: { id: true, ownerId: true, deadline: true, status: true, startedAt: true, estimateMin: true, deadlineChanges: true, dependsOn: true },
      orderBy: { deadline: 'asc' },
      take: 500,
    });
    const deps = [...new Set(tasks.flatMap((t) => t.dependsOn))];
    const openDeps = new Set((await this.prisma.task.findMany({ where: { id: { in: deps }, status: { in: [...OPEN_TASK] } }, select: { id: true } })).map((t) => t.id));
    const owners = [...new Set(tasks.map((t) => t.ownerId).filter((x): x is string => !!x))];
    const week = mondayOf(todayIst());
    const loads = owners.length ? await this.get(CapacityService).loads(orgId, owners, [week]) : new Map();
    return tasks
      .map((t) => {
        const calendarHours = (t.deadline!.getTime() - now.getTime()) / 3_600_000;
        // About 9 working hours in each 24.
        const hoursLeft = calendarHours < 0 ? calendarHours : calendarHours * (9 / 24);
        const r = slipRisk({
          hoursLeft,
          estimateHours: (t.estimateMin ?? 0) / 60,
          status: t.status,
          started: !!t.startedAt || t.status !== 'todo',
          ownerLoadPct: t.ownerId ? (loads.get(t.ownerId)?.[0]?.loadPct ?? null) : null,
          hasOwner: !!t.ownerId,
          deadlineChanges: t.deadlineChanges,
          openDependencies: t.dependsOn.filter((d) => openDeps.has(d)).length,
        });
        return { kind: 'slip' as const, subjectType: 'task', subjectId: t.id, value: Math.round(hoursLeft), score: r.score, reasons: r.reasons };
      })
      .filter((r) => r.score >= 30);
  }

  // ---------------------------------------------------------------------------------------------- capacity

  /** Next two weeks, per skill: hours of work due (tasks and bookings) against hours people have. */
  async capacity(orgId: string): Promise<Row[]> {
    const week = mondayOf(todayIst());
    const weeks = [week, addDays(week, 7)];
    const staff = await this.prisma.user.findMany({ where: { orgId, type: 'staff', deletedAt: null, status: 'active', specialty: { not: null } }, select: { id: true, specialty: true } });
    if (!staff.length) return [];
    const loads = await this.get(CapacityService).loads(orgId, staff.map((s) => s.id), weeks);
    const end = new Date(new Date(`${addDays(week, 14)}T00:00:00Z`).getTime() - 330 * 60_000);
    const unassigned = await this.prisma.task.findMany({ where: { orgId, ownerId: null, archivedAt: null, isDraft: false, status: { in: [...OPEN_TASK] }, specialty: { not: null }, deadline: { lt: end } }, select: { specialty: true, estimateMin: true } });
    const bySkill = new Map<string, { people: number; available: number; demand: number; leave: number; unassigned: number; unassignedHours: number }>();
    for (const s of staff) {
      const k = s.specialty!;
      const g = bySkill.get(k) ?? { people: 0, available: 0, demand: 0, leave: 0, unassigned: 0, unassignedHours: 0 };
      g.people++;
      for (const c of loads.get(s.id) ?? []) {
        g.available += c.availableHours;
        g.demand += c.bookedHours + c.taskHours;
        g.leave += c.leaveDays;
      }
      bySkill.set(k, g);
    }
    for (const t of unassigned) {
      const g = bySkill.get(t.specialty!);
      if (!g) continue;
      g.unassigned++;
      g.unassignedHours += (t.estimateMin ?? 120) / 60;
    }
    return [...bySkill.entries()].map(([skill, g]) => {
      const demand = Math.round(g.demand + g.unassignedHours);
      const available = Math.round(g.available);
      const reasons: ForecastReason[] = [{ label: `${demand} h of work due in the next two weeks against ${available} h available (${g.people} ${g.people === 1 ? 'person' : 'people'})`, impact: demand - available }];
      if (g.unassigned) reasons.push({ label: `${g.unassigned} task${g.unassigned === 1 ? '' : 's'} with nobody assigned yet (${Math.round(g.unassignedHours)} h)`, impact: Math.round(g.unassignedHours) });
      if (g.leave) reasons.push({ label: `${g.leave} day${g.leave === 1 ? '' : 's'} of approved leave`, impact: 0 });
      return { kind: 'capacity' as const, subjectType: 'specialty', subjectId: skill, value: demand - available, score: available ? Math.min(999, Math.round((demand / available) * 100)) : demand ? 999 : 0, reasons };
    });
  }
}
