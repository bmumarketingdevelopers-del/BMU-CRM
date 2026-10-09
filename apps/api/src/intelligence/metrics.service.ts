// v20 metric layer (API side): computes any metric from packages/shared/src/metrics for a period, for the whole
// organisation or one client, with the previous period for comparison. Report Builder metrics reuse its engine so
// a number here always matches Analytics → Explore.
import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { canSeeMetric, formatMetric, metricDef, METRICS, pctChange, type Me, type MetricDef, type MetricValueView } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { LIVE, loadEngagements } from '../analytics/sales-data.js';
import { canReadCommand, canSeeMoney } from '../insights/access.js';
import { OpsExploreService } from '../ops-analytics/explore.service.js';
import { CapacityService } from '../money/capacity.service.js';
import { ProfitService } from '../money/profit.service.js';
import { addDays, DAY, mondayOf, todayIst } from '../money/dates.js';
import { FieldAccessService } from '../security/field-access.service.js';

const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const IST = 330 * 60_000;
/** IST midnight at the start of an ISO day. */
const istStart = (iso: string) => new Date(new Date(`${iso}T00:00:00Z`).getTime() - IST);
const round1 = (n: number) => Math.round(n * 10) / 10;
const ratio = (num: number, den: number) => (den ? round1((num / den) * 100) : null);

export type Period = { from: string; to: string };
export type Pair = { value: number | null; previous: number | null };

/** The window ending today: `days` long, plus the same length before it. */
export function windowOf(days: number, now = new Date()): Period {
  const to = todayIst(now);
  return { from: addDays(to, -(days - 1)), to };
}
const prevOf = (p: Period): Period => {
  const len = Math.round((istStart(p.to).getTime() - istStart(p.from).getTime()) / DAY) + 1;
  return { from: addDays(p.from, -len), to: addDays(p.from, -1) };
};

@Injectable()
export class MetricsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ref: ModuleRef,
  ) {}

  private get<T>(cls: new (...args: never[]) => T): T {
    return this.ref.get(cls as never, { strict: false }) as T;
  }

  /** Metrics this person may see (money metrics need money access; margins follow field-level permissions). */
  async visible(me: Me): Promise<MetricDef[]> {
    const access = { command: canReadCommand(me), money: canSeeMoney(me) };
    const fc = await this.get(FieldAccessService).context(me);
    return METRICS.filter((m) => canSeeMetric(m, access) && !(m.key === 'profit_margin_pct' && fc.modes['finance.margins'] === 'hidden'));
  }

  async assertCanSee(me: Me, key: string): Promise<MetricDef> {
    const def = metricDef(key);
    if (!def) throw new BadRequestException('Unknown metric');
    if (!(await this.visible(me)).some((m) => m.key === key)) throw new ForbiddenException(`${def.label} is not shown to your role`);
    return def;
  }

  async view(me: Me, key: string, period: Period, clientOrgId?: string | null): Promise<MetricValueView> {
    const def = await this.assertCanSee(me, key);
    const v = await this.pair(me, def, period, clientOrgId ?? null);
    return { key, label: def.label, unit: def.unit, direction: def.direction, formula: def.formula, value: v.value, previous: v.previous, changePct: pctChange(v.value, v.previous), display: formatMetric(v.value, def.unit), from: period.from, to: period.to };
  }

  /** This period and the one before. Snapshot metrics (MRR, overdue tasks) have no "previous" unless stored. */
  async pair(actor: Me, def: MetricDef, period: Period, clientOrgId: string | null): Promise<Pair> {
    if (def.explore) {
      const ex = this.get(OpsExploreService);
      if (clientOrgId) {
        const [cur, prev] = await Promise.all([period, prevOf(period)].map((p) => ex.explore(actor, { metric: def.explore, dimension: 'client', from: p.from, to: p.to })));
        const pick = (r: typeof cur) => r.rows.find((x) => x.key === clientOrgId)?.value ?? 0;
        return { value: pick(cur), previous: pick(prev) };
      }
      const r = await ex.explore(actor, { metric: def.explore, dimension: 'month', from: period.from, to: period.to });
      return { value: r.total, previous: r.prevTotal };
    }
    const orgId = actor.orgId;
    switch (def.key) {
      case 'mrr':
        return { value: await this.mrr(orgId, clientOrgId), previous: null };
      case 'pipeline_value': {
        const f = await this.get(AnalyticsService).forecast(actor);
        return { value: f.deals.reduce((s, d) => s + d.weightedPaise, 0), previous: null };
      }
      case 'active_clients':
        return { value: await this.prisma.clientOrg.count({ where: { orgId, deletedAt: null, engagements: { some: { deletedAt: null, status: { in: [...LIVE, 'awaiting_final_payment'] as never } } } } }), previous: null };
      case 'overdue_tasks':
        return { value: await this.prisma.task.count({ where: { orgId, archivedAt: null, isDraft: false, status: { in: [...OPEN_TASK] }, deadline: { lt: new Date() }, ...(clientOrgId ? { engagement: { clientOrgId } } : {}) } }), previous: null };
      case 'win_rate':
        return this.both(period, (p) => this.winRate(orgId, p));
      case 'on_time_pct':
        return this.both(period, (p) => this.onTime(orgId, p, clientOrgId));
      case 'utilisation_pct':
        return this.both(period, (p) => this.utilisation(orgId, p));
      case 'profit_margin_pct':
        return this.both(period, async (p) => (await this.get(ProfitService).compute(orgId, p.from, p.to)).totals.marginPct);
      case 'client_activity':
        return this.both(period, async (p) => (clientOrgId ? ((await this.clientActivity(orgId, p)).get(clientOrgId) ?? 0) : [...(await this.clientActivity(orgId, p)).values()].reduce((s, n) => s + n, 0)));
    }
    throw new BadRequestException('Unknown metric');
  }

  /** Per-client values for a client-scoped metric (used by "any client" alerts). */
  async perClient(actor: Me, def: MetricDef, period: Period): Promise<Map<string, Pair>> {
    const out = new Map<string, Pair>();
    if (def.explore) {
      const ex = this.get(OpsExploreService);
      const [cur, prev] = await Promise.all([period, prevOf(period)].map((p) => ex.explore(actor, { metric: def.explore, dimension: 'client', from: p.from, to: p.to })));
      for (const r of cur.rows) if (r.key !== '_none') out.set(r.key, { value: r.value, previous: 0 });
      for (const r of prev.rows) if (r.key !== '_none') out.set(r.key, { value: out.get(r.key)?.value ?? 0, previous: r.value });
      return out;
    }
    if (def.key === 'client_activity') {
      const [cur, prev] = await Promise.all([this.clientActivity(actor.orgId, period), this.clientActivity(actor.orgId, prevOf(period))]);
      for (const id of new Set([...cur.keys(), ...prev.keys()])) out.set(id, { value: cur.get(id) ?? 0, previous: prev.get(id) ?? 0 });
      return out;
    }
    const clients = await this.prisma.clientOrg.findMany({ where: { orgId: actor.orgId, deletedAt: null, archivedAt: null }, select: { id: true } });
    for (const c of clients) out.set(c.id, await this.pair(actor, def, period, c.id));
    return out;
  }

  private async both(period: Period, f: (p: Period) => Promise<number | null>): Promise<Pair> {
    const [value, previous] = await Promise.all([f(period), f(prevOf(period))]);
    return { value, previous };
  }

  async mrr(orgId: string, clientOrgId: string | null = null): Promise<number> {
    // Same prices the Revenue dashboard uses (accepted proposal line, else the price-book tier).
    const all = await loadEngagements(this.prisma, orgId);
    return all.filter((e) => e.billingType === 'monthly' && e.live && !e.end && (!clientOrgId || e.clientId === clientOrgId)).reduce((s, e) => s + e.pricePaise, 0);
  }

  private async winRate(orgId: string, p: Period) {
    const where = { orgId, deletedAt: null, updatedAt: { gte: istStart(p.from), lt: istStart(addDays(p.to, 1)) } };
    const [won, lost] = await Promise.all([this.prisma.lead.count({ where: { ...where, stage: 'won' } }), this.prisma.lead.count({ where: { ...where, stage: 'lost' } })]);
    return ratio(won, won + lost);
  }

  private async onTime(orgId: string, p: Period, clientOrgId: string | null) {
    const rows = await this.prisma.task.findMany({
      where: { orgId, status: 'done', deadline: { not: null }, completedAt: { gte: istStart(p.from), lt: istStart(addDays(p.to, 1)) }, ...(clientOrgId ? { engagement: { clientOrgId } } : {}) },
      select: { deadline: true, completedAt: true },
    });
    return ratio(rows.filter((t) => t.completedAt! <= t.deadline!).length, rows.length);
  }

  private async utilisation(orgId: string, p: Period) {
    const staff = await this.prisma.user.findMany({ where: { orgId, type: 'staff', deletedAt: null, status: 'active' }, select: { id: true } });
    if (!staff.length) return null;
    const weeks: string[] = [];
    for (let w = mondayOf(p.from); w <= p.to; w = addDays(w, 7)) weeks.push(w);
    const loads = await this.get(CapacityService).loads(orgId, staff.map((s) => s.id), weeks);
    let available = 0;
    for (const cells of loads.values()) for (const c of cells) available += c.availableHours;
    const logged = await this.prisma.timeEntry.aggregate({ where: { orgId, date: { gte: new Date(`${p.from}T00:00:00Z`), lte: new Date(`${p.to}T00:00:00Z`) } }, _sum: { minutes: true } });
    return ratio((logged._sum.minutes ?? 0) / 60, available);
  }

  /** Requests raised, approvals given and messages written by each client's own people. */
  async clientActivity(orgId: string, p: Period): Promise<Map<string, number>> {
    const range = { gte: istStart(p.from), lt: istStart(addDays(p.to, 1)) };
    const people = await this.prisma.clientUser.findMany({ where: { orgId }, select: { userId: true, clientOrgId: true } });
    const clientOf = new Map(people.map((u) => [u.userId, u.clientOrgId]));
    const ids = [...clientOf.keys()];
    const [requests, approvals, messages] = await Promise.all([
      this.prisma.request.findMany({ where: { orgId, createdAt: range, createdById: { in: ids } }, select: { createdById: true } }),
      this.prisma.approval.findMany({ where: { orgId, at: range, userId: { in: ids } }, select: { userId: true } }),
      this.prisma.message.findMany({ where: { orgId, createdAt: range, authorId: { in: ids } }, select: { authorId: true } }),
    ]);
    const out = new Map<string, number>();
    const bump = (uid: string | null) => {
      const c = uid ? clientOf.get(uid) : undefined;
      if (c) out.set(c, (out.get(c) ?? 0) + 1);
    };
    requests.forEach((r) => bump(r.createdById));
    approvals.forEach((a) => bump(a.userId));
    messages.forEach((m) => bump(m.authorId));
    return out;
  }
}
