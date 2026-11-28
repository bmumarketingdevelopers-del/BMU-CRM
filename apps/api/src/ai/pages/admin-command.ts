// Ask BMU page skills for the Command Centre's Command, Dashboards, Intelligence and Analytics pages.
// See ./types.ts for the contract and ./access.ts for who sees each tab.
// Not here (core Ask BMU answers already cover them): Weekly Review, Scorecard, Team Performance, Client Health,
// Goals and Approvals.
import { ForbiddenException } from '@nestjs/common';
import { formatINR, leadStageLabels, opsDimensionLabels, opsMetricInfo, type Me } from '@bmu/shared';
import { AnalyticsService } from '../../analytics/analytics.service.js';
import { DashboardsService } from '../../dashboards/dashboards.service.js';
import { canReadCommand } from '../../insights/access.js';
import { InsightsService } from '../../insights/insights.service.js';
import { AlertsService } from '../../intelligence/alerts.service.js';
import { IntelligenceController } from '../../intelligence/intelligence.controller.js';
import { ReportsService } from '../../intelligence/reports.service.js';
import { LeadsController } from '../../leads/leads.controller.js';
import { OpsDeliveryService } from '../../ops-analytics/delivery.service.js';
import { OpsExploreService } from '../../ops-analytics/explore.service.js';
import { OpsSlaService } from '../../ops-analytics/sla.service.js';
import { redact } from '../ai-safety.js';
import { admin } from './access.js';
import { bullets, day, link, plural, svc, type PageSkill } from './types.js';

const inr = (paise: number | null | undefined) => (paise === null || paise === undefined ? null : formatINR(paise));
const pctText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);
const num = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '—' : `${v}${unit}`);
const was = (prev: string | null) => (prev && prev !== '—' ? ` (previous period ${prev})` : '');
const minutes = (m: number | null | undefined) => (m === null || m === undefined ? '—' : m < 60 ? `${Math.round(m)} min` : `${Math.round((m / 60) * 10) / 10} h`);
const range = (p: { from: string; to: string }) => `${day(p.from)} – ${day(p.to)}`;
const insightLines = (xs: { text: string }[]) => xs.slice(0, 3).map((i) => i.text);
/** Command Centre pages whose API is for the Command Centre readers (HR opens the menu item but the API says no). */
const command = (label: string) => (me: Me) => admin(label)(me) && canReadCommand(me);

// ------------------------------------------------------------------------------------------------ data shapes

export type PipelineData = { open: number; openValue: string | null; stages: { stage: string; count: number; value: string | null }[]; top: { name: string; stage: string; value: string | null; owner: string | null; nextFollowUp: string | null }[] };
export type RevenueData = { period: string; revenue: string; previousMonth: string | null; invoiced: string; collected: string; creditNotes: string; mrr: string; activeRetainers: number; byService: { label: string; value: string }[]; byClient: { label: string; value: string }[]; split: { label: string; value: string }[] };
export type CollectionsData = { outstanding: string; overdue: string; collectedThisMonth: string; avgDaysToPay: number | null; aging: { label: string; value: string; count: number }[]; latest: { number: string; client: string; balance: string; due: string | null; daysOverdue: number }[] };
export type CapacityData = { weekHours: number; departments: { name: string; people: number; openTasks: number; dueThisWeek: number; overdue: number; hours: number; utilisation: number; checkedIn: number }[]; overloaded: string[]; idle: number };
export type QualityData = { checks: number; passRate: number | null; firstTimeRight: number | null; avgRevisionRounds: number | null; clientChangeRequests: number; lastWeek: number | null; weekBefore: number | null; byDepartment: { label: string; checks: number; passRate: number }[]; byFlow: { label: string; checks: number; passRate: number }[]; topFailures: { label: string; count: number }[] };
export type StudioData = { builtins: { name: string; who: string; widgets: number; customised: boolean }[]; custom: { name: string; who: string; where: string; widgets: number; updated: string | null; updatedBy: string | null }[]; archived: number };
export type ForecastRisksData = { computed: string | null; revenue: { nextMonth: string; target: string | null; months: { label: string; expected: string }[] } | null; churn: { title: string; score: number | null; why: string[] }[]; win: { title: string; chance: number | null; value: string | null }[]; slip: { title: string; score: number | null; why: string[] }[]; capacity: { title: string; score: number | null }[] };
export type MetricsData = { from: string; to: string; metrics: { label: string; value: string; previous: number | null; changePct: number | null; direction: 'higher' | 'lower' }[] };
export type AlertsData = { alerts: { name: string; summary: string; active: boolean; lastFired: string | null }[]; events: { alert: string; subject: string; message: string; when: string | null }[] };
export type ScheduledReportsData = { reports: { name: string; schedule: string; active: boolean; recipients: number; nextRun: string | null; lastSent: string | null; failed: boolean }[] };
export type FunnelData = { period: string; leads: number; prevLeads: number; winRate: number | null; prevWinRate: number | null; stages: { label: string; count: number; prevCount: number }[]; medianHoursToFirstReply: number | null; bySource: { label: string; leads: number; won: number; conversion: number | null }[]; lostReasons: { label: string; count: number }[]; insights: string[] };
export type RevenueForecastData = { mrr: string; atRiskMrr: string; target: string; totals: { committed: string; weighted: string; expected: string; best: string; worst: string }; months: { label: string; expected: string | null; best: string | null; worst: string | null }[]; deals: { name: string; stage: string; value: string; chance: number; month: string }[]; insights: string[] };
export type RetentionData = { period: string; mrrStart: string; mrrEnd: string; prevMrrEnd: string; newMrr: string; expansion: string; contraction: string; churned: string; clients: number; prevClients: number; logoChurn: number | null; prevLogoChurn: number | null; revenueChurn: number | null; prevRevenueChurn: number | null; nrr: number | null; prevNrr: number | null; avgLifetimeMonths: number | null; top3Share: number | null; movements: { client: string; kind: string; from: string; to: string }[]; insights: string[] };
export type ProfitData = { period: string; revenue: string; cost: string; margin: string; marginPct: number | null; prevMarginPct: number | null; hours: number; costPerHour: string | null; clients: { name: string; revenue: string; margin: string; marginPct: number | null; hours: number }[]; services: { name: string; revenue: string; margin: string; marginPct: number | null }[]; insights: string[] };
export type DeliveryData = { period: string; approved: { value: number | null; prev: number | null }; cycleDays: { value: number | null; prev: number | null }; onTimePct: { value: number | null; prev: number | null }; revisionRounds: { value: number | null; prev: number | null }; bottleneck: string | null; steps: { label: string; avgDays: number | null; prevAvgDays: number | null }[]; byType: { type: string; count: number; avgDays: number | null }[]; wip: { title: string; client: string; status: string; ageDays: number; owner: string | null; overdue: boolean }[]; insights: string[] };
export type SlaData = { period: string; requests: { value: number | null; prev: number | null }; withinPct: { value: number | null; prev: number | null }; avgReplyMin: { value: number | null; prev: number | null }; breaches: { value: number | null; prev: number | null }; openPastSla: number; byType: { label: string; target: string; count: number; within: number | null; breaches: number }[]; managers: { name: string; requests: number; avgReply: string; within: number | null; breaches: number }[]; slowest: { client: string; type: string; waiting: string; text: string }[]; insights: string[] };
export type SavedReportsData = { mine: { name: string; metric: string; by: string; pinned: boolean; shared: boolean; updated: string | null }[]; shared: { name: string; metric: string; by: string; owner: string; updated: string | null }[] };

// ------------------------------------------------------------------------------------------------ answers

const kindLabel: Record<string, string> = { new: 'new', expansion: 'grew', contraction: 'shrank', churn: 'left' };

export const SKILLS: PageSkill[] = [
  {
    name: 'page_admin_pipeline',
    label: 'Pipeline',
    href: '/admin/pipeline',
    surface: 'admin',
    can: (me) => admin('Pipeline')(me) && (me.permissions.leads_pipeline?.scope ?? 'none') !== 'none',
    keywords: /\b(pipeline (by stage|value|worth|stages?|board|total)|leads (by|per|in each) stage|how much is (in )?(the |our )?pipeline|pipeline is worth)\b/,
    examples: ['How much is in the pipeline by stage?', 'What is our pipeline value?'],
    description: 'Open leads by stage with their budget, and the biggest open leads with owner and next follow-up.',
    load: async (ref, me) => {
      if ((me.permissions.leads_pipeline?.scope ?? 'none') === 'none') throw new ForbiddenException("Your role doesn't include the sales pipeline");
      const rows = await svc(ref, LeadsController).list(me);
      const open = rows.filter((l) => l.stage !== 'won' && l.stage !== 'lost');
      const sum = (xs: typeof rows) => xs.reduce((s, l) => s + (l.budgetPaise ?? 0), 0);
      return {
        open: open.length,
        openValue: inr(sum(open)),
        stages: (Object.keys(leadStageLabels) as (keyof typeof leadStageLabels)[]).map((k) => {
          const xs = rows.filter((l) => l.stage === k);
          return { stage: leadStageLabels[k], count: xs.length, value: inr(sum(xs)) };
        }),
        top: [...open]
          .sort((a, b) => (b.budgetPaise ?? 0) - (a.budgetPaise ?? 0) || b.score - a.score)
          .slice(0, 10)
          .map((l) => ({ name: l.contact.company || l.contact.name, stage: leadStageLabels[l.stage], value: inr(l.budgetPaise), owner: l.owner?.name ?? null, nextFollowUp: day(l.nextFollowUpAt) })),
      } satisfies PipelineData;
    },
    answer: (d: PipelineData) => {
      if (!d.stages.some((s) => s.count)) return `There are no leads on the board yet. See ${link('Pipeline', '/admin/pipeline')}.`;
      return [
        `${plural(d.open, 'open lead')} worth ${d.openValue} in budgets.`,
        bullets(d.stages.filter((s) => s.count).map((s) => `${s.stage}: ${s.count} (${s.value})`)),
        d.top.length ? `Biggest open leads:\n${bullets(d.top.map((l) => `${l.name} · ${l.stage}${l.value && l.value !== formatINR(0) ? ` · ${l.value}` : ''}${l.owner ? ` · ${l.owner}` : ' · no owner'}${l.nextFollowUp ? ` · follow up ${l.nextFollowUp}` : ''}`))}` : '',
        `See ${link('Pipeline', '/admin/pipeline')}.`,
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'page_admin_revenue',
    label: 'Revenue',
    href: '/admin/revenue',
    surface: 'admin',
    can: admin('Revenue'),
    keywords: /\b(revenue (by|per) (service|client)s?|revenue (split|breakdown|mix)|(which|what) (services?|clients?) (bring|brings|brought|earn|earns|make|makes|made) (us )?(the )?most|top (earning|paying) clients|active retainers)\b/,
    examples: ['Show revenue by service', 'Which clients bring the most revenue?'],
    description: 'This month: revenue before GST (and last month invoiced), invoiced, collected, credit notes, MRR and retainers, revenue by service, by client and the split.',
    load: async (ref, me) => {
      const r = await svc(ref, InsightsService).revenue(me, 'month');
      const prev = r.byMonth.at(-2);
      return {
        period: r.periodLabel,
        revenue: formatINR(r.revenuePaise),
        previousMonth: prev ? `${prev.label}: ${formatINR(prev.invoicedPaise)} invoiced` : null,
        invoiced: formatINR(r.invoicedPaise),
        collected: formatINR(r.collectedPaise),
        creditNotes: formatINR(r.creditNotesPaise),
        mrr: formatINR(r.mrrPaise),
        activeRetainers: r.activeRetainers,
        byService: r.byService.slice(0, 10).map((x) => ({ label: x.label, value: formatINR(x.valuePaise) })),
        byClient: r.byClient.slice(0, 10).map((x) => ({ label: x.label, value: formatINR(x.valuePaise) })),
        split: r.split.filter((x) => x.valuePaise > 0).map((x) => ({ label: x.label, value: formatINR(x.valuePaise) })),
      } satisfies RevenueData;
    },
    answer: (d: RevenueData, q) => {
      const byClient = /\bclients?\b/.test(q) && !/\bservices?\b/.test(q);
      const rows = byClient ? d.byClient : d.byService;
      return [
        `${d.period}: revenue ${d.revenue} before GST (${d.invoiced} invoiced, ${d.collected} collected${d.creditNotes !== formatINR(0) ? `, ${d.creditNotes} in credit notes` : ''}).${d.previousMonth ? ` Last month ${d.previousMonth}.` : ''}`,
        `MRR ${d.mrr} from ${plural(d.activeRetainers, 'active retainer')}.`,
        rows.length ? `By ${byClient ? 'client' : 'service'}:\n${bullets(rows.map((x) => `${x.label}: ${x.value}`))}` : 'Nothing invoiced yet this month.',
        d.split.length ? `Split: ${d.split.map((x) => `${x.label} ${x.value}`).join(', ')}.` : '',
        `See ${link('Revenue', '/admin/revenue')}.`,
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'page_admin_collections',
    label: 'Collections',
    href: '/admin/collections',
    surface: 'admin',
    can: admin('Collections'),
    keywords: /\b((receivables? )?age?ing|days to pay|take to pay|collections? (summary|dashboard|page|aging|ageing)|collected this month)\b/,
    examples: ['Show the receivables ageing', 'How long do clients take to pay?'],
    description: 'Outstanding and overdue totals, ageing buckets, collected this month, average days to pay, and the most overdue unpaid invoices.',
    load: async (ref, me) => {
      const c = await svc(ref, InsightsService).collections(me);
      return {
        outstanding: formatINR(c.outstandingPaise),
        overdue: formatINR(c.overduePaise),
        collectedThisMonth: formatINR(c.collectedThisMonthPaise),
        avgDaysToPay: c.avgDaysToPay,
        aging: c.aging.map((a) => ({ label: a.label, value: formatINR(a.valuePaise), count: a.count })),
        latest: c.unpaid.slice(0, 10).map((i) => ({ number: i.number, client: i.client, balance: formatINR(i.balancePaise), due: day(i.dueDate), daysOverdue: i.daysOverdue })),
      } satisfies CollectionsData;
    },
    answer: (d: CollectionsData) => {
      const head = `Outstanding ${d.outstanding}, of which ${d.overdue} is overdue. Collected this month: ${d.collectedThisMonth}.${d.avgDaysToPay !== null ? ` Clients take ${d.avgDaysToPay} days to pay on average (last 6 months).` : ''}`;
      if (!d.latest.length) return `${head}\nNothing is unpaid right now. See ${link('Collections', '/admin/collections')}.`;
      return [
        head,
        `Ageing:\n${bullets(d.aging.filter((a) => a.count).map((a) => `${a.label}: ${a.value} (${plural(a.count, 'invoice')})`))}`,
        `Most overdue:\n${bullets(d.latest.map((i) => `${i.number} · ${i.client} · ${i.balance}${i.daysOverdue ? ` · ${i.daysOverdue} days late` : i.due ? ` · due ${i.due}` : ''}`))}`,
        `See ${link('Collections', '/admin/collections')}.`,
      ].join('\n');
    },
  },
  {
    // The Team app has its own Capacity tab (people's load); this one answers the department view of the Command Centre.
    name: 'page_admin_capacity',
    label: 'Capacity',
    href: '/admin/capacity',
    surface: 'admin',
    can: admin('Capacity'),
    keywords: /\b(department capacity|capacity (by|per|of each|across|for each|of) (departments?|teams?)|departments? (load|capacity|utili[sz]ation)|which department (is|has) (the )?(most|least|busiest))\b/,
    examples: ['Show capacity by department', 'Which department has the most open work?'],
    description: 'This week per department: people, open tasks, due this week, overdue, hours logged, utilisation and who is checked in today; plus overloaded people.',
    load: async (ref, me) => {
      const c = await svc(ref, InsightsService).capacity(me);
      return {
        weekHours: c.weekHours,
        departments: c.departments.slice(0, 15).map((d) => ({ name: d.name, people: d.people, openTasks: d.openTasks, dueThisWeek: d.dueThisWeek, overdue: d.overdue, hours: d.hoursThisWeek, utilisation: d.utilisation, checkedIn: d.checkedIn })),
        overloaded: c.people.filter((p) => p.flag === 'overloaded').slice(0, 10).map((p) => `${p.name}${p.department ? ` (${p.department})` : ''}: ${p.openTasks} open`),
        idle: c.people.filter((p) => p.flag === 'idle').length,
      } satisfies CapacityData;
    },
    answer: (d: CapacityData) => {
      if (!d.departments.length) return `No active team members to show. See ${link('Capacity', '/admin/capacity')}.`;
      return [
        `This week by department (${d.weekHours} h a person):`,
        bullets(d.departments.map((x) => `${x.name}: ${plural(x.people, 'person', 'people')}, ${x.openTasks} open tasks (${x.dueThisWeek} due this week, ${x.overdue} overdue), ${x.hours} h logged, ${x.utilisation}% used, ${x.checkedIn} checked in today`)),
        d.overloaded.length ? `Overloaded:\n${bullets(d.overloaded)}` : 'Nobody is overloaded.',
        d.idle ? `${plural(d.idle, 'person has', 'people have')} no open tasks.` : '',
        `See ${link('Capacity', '/admin/capacity')}.`,
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'page_admin_quality',
    label: 'Quality',
    href: '/admin/quality',
    surface: 'admin',
    can: admin('Quality'),
    keywords: /\b(first[- ]time[- ]right|checklist items? (fail|fails|failing|failed|missed)|(most )?common failures|top failures|revision rounds|pass rates? (by|per|for each) (department|flow|service)s?)\b/,
    examples: ['What is our first-time-right rate?', 'Which checklist items fail most often?'],
    description: 'Last 12 weeks of QC: checks, pass rate (this week vs last), first-time-right, average revision rounds, client change requests, pass rate by department and flow, and the checklist items that fail most.',
    load: async (ref, me) => {
      const v = await svc(ref, InsightsService).quality(me);
      return {
        checks: v.checks,
        passRate: v.passRate,
        firstTimeRight: v.firstTimeRight,
        avgRevisionRounds: v.avgRevisionRounds,
        clientChangeRequests: v.clientChangeRequests,
        lastWeek: v.trend.at(-1)?.passRate ?? null,
        weekBefore: v.trend.at(-2)?.passRate ?? null,
        byDepartment: v.byDepartment.slice(0, 10),
        byFlow: v.byFlow.slice(0, 10),
        topFailures: v.topFailures.map((f) => ({ label: redact(f.label), count: f.count })),
      } satisfies QualityData;
    },
    answer: (d: QualityData) => {
      if (!d.checks) return `No checks in the last 12 weeks. See ${link('Quality', '/admin/quality')}.`;
      return [
        `Last 12 weeks: ${plural(d.checks, 'check')}, ${pctText(d.passRate)} passed, ${pctText(d.firstTimeRight)} first time right${d.avgRevisionRounds !== null ? `, ${d.avgRevisionRounds} revision rounds on average` : ''}, ${plural(d.clientChangeRequests, 'client change request')}.`,
        d.lastWeek !== null ? `This week ${pctText(d.lastWeek)} passed${d.weekBefore !== null ? ` (last week ${d.weekBefore}%)` : ''}.` : '',
        d.byDepartment.length ? `By department:\n${bullets(d.byDepartment.map((x) => `${x.label}: ${x.passRate}% of ${plural(x.checks, 'check')}`))}` : '',
        d.topFailures.length ? `Items that fail most:\n${bullets(d.topFailures.map((f) => `${f.label} (${f.count})`))}` : '',
        `See ${link('Quality', '/admin/quality')}.`,
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'page_admin_dashboard_studio',
    label: 'Dashboard Studio',
    href: '/admin/dashboards',
    surface: 'admin',
    can: admin('Dashboard Studio'),
    keywords: /\b(dashboard studio|custom dashboards?|built[- ]in dashboards?|archived dashboards?|(which|what|how many) dashboards)\b/,
    examples: ['Which custom dashboards do we have?', 'How many dashboards are in Dashboard Studio?'],
    description: 'Built-in dashboards (customised or not), custom dashboards with who sees them, where they show and when they were last changed, and how many are archived.',
    load: async (ref, me) => {
      const s = await svc(ref, DashboardsService).studio(me);
      return {
        builtins: s.builtins.map((b) => ({ name: b.name, who: b.who, widgets: b.widgets, customised: b.customised })),
        custom: s.custom.slice(0, 15).map((c) => ({ name: c.name, who: c.who, where: c.where, widgets: c.widgets, updated: day(c.updatedAt), updatedBy: c.updatedBy })),
        archived: s.archived.length,
      } satisfies StudioData;
    },
    answer: (d: StudioData) =>
      [
        `${plural(d.builtins.length, 'built-in dashboard')}${d.builtins.some((b) => b.customised) ? ` (${d.builtins.filter((b) => b.customised).map((b) => b.name).join(', ')} customised)` : ''}, ${plural(d.custom.length, 'custom dashboard')}${d.archived ? `, ${d.archived} archived` : ''}.`,
        d.custom.length ? `Custom dashboards:\n${bullets(d.custom.map((c) => `${c.name} · ${c.who || 'nobody yet'} · ${c.where} · ${plural(c.widgets, 'widget')}${c.updated ? ` · changed ${c.updated}${c.updatedBy ? ` by ${c.updatedBy}` : ''}` : ''}`))}` : 'No custom dashboards yet.',
        `See ${link('Dashboard Studio', '/admin/dashboards')}.`,
      ].join('\n'),
  },
  {
    name: 'page_admin_forecast_risks',
    label: 'Forecast & Risks',
    href: '/admin/intelligence',
    surface: 'admin',
    can: command('Forecast & Risks'),
    keywords: /\b(forecast (and|&) risks?|deals? (are )?(likely|most likely|going) to (close|win)|which deals will close|(tasks?|work) (is |are )?(likely to|may|might|could) slip|where (is )?the team (is )?short|churn (forecast|predictions?))\b/,
    examples: ['Which deals are likely to close?', 'What work may slip?'],
    description: 'Forecasts with reasons: revenue for the coming months (money roles), clients likely to leave, deals likely to close, tasks that may miss their deadline and where the team is short.',
    load: async (ref, me) => {
      const o = await svc(ref, IntelligenceController).overview(me);
      const why = (r: { label: string }[]) => r.slice(0, 2).map((x) => redact(x.label));
      return {
        computed: day(o.computedAt),
        revenue: o.revenue ? { nextMonth: formatINR(o.revenue.nextMonthPaise), target: o.revenue.targetPaise ? formatINR(o.revenue.targetPaise) : null, months: o.revenue.months.slice(0, 6).map((m) => ({ label: m.label, expected: formatINR(m.expectedPaise) })) } : null,
        churn: o.churn.slice(0, 8).map((f) => ({ title: f.title, score: f.score, why: why(f.reasons) })),
        win: o.win.slice(0, 8).map((f) => ({ title: f.title, chance: f.score, value: f.value ? formatINR(f.value) : null })),
        slip: o.slip.slice(0, 8).map((f) => ({ title: redact(f.title), score: f.score, why: why(f.reasons) })),
        capacity: o.capacity.slice(0, 6).map((f) => ({ title: f.title, score: f.score })),
      } satisfies ForecastRisksData;
    },
    answer: (d: ForecastRisksData, q) => {
      const end = `See ${link('Forecast & Risks', '/admin/intelligence')}.`;
      const deals = d.win.length ? `Deals most likely to close:\n${bullets(d.win.map((w) => `${w.title}: ${num(w.chance, '%')} chance${w.value ? ` · ${w.value}` : ''}`))}` : 'No open deals to forecast.';
      const slip = d.slip.length ? `Work that may slip:\n${bullets(d.slip.map((s) => `${s.title}: risk ${num(s.score)}${s.why.length ? ` (${s.why.join('; ')})` : ''}`))}` : 'No work looks likely to slip.';
      const churn = d.churn.length ? `Clients who may leave:\n${bullets(d.churn.map((c) => `${c.title}: risk ${num(c.score)}${c.why.length ? ` (${c.why.join('; ')})` : ''}`))}` : 'No client looks likely to leave.';
      const short = d.capacity.length ? `Where the team is short:\n${bullets(d.capacity.map((c) => `${c.title}${c.score !== null ? `: ${c.score}%` : ''}`))}` : '';
      const rev = d.revenue ? `Revenue expected next month: ${d.revenue.nextMonth}${d.revenue.target ? ` (target ${d.revenue.target})` : ''}.` : '';
      const stamp = d.computed ? `Worked out on ${d.computed}.` : '';
      if (/\b(deals?|close|win)\b/.test(q)) return [deals, stamp, end].filter(Boolean).join('\n');
      if (/\b(slip|tasks?|work|deadlines?)\b/.test(q)) return [slip, stamp, end].filter(Boolean).join('\n');
      if (/\b(short|capacity)\b/.test(q)) return [short || 'No team looks short right now.', stamp, end].filter(Boolean).join('\n');
      return [rev, churn, deals, slip, short, stamp, end].filter(Boolean).join('\n');
    },
  },
  {
    name: 'page_admin_metrics',
    label: 'Metrics',
    href: '/admin/intelligence/metrics',
    surface: 'admin',
    can: command('Metrics'),
    keywords: /\b(metrics|metric layer|key metrics)\b/,
    examples: ['Show the key metrics', 'How are our metrics changing?'],
    description: 'Every metric this role may see for the last 30 days, with the 30 days before and the change.',
    load: async (ref, me) => {
      const all = await svc(ref, IntelligenceController).allMetrics(me);
      return {
        from: day(all[0]?.from) ?? '',
        to: day(all[0]?.to) ?? '',
        metrics: all.map((m) => ({ label: m.label, value: m.display, previous: m.previous, changePct: m.changePct, direction: m.direction })),
      } satisfies MetricsData;
    },
    answer: (d: MetricsData) => {
      if (!d.metrics.length) return `No metrics are shown to your role. See ${link('Metrics', '/admin/intelligence/metrics')}.`;
      const change = (m: MetricsData['metrics'][number]) => {
        if (m.changePct === null || m.changePct === 0) return m.changePct === 0 ? ' · no change' : '';
        const good = m.direction === 'higher' ? m.changePct > 0 : m.changePct < 0;
        return ` · ${m.changePct > 0 ? 'up' : 'down'} ${Math.abs(m.changePct)}% on the 30 days before${good ? '' : ' (worse)'}`;
      };
      return [`Last 30 days${d.from ? ` (${d.from} – ${d.to})` : ''}:`, bullets(d.metrics.map((m) => `${m.label}: ${m.value}${change(m)}`), 20), `See ${link('Metrics', '/admin/intelligence/metrics')}.`].join('\n');
    },
  },
  {
    name: 'page_admin_alerts',
    label: 'Alerts',
    href: '/admin/intelligence/alerts',
    surface: 'admin',
    can: command('Alerts'),
    keywords: /\b(metric alerts?|anomaly alerts?|anomal(y|ies)|alerts? (fired|triggered|went off|rules?|set up)|(which|what|any|recent) alerts)\b/,
    examples: ['Which alerts fired recently?', 'Any anomaly alerts?'],
    description: 'Alert rules on metrics (what each watches, on or off, last fired) and the alerts that fired recently.',
    load: async (ref, me) => {
      const a = await svc(ref, AlertsService).list(me);
      return {
        alerts: a.alerts.slice(0, 20).map((x) => ({ name: redact(x.name), summary: x.summary, active: x.active, lastFired: day(x.lastFiredAt) })),
        events: a.events.slice(0, 10).map((e) => ({ alert: redact(e.alertName), subject: e.subject, message: redact(e.message), when: day(e.createdAt) })),
      } satisfies AlertsData;
    },
    answer: (d: AlertsData) => {
      const on = d.alerts.filter((a) => a.active).length;
      return [
        `${plural(d.alerts.length, 'alert rule')} (${on} on).`,
        d.events.length ? `Recently fired:\n${bullets(d.events.map((e) => `${e.when ?? ''}: ${e.alert}${e.subject ? ` · ${e.subject}` : ''} · ${e.message}`))}` : 'No alert has fired recently.',
        `See ${link('Alerts', '/admin/intelligence/alerts')}.`,
      ].join('\n');
    },
  },
  {
    name: 'page_admin_scheduled_reports',
    label: 'Scheduled Reports',
    href: '/admin/intelligence/reports',
    surface: 'admin',
    can: command('Scheduled Reports'),
    keywords: /\b(scheduled reports?|report schedules?|reports? (are |is )?(scheduled|emailed|sent out)|emailed reports?)\b/,
    examples: ['Which scheduled reports do we have?', 'When is the next scheduled report going out?'],
    description: 'Reports emailed on a schedule: name, schedule, on or off, number of recipients, next run, last sent and whether the last send failed.',
    load: async (ref, me) => {
      const r = await svc(ref, ReportsService).list(me);
      return {
        reports: r.reports.slice(0, 20).map((x) => ({ name: redact(x.name), schedule: x.schedule, active: x.active, recipients: x.recipients.length, nextRun: x.active ? day(x.nextRunAt) : null, lastSent: day(x.lastSentAt), failed: !!x.lastError })),
      } satisfies ScheduledReportsData;
    },
    answer: (d: ScheduledReportsData) => {
      if (!d.reports.length) return `No scheduled reports yet. Set one up on ${link('Scheduled Reports', '/admin/intelligence/reports')}.`;
      return [
        `${plural(d.reports.length, 'scheduled report')} (${d.reports.filter((r) => r.active).length} on):`,
        bullets(d.reports.map((r) => `${r.name} · ${r.schedule} · ${plural(r.recipients, 'recipient')}${r.active ? (r.nextRun ? ` · next ${r.nextRun}` : '') : ' · off'}${r.lastSent ? ` · last sent ${r.lastSent}` : ''}${r.failed ? ' · last send failed' : ''}`)),
        `See ${link('Scheduled Reports', '/admin/intelligence/reports')}.`,
      ].join('\n');
    },
  },
  {
    name: 'page_admin_sales_funnel',
    label: 'Sales Funnel',
    href: '/admin/analytics/funnel',
    surface: 'admin',
    can: admin('Sales Funnel'),
    keywords: /\b(sales funnel|funnel|win rate|lost reasons?|why (do |did )?we lose|lead sources?|conversion (by|per) (source|service)|speed to lead)\b/,
    examples: ['Show the sales funnel', 'What is our win rate and why do we lose deals?'],
    description: 'Last 90 days vs the 90 before: leads, stage counts, win rate, time to first reply, conversion by lead source and the reasons deals are lost.',
    load: async (ref, me) => {
      const f = await svc(ref, AnalyticsService).funnel(me);
      return {
        period: range(f.period),
        leads: f.leadsCount,
        prevLeads: f.prevLeadsCount,
        winRate: f.winRatePct,
        prevWinRate: f.prevWinRatePct,
        stages: f.stages.map((s) => ({ label: s.label, count: s.count, prevCount: s.prevCount })),
        medianHoursToFirstReply: f.speed.medianHours,
        bySource: f.bySource.slice(0, 8).map((s) => ({ label: s.label, leads: s.leads, won: s.won, conversion: s.conversionPct })),
        lostReasons: f.lostReasons.slice(0, 6).map((r) => ({ label: redact(r.label), count: r.count })),
        insights: insightLines(f.insights),
      } satisfies FunnelData;
    },
    answer: (d: FunnelData) => {
      if (!d.leads && !d.prevLeads) return `No leads in ${d.period}. See ${link('Sales Funnel', '/admin/analytics/funnel')}.`;
      return [
        `${d.period}: ${plural(d.leads, 'lead')}${was(String(d.prevLeads))}, win rate ${pctText(d.winRate)}${was(pctText(d.prevWinRate))}.${d.medianHoursToFirstReply !== null ? ` First reply to a lead in ${d.medianHoursToFirstReply} h (median).` : ''}`,
        `Funnel:\n${bullets(d.stages.map((s) => `${s.label}: ${s.count} (before ${s.prevCount})`))}`,
        d.bySource.length ? `By source:\n${bullets(d.bySource.map((s) => `${s.label}: ${s.leads} leads, ${s.won} won (${pctText(s.conversion)})`))}` : '',
        d.lostReasons.length ? `Why deals are lost: ${d.lostReasons.map((r) => `${r.label} (${r.count})`).join(', ')}.` : '',
        bullets(d.insights),
        `See ${link('Sales Funnel', '/admin/analytics/funnel')}.`,
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'page_admin_revenue_forecast',
    label: 'Revenue Forecast',
    href: '/admin/analytics/forecast',
    surface: 'admin',
    can: admin('Revenue Forecast'),
    keywords: /\b(revenue forecast|forecast(ed)? revenue|expected revenue|best (and|or) worst case|committed revenue|weighted pipeline)\b/,
    examples: ['What is the revenue forecast?', 'Show best and worst case revenue'],
    description: 'Next 6 months: committed (retainers and balances), weighted deals, expected, best and worst case against the target; MRR and MRR at risk; the biggest deals with their chance.',
    load: async (ref, me) => {
      const f = await svc(ref, AnalyticsService).forecast(me);
      const m = (p: number | null) => inr(p);
      return {
        mrr: formatINR(f.mrrPaise),
        atRiskMrr: formatINR(f.atRiskMrrPaise),
        target: formatINR(f.targetPaise),
        totals: { committed: formatINR(f.totals.committedPaise), weighted: formatINR(f.totals.weightedPaise), expected: formatINR(f.totals.expectedPaise), best: formatINR(f.totals.bestPaise), worst: formatINR(f.totals.worstPaise) },
        months: f.months.filter((x) => x.future).map((x) => ({ label: x.label, expected: m(x.expectedPaise), best: m(x.bestPaise), worst: m(x.worstPaise) })),
        deals: [...f.deals].sort((a, b) => b.weightedPaise - a.weightedPaise).slice(0, 10).map((x) => ({ name: x.name, stage: x.stageLabel, value: formatINR(x.valuePaise), chance: x.probabilityPct, month: x.expectedMonth })),
        insights: insightLines(f.insights),
      } satisfies RevenueForecastData;
    },
    answer: (d: RevenueForecastData) =>
      [
        `Next 6 months: ${d.totals.expected} expected (best ${d.totals.best}, worst ${d.totals.worst}); ${d.totals.committed} committed and ${d.totals.weighted} from weighted deals.`,
        `MRR ${d.mrr}${d.atRiskMrr !== formatINR(0) ? `, ${d.atRiskMrr} of it at risk` : ''}. Monthly target ${d.target}.`,
        d.months.length ? `By month:\n${bullets(d.months.map((x) => `${x.label}: ${x.expected ?? '—'} (best ${x.best ?? '—'}, worst ${x.worst ?? '—'})`))}` : '',
        d.deals.length ? `Biggest deals:\n${bullets(d.deals.map((x) => `${x.name} · ${x.stage} · ${x.value} · ${x.chance}% chance · ${x.month}`))}` : '',
        bullets(d.insights),
        `See ${link('Revenue Forecast', '/admin/analytics/forecast')}.`,
      ].filter(Boolean).join('\n'),
  },
  {
    name: 'page_admin_mrr_retention',
    label: 'MRR & Retention',
    href: '/admin/analytics/retention',
    surface: 'admin',
    can: admin('MRR & Retention'),
    keywords: /\b(mrr|monthly recurring|retention|churn rate|logo churn|revenue churn|nrr|net revenue retention|client lifetime|revenue concentration)\b/,
    examples: ['What is our MRR and churn rate?', 'Show net revenue retention'],
    description: 'Last 90 days vs the 90 before: MRR start/end and its movement (new, expansion, contraction, churn), retainer clients, logo and revenue churn, NRR, average lifetime, top-3 concentration and client movements.',
    load: async (ref, me) => {
      const r = await svc(ref, AnalyticsService).retention(me);
      return {
        period: range(r.period),
        mrrStart: formatINR(r.waterfall.startPaise),
        mrrEnd: formatINR(r.waterfall.endPaise),
        prevMrrEnd: formatINR(r.prevWaterfall.endPaise),
        newMrr: formatINR(r.waterfall.newPaise),
        expansion: formatINR(r.waterfall.expansionPaise),
        contraction: formatINR(r.waterfall.contractionPaise),
        churned: formatINR(r.waterfall.churnPaise),
        clients: r.retainerClients,
        prevClients: r.prevRetainerClients,
        logoChurn: r.logoChurnPct,
        prevLogoChurn: r.prevLogoChurnPct,
        revenueChurn: r.revenueChurnPct,
        prevRevenueChurn: r.prevRevenueChurnPct,
        nrr: r.nrrPct,
        prevNrr: r.prevNrrPct,
        avgLifetimeMonths: r.avgLifetimeMonths,
        top3Share: r.concentration.top3Pct,
        movements: r.movements.slice(0, 10).map((m) => ({ client: m.client, kind: m.kind, from: formatINR(m.startPaise), to: formatINR(m.endPaise) })),
        insights: insightLines(r.insights),
      } satisfies RetentionData;
    },
    answer: (d: RetentionData) =>
      [
        `${d.period}: MRR ${d.mrrStart} → ${d.mrrEnd}${was(d.prevMrrEnd)}. New ${d.newMrr}, grew ${d.expansion}, shrank ${d.contraction}, lost ${d.churned}.`,
        `${plural(d.clients, 'retainer client')}${was(String(d.prevClients))}. Logo churn ${pctText(d.logoChurn)}${was(pctText(d.prevLogoChurn))}, revenue churn ${pctText(d.revenueChurn)}${was(pctText(d.prevRevenueChurn))}, net revenue retention ${pctText(d.nrr)}${was(pctText(d.prevNrr))}.`,
        [d.avgLifetimeMonths !== null ? `Clients stay ${d.avgLifetimeMonths} months on average.` : '', d.top3Share !== null ? `The top 3 clients bring ${d.top3Share}% of revenue.` : ''].filter(Boolean).join(' '),
        d.movements.length ? `Changes:\n${bullets(d.movements.map((m) => `${m.client} ${kindLabel[m.kind] ?? m.kind}: ${m.from} → ${m.to}`))}` : '',
        bullets(d.insights),
        `See ${link('MRR & Retention', '/admin/analytics/retention')}.`,
      ].filter(Boolean).join('\n'),
  },
  {
    name: 'page_admin_profitability',
    label: 'Profitability',
    href: '/admin/analytics/profitability',
    surface: 'admin',
    can: admin('Profitability'),
    keywords: /\b(profitab(le|ility)|margins? (by|per|for each) (client|service)s?|(client|service) margins?|cost per hour|effective hourly rate)\b/,
    examples: ['Which clients are most profitable?', 'Show margin by service'],
    description: 'Last 90 days vs the 90 before: revenue, team and creator cost, margin and margin %, hours, cost of an hour; margin by client and by service.',
    load: async (ref, me) => {
      const p = await svc(ref, AnalyticsService).profitability(me);
      return {
        period: range(p.period),
        revenue: formatINR(p.totals.revenuePaise),
        cost: formatINR(p.totals.costPaise),
        margin: formatINR(p.totals.marginPaise),
        marginPct: p.totals.marginPct,
        prevMarginPct: p.prevTotals.marginPct,
        hours: p.totals.hours,
        costPerHour: inr(p.avgCostPerHourPaise),
        clients: [...p.clients].sort((a, b) => b.marginPaise - a.marginPaise).slice(0, 10).map((c) => ({ name: c.name, revenue: formatINR(c.revenuePaise), margin: formatINR(c.marginPaise), marginPct: c.marginPct, hours: c.hours })),
        services: [...p.services].sort((a, b) => b.marginPaise - a.marginPaise).slice(0, 10).map((c) => ({ name: c.name, revenue: formatINR(c.revenuePaise), margin: formatINR(c.marginPaise), marginPct: c.marginPct })),
        insights: insightLines(p.insights),
      } satisfies ProfitData;
    },
    answer: (d: ProfitData, q) => {
      const byService = /\bservices?\b/.test(q);
      const head = `${d.period}: revenue ${d.revenue}, cost ${d.cost}, margin ${d.margin} (${pctText(d.marginPct)}${was(pctText(d.prevMarginPct))}) over ${d.hours} h${d.costPerHour ? `; an hour costs ${d.costPerHour}` : ''}.`;
      const rows = byService ? d.services.map((s) => `${s.name}: ${s.margin} on ${s.revenue} (${pctText(s.marginPct)})`) : d.clients.map((c) => `${c.name}: ${c.margin} on ${c.revenue} (${pctText(c.marginPct)}, ${c.hours} h)`);
      return [head, rows.length ? `${byService ? 'By service' : 'By client'}, highest margin first:\n${bullets(rows)}` : 'Nothing billed in this period yet.', bullets(d.insights), `See ${link('Profitability', '/admin/analytics/profitability')}.`].filter(Boolean).join('\n');
    },
  },
  {
    name: 'page_admin_delivery_speed',
    label: 'Delivery Speed',
    href: '/admin/analytics/delivery',
    surface: 'admin',
    can: admin('Delivery Speed'),
    // "delivery" itself is answered earlier from the person's own My Day; these are this page's own words.
    keywords: /\b(delivery speed|cycle time|turnaround( time)?|how fast (do|are) we|bottlenecks?|work in progress|wip|gate steps?)\b/,
    examples: ['What is our average cycle time?', 'Where is the bottleneck in production?'],
    description: 'Last 90 days vs the 90 before: pieces approved, average cycle days, on-time %, revision rounds, time spent at each step, the bottleneck, by type, and the oldest work in progress.',
    load: async (ref, me) => {
      const v = await svc(ref, OpsDeliveryService).delivery(me, {});
      return {
        period: range(v.range),
        approved: v.totals.approved,
        cycleDays: v.totals.avgCycleDays,
        onTimePct: v.totals.onTimePct,
        revisionRounds: v.totals.avgRevisionRounds,
        bottleneck: v.bottleneck,
        steps: v.steps.map((s) => ({ label: s.label, avgDays: s.avgDays, prevAvgDays: s.prevAvgDays })),
        byType: v.byType.slice(0, 8).map((t) => ({ type: t.type, count: t.count, avgDays: t.avgDays })),
        wip: [...v.wip].sort((a, b) => b.ageDays - a.ageDays).slice(0, 10).map((w) => ({ title: redact(w.title), client: w.client, status: w.status.replace(/_/g, ' '), ageDays: w.ageDays, owner: w.owner, overdue: w.overdue })),
        insights: insightLines(v.insights),
      } satisfies DeliveryData;
    },
    answer: (d: DeliveryData) =>
      [
        `${d.period}: ${num(d.approved.value)} approved${was(num(d.approved.prev))}, ${num(d.cycleDays.value)} days from start to approval on average${was(num(d.cycleDays.prev))}, ${pctText(d.onTimePct.value)} on time${was(pctText(d.onTimePct.prev))}, ${num(d.revisionRounds.value)} revision rounds${was(num(d.revisionRounds.prev))}.`,
        d.bottleneck ? `Bottleneck: ${d.bottleneck}.` : '',
        d.steps.length ? `Days at each step:\n${bullets(d.steps.map((s) => `${s.label}: ${num(s.avgDays)}${s.prevAvgDays !== null ? ` (before ${s.prevAvgDays})` : ''}`))}` : '',
        d.wip.length ? `Oldest work in progress:\n${bullets(d.wip.map((w) => `${w.title} · ${w.client} · ${w.status} · ${w.ageDays} days${w.owner ? ` · ${w.owner}` : ''}${w.overdue ? ' · overdue' : ''}`))}` : 'Nothing is in progress.',
        bullets(d.insights),
        `See ${link('Delivery Speed', '/admin/analytics/delivery')}.`,
      ].filter(Boolean).join('\n'),
  },
  {
    name: 'page_admin_sla_response',
    label: 'SLA & Response',
    href: '/admin/analytics/sla',
    surface: 'admin',
    can: admin('SLA & Response'),
    keywords: /\b(sla (compliance|breach(es)?|report|performance|by type)|sla (&|and) response|response times?|within sla|reply times? (by|per) (type|request type|client manager)|slowest repl(y|ies))\b/,
    examples: ['How is our SLA compliance?', 'Show response times by request type'],
    description: 'Last 90 days vs the 90 before: client requests, % replied within target, average reply time, breaches, by request type and by Client Manager, and the open requests waiting longest.',
    load: async (ref, me) => {
      const v = await svc(ref, OpsSlaService).sla(me, {});
      return {
        period: range(v.range),
        requests: v.totals.requests,
        withinPct: v.totals.withinPct,
        avgReplyMin: v.totals.avgReplyMin,
        breaches: v.totals.breaches,
        openPastSla: v.totals.openPastSla,
        byType: v.byType.map((t) => ({ label: t.label, target: minutes(t.targetMin), count: t.count, within: t.withinPct, breaches: t.breaches })),
        managers: v.ams.slice(0, 10).map((a) => ({ name: a.name, requests: a.requests, avgReply: minutes(a.avgReplyMin), within: a.withinPct, breaches: a.breaches })),
        slowest: v.slowest.slice(0, 8).map((r) => ({ client: r.client, type: r.typeLabel, waiting: minutes(r.waitingMin), text: redact(r.description).slice(0, 80) })),
        insights: insightLines(v.insights),
      } satisfies SlaData;
    },
    answer: (d: SlaData, q) => {
      if (!d.requests.value && !d.requests.prev) return `No client requests in ${d.period}. See ${link('SLA & Response', '/admin/analytics/sla')}.`;
      const managers = /\b(client managers?|account managers?|who|managers?)\b/.test(q);
      return [
        `${d.period}: ${plural(d.requests.value ?? 0, 'request')}${was(num(d.requests.prev))}, ${pctText(d.withinPct.value)} replied within target${was(pctText(d.withinPct.prev))}, average reply ${minutes(d.avgReplyMin.value)}${was(minutes(d.avgReplyMin.prev))}, ${num(d.breaches.value)} breaches${was(num(d.breaches.prev))}. ${d.openPastSla} open past target now.`,
        managers && d.managers.length
          ? `By Client Manager:\n${bullets(d.managers.map((m) => `${m.name}: ${m.requests} requests, ${pctText(m.within)} within target, average ${m.avgReply}, ${m.breaches} breaches`))}`
          : d.byType.length
            ? `By type:\n${bullets(d.byType.map((t) => `${t.label} (target ${t.target}): ${t.count} requests, ${pctText(t.within)} within, ${t.breaches} breaches`))}`
            : '',
        d.slowest.length ? `Waiting longest:\n${bullets(d.slowest.map((r) => `${r.client} · ${r.type} · waiting ${r.waiting}${r.text ? ` · ${r.text}` : ''}`))}` : '',
        bullets(d.insights),
        `See ${link('SLA & Response', '/admin/analytics/sla')}.`,
      ].filter(Boolean).join('\n');
    },
  },
  {
    name: 'page_admin_report_builder',
    label: 'Report Builder',
    href: '/admin/analytics/explore',
    surface: 'admin',
    can: admin('Report Builder'),
    keywords: /\b(report builder|saved reports?|shared reports?|pinned reports?)\b/,
    examples: ['Which saved reports do we have?', 'Show the reports in the report builder'],
    description: 'Saved Report Builder reports: mine (pinned, shared) and those others shared, with the metric and grouping each shows.',
    load: async (ref, me) => {
      const r = await svc(ref, OpsExploreService).reports(me);
      const what = (c: { metric: string; dimension: string }) => ({ metric: opsMetricInfo[c.metric as keyof typeof opsMetricInfo]?.label ?? c.metric, by: opsDimensionLabels[c.dimension as keyof typeof opsDimensionLabels] ?? c.dimension });
      return {
        mine: r.mine.slice(0, 15).map((x) => ({ name: redact(x.name), ...what(x.config), pinned: x.pinned, shared: x.shared, updated: day(x.updatedAt) })),
        shared: r.shared.filter((x) => !x.mine).slice(0, 15).map((x) => ({ name: redact(x.name), ...what(x.config), owner: x.owner, updated: day(x.updatedAt) })),
      } satisfies SavedReportsData;
    },
    answer: (d: SavedReportsData) => {
      if (!d.mine.length && !d.shared.length) return `No saved reports yet. Build one on ${link('Report Builder', '/admin/analytics/explore')}.`;
      return [
        d.mine.length ? `Your saved reports:\n${bullets(d.mine.map((r) => `${r.name}: ${r.metric} by ${r.by.toLowerCase()}${r.pinned ? ' · pinned' : ''}${r.shared ? ' · shared' : ''}${r.updated ? ` · ${r.updated}` : ''}`))}` : 'You have no saved reports of your own.',
        d.shared.length ? `Shared by others:\n${bullets(d.shared.map((r) => `${r.name}: ${r.metric} by ${r.by.toLowerCase()} · ${r.owner}`))}` : '',
        `See ${link('Report Builder', '/admin/analytics/explore')}.`,
      ].filter(Boolean).join('\n');
    },
  },
];
