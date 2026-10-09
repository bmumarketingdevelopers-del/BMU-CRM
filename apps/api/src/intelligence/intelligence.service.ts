// v20 "Forecast & risks": the stored forecasts with their reasons, shaped for the founder dashboard and the
// Intelligence page, filtered by what the viewer may see (money only for money roles).
import { Injectable } from '@nestjs/common';
import type { ForecastReason, ForecastView, IntelligenceOverview, Me } from '@bmu/shared';
import type { Forecast } from '../generated/prisma/client.js';
import { assertCommand, canSeeMoney } from '../insights/access.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AlertsService } from './alerts.service.js';
import { ForecastService } from './forecast.service.js';
import { GoalsService } from './goals.service.js';

let pyCache: { ok: boolean; at: number } | null = null;
async function pythonUp() {
  const base = process.env.FORECAST_URL?.replace(/\/$/, '');
  if (!base) return false;
  if (pyCache && Date.now() - pyCache.at < 60_000) return pyCache.ok;
  const ok = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.ok)
    .catch(() => false);
  pyCache = { ok, at: Date.now() };
  return ok;
}

const monthLabel = (ym: string) => new Intl.DateTimeFormat('en-IN', { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${ym}-01T00:00:00Z`));

@Injectable()
export class IntelligenceService {
  private computing = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly forecasts: ForecastService,
    private readonly alerts: AlertsService,
    private readonly goals: GoalsService,
  ) {}

  /** Recompute now (one run per organisation at a time). */
  async refresh(orgId: string) {
    const running = this.computing.get(orgId);
    if (running) return running as Promise<Record<string, number>>;
    const p = this.forecasts.refresh(orgId).finally(() => this.computing.delete(orgId));
    this.computing.set(orgId, p);
    return p;
  }

  async overview(me: Me): Promise<IntelligenceOverview> {
    assertCommand(me);
    const money = canSeeMoney(me);
    let rows = await this.prisma.forecast.findMany({ where: { orgId: me.orgId } });
    if (!rows.length) {
      await this.refresh(me.orgId);
      rows = await this.prisma.forecast.findMany({ where: { orgId: me.orgId } });
    }
    const of = (k: string) => rows.filter((r) => r.kind === k);
    const [clients, leads, tasks] = await Promise.all([
      this.prisma.clientOrg.findMany({ where: { id: { in: of('churn').map((r) => r.subjectId) } }, select: { id: true, name: true } }),
      this.prisma.lead.findMany({ where: { id: { in: of('win').map((r) => r.subjectId) } }, select: { id: true, contact: true } }),
      this.prisma.task.findMany({ where: { id: { in: of('slip').map((r) => r.subjectId) } }, select: { id: true, title: true, owner: { select: { name: true } }, deadline: true } }),
    ]);
    const view = (r: Forecast, title: string, href: string | null, hideMoney = false): ForecastView => ({
      kind: r.kind as ForecastView['kind'],
      subjectType: r.subjectType,
      subjectId: r.subjectId,
      title,
      href,
      period: r.period,
      value: hideMoney ? 0 : r.value,
      score: r.score,
      reasons: (r.reasons as ForecastReason[]).filter((x) => !hideMoney || !/₹|Rs|recurring revenue|Deal value/i.test(x.label)),
      source: r.source as 'ts' | 'python',
      computedAt: r.computedAt.toISOString(),
    });
    const top = <T extends ForecastView>(xs: T[], n: number) => xs.sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, n);

    let revenue: IntelligenceOverview['revenue'] = null;
    const rev = of('revenue').sort((a, b) => a.period.localeCompare(b.period));
    if (money && rev.length) {
      const meta = (r: Forecast) => (r.meta ?? {}) as { lowPaise?: number; highPaise?: number; trendPaise?: number; label?: string; targetPaise?: number };
      revenue = {
        months: rev.map((r) => ({ period: r.period, label: meta(r).label ?? monthLabel(r.period), expectedPaise: r.value, lowPaise: meta(r).lowPaise ?? r.value, highPaise: meta(r).highPaise ?? r.value, trendPaise: meta(r).trendPaise ?? r.value })),
        reasons: rev[0].reasons as ForecastReason[],
        nextMonthPaise: rev[0].value,
        targetPaise: meta(rev[0]).targetPaise ?? 0,
      };
    }
    const leadName = (id: string) => {
      const c = (leads.find((l) => l.id === id)?.contact ?? {}) as { company?: string; name?: string };
      return c.company || c.name || 'Lead';
    };
    const computed = rows.map((r) => r.computedAt.getTime()).sort((a, b) => b - a)[0];
    const goals = (await this.goals.list(me)).goals.filter((g) => g.level === 'company').slice(0, 6);
    return {
      computedAt: computed ? new Date(computed).toISOString() : null,
      source: rows.some((r) => r.source === 'python') ? 'python' : rows.length ? 'ts' : null,
      pythonAvailable: await pythonUp(),
      revenue,
      churn: top(
        of('churn')
          .filter((r) => (r.score ?? 0) >= 15)
          .map((r) => view(r, clients.find((c) => c.id === r.subjectId)?.name ?? 'Client', `/team/clients/${r.subjectId}`, !money)),
        8,
      ),
      win: of('win')
        .map((r) => view(r, leadName(r.subjectId), `/team/leads/${r.subjectId}`, !money))
        .sort((a, b) => b.value - a.value || (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 8),
      slip: top(
        of('slip').map((r) => {
          const t = tasks.find((x) => x.id === r.subjectId);
          return view(r, t ? `${t.title}${t.owner ? ` · ${t.owner.name}` : ''}` : 'Task', `/team/tasks/${r.subjectId}`);
        }),
        10,
      ),
      capacity: top(
        of('capacity').map((r) => view(r, r.subjectId.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), '/admin/capacity')),
        12,
      ),
      alerts: await this.alerts.visibleEvents(me, 8),
      goals,
    };
  }
}
