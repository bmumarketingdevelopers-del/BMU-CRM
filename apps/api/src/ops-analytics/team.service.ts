import { Injectable } from '@nestjs/common';
import type { Me, OpsDepartmentRow, OpsInsight, OpsPersonRow, OpsTeamView } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { startOfWeek } from '../insights/ist.js';
import {
  DAY,
  OPEN_TASK_STATUSES,
  PRODUCTIVE_HOURS_PER_WEEK,
  assertTeamReader,
  avg,
  bucketOf,
  buckets,
  cmp,
  fmtPct,
  inRange,
  insight,
  limitedToOwnDepartment,
  outRange,
  parseRange,
  pct,
  plural,
  round1,
  sum,
  trendWords,
  workingDayCount,
  type Range,
} from './common.js';

type TaskRow = {
  id: string;
  ownerId: string | null;
  status: string;
  deadline: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  timeLoggedMin: number;
};
type VersionRow = { uploadedById: string; createdAt: Date; deliverableId: string; deliverable: { revisionRoundsUsed: number }; qcResults: { result: string; createdAt: Date }[] };

const isOpen = (t: TaskRow) => (OPEN_TASK_STATUSES as readonly string[]).includes(t.status);

/** Team performance numbers for a set of tasks and versions over [a, b). */
export function workStats(tasks: TaskRow[], versions: VersionRow[], a: Date, b: Date) {
  const done = tasks.filter((t) => t.status === 'done' && inRange(t.completedAt, a, b));
  const due = done.filter((t) => t.deadline);
  const onTime = due.filter((t) => t.completedAt! <= t.deadline!);
  const cycle = done.map((t) => (t.completedAt!.getTime() - (t.startedAt ?? t.createdAt).getTime()) / DAY).filter((d) => d >= 0);
  const minutes = sum(done.map((t) => t.timeLoggedMin)) + sum(tasks.filter((t) => isOpen(t) && inRange(t.updatedAt, a, b)).map((t) => t.timeLoggedMin));
  const checked = versions.filter((v) => v.qcResults.length && inRange(v.qcResults[0].createdAt, a, b));
  const firstPass = checked.filter((v) => v.qcResults[0].result === 'pass').length;
  const delivs = new Map<string, number>();
  for (const v of versions) if (inRange(v.createdAt, a, b)) delivs.set(v.deliverableId, v.deliverable.revisionRoundsUsed);
  return {
    completed: done.length,
    onTimePct: pct(onTime.length, due.length),
    onTimeCount: onTime.length,
    dueCount: due.length,
    avgCycleDays: avg(cycle),
    hours: round1(minutes / 60),
    qcFirstPassPct: pct(firstPass, checked.length),
    qcVersions: checked.length,
    avgRevisionRounds: avg([...delivs.values()]),
  };
}

@Injectable()
export class OpsTeamService {
  constructor(private readonly prisma: PrismaService) {}

  async ownDepartment(me: Me) {
    const self = await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } });
    if (self?.departmentId) return self.departmentId;
    const headed = await this.prisma.department.findFirst({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true } });
    return headed?.id ?? '__none__';
  }

  async team(me: Me, q: { from?: string; to?: string; departmentId?: string }): Promise<OpsTeamView> {
    assertTeamReader(me);
    const r = parseRange(q.from, q.to);
    const orgId = me.orgId;
    const now = new Date();
    const locked = limitedToOwnDepartment(me) ? await this.ownDepartment(me) : null;
    const deptId = locked ?? (q.departmentId || null);

    const [cal, depts, users] = await Promise.all([
      calendarFor(this.prisma, orgId),
      this.prisma.department.findMany({ where: { orgId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.user.findMany({
        where: { orgId, type: 'staff', status: 'active', deletedAt: null, ...(deptId ? { departmentId: deptId } : {}) },
        select: { id: true, name: true, departmentId: true, roles: { select: { role: { select: { name: true } } } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    const ids = users.map((u) => u.id);
    const [tasks, versions] = await Promise.all([
      this.prisma.task.findMany({
        where: {
          orgId,
          ownerId: { in: ids },
          OR: [{ completedAt: { gte: r.prevFrom } }, { status: { in: [...OPEN_TASK_STATUSES] } }, { createdAt: { gte: r.prevFrom } }],
        },
        select: { id: true, ownerId: true, status: true, deadline: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true, timeLoggedMin: true },
      }),
      this.prisma.version.findMany({
        where: { orgId, uploadedById: { in: ids }, createdAt: { gte: new Date(r.prevFrom.getTime() - 30 * DAY), lt: r.to } },
        select: { uploadedById: true, createdAt: true, deliverableId: true, deliverable: { select: { revisionRoundsUsed: true } }, qcResults: { select: { result: true, createdAt: true }, orderBy: { createdAt: 'asc' } } },
      }),
    ]);
    const deptName = new Map(depts.map((d) => [d.id, d.name]));
    const capFor = (range: Pick<Range, 'from' | 'to'>) => (workingDayCount(range.from, range.to < now ? range.to : now, cal) * PRODUCTIVE_HOURS_PER_WEEK) / 6;
    const cap = capFor(r);
    const capPrev = capFor({ from: r.prevFrom, to: r.prevTo });

    const byOwner = new Map<string, TaskRow[]>();
    for (const t of tasks) byOwner.set(t.ownerId!, [...(byOwner.get(t.ownerId!) ?? []), t]);
    const vByOwner = new Map<string, VersionRow[]>();
    for (const v of versions) vByOwner.set(v.uploadedById, [...(vByOwner.get(v.uploadedById) ?? []), v]);

    const rowFor = (ts: TaskRow[], vs: VersionRow[], people: number) => {
      const s = workStats(ts, vs, r.from, r.to);
      const p = workStats(ts, vs, r.prevFrom, r.prevTo);
      const open = ts.filter(isOpen);
      return {
        s,
        p,
        row: {
          completed: s.completed,
          completedPrev: p.completed,
          onTimePct: s.onTimePct,
          avgCycleDays: s.avgCycleDays,
          hours: s.hours,
          utilisation: cap ? Math.round((s.hours / (cap * people)) * 100) : 0,
          qcFirstPassPct: s.qcFirstPassPct,
          qcVersions: s.qcVersions,
          avgRevisionRounds: s.avgRevisionRounds,
          overdueNow: open.filter((t) => t.deadline && t.deadline < now).length,
          openTasks: open.length,
        },
      };
    };

    const people: OpsPersonRow[] = users
      .map((u) => {
        const ts = byOwner.get(u.id) ?? [];
        const vs = vByOwner.get(u.id) ?? [];
        const { row, p } = rowFor(ts, vs, 1);
        return { active: ts.length > 0 || vs.length > 0 || p.completed > 0, person: { id: u.id, name: u.name, department: u.departmentId ? (deptName.get(u.departmentId) ?? null) : null, departmentId: u.departmentId, role: u.roles[0]?.role.name.split(' (')[0] ?? null, ...row } };
      })
      .filter((x) => x.active)
      .map((x) => x.person)
      .sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name));

    const groups = new Map<string, OpsPersonRow[]>();
    for (const p of people) groups.set(p.departmentId ?? '', [...(groups.get(p.departmentId ?? '') ?? []), p]);
    const departments: OpsDepartmentRow[] = [...groups.entries()]
      .map(([id, ps]) => {
        const ts = ps.flatMap((p) => byOwner.get(p.id) ?? []);
        const vs = ps.flatMap((p) => vByOwner.get(p.id) ?? []);
        return { id: id || null, name: id ? (deptName.get(id) ?? 'Department') : 'No department', people: ps.length, ...rowFor(ts, vs, ps.length).row };
      })
      .sort((a, b) => b.completed - a.completed || a.name.localeCompare(b.name));

    // Totals across everyone in view.
    const all = rowFor(tasks, versions, Math.max(1, people.length));
    const utilNow = cap && people.length ? Math.round((all.s.hours / (cap * people.length)) * 100) : null;
    const utilPrev = capPrev && people.length ? Math.round((all.p.hours / (capPrev * people.length)) * 100) : null;

    // Weekly throughput: tasks completed vs created.
    const bs = buckets(r, r.bucket);
    const completedSeries = bs.map(() => 0);
    const createdSeries = bs.map(() => 0);
    for (const t of tasks) {
      const ci = t.status === 'done' ? bucketOf(bs, t.completedAt) : -1;
      if (ci >= 0 && inRange(t.completedAt, r.from, r.to)) completedSeries[ci]++;
      const ki = bucketOf(bs, t.createdAt);
      if (ki >= 0 && inRange(t.createdAt, r.from, r.to)) createdSeries[ki]++;
    }

    // Workload for the next four weeks, by deadline (overdue work counts in this week).
    const doneWithTime = tasks.filter((t) => t.status === 'done' && t.timeLoggedMin > 0 && inRange(t.completedAt, r.from, r.to));
    const hoursPerTask = doneWithTime.length >= 5 ? round1(sum(doneWithTime.map((t) => t.timeLoggedMin)) / doneWithTime.length / 60) : 6;
    const week0 = startOfWeek(now);
    const weekStarts = [0, 1, 2, 3].map((k) => startOfWeek(now, k));
    const weekIdx = (d: Date) => (d < week0 ? 0 : weekStarts.findIndex((s, k) => d >= s && d < startOfWeek(now, k + 1)));
    const workloadRows = people
      .map((p) => {
        const counts = [0, 0, 0, 0];
        for (const t of (byOwner.get(p.id) ?? []).filter((x) => isOpen(x) && x.deadline)) {
          const k = weekIdx(t.deadline!);
          if (k >= 0) counts[k]++;
        }
        return { id: p.id, name: p.name, department: p.department, departmentId: p.departmentId, tasks: counts, loadPct: counts.map((c) => Math.round(((c * hoursPerTask) / PRODUCTIVE_HOURS_PER_WEEK) * 100)) };
      })
      .filter((x) => sum(x.tasks) > 0)
      .sort((a, b) => sum(b.tasks) - sum(a.tasks))
      .slice(0, 20);

    // Insights
    const insights: OpsInsight[] = [];
    const nextWeek = new Map<string, { name: string; tasks: number; people: number; top: { name: string; n: number } }>();
    for (const p of people) {
      const key = p.departmentId ?? '';
      const n = (byOwner.get(p.id) ?? []).filter((t) => isOpen(t) && t.deadline && weekIdx(t.deadline) === 1).length;
      const g = nextWeek.get(key) ?? { name: p.department ?? 'No department', tasks: 0, people: 0, top: { name: p.name, n: -1 } };
      g.tasks += n;
      g.people++;
      if (n > g.top.n) g.top = { name: p.name, n };
      nextWeek.set(key, g);
    }
    const busiest = [...nextWeek.values()].filter((g) => g.tasks > 0).map((g) => ({ ...g, load: Math.round(((g.tasks * hoursPerTask) / (PRODUCTIVE_HOURS_PER_WEEK * g.people)) * 100) })).sort((a, b) => b.load - a.load)[0];
    if (busiest)
      insights.push(
        insight(`${busiest.name} is at ${busiest.load}% load next week (about ${hoursPerTask}h per task); ${busiest.top.name} has ${plural(busiest.top.n, 'task')} due.`, busiest.load > 100 ? 'warn' : 'default'),
      );
    if (all.s.dueCount) {
      const good = all.p.onTimePct !== null && all.s.onTimePct! >= all.p.onTimePct;
      insights.push(insight(`${fmtPct(all.s.onTimePct)} of tasks with a deadline were finished on time (${all.s.onTimeCount} of ${all.s.dueCount})${trendWords(all.s.onTimePct, all.p.onTimePct, '%')}.`, good ? 'good' : all.p.onTimePct === null ? 'default' : 'warn'));
    }
    const overdue = sum(people.map((p) => p.overdueNow));
    if (overdue) {
      const worst = [...people].sort((a, b) => b.overdueNow - a.overdueNow)[0];
      insights.push(insight(`${plural(overdue, 'task is', 'tasks are')} overdue right now; ${worst.overdueNow} of them belong to ${worst.name}.`, 'warn'));
    }
    const qcBest = people.filter((p) => p.qcVersions >= 3 && p.qcFirstPassPct !== null).sort((a, b) => b.qcFirstPassPct! - a.qcFirstPassPct!)[0];
    if (qcBest) insights.push(insight(`${qcBest.name} has the best first-time QC pass rate: ${fmtPct(qcBest.qcFirstPassPct)} of ${plural(qcBest.qcVersions, 'version')}.`, 'good'));
    if (!insights.length) insights.push(insight('No finished tasks in this period yet. Pick a longer period to see trends.'));

    return {
      range: outRange(r),
      productiveHoursPerWeek: PRODUCTIVE_HOURS_PER_WEEK,
      departmentFilter: locked ? depts.filter((d) => d.id === locked) : depts,
      lockedDepartmentId: locked,
      totals: {
        completed: cmp(all.s.completed, all.p.completed),
        onTimePct: cmp(all.s.onTimePct, all.p.onTimePct),
        avgCycleDays: cmp(all.s.avgCycleDays, all.p.avgCycleDays),
        hours: cmp(all.s.hours, all.p.hours),
        utilisation: cmp(utilNow, utilPrev),
        qcFirstPassPct: cmp(all.s.qcFirstPassPct, all.p.qcFirstPassPct),
        overdueNow: overdue,
      },
      people,
      departments,
      throughput: {
        labels: bs.map((b) => b.label),
        series: [
          { key: 'completed', label: 'Completed', values: completedSeries },
          { key: 'created', label: 'Created', values: createdSeries },
        ],
      },
      workload: {
        weeks: weekStarts.map((s, k) => (k === 0 ? 'This week' : k === 1 ? 'Next week' : `w/c ${new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(s)}`)),
        rows: workloadRows.map(({ departmentId: _d, ...w }) => w),
        hoursPerTask,
      },
      insights: insights.slice(0, 4),
    };
  }
}
