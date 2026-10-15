import { Injectable } from '@nestjs/common';
import {
  REQUEST_TYPES,
  addWorkingMinutes,
  endOfWorkingDay,
  requestStatusLabels,
  requestTypeLabels,
  workingMinutesBetween,
  type Me,
  type OpsAmRow,
  type OpsInsight,
  type OpsOpenRequestRow,
  type OpsSlaView,
  type RequestStatus,
  type RequestType,
  type WorkCalendar,
} from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { calendarFor } from '../production/generate.js';
import { istParts } from '../insights/ist.js';
import { assertOpsReader, avg, bucketOf, buckets, cmp, fmtMinutes, fmtPct, inRange, insight, median, outRange, parseRange, pct, plural, trendWords } from './common.js';

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export type SlaRequest = { createdAt: Date; slaDue: Date | null; firstReplyAt: Date | null; type: string };

/** Reply time in working minutes and whether the reply target was missed (null = still within time). */
export function slaOutcome(r: SlaRequest, targetMin: number, cal: WorkCalendar, now: Date) {
  const replyMin = r.firstReplyAt ? workingMinutesBetween(r.createdAt, r.firstReplyAt, cal) : null;
  const due = r.slaDue ?? addWorkingMinutes(r.createdAt, targetMin, cal);
  const breached = r.firstReplyAt ? r.firstReplyAt > due : due < now ? true : null;
  return { replyMin, breached, due };
}

@Injectable()
export class OpsSlaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  async sla(me: Me, q: { from?: string; to?: string }): Promise<OpsSlaView> {
    assertOpsReader(me);
    const r = parseRange(q.from, q.to);
    const orgId = me.orgId;
    const now = new Date();
    const [cal, sla, requests, open] = await Promise.all([
      calendarFor(this.prisma, orgId),
      this.settings.get(orgId, 'sla'),
      this.prisma.request.findMany({
        where: { orgId, createdAt: { gte: r.prevFrom, lt: r.to } },
        select: { id: true, type: true, createdAt: true, slaDue: true, firstReplyAt: true, engagement: { select: { amId: true, am: { select: { name: true } } } } },
      }),
      this.prisma.request.findMany({
        where: { orgId, status: { notIn: ['done', 'declined'] } },
        select: {
          id: true,
          type: true,
          status: true,
          description: true,
          createdAt: true,
          slaDue: true,
          firstReplyAt: true,
          engagement: { select: { am: { select: { name: true } }, clientOrg: { select: { id: true, name: true } } } },
        },
        orderBy: { createdAt: 'asc' },
        take: 200,
      }),
    ]);
    const target = (t: string) => (sla.firstReplyMinutes as Record<string, number>)[t] ?? 540;
    const rows = requests.map((x) => ({ ...x, ...slaOutcome(x, target(x.type), cal, now) }));
    const cur = rows.filter((x) => inRange(x.createdAt, r.from, r.to));
    const prev = rows.filter((x) => inRange(x.createdAt, r.prevFrom, r.prevTo));
    const within = (xs: typeof rows) => {
      const decided = xs.filter((x) => x.breached !== null);
      return pct(decided.filter((x) => !x.breached).length, decided.length);
    };
    const replyMins = (xs: typeof rows) => xs.map((x) => x.replyMin).filter((m): m is number => m !== null);

    const byType = REQUEST_TYPES.map((type) => {
      const c = cur.filter((x) => x.type === type);
      const p = prev.filter((x) => x.type === type);
      return {
        type,
        label: requestTypeLabels[type].team,
        targetMin: target(type),
        count: c.length,
        avgReplyMin: avg(replyMins(c)),
        medianReplyMin: median(replyMins(c)),
        withinPct: within(c),
        prevWithinPct: within(p),
        breaches: c.filter((x) => x.breached).length,
      };
    }).filter((t) => t.count > 0 || t.prevWithinPct !== null);

    const bs = buckets(r, r.bucket);
    const trendWithin = bs.map((b) => within(cur.filter((x) => x.createdAt >= b.start && x.createdAt < b.end)));
    const trendCount = bs.map((b) => cur.filter((x) => bucketOf([b], x.createdAt) === 0).length);

    const heatReq = WEEKDAYS.map(() => Array.from({ length: 24 }, () => 0));
    const heatBreach = WEEKDAYS.map(() => Array.from({ length: 24 }, () => 0));
    for (const x of cur) {
      const p = istParts(x.createdAt);
      const hour = new Date(x.createdAt.getTime() + 330 * 60_000).getUTCHours();
      const row = (p.dow + 6) % 7;
      heatReq[row][hour]++;
      if (x.breached) heatBreach[row][hour]++;
    }

    const amMap = new Map<string, { name: string; xs: typeof rows }>();
    for (const x of cur) {
      const id = x.engagement.amId ?? 'none';
      const g = amMap.get(id) ?? { name: x.engagement.am?.name ?? 'No Client Manager', xs: [] };
      g.xs.push(x);
      amMap.set(id, g);
    }
    const ams: OpsAmRow[] = [...amMap.entries()]
      .map(([id, g]) => ({ id, name: g.name, requests: g.xs.length, avgReplyMin: avg(replyMins(g.xs)), withinPct: within(g.xs), breaches: g.xs.filter((x) => x.breached).length }))
      .sort((a, b) => (a.avgReplyMin ?? Infinity) - (b.avgReplyMin ?? Infinity));

    const slowest: OpsOpenRequestRow[] = open
      .map((x) => {
        const o = slaOutcome(x, target(x.type), cal, now);
        return {
          id: x.id,
          client: x.engagement.clientOrg.name,
          clientId: x.engagement.clientOrg.id,
          type: x.type,
          typeLabel: requestTypeLabels[x.type as RequestType]?.team ?? x.type,
          description: x.description,
          status: requestStatusLabels[x.status as RequestStatus]?.team ?? x.status,
          createdAt: x.createdAt.toISOString(),
          waitingMin: workingMinutesBetween(x.createdAt, x.firstReplyAt ?? now, cal),
          replied: !!x.firstReplyAt,
          pastSla: !x.firstReplyAt && o.due < now,
          am: x.engagement.am?.name ?? null,
        };
      })
      .sort((a, b) => Number(b.pastSla) - Number(a.pastSla) || Number(a.replied) - Number(b.replied) || b.waitingMin - a.waitingMin)
      .slice(0, 12);

    const messages = await this.messageReplies(orgId, r, cal, sla.messageReply, now);

    const totals = {
      requests: cmp(cur.length, prev.length),
      withinPct: cmp(within(cur), within(prev)),
      avgReplyMin: cmp(avg(replyMins(cur)), avg(replyMins(prev))),
      breaches: cmp(cur.filter((x) => x.breached).length, prev.filter((x) => x.breached).length),
      openPastSla: slowest.filter((s) => s.pastSla).length,
    };

    const insights: OpsInsight[] = [];
    if (totals.withinPct.value !== null)
      insights.push(insight(`${fmtPct(totals.withinPct.value)} of client requests got a first reply within the target${trendWords(totals.withinPct.value, totals.withinPct.prev, '%')}.`, totals.withinPct.value >= 85 ? 'good' : 'warn'));
    const worstType = byType.filter((t) => t.avgReplyMin !== null && t.count >= 2).sort((a, b) => b.avgReplyMin! / b.targetMin - a.avgReplyMin! / a.targetMin)[0];
    if (worstType) insights.push(insight(`First replies to “${worstType.label}” take ${fmtMinutes(worstType.avgReplyMin)} of working time on average, against a target of ${fmtMinutes(worstType.targetMin)}.`, worstType.avgReplyMin! > worstType.targetMin ? 'warn' : 'default'));
    let peak = { row: 0, col: 0, n: 0 };
    heatBreach.forEach((row, ri) => row.forEach((n, ci) => n > peak.n && (peak = { row: ri, col: ci, n })));
    if (peak.n >= 2) insights.push(insight(`Missed replies cluster on ${WEEKDAYS[peak.row]} around ${peak.col}:00 (${plural(peak.n, 'request')}); consider who covers that slot.`, 'warn'));
    if (totals.openPastSla) insights.push(insight(`${plural(totals.openPastSla, 'request is', 'requests are')} waiting past the reply target right now.`, 'warn'));
    if (messages && messages.sameDayPct.value !== null && insights.length < 4) insights.push(insight(`${fmtPct(messages.sameDayPct.value)} of client messages were answered ${sla.messageReply === 'same_working_day' ? 'the same working day' : 'by the next working day'}.`));
    if (!insights.length) insights.push(insight('No client requests in this period.'));

    return {
      range: outRange(r),
      totals,
      byType,
      trend: {
        labels: bs.map((b) => b.label),
        series: [
          { key: 'within', label: 'Within target %', values: trendWithin },
          { key: 'count', label: 'Requests', values: trendCount },
        ],
      },
      heatmap: { rows: WEEKDAYS, cols: Array.from({ length: 24 }, (_, h) => String(h)), requests: heatReq, breaches: heatBreach },
      ams,
      messages,
      slowest,
      insights: insights.slice(0, 4),
    };
  }

  /** Client messages and whether the team replied within the message rule (same or next working day). */
  private async messageReplies(orgId: string, r: { from: Date; to: Date; prevFrom: Date; prevTo: Date }, cal: WorkCalendar, rule: string, now: Date) {
    const msgs = await this.prisma.message.findMany({
      where: { orgId, isInternal: false, createdAt: { gte: r.prevFrom, lt: new Date(r.to.getTime() + 7 * 86_400_000) } },
      select: { threadId: true, authorId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!msgs.length) return null;
    const authors = await this.prisma.user.findMany({ where: { id: { in: [...new Set(msgs.map((m) => m.authorId))] } }, select: { id: true, type: true } });
    const isClient = new Set(authors.filter((a) => a.type === 'client').map((a) => a.id));
    const byThread = new Map<string, typeof msgs>();
    for (const m of msgs) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
    const turns: { at: Date; replyAt: Date | null }[] = [];
    for (const list of byThread.values()) {
      list.forEach((m, i) => {
        if (!isClient.has(m.authorId)) return;
        if (i > 0 && isClient.has(list[i - 1].authorId)) return; // same client turn
        const reply = list.slice(i + 1).find((x) => !isClient.has(x.authorId));
        turns.push({ at: m.createdAt, replyAt: reply?.createdAt ?? null });
      });
    }
    const judge = (t: { at: Date; replyAt: Date | null }) => {
      let due = endOfWorkingDay(t.at, cal);
      if (rule === 'next_working_day') due = endOfWorkingDay(addWorkingMinutes(due, 1, cal), cal);
      if (t.replyAt) return t.replyAt <= due;
      return due < now ? false : null;
    };
    const rate = (xs: typeof turns) => {
      const judged = xs.map(judge).filter((x): x is boolean => x !== null);
      return pct(judged.filter(Boolean).length, judged.length);
    };
    const cur = turns.filter((t) => inRange(t.at, r.from, r.to));
    const prev = turns.filter((t) => inRange(t.at, r.prevFrom, r.prevTo));
    if (cur.length < 3) return null;
    const replied = cur.filter((t) => t.replyAt);
    return {
      rule: rule === 'same_working_day' ? 'Same working day' : 'By the next working day',
      clientMessages: cur.length,
      replied: replied.length,
      sameDayPct: cmp(rate(cur), rate(prev)),
      avgReplyMin: avg(replied.map((t) => workingMinutesBetween(t.at, t.replyAt!, cal))),
    };
  }
}
