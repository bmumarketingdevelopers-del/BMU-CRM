import { Injectable } from '@nestjs/common';
import { deliverableStatusLabels, type DeliverableStatus, type Me, type OpsDeliveryView, type OpsGateStep, type OpsInsight, type OpsWipRow } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import {
  DAY,
  DONE_DELIVERABLE,
  assertOpsReader,
  avg,
  bucketOf,
  buckets,
  cmp,
  fmtPct,
  inRange,
  insight,
  median,
  outRange,
  parseRange,
  pct,
  plural,
  trendWords,
  workDays,
} from './common.js';

const STEPS: { key: string; label: string; detail: string }[] = [
  { key: 'G1', label: 'G1 Requirements', detail: 'Signed up → all requirements received' },
  { key: 'G2', label: 'G2 Plan approved', detail: 'Requirements received → client approves the plan' },
  { key: 'G3', label: 'G3 Work started', detail: 'Plan approved → first task started' },
  { key: 'G4', label: 'G4 All approved', detail: 'Work started → client approves every deliverable' },
  { key: 'G5', label: 'G5 Final sign-off', detail: 'Everything approved → final sign-off' },
];

const typeLabel = (t: string) => t.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

@Injectable()
export class OpsDeliveryService {
  constructor(private readonly prisma: PrismaService) {}

  async delivery(me: Me, q: { from?: string; to?: string }): Promise<OpsDeliveryView> {
    assertOpsReader(me);
    const r = parseRange(q.from, q.to);
    const orgId = me.orgId;
    const now = new Date();
    const [cal, engagements, approvals, qc] = await Promise.all([
      calendarFor(this.prisma, orgId),
      this.prisma.engagement.findMany({
        where: { orgId, deletedAt: null, createdAt: { lt: r.to } },
        select: {
          id: true,
          createdAt: true,
          status: true,
          clientOrg: { select: { id: true, name: true } },
          cycles: {
            select: {
              id: true,
              rcdAt: true,
              plans: { select: { id: true, approvedAt: true } },
              deliverables: {
                select: {
                  id: true,
                  type: true,
                  title: true,
                  status: true,
                  dueAt: true,
                  revisionRoundsUsed: true,
                  approvedVersionId: true,
                  versions: { select: { id: true, number: true, createdAt: true, sentToClientAt: true, qcResults: { select: { createdAt: true } } }, orderBy: { number: 'asc' } },
                  tasks: { select: { status: true, startedAt: true, createdAt: true, updatedAt: true, sort: true, kind: true, owner: { select: { name: true } } }, orderBy: { sort: 'asc' } },
                },
              },
            },
          },
        },
      }),
      this.prisma.approval.findMany({ where: { orgId, gate: { in: ['G1', 'G2', 'G4', 'G5'] } }, select: { targetType: true, targetId: true, gate: true, at: true }, orderBy: { at: 'asc' } }),
      this.prisma.qCResult.findMany({ where: { orgId, createdAt: { gte: r.prevFrom, lt: r.to } }, select: { result: true, createdAt: true } }),
    ]);
    const firstApproval = new Map<string, Date>();
    for (const a of approvals) {
      const k = `${a.targetType}:${a.targetId}:${a.gate}`;
      if (!firstApproval.has(k)) firstApproval.set(k, a.at);
    }

    // Gate timings: one measurement per step, counted in the period its step ended.
    const measures: Record<string, { end: Date; days: number }[]> = Object.fromEntries(STEPS.map((s) => [s.key, []]));
    const add = (key: string, start: Date | null | undefined, end: Date | null | undefined) => {
      if (start && end && end >= start) measures[key].push({ end, days: workDays(start, end, cal) });
    };

    type Deliv = (typeof engagements)[number]['cycles'][number]['deliverables'][number] & { client: { id: string; name: string } };
    const delivs: (Deliv & { approvedAt: Date | null; live: boolean })[] = [];
    const approvedAtOf = (d: Deliv) => {
      const a = firstApproval.get(`deliverable:${d.id}:G4`);
      if (a) return a;
      if (!DONE_DELIVERABLE.includes(d.status)) return null;
      const v = d.versions.find((x) => x.id === d.approvedVersionId) ?? d.versions.at(-1);
      return v ? (v.sentToClientAt ?? v.createdAt) : null;
    };

    for (const e of engagements) {
      const cycles = [...e.cycles].sort((a, b) => (a.rcdAt?.getTime() ?? Infinity) - (b.rcdAt?.getTime() ?? Infinity));
      let lastG4: Date | null = null;
      cycles.forEach((c, i) => {
        const ds = c.deliverables.map((d) => ({ ...d, client: e.clientOrg, live: !['closed', 'paused', 'offboarding'].includes(e.status), approvedAt: approvedAtOf({ ...d, client: e.clientOrg }) }));
        delivs.push(...ds);
        const g1 = i === 0 ? (firstApproval.get(`engagement:${e.id}:G1`) ?? c.rcdAt) : c.rcdAt;
        if (i === 0) add('G1', e.createdAt, g1);
        const g2 = c.plans.map((p) => firstApproval.get(`plan:${p.id}:G2`) ?? p.approvedAt).filter((x): x is Date => !!x).sort((a, b) => a.getTime() - b.getTime())[0] ?? null;
        add('G2', g1, g2);
        const starts = ds.flatMap((d) => d.tasks.filter((t) => t.kind !== 'planning').map((t) => t.startedAt)).filter((x): x is Date => !!x);
        const g3 = starts.length ? new Date(Math.min(...starts.map((x) => x.getTime()))) : null;
        add('G3', g2, g3);
        const allDone = ds.length > 0 && ds.every((d) => d.approvedAt);
        const g4 = allDone ? new Date(Math.max(...ds.map((d) => d.approvedAt!.getTime()))) : null;
        add('G4', g3, g4);
        if (g4 && (!lastG4 || g4 > lastG4)) lastG4 = g4;
      });
      add('G5', lastG4, firstApproval.get(`engagement:${e.id}:G5`));
    }

    const steps: OpsGateStep[] = STEPS.map((s) => {
      const cur = measures[s.key].filter((m) => inRange(m.end, r.from, r.to)).map((m) => m.days);
      const prev = measures[s.key].filter((m) => inRange(m.end, r.prevFrom, r.prevTo)).map((m) => m.days);
      return { ...s, avgDays: avg(cur), medianDays: median(cur), count: cur.length, prevAvgDays: avg(prev) };
    });
    const slowest = steps.filter((s) => s.avgDays !== null).sort((a, b) => b.avgDays! - a.avgDays!)[0] ?? null;

    // Deliverables approved by the client in each period.
    const firstDraft = (d: Deliv) => d.versions[0]?.createdAt ?? null;
    const cycleDays = (d: Deliv & { approvedAt: Date | null }) => {
      const f = firstDraft(d);
      return f && d.approvedAt && d.approvedAt >= f ? workDays(f, d.approvedAt, cal) : null;
    };
    const approvedIn = (a: Date, b: Date) => delivs.filter((d) => inRange(d.approvedAt, a, b));
    const cur = approvedIn(r.from, r.to);
    const prev = approvedIn(r.prevFrom, r.prevTo);
    const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
    const onTime = (xs: typeof cur) => {
      const due = xs.filter((d) => d.dueAt);
      return { pct: pct(due.filter((d) => d.approvedAt! <= d.dueAt!).length, due.length), n: due.length };
    };

    const types = new Map<string, { cur: number[]; prev: number[]; count: number }>();
    for (const d of cur) {
      const g = types.get(d.type) ?? { cur: [], prev: [], count: 0 };
      g.count++;
      const c = cycleDays(d);
      if (c !== null) g.cur.push(c);
      types.set(d.type, g);
    }
    for (const d of prev) {
      const g = types.get(d.type);
      const c = cycleDays(d);
      if (g && c !== null) g.prev.push(c);
    }
    const byType = [...types.entries()].map(([type, g]) => ({ type: typeLabel(type), count: g.count, avgDays: avg(g.cur), prevAvgDays: avg(g.prev) })).sort((a, b) => (b.avgDays ?? 0) - (a.avgDays ?? 0));

    const revisions = ['0', '1', '2', '3', '4+'].map((label, i) => ({ label: label === '1' ? '1 round' : label === '0' ? 'No changes' : `${label} rounds`, count: cur.filter((d) => (i === 4 ? d.revisionRoundsUsed >= 4 : d.revisionRoundsUsed === i)).length }));

    const bs = buckets(r, r.bucket);
    const qcPass = bs.map((b) => {
      const xs = qc.filter((x) => x.createdAt >= b.start && x.createdAt < b.end && x.createdAt >= r.from);
      return pct(xs.filter((x) => x.result === 'pass').length, xs.length);
    });
    const qcChecks = bs.map((b) => qc.filter((x) => x.createdAt >= b.start && x.createdAt < b.end && x.createdAt >= r.from).length);
    const onTimeSeries = bs.map(() => ({ due: 0, ok: 0, approved: 0 }));
    for (const d of cur) {
      const i = bucketOf(bs, d.approvedAt);
      if (i < 0) continue;
      onTimeSeries[i].approved++;
      if (d.dueAt) {
        onTimeSeries[i].due++;
        if (d.approvedAt! <= d.dueAt) onTimeSeries[i].ok++;
      }
    }

    // Work in progress, oldest first.
    const wip: OpsWipRow[] = delivs
      .filter((d) => d.live && !d.approvedAt && !DONE_DELIVERABLE.includes(d.status) && d.status !== 'planned')
      .map((d) => {
        const starts = [...d.tasks.map((t) => t.startedAt ?? t.createdAt), ...d.versions.map((v) => v.createdAt)];
        const touches = [...d.tasks.map((t) => t.updatedAt), ...d.versions.map((v) => v.createdAt), ...d.versions.flatMap((v) => v.qcResults.map((x) => x.createdAt))];
        const start = starts.length ? Math.min(...starts.map((x) => x.getTime())) : now.getTime();
        const touched = touches.length ? Math.max(...touches.map((x) => x.getTime())) : start;
        const openTask = d.tasks.find((t) => t.status !== 'done' && t.status !== 'cancelled');
        return {
          id: d.id,
          title: d.title,
          type: typeLabel(d.type),
          client: d.client.name,
          clientId: d.client.id,
          status: deliverableStatusLabels[d.status as DeliverableStatus] ?? d.status,
          ageDays: Math.max(0, Math.floor((now.getTime() - start) / DAY)),
          sinceUpdateDays: Math.max(0, Math.floor((now.getTime() - touched) / DAY)),
          owner: openTask?.owner?.name ?? null,
          dueAt: d.dueAt?.toISOString() ?? null,
          overdue: !!d.dueAt && d.dueAt < now,
        };
      })
      .sort((a, b) => b.ageDays - a.ageDays)
      .slice(0, 25);

    const qcNow = pct(qc.filter((x) => x.createdAt >= r.from && x.result === 'pass').length, qc.filter((x) => x.createdAt >= r.from).length);
    const qcPrev = pct(qc.filter((x) => x.createdAt < r.from && x.result === 'pass').length, qc.filter((x) => x.createdAt < r.from).length);
    const cycleNow = avg(nums(cur.map(cycleDays)));
    const cyclePrev = avg(nums(prev.map(cycleDays)));
    const otNow = onTime(cur);
    const otPrev = onTime(prev);

    const insights: OpsInsight[] = [];
    if (slowest)
      insights.push(
        insight(`${slowest.label} is the slowest step: ${slowest.avgDays} working days on average (median ${slowest.medianDays}) across ${plural(slowest.count, 'project')}${trendWords(slowest.avgDays, slowest.prevAvgDays)}.`, 'warn'),
      );
    const slowType = byType.find((t) => t.avgDays !== null && t.count >= 2);
    if (slowType) insights.push(insight(`${slowType.type} deliverables take the longest from first draft to client approval: ${slowType.avgDays} working days on average over ${plural(slowType.count, 'deliverable')}.`));
    if (qcNow !== null) insights.push(insight(`QC passed ${fmtPct(qcNow)} of checks in this period${trendWords(qcNow, qcPrev, '%')}.`, qcPrev !== null && qcNow < qcPrev ? 'warn' : 'good'));
    const stuck = wip.filter((w) => w.ageDays > 15);
    if (stuck.length) insights.push(insight(`${plural(stuck.length, 'deliverable has', 'deliverables have')} been in progress for more than 15 days; the oldest is “${stuck[0].title}” for ${stuck[0].client} (${stuck[0].ageDays} days).`, 'warn'));
    else if (otNow.pct !== null) insights.push(insight(`${fmtPct(otNow.pct)} of deliverables were approved by their due date${trendWords(otNow.pct, otPrev.pct, '%')}.`));
    if (!insights.length) insights.push(insight('Nothing was approved in this period yet. Try a longer period.'));

    return {
      range: outRange(r),
      totals: {
        approved: cmp(cur.length, prev.length),
        avgCycleDays: cmp(cycleNow, cyclePrev),
        qcPassRate: cmp(qcNow, qcPrev),
        onTimePct: cmp(otNow.pct, otPrev.pct),
        avgRevisionRounds: cmp(avg(cur.map((d) => d.revisionRoundsUsed)), avg(prev.map((d) => d.revisionRoundsUsed))),
      },
      steps,
      bottleneck: slowest?.key ?? null,
      byType,
      revisions,
      qcTrend: {
        labels: bs.map((b) => b.label),
        series: [
          { key: 'pass', label: 'QC pass rate %', values: qcPass },
          { key: 'checks', label: 'Checks', values: qcChecks },
        ],
      },
      onTimeTrend: {
        labels: bs.map((b) => b.label),
        series: [
          { key: 'onTime', label: 'On time %', values: onTimeSeries.map((x) => pct(x.ok, x.due)) },
          { key: 'approved', label: 'Approved', values: onTimeSeries.map((x) => x.approved) },
        ],
      },
      wip,
      insights: insights.slice(0, 4),
    };
  }
}
