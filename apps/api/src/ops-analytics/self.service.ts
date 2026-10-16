import { ForbiddenException, Injectable } from '@nestjs/common';
import { requestTypeLabels, taskStatusLabels, workingMinutesBetween, type Me, type OpsClientView, type OpsInsight, type OpsMyView, type RequestType, type TaskStatus } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { DAY as IST_DAY, dayLabel, isoDay, istParts, startOfDay } from '../insights/ist.js';
import { workStats } from './team.service.js';
import {
  DAY,
  DONE_DELIVERABLE,
  OPEN_TASK_STATUSES,
  assertStaff,
  avg,
  bucketOf,
  buckets,
  cmp,
  fmtPct,
  inRange,
  insight,
  outRange,
  parseRange,
  pct,
  plural,
  round1,
  sum,
  workDays,
} from './common.js';
import { clientVisibleInvoiceWhere, readInvoiceBranding } from '../service/invoice-branding.service.js';

const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const CLIENT_MONEY_ROLES = ['client_owner', 'client_finance'];

@Injectable()
export class OpsSelfService {
  constructor(private readonly prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // My performance (any staff member, own numbers only)

  async me(me: Me, q: { from?: string; to?: string }): Promise<OpsMyView> {
    assertStaff(me);
    const r = parseRange(q.from, q.to);
    const orgId = me.orgId;
    const now = new Date();
    const taskSelect = { id: true, ownerId: true, title: true, status: true, deadline: true, startedAt: true, completedAt: true, createdAt: true, updatedAt: true, timeLoggedMin: true } as const;
    const [mine, myVersions, teamTasks, teamVersions] = await Promise.all([
      this.prisma.task.findMany({
        where: { orgId, ownerId: me.id, OR: [{ completedAt: { gte: new Date(Math.min(r.prevFrom.getTime(), now.getTime() - 200 * DAY)) } }, { status: { in: [...OPEN_TASK_STATUSES] } }] },
        select: { ...taskSelect, engagementId: true, deliverable: { select: { cycle: { select: { engagement: { select: { clientOrg: { select: { name: true } } } } } } } } },
      }),
      this.prisma.version.findMany({
        where: { orgId, uploadedById: me.id, createdAt: { gte: new Date(r.prevFrom.getTime() - 30 * DAY), lt: r.to } },
        select: { uploadedById: true, createdAt: true, deliverableId: true, deliverable: { select: { revisionRoundsUsed: true } }, qcResults: { select: { result: true, createdAt: true }, orderBy: { createdAt: 'asc' } } },
      }),
      this.prisma.task.findMany({
        where: { orgId, status: 'done', completedAt: { gte: r.from, lt: r.to }, owner: { type: 'staff', deletedAt: null } },
        select: taskSelect,
      }),
      this.prisma.version.findMany({
        where: { orgId, createdAt: { gte: new Date(r.from.getTime() - 30 * DAY), lt: r.to } },
        select: { uploadedById: true, createdAt: true, deliverableId: true, deliverable: { select: { revisionRoundsUsed: true } }, qcResults: { select: { result: true, createdAt: true }, orderBy: { createdAt: 'asc' } } },
      }),
    ]);
    const s = workStats(mine, myVersions, r.from, r.to);
    const p = workStats(mine, myVersions, r.prevFrom, r.prevTo);

    // Team average per person (everyone who finished at least one task).
    const owners = new Map<string, typeof teamTasks>();
    for (const t of teamTasks) owners.set(t.ownerId!, [...(owners.get(t.ownerId!) ?? []), t]);
    const per = [...owners.entries()].map(([id, ts]) => workStats(ts, teamVersions.filter((v) => v.uploadedById === id), r.from, r.to));
    const teamQc = workStats([], teamVersions, r.from, r.to);
    const teamAverage = {
      completed: per.length ? round1(sum(per.map((x) => x.completed)) / per.length) : null,
      onTimePct: pct(sum(per.map((x) => x.onTimeCount)), sum(per.map((x) => x.dueCount))),
      hours: per.length ? round1(sum(per.map((x) => x.hours)) / per.length) : null,
      qcFirstPassPct: teamQc.qcFirstPassPct,
      people: per.length,
    };

    // Weekly trend: me vs the team average.
    const bs = buckets(r, r.bucket);
    const myDone = bs.map(() => 0);
    const teamDone = bs.map(() => 0);
    const teamPeople = bs.map(() => new Set<string>());
    for (const t of mine) if (t.status === 'done' && inRange(t.completedAt, r.from, r.to)) myDone[bucketOf(bs, t.completedAt)]++;
    for (const t of teamTasks) {
      const i = bucketOf(bs, t.completedAt);
      if (i < 0) continue;
      teamDone[i]++;
      teamPeople[i].add(t.ownerId!);
    }

    // On-time streak: working days (newest first) where everything due was finished on time. Days with nothing due are skipped.
    const dayKey = (d: Date) => isoDay(d);
    const dueByDay = new Map<string, typeof mine>();
    for (const t of mine) if (t.deadline && t.deadline < now) dueByDay.set(dayKey(t.deadline), [...(dueByDay.get(dayKey(t.deadline)) ?? []), t]);
    let streak = 0;
    for (let d = startOfDay(new Date(now.getTime() - IST_DAY)), n = 0; n < 200; n++, d = new Date(d.getTime() - IST_DAY)) {
      const due = dueByDay.get(dayKey(d));
      if (!due) continue;
      const ok = due.every((t) => t.status === 'done' && t.completedAt && t.completedAt <= t.deadline!);
      if (!ok) break;
      streak++;
    }

    // Upcoming load: next 14 days.
    const open = mine.filter((t) => (OPEN_TASK_STATUSES as readonly string[]).includes(t.status));
    const today = startOfDay(now);
    const days = Array.from({ length: 14 }, (_, i) => {
      const start = new Date(today.getTime() + i * IST_DAY);
      const end = new Date(start.getTime() + IST_DAY);
      const p2 = istParts(start);
      return { date: isoDay(start), label: i === 0 ? 'Today' : `${WEEKDAY[p2.dow].slice(0, 3)} ${dayLabel(start)}`, count: open.filter((t) => t.deadline && (i === 0 ? t.deadline < end : t.deadline >= start && t.deadline < end)).length };
    });
    const horizon = new Date(today.getTime() + 14 * IST_DAY);
    const clientOf = (t: (typeof mine)[number]) => t.deliverable?.cycle.engagement.clientOrg.name ?? null;
    const upcomingTasks = open
      .filter((t) => t.deadline && t.deadline < horizon)
      .sort((a, b) => a.deadline!.getTime() - b.deadline!.getTime())
      .slice(0, 30)
      .map((t) => ({ id: t.id, title: t.title, deadline: t.deadline!.toISOString(), status: taskStatusLabels[t.status as TaskStatus] ?? t.status, client: clientOf(t) }));

    const recent = mine
      .filter((t) => t.status === 'done' && inRange(t.completedAt, r.from, r.to))
      .sort((a, b) => b.completedAt!.getTime() - a.completedAt!.getTime())
      .slice(0, 60)
      .map((t) => ({ id: t.id, title: t.title, client: clientOf(t), deadline: t.deadline?.toISOString() ?? null, completedAt: t.completedAt!.toISOString(), onTime: t.deadline ? t.completedAt! <= t.deadline : null, hours: round1(t.timeLoggedMin / 60) }));

    const firstName = me.name.split(' ')[0];
    const insights: OpsInsight[] = [];
    if (s.completed) {
      const diff = s.completed - p.completed;
      insights.push(insight(`You finished ${plural(s.completed, 'task')} in this period${p.completed ? (diff > 0 ? `, ${diff} more than the period before` : diff < 0 ? `, ${-diff} fewer than the period before` : ', the same as the period before') : ''}.`, diff >= 0 ? 'good' : 'default'));
    } else insights.push(insight(`No finished tasks in this period yet, ${firstName}. Your numbers will fill in as you complete work.`));
    if (s.onTimePct !== null)
      insights.push(insight(`${fmtPct(s.onTimePct)} of your tasks landed on or before the deadline${teamAverage.onTimePct !== null ? `; the team average is ${fmtPct(teamAverage.onTimePct)}` : ''}.`, teamAverage.onTimePct === null || s.onTimePct >= teamAverage.onTimePct ? 'good' : 'default'));
    const nextWeek = days.slice(1, 8);
    const busiestDay = [...nextWeek].sort((a, b) => b.count - a.count)[0];
    const dueSoon = sum(nextWeek.map((d) => d.count));
    if (dueSoon) insights.push(insight(`The next 7 days have ${plural(dueSoon, 'task')} due${busiestDay.count > 1 ? `; ${busiestDay.label} is the busiest with ${busiestDay.count}` : ''}.`, dueSoon > 8 ? 'warn' : 'default'));
    if (streak >= 3) insights.push(insight(`You're on a ${streak}-day on-time streak. Nice work.`, 'good'));
    else if (days[0].count) insights.push(insight(`${plural(days[0].count, 'task is', 'tasks are')} due today or already late. Start there.`, 'warn'));

    return {
      range: outRange(r),
      name: me.name,
      stats: {
        completed: cmp(s.completed, p.completed),
        onTimePct: cmp(s.onTimePct, p.onTimePct),
        hours: cmp(s.hours, p.hours),
        qcFirstPassPct: cmp(s.qcFirstPassPct, p.qcFirstPassPct),
        avgCycleDays: cmp(s.avgCycleDays, p.avgCycleDays),
        streakDays: streak,
      },
      teamAverage,
      trend: {
        labels: bs.map((b) => b.label),
        series: [
          { key: 'me', label: 'You', values: myDone },
          { key: 'team', label: 'Team average', values: teamDone.map((n, i) => (teamPeople[i].size ? round1(n / teamPeople[i].size) : 0)) },
        ],
      },
      upcoming: { days, tasks: upcomingTasks },
      recent,
      insights: insights.slice(0, 4),
    };
  }

  // -------------------------------------------------------------------------
  // Client insights (client users, own account only, nothing internal)

  async client(me: Me, q: { from?: string; to?: string }): Promise<OpsClientView> {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Insights are for client accounts');
    const r = parseRange(q.from, q.to);
    const clientOrgId = me.clientOrg.id;
    const money = CLIENT_MONEY_ROLES.includes(me.clientOrg.role);
    const [cal, engagements] = await Promise.all([
      calendarFor(this.prisma, me.orgId),
      this.prisma.engagement.findMany({
        where: { orgId: me.orgId, clientOrgId, deletedAt: null },
        select: {
          id: true,
          tier: true,
          service: { select: { tiers: { select: { tier: true, revisionRounds: true } } } },
          cycles: {
            select: {
              deliverables: {
                select: { id: true, title: true, type: true, status: true, dueAt: true, revisionRoundsUsed: true, approvedVersionId: true, versions: { select: { id: true, createdAt: true, sentToClientAt: true }, orderBy: { number: 'asc' } } },
              },
            },
          },
        },
      }),
    ]);
    const delivs = engagements.flatMap((e) => {
      const allowance = e.service.tiers.find((t) => t.tier === e.tier)?.revisionRounds ?? 2;
      return e.cycles.flatMap((c) => c.deliverables.map((d) => ({ ...d, allowance })));
    });
    const engagementIds = engagements.map((e) => e.id);
    const [approvals, requests, invoices] = await Promise.all([
      delivs.length ? this.prisma.approval.findMany({ where: { targetType: 'deliverable', gate: 'G4', targetId: { in: delivs.map((d) => d.id) } }, select: { targetId: true, at: true }, orderBy: { at: 'asc' } }) : [],
      engagementIds.length ? this.prisma.request.findMany({ where: { engagementId: { in: engagementIds }, createdAt: { gte: r.prevFrom, lt: r.to } }, select: { type: true, createdAt: true, firstReplyAt: true } }) : [],
      money
        ? readInvoiceBranding(this.prisma, me.orgId).then((b) => this.prisma.invoice.findMany({ where: { orgId: me.orgId, clientOrgId, status: { notIn: ['draft', 'void'] }, ...clientVisibleInvoiceWhere(b) }, select: { createdAt: true, totalPaise: true, payments: { select: { at: true, amountPaise: true } } } }))
        : Promise.resolve(null),
    ]);
    const approvedMap = new Map<string, Date>();
    for (const a of approvals) if (!approvedMap.has(a.targetId)) approvedMap.set(a.targetId, a.at);
    const withApproval = delivs.map((d) => {
      let at = approvedMap.get(d.id) ?? null;
      if (!at && DONE_DELIVERABLE.includes(d.status)) {
        const v = d.versions.find((x) => x.id === d.approvedVersionId) ?? d.versions.at(-1);
        at = v ? (v.sentToClientAt ?? v.createdAt) : null;
      }
      return { ...d, approvedAt: at };
    });
    const approvedIn = (a: Date, b: Date) => withApproval.filter((d) => inRange(d.approvedAt, a, b));
    const cur = approvedIn(r.from, r.to);
    const prev = approvedIn(r.prevFrom, r.prevTo);
    const draftDays = (xs: typeof cur) =>
      avg(
        xs
          .map((d) => {
            const sent = d.versions.find((v) => v.sentToClientAt)?.sentToClientAt;
            return sent && d.approvedAt! >= sent ? workDays(sent, d.approvedAt!, cal) : null;
          })
          .filter((x): x is number => x !== null),
      );
    const onTime = (xs: typeof cur) => {
      const due = xs.filter((d) => d.dueAt);
      return pct(due.filter((d) => d.approvedAt! <= d.dueAt!).length, due.length);
    };
    const replyHours = (a: Date, b: Date) =>
      avg(requests.filter((x) => inRange(x.createdAt, a, b) && x.firstReplyAt).map((x) => round1(workingMinutesBetween(x.createdAt, x.firstReplyAt!, cal) / 60)));

    const months = buckets(r, 'month');
    const approvedByMonth = months.map((m) => ({ label: m.label, value: cur.filter((d) => d.approvedAt! >= m.start && d.approvedAt! < m.end).length }));
    const used = sum(cur.map((d) => d.revisionRoundsUsed));
    const allowance = sum(cur.map((d) => d.allowance));
    const curReq = requests.filter((x) => inRange(x.createdAt, r.from, r.to));
    const typeCounts = new Map<string, number>();
    for (const x of curReq) typeCounts.set(x.type, (typeCounts.get(x.type) ?? 0) + 1);
    const requestsByType = [...typeCounts.entries()].map(([type, count]) => ({ type, label: requestTypeLabels[type as RequestType]?.client ?? type, count })).sort((a, b) => b.count - a.count);

    const spendByMonth = invoices
      ? months.map((m) => ({
          label: m.label,
          invoicedPaise: sum(invoices.filter((i) => i.createdAt >= m.start && i.createdAt < m.end).map((i) => i.totalPaise)),
          paidPaise: sum(invoices.flatMap((i) => i.payments).filter((p) => p.at >= m.start && p.at < m.end).map((p) => p.amountPaise)),
        }))
      : null;

    const totals = {
      approved: cmp(cur.length, prev.length),
      firstReplyHours: cmp(replyHours(r.from, r.to), replyHours(r.prevFrom, r.prevTo)),
      draftToApprovalDays: cmp(draftDays(cur), draftDays(prev)),
      onTimePct: cmp(onTime(cur), onTime(prev)),
      requests: cmp(curReq.length, requests.filter((x) => inRange(x.createdAt, r.prevFrom, r.prevTo)).length),
    };

    const insights: OpsInsight[] = [];
    if (cur.length) {
      const diff = cur.length - prev.length;
      insights.push(insight(`We delivered ${plural(cur.length, 'piece', 'pieces')} of approved work for you in this period${prev.length ? (diff > 0 ? `, ${diff} more than the period before` : diff < 0 ? `, ${-diff} fewer than the period before` : ', the same as the period before') : ''}.`, 'good'));
    } else insights.push(insight('Nothing was approved in this period yet. Approved work will show up here.'));
    if (totals.firstReplyHours.value !== null) insights.push(insight(`Your requests got a first reply in ${totals.firstReplyHours.value} working hours on average.`));
    if (allowance) insights.push(insight(`You used ${used} of the ${allowance} revision rounds included with this work.`, used > allowance ? 'warn' : 'default'));
    if (totals.onTimePct.value !== null) insights.push(insight(`${fmtPct(totals.onTimePct.value)} of your work was approved on or before the promised date.`, totals.onTimePct.value >= 80 ? 'good' : 'default'));

    return {
      range: outRange(r),
      clientName: me.clientOrg.name,
      canSeeMoney: money,
      totals,
      approvedByMonth,
      revisions: { used, allowance, overAllowance: cur.filter((d) => d.revisionRoundsUsed > d.allowance).length },
      requestsByType,
      spendByMonth,
      spendTotalPaise: spendByMonth ? sum(spendByMonth.map((m) => m.invoicedPaise)) : null,
      delivered: cur
        .sort((a, b) => b.approvedAt!.getTime() - a.approvedAt!.getTime())
        .slice(0, 40)
        .map((d) => ({ id: d.id, title: d.title, type: d.type.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), approvedAt: d.approvedAt!.toISOString(), rounds: d.revisionRoundsUsed, allowance: d.allowance, onTime: d.dueAt ? d.approvedAt! <= d.dueAt : null })),
      insights: insights.slice(0, 4),
    };
  }
}
