// Ask BMU page skills for the Team app's work tabs (Projects, Review Studio, calendars, capacity, reports, inboxes,
// onboarding, HR issues, discussions, SOPs, docs). See ./types.ts for the contract and ./access.ts for who sees each tab.
// Every lookup is the same service call the page's controller makes, with the signed-in person (`me`).
import {
  deliverableStatusLabels,
  deliverChannelLabels,
  GATES,
  HR_ISSUE_CATEGORIES,
  HR_ISSUE_STATUSES,
  type CalendarItem,
  type DeliverCalendarItem,
} from '@bmu/shared';
import { AgentsService } from '../../agents/agents.service.js';
import { DocsService } from '../../comms/docs.service.js';
import { CraftManagerService } from '../../craft/craft-manager.service.js';
import { CraftService } from '../../craft/craft.service.js';
import { DashboardsService } from '../../dashboards/dashboards.service.js';
import { DeliverCalendarService } from '../../deliver/deliver-calendar.service.js';
import { EngagementsService } from '../../engagements/engagements.service.js';
import { HrIssuesService } from '../../hr-issues/hr-issues.service.js';
import { CapacityService } from '../../money/capacity.service.js';
import { OpsCommsService } from '../../ops-actions/ops-comms.service.js';
import { ProductionService } from '../../production/production.service.js';
import { PeopleService } from '../../team-flows/people.service.js';
import { TeamWorkspaceService } from '../../workspace/team.service.js';
import { redact } from '../ai-safety.js';
import { team } from './access.js';
import { bullets, day, dayShort, link, plural, svc, type PageSkill } from './types.js';

/** yyyy-mm-dd in IST. */
const istDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const istMonthOf = (ymd: string) => ymd.slice(0, 7);
const nextMonth = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
};
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const words = (q: string) => q.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
const gateName = (id: string) => GATES.find((g) => g.id === id)?.name ?? id;
const statusLabel = (s: string) => (deliverableStatusLabels as Record<string, string>)[s] ?? s.replace(/_/g, ' ');
const channelLabel = (c: string | null) => (c ? ((deliverChannelLabels as Record<string, string>)[c] ?? c) : null);
const DONE_PROJECTS = ['delivered', 'closed', 'offboarding'];

// ---------------------------------------------------------------------------------------------------------------
// Data shapes returned by load() (and used by answer() and the spec).

export type ProjectsData = {
  live: number;
  delivered: number;
  waitingOnInputs: number;
  plansDue: number;
  lateDeliverables: number;
  atRiskDeliverables: number;
  byGate: { gate: string; count: number }[];
  projects: { client: string; service: string; gate: string; am: string | null; inputsOutstanding: number; planningDue: string | null; late: number; link: string }[];
};
export type ReviewsData = { total: number; byStage: { stage: string; count: number }[]; items: { title: string; client: string; type: string; stage: string; link: string }[] };
export type ContentCalendarData = {
  from: string;
  to: string;
  upcoming: { title: string; client: string; channel: string | null; when: string | null; stage: string }[];
  upcomingCount: number;
  dueToPublish: { title: string; client: string; when: string | null }[];
  unscheduled: number;
};
export type CalendarData = { from: string; to: string; counts: { kind: string; count: number }[]; items: { date: string; kind: string; title: string; sub: string | null; overdue: boolean }[] };
export type CapacityData = {
  scope: string;
  week: string;
  me: { open: number; dueThisWeek: number; overdue: number; loadPct: number } | null;
  people: { name: string; department: string | null; open: number; overdue: number; loadPct: number; onLeave: boolean }[];
  unassigned: number;
  unassignedTop: { title: string; client: string | null; deadline: string | null }[];
};
export type WorkloadData = {
  week: string | null;
  people: { name: string; specialty: string | null; loadPct: number | null; hours: number; available: number; leaveDays: number }[];
  over: number;
  requests: number;
};
export type SpecialistsData = { count: number; specialists: { name: string; specialty: string; department: string | null; open: number; overdue: number; dueThisWeek: number; doneLast30: number }[] };
export type DailyReportsData = { date: string; filed: string[]; notFiled: string[]; blocked: { name: string; items: string[] }[] };
export type AgentInboxData = { pending: number; toDecide: number; proposals: { agent: string; action: string; title: string; why: string; canDecide: boolean; expires: string | null }[] };
export type DashboardsData = { dashboards: { name: string; description: string | null; link: string }[] };
export type ManagerData = {
  scope: string;
  kpis: { label: string; value: string }[];
  insights: string[];
  openTasks: number;
  unassigned: number;
  overdue: number;
  today: { title: string; detail: string; client: string | null }[];
  overloaded: { name: string; loadPct: number }[];
  onLeave: string[];
};
export type OnboardingData = {
  onboarding: { status: string; startDate: string | null; buddy: string | null; done: number; total: number; progressPct: number; remaining: string[] } | null;
};
export type HrIssuesData = {
  mine: { subject: string; category: string; status: string; raised: string | null; reply: string | null }[];
  answers: boolean;
  inbox: { subject: string; from: string | null; category: string; status: string; raised: string | null }[];
};
export type DiscussionsData = { total: number; unreadThreads: number; unreadMessages: number; threads: { title: string; client: string | null; unread: number; last: { author: string; at: string | null; body: string } | null; link: string }[] };
export type SopsData = { count: number; sops: { title: string; department: string; version: number; link: string }[] };
export type DocsData = { count: number; docs: { title: string; kind: string; client: string | null; updatedBy: string | null; updated: string | null; clientVisible: boolean; link: string }[] };

// ---------------------------------------------------------------------------------------------------------------

export const SKILLS: PageSkill[] = [
  {
    name: 'page_projects',
    label: 'Projects',
    href: '/team/projects',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(projects?|project board|waiting on client inputs?)\b/,
    examples: ['How many live projects do we have?', 'Which projects are waiting on client inputs?'],
    description: 'Projects (paid services) you can see: live/delivered counts, how many wait on client inputs or a plan, late deliverables, count per milestone gate, and the live projects.',
    load: async (ref, me) => {
      const rows = await svc(ref, EngagementsService).list(me);
      const live = rows.filter((e) => !DONE_PROJECTS.includes(e.status));
      return {
        live: live.length,
        delivered: rows.filter((e) => e.status === 'delivered').length,
        waitingOnInputs: live.filter((e) => e.requirementsOutstanding > 0).length,
        plansDue: live.filter((e) => e.planningDue && e.planStatus !== 'approved').length,
        lateDeliverables: live.reduce((n, e) => n + (e.slaOverdue ?? 0), 0),
        atRiskDeliverables: live.reduce((n, e) => n + (e.slaAtRisk ?? 0), 0),
        byGate: GATES.map((g) => ({ gate: `${g.id} ${g.name}`, count: live.filter((e) => e.currentGate === g.id).length })),
        projects: [...live]
          .sort((a, b) => (b.slaOverdue ?? 0) - (a.slaOverdue ?? 0) || b.requirementsOutstanding - a.requirementsOutstanding)
          .slice(0, 15)
          .map((e) => ({
            client: e.client.name,
            service: e.serviceName,
            gate: gateName(e.currentGate),
            am: e.am?.name ?? null,
            inputsOutstanding: e.requirementsOutstanding,
            planningDue: day(e.planningDue),
            late: e.slaOverdue ?? 0,
            link: `/team/projects/${e.id}`,
          })),
      } satisfies ProjectsData;
    },
    answer: (d: ProjectsData, q) => {
      const page = link('Projects', '/team/projects');
      if (!d.live && !d.delivered) return `There are no projects you can see yet. ${page}`;
      const waiting = /\b(waiting|inputs?|requirements?)\b/.test(q);
      const rows = (waiting ? d.projects.filter((p) => p.inputsOutstanding > 0) : d.projects).map(
        (p) =>
          `${link(`${p.client} · ${p.service}`, p.link)}: ${p.gate}${p.inputsOutstanding ? `, ${plural(p.inputsOutstanding, 'client input')} outstanding` : ''}${p.late ? `, ${p.late} late` : ''}${p.am ? ` (${p.am})` : ''}`,
      );
      const head = waiting
        ? d.waitingOnInputs
          ? `${plural(d.waitingOnInputs, 'live project')} ${d.waitingOnInputs === 1 ? 'is' : 'are'} waiting on client inputs:`
          : 'No live project is waiting on client inputs.'
        : `${plural(d.live, 'live project')}, ${d.delivered} delivered. ${d.waitingOnInputs} waiting on client inputs, ${d.plansDue} with a plan due${d.lateDeliverables || d.atRiskDeliverables ? `, ${d.lateDeliverables} deliverables late and ${d.atRiskDeliverables} at risk` : ''}.\nBy milestone: ${d.byGate.map((g) => `${g.gate} ${g.count}`).join(' · ')}`;
      return [head, bullets(rows), `Open ${page}.`].filter(Boolean).join('\n');
    },
  },
  {
    name: 'page_review_studio',
    label: 'Review Studio',
    href: '/team/reviews',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(review studio|versions? (in|for) review)\b/,
    examples: ["What's in the Review Studio?", 'Review Studio summary'],
    description: 'Deliverables from the tasks you can see, grouped by stage (QC passed, ready for client, changes requested, in QC…), with the most actionable first.',
    load: async (ref, me) => {
      const tasks = await svc(ref, ProductionService).tasks(me, 'team');
      const order = ['qc_passed', 'ready_for_client', 'changes_requested', 'in_qc', 'qc_failed', 'in_production', 'planned', 'approved', 'scheduled', 'published'];
      const seen = new Map<string, { id: string; title: string; type: string; status: string; client: string }>();
      for (const t of tasks) if (t.deliverable && !seen.has(t.deliverable.id)) seen.set(t.deliverable.id, { ...t.deliverable, client: t.client?.name ?? '' });
      const rows = [...seen.values()].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
      const counts = new Map<string, number>();
      for (const r of rows) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
      return {
        total: rows.length,
        byStage: [...counts].map(([s, count]) => ({ stage: statusLabel(s), count })),
        items: rows.slice(0, 10).map((r) => ({ title: redact(r.title), client: r.client, type: r.type, stage: statusLabel(r.status), link: `/team/deliverables/${r.id}` })),
      } satisfies ReviewsData;
    },
    answer: (d: ReviewsData) => {
      const page = link('Review Studio', '/team/reviews');
      if (!d.total) return `No deliverables in Review Studio yet. They appear when a client approves a plan. ${page}`;
      return [
        `${plural(d.total, 'deliverable')} in Review Studio: ${d.byStage.map((s) => `${s.count} ${s.stage.toLowerCase()}`).join(', ')}.`,
        bullets(d.items.map((i) => `${link(i.title, i.link)} · ${i.client || 'no client'} · ${i.type} (${i.stage})`)),
        `Open ${page}.`,
      ].join('\n');
    },
  },
  {
    name: 'page_content_calendar',
    label: 'Content calendar',
    href: '/team/content-calendar',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(content calendar|posting calendar|scheduled posts?|due to publish|posts? (to|waiting to) publish)\b/,
    examples: ["What's on the content calendar this week?", 'Which posts are due to publish?'],
    description: 'Posts, reels and ads scheduled for the next 14 days, scheduled posts whose time has passed but are not marked published, and approved social work with no date yet.',
    load: async (ref, me) => {
      const from = new Date(`${istDay()}T00:00:00+05:30`);
      const to = new Date(from.getTime() + 14 * 86_400_000);
      const v = await svc(ref, DeliverCalendarService).team(me, from.toISOString(), to.toISOString());
      const row = (i: DeliverCalendarItem) => ({ title: redact(i.title), client: i.client.name, channel: channelLabel(i.channel), when: dayShort(i.scheduledAt ?? i.publishedAt), stage: statusLabel(i.status) });
      return {
        from: day(from)!,
        to: day(new Date(to.getTime() - 1))!,
        upcoming: v.items.slice(0, 15).map(row),
        upcomingCount: v.items.length,
        dueToPublish: (v.dueToPublish ?? []).slice(0, 10).map((i) => ({ title: redact(i.title), client: i.client.name, when: dayShort(i.scheduledAt) })),
        unscheduled: v.unscheduled.length,
      } satisfies ContentCalendarData;
    },
    answer: (d: ContentCalendarData, q) => {
      const page = link('Content calendar', '/team/content-calendar');
      const out: string[] = [];
      const dueFirst = /\b(due|publish|passed|late)\b/.test(q);
      const due = d.dueToPublish.length
        ? `${plural(d.dueToPublish.length, 'scheduled post')} ${d.dueToPublish.length === 1 ? 'is' : 'are'} past ${d.dueToPublish.length === 1 ? 'its' : 'their'} time and not marked published:\n${bullets(d.dueToPublish.map((p) => `${p.when}: ${p.title} · ${p.client}`))}`
        : 'Nothing is waiting to be marked published.';
      const upcoming = d.upcomingCount
        ? `${plural(d.upcomingCount, 'post')} on the calendar from ${d.from} to ${d.to}:\n${bullets(d.upcoming.map((p) => `${p.when ?? 'no date'}: ${p.title} · ${p.client}${p.channel ? ` · ${p.channel}` : ''} (${p.stage})`))}`
        : `Nothing is scheduled from ${d.from} to ${d.to}.`;
      out.push(...(dueFirst ? [due, upcoming] : [upcoming, due]));
      if (d.unscheduled) out.push(`${plural(d.unscheduled, 'approved post')} still ${d.unscheduled === 1 ? 'has' : 'have'} no date.`);
      out.push(`Open ${page}.`);
      return out.join('\n');
    },
  },
  {
    name: 'page_calendar',
    label: 'Calendar',
    href: '/team/calendar',
    surface: 'team',
    can: team.everyone,
    keywords: /(?<!content |posting )\bcalendar\b/,
    examples: ['Show my calendar for this month', "What's coming up on the calendar?"],
    description: 'Your calendar for the next 14 days: task deadlines, deliverables and drafts due, meetings, social posts, leave and holidays.',
    load: async (ref, me) => {
      const today = istDay();
      const until = istDay(new Date(Date.now() + 14 * 86_400_000));
      const s = svc(ref, TeamWorkspaceService);
      const month = istMonthOf(today);
      const views = [await s.calendar(me, month, 'mine')];
      if (istMonthOf(until) !== month) views.push(await s.calendar(me, nextMonth(month), 'mine'));
      const items = views
        .flatMap((v) => v.items)
        .filter((i: CalendarItem) => i.date >= today && i.date <= until && !i.done)
        .sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? ''));
      const counts = new Map<string, number>();
      for (const i of items) counts.set(i.kind, (counts.get(i.kind) ?? 0) + 1);
      const KIND: Record<string, string> = { task: 'task deadlines', deliverable: 'deliverables due', draft_due: 'first drafts due', meeting: 'meetings', post: 'social posts', leave: 'leave', holiday: 'holidays' };
      return {
        from: day(`${today}T00:00:00+05:30`)!,
        to: day(`${until}T00:00:00+05:30`)!,
        counts: [...counts].map(([k, count]) => ({ kind: KIND[k] ?? k, count })),
        items: items.slice(0, 15).map((i) => ({ date: `${dayShort(`${i.date}T00:00:00+05:30`)}${i.time ? ` ${i.time}` : ''}`, kind: KIND[i.kind] ?? i.kind, title: redact(i.title), sub: i.sub ? redact(i.sub) : null, overdue: !!i.overdue })),
      } satisfies CalendarData;
    },
    answer: (d: CalendarData) => {
      const page = link('Calendar', '/team/calendar');
      if (!d.items.length) return `Nothing on your calendar from ${d.from} to ${d.to}. ${page}`;
      return [
        `From ${d.from} to ${d.to}: ${d.counts.map((c) => `${c.count} ${c.kind}`).join(', ')}.`,
        bullets(d.items.map((i) => `${i.date}: ${i.title}${i.sub ? ` · ${i.sub}` : ''}${i.overdue ? ' (overdue)' : ''}`), 15),
        `Open ${page}.`,
      ].join('\n');
    },
  },
  {
    name: 'page_capacity',
    label: 'Capacity',
    href: '/team/capacity',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(capacity|who has room|has (the )?room)\b/,
    examples: ['Show team capacity this week', 'Who has room this week?'],
    description: "This week's load per person in your scope (open tasks, due this week, overdue, load %), who is on leave, your own load, and unassigned work.",
    load: async (ref, me) => {
      const v = await svc(ref, TeamWorkspaceService).capacity(me);
      return {
        scope: v.scopeLabel,
        week: `${dayShort(v.week.from)} to ${dayShort(v.week.to)}`,
        me: v.me ? { open: v.me.open, dueThisWeek: v.me.dueThisWeek, overdue: v.me.overdue, loadPct: v.me.loadPct } : null,
        people: [...v.people].sort((a, b) => a.loadPct - b.loadPct).map((p) => ({ name: p.name, department: p.department, open: p.open, overdue: p.overdue, loadPct: p.loadPct, onLeave: p.onLeave })),
        unassigned: v.unassigned.length,
        unassignedTop: v.unassigned.slice(0, 5).map((u) => ({ title: redact(u.title), client: u.client, deadline: dayShort(u.deadline) })),
      } satisfies CapacityData;
    },
    answer: (d: CapacityData, q) => {
      const page = link('Capacity', '/team/capacity');
      const out: string[] = [`Capacity for ${d.scope}, week of ${d.week}.`];
      if (d.me) out.push(`You: ${d.me.loadPct}% loaded, ${plural(d.me.open, 'open task')}, ${d.me.dueThisWeek} due this week${d.me.overdue ? `, ${d.me.overdue} overdue` : ''}.`);
      const others = d.people.filter((p) => !p.onLeave);
      if (others.length) {
        const room = others.filter((p) => p.loadPct < 80);
        const rows = (/\b(room|free|available)\b/.test(q) ? room : [...others].reverse()).map((p) => `${p.name}${p.department ? ` (${p.department})` : ''}: ${p.loadPct}% · ${p.open} open${p.overdue ? `, ${p.overdue} overdue` : ''}`);
        out.push(/\b(room|free|available)\b/.test(q) ? (room.length ? `Has room (under 80%):\n${bullets(rows)}` : 'Nobody is under 80% this week.') : `Most loaded first:\n${bullets(rows)}`);
      }
      const away = d.people.filter((p) => p.onLeave).map((p) => p.name);
      if (away.length) out.push(`On leave: ${away.join(', ')}.`);
      if (d.unassigned) out.push(`${plural(d.unassigned, 'task')} with no owner${d.unassignedTop.length ? `, e.g. ${d.unassignedTop.map((u) => u.title).join('; ')}` : ''}.`);
      out.push(`Open ${page}.`);
      return out.join('\n');
    },
  },
  {
    name: 'page_workload',
    label: 'Workload',
    href: '/team/workload',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(workloads?|booked hours|hours (are )?booked|over ?booked)\b/,
    examples: ['Show the workload for this week', 'How many hours are booked this week?'],
    description: "This week's booked and task hours against each person's available hours (load %), who is over 100%, and booking requests waiting.",
    load: async (ref, me) => {
      const v = await svc(ref, CapacityService).workload(me, {});
      const week = v.weeks[0] ?? null;
      const people = v.people.map((p) => {
        const c = p.cells.find((x) => x.weekStart === week) ?? p.cells[0];
        return { name: p.name, specialty: p.specialty, loadPct: c?.loadPct ?? null, hours: Math.round(((c?.bookedHours ?? 0) + (c?.taskHours ?? 0)) * 10) / 10, available: c?.availableHours ?? 0, leaveDays: c?.leaveDays ?? 0 };
      });
      people.sort((a, b) => (b.loadPct ?? -1) - (a.loadPct ?? -1));
      return { week: week ? day(week) : null, people: people.slice(0, 15), over: people.filter((p) => (p.loadPct ?? 0) > 100).length, requests: v.requests.length } satisfies WorkloadData;
    },
    answer: (d: WorkloadData) => {
      const page = link('Workload', '/team/workload');
      if (!d.people.length) return `No one's workload is visible to you yet. ${page}`;
      const total = d.people.reduce((n, p) => n + p.hours, 0);
      return [
        `Week of ${d.week ?? 'this week'}: ${Math.round(total)} hours booked or on tasks across ${plural(d.people.length, 'person', 'people')}${d.over ? `, ${d.over} over 100%` : ''}.`,
        bullets(d.people.map((p) => `${p.name}${p.specialty ? ` (${p.specialty})` : ''}: ${p.hours} of ${p.available} h${p.loadPct === null ? ' (not available)' : ` · ${p.loadPct}%`}${p.leaveDays ? ` · ${p.leaveDays} leave day${p.leaveDays === 1 ? '' : 's'}` : ''}`)),
        d.requests ? `${plural(d.requests, 'booking request')} waiting.` : '',
        `Open ${page}.`,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'page_specialists',
    label: 'Specialists',
    href: '/team/specialists',
    surface: 'team',
    can: team.specialists,
    keywords: /\bspecialists?\b/,
    examples: ['How busy are the specialists?', 'Show the specialists list'],
    description: 'Specialists you lead: specialty, open, overdue and due-this-week work, and work done in the last 30 days.',
    load: async (ref, me) => {
      const rows = await svc(ref, CraftService).specialists(me);
      return {
        count: rows.length,
        specialists: [...rows].sort((a, b) => b.overdue - a.overdue || b.open - a.open).slice(0, 15).map((r) => ({ name: r.name, specialty: r.specialtyLabel, department: r.department, open: r.open, overdue: r.overdue, dueThisWeek: r.dueThisWeek, doneLast30: r.doneLast30 })),
      } satisfies SpecialistsData;
    },
    answer: (d: SpecialistsData) => {
      const page = link('Specialists', '/team/specialists');
      if (!d.count) return `No specialists in your team yet. ${page}`;
      const overdue = d.specialists.filter((s) => s.overdue).length;
      return [
        `${plural(d.count, 'specialist')}${overdue ? `, ${overdue} with overdue work` : ''}:`,
        bullets(d.specialists.map((s) => `${s.name} (${s.specialty}): ${s.open} open, ${s.dueThisWeek} due this week${s.overdue ? `, ${s.overdue} overdue` : ''}, ${s.doneLast30} done in 30 days`), 15),
        `Open ${page}.`,
      ].join('\n');
    },
  },
  {
    name: 'page_daily_reports',
    label: 'Daily reports',
    href: '/team/reports',
    surface: 'team',
    can: team.dailyReports,
    // The core "eod" check answers "have I filed" and "how many filed"; this is who has not, and what is blocked.
    keywords: /\b(who (hasn'?t|has not|haven'?t|have not|didn'?t|did not) (filed|submitted|sent)|not (yet )?(filed|submitted)|missing (a |an |their )?reports?)\b/,
    examples: ["Who hasn't filed today?", 'Who is missing their report today?'],
    description: "Today's end-of-day reports from the people you oversee: who filed, who has not, and what they reported blocked.",
    load: async (ref, me) => {
      const v = await svc(ref, ProductionService).teamEod(me);
      return {
        date: day(`${v.date}T00:00:00+05:30`)!,
        filed: v.people.filter((p) => p.report).map((p) => p.name),
        notFiled: v.people.filter((p) => !p.report).map((p) => p.name),
        blocked: v.people.filter((p) => p.report?.blocked.length).map((p) => ({ name: p.name, items: p.report!.blocked.slice(0, 3).map((b) => cut(redact(b), 120)) })),
      } satisfies DailyReportsData;
    },
    answer: (d: DailyReportsData) => {
      const page = link('Daily reports', '/team/reports');
      const total = d.filed.length + d.notFiled.length;
      if (!total) return `Nobody reports to you yet. ${page}`;
      const out = [
        d.notFiled.length ? `${d.notFiled.length} of ${total} have not filed their report for ${d.date}: ${d.notFiled.join(', ')}.` : `Everyone (${total}) has filed their report for ${d.date}.`,
      ];
      if (d.filed.length && d.notFiled.length) out.push(`Filed: ${d.filed.join(', ')}.`);
      if (d.blocked.length) out.push(`Blocked:\n${bullets(d.blocked.map((b) => `${b.name}: ${b.items.join('; ')}`))}`);
      out.push(`Open ${page}.`);
      return out.join('\n');
    },
  },
  {
    name: 'page_agent_inbox',
    label: 'Agent Inbox',
    href: '/team/agent-inbox',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(agent inbox|agent proposals?|agents? (suggest|propos)\w*|proposals? from (the )?agents?)\b/,
    examples: ["What's waiting in the agent inbox?", 'Any agent proposals to decide?'],
    description: 'AI agent proposals waiting for a decision (the ones you may decide), with what each agent wants to do and why.',
    load: async (ref, me) => {
      // Same call as the page: it also marks proposals past their expiry as expired.
      const rows = await svc(ref, AgentsService).inbox(me, 'pending');
      return {
        pending: rows.length,
        toDecide: rows.filter((r) => r.canDecide).length,
        proposals: rows.slice(0, 10).map((r) => ({ agent: r.agentLabel, action: r.actionLabel, title: redact(r.title), why: cut(redact(r.why), 140), canDecide: r.canDecide, expires: dayShort(r.expiresAt) })),
      } satisfies AgentInboxData;
    },
    answer: (d: AgentInboxData) => {
      const page = link('Agent Inbox', '/team/agent-inbox');
      if (!d.pending) return `Nothing is waiting in your Agent Inbox. ${page}`;
      return [
        `${plural(d.pending, 'agent proposal')} waiting${d.toDecide !== d.pending ? `, ${d.toDecide} for you to decide` : ''}:`,
        bullets(d.proposals.map((p) => `${p.agent}: ${p.action}: ${p.title}${p.why ? ` (${p.why})` : ''}${p.expires ? ` · expires ${p.expires}` : ''}`)),
        `Approve or reject them in ${page}.`,
      ].join('\n');
    },
  },
  {
    name: 'page_dashboards',
    label: 'Dashboards',
    href: '/team/dashboards',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(dashboards|shared dashboards?|dashboards? (shared|made) (with|for) me)\b/,
    examples: ['Which dashboards are shared with me?'],
    description: 'Dashboards made in the Dashboard Studio and shared with you.',
    load: async (ref, me) => {
      const rows = await svc(ref, DashboardsService).mine(me);
      return { dashboards: rows.slice(0, 20).map((d) => ({ name: d.name, description: d.description ? cut(redact(d.description), 120) : null, link: `/team/dashboards/${d.id}` })) } satisfies DashboardsData;
    },
    answer: (d: DashboardsData) => {
      const page = link('Dashboards', '/team/dashboards');
      if (!d.dashboards.length) return `No dashboards have been shared with you yet. ${page}`;
      return [`${plural(d.dashboards.length, 'dashboard')} shared with you:`, bullets(d.dashboards.map((x) => `${link(x.name, x.link)}${x.description ? `: ${x.description}` : ''}`), 20), `Open ${page}.`].join('\n');
    },
  },
  {
    name: 'page_manager_workspace',
    label: 'Manager workspace',
    href: '/team/manager',
    surface: 'team',
    can: team.managerWorkspace,
    keywords: /\b(manager workspace|manager board|unassigned (work|tasks?)|assign work)\b/,
    examples: ["What's on the manager workspace today?", 'How many unassigned tasks are there?'],
    description: "The manager workspace for your scope: headline numbers, insights, open/unassigned/overdue work, today's items that need you, and who is overloaded or on leave.",
    load: async (ref, me) => {
      const v = await svc(ref, CraftManagerService).view(me);
      const fmt = (k: { value: number; format: string }) => (k.format === 'pct' ? `${k.value}%` : k.format === 'hours' ? `${k.value} h` : k.format === 'days' ? `${k.value} days` : String(k.value));
      return {
        scope: v.scopeLabel,
        kpis: v.kpis.slice(0, 8).map((k) => ({ label: k.label, value: fmt(k) })),
        insights: v.insights.slice(0, 5).map((i) => cut(redact(i), 160)),
        openTasks: v.board.length,
        unassigned: v.board.filter((t) => !t.owner).length,
        overdue: v.board.filter((t) => t.overdue).length,
        today: v.today.slice(0, 8).map((t) => ({ title: redact(t.title), detail: cut(redact(t.detail), 100), client: t.client })),
        overloaded: v.members.filter((m) => m.loadPct > 100).map((m) => ({ name: m.name, loadPct: m.loadPct })),
        onLeave: v.members.filter((m) => m.onLeaveToday).map((m) => m.name),
      } satisfies ManagerData;
    },
    answer: (d: ManagerData) => {
      const page = link('Manager workspace', '/team/manager');
      const out = [`Manager workspace (${d.scope}): ${plural(d.openTasks, 'open task')}, ${d.unassigned} unassigned, ${d.overdue} overdue.`];
      if (d.kpis.length) out.push(d.kpis.map((k) => `${k.label}: ${k.value}`).join(' · '));
      if (d.today.length) out.push(`Needs you today:\n${bullets(d.today.map((t) => `${t.title}${t.client ? ` · ${t.client}` : ''}${t.detail ? `: ${t.detail}` : ''}`))}`);
      if (d.insights.length) out.push(bullets(d.insights));
      if (d.overloaded.length) out.push(`Over capacity: ${d.overloaded.map((m) => `${m.name} (${m.loadPct}%)`).join(', ')}.`);
      if (d.onLeave.length) out.push(`On leave today: ${d.onLeave.join(', ')}.`);
      out.push(`Open ${page}.`);
      return out.join('\n');
    },
  },
  {
    name: 'page_onboarding',
    label: 'My onboarding',
    href: '/team/onboarding',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(my onboarding|onboarding (checklist|progress|steps?|status))\b/,
    examples: ['How far along is my onboarding?', "What's left on my onboarding checklist?"],
    description: 'Your own onboarding checklist: progress, buddy, start date and the steps still to do.',
    load: async (ref, me) => {
      // Same call as the page (it also ticks the steps the system can confirm, e.g. SOPs acknowledged).
      const rows = await svc(ref, PeopleService).mine(me);
      const p = rows.find((r) => r.status === 'open') ?? rows[0];
      return {
        onboarding: p
          ? { status: p.status, startDate: day(p.startDate), buddy: p.buddy?.name ?? null, done: p.doneCount, total: p.items.length, progressPct: p.progressPct, remaining: p.items.filter((i) => !i.done).map((i) => i.label) }
          : null,
      } satisfies OnboardingData;
    },
    answer: (d: OnboardingData) => {
      const page = link('My onboarding', '/team/onboarding');
      const o = d.onboarding;
      if (!o) return `You have no onboarding checklist. ${page}`;
      if (o.status === 'done' || !o.remaining.length) return `Your onboarding is complete (${o.done} of ${o.total} steps). ${page}`;
      return [
        `Your onboarding is ${o.progressPct}% done (${o.done} of ${o.total} steps)${o.buddy ? `, buddy ${o.buddy}` : ''}${o.startDate ? `, started ${o.startDate}` : ''}. Still to do:`,
        bullets(o.remaining),
        `Open ${page}.`,
      ].join('\n');
    },
  },
  {
    name: 'page_hr_issues',
    label: 'HR issues',
    href: '/team/hr-issues',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(hr issues?|hr complaints?|raised with hr|issues? (i )?raised)\b/,
    examples: ['Any update on my HR issue?', 'Which HR issues are still open?'],
    description: 'Issues you raised with HR (status and reply); for HR, the Branch Manager and the Founder also the open issues raised with them.',
    load: async (ref, me) => {
      const s = svc(ref, HrIssuesService);
      const setup = await s.setup(me);
      const answers = setup.handlesHr || setup.handlesLeadership;
      const [mine, inbox] = await Promise.all([s.mine(me), answers ? s.inbox(me) : Promise.resolve([])]);
      const cat = (c: string) => (HR_ISSUE_CATEGORIES as Record<string, string>)[c] ?? c;
      const st = (x: string) => (HR_ISSUE_STATUSES as Record<string, string>)[x] ?? x;
      return {
        mine: mine.slice(0, 10).map((i) => ({ subject: cut(redact(i.subject), 100), category: cat(i.category), status: st(i.status), raised: dayShort(i.createdAt), reply: i.response ? cut(redact(i.response), 200) : null })),
        answers,
        inbox: inbox.slice(0, 10).map((i) => ({ subject: cut(redact(i.subject), 100), from: i.from?.name ?? null, category: cat(i.category), status: st(i.status), raised: dayShort(i.createdAt) })),
      } satisfies HrIssuesData;
    },
    answer: (d: HrIssuesData) => {
      const page = link('HR issues', '/team/hr-issues');
      const out: string[] = [];
      if (d.answers) out.push(d.inbox.length ? `${plural(d.inbox.length, 'open issue')} raised with you:\n${bullets(d.inbox.map((i) => `${i.raised}: ${i.subject} · ${i.category}${i.from ? ` · from ${i.from}` : ''} (${i.status})`))}` : 'No open issues are raised with you.');
      out.push(
        d.mine.length
          ? `Issues you raised:\n${bullets(d.mine.map((i) => `${i.raised}: ${i.subject} · ${i.status}${i.reply ? `. Reply: ${i.reply}` : ''}`))}`
          : "You haven't raised any HR issues.",
      );
      out.push(`Open ${page}.`);
      return out.join('\n');
    },
  },
  {
    name: 'page_discussions',
    label: 'Discussions',
    href: '/team/discussions',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(discussions?|discussion threads?)\b/,
    examples: ['Any unread discussions?', "What's new in my discussions?"],
    description: 'Discussions you are part of: unread counts and the latest message in each, newest first.',
    load: async (ref, me) => {
      const rows = await svc(ref, OpsCommsService).threads(me, {});
      const sorted = [...rows].sort((a, b) => (b.lastMessage?.at ?? b.createdAt).localeCompare(a.lastMessage?.at ?? a.createdAt));
      return {
        total: rows.length,
        unreadThreads: rows.filter((t) => (t.unread ?? 0) > 0).length,
        unreadMessages: rows.reduce((n, t) => n + (t.unread ?? 0), 0),
        threads: sorted.slice(0, 10).map((t) => ({
          title: redact(t.title),
          // Internal discussions have no client.
          client: t.client?.name ?? null,
          unread: t.unread ?? 0,
          last: t.lastMessage ? { author: t.lastMessage.author, at: dayShort(t.lastMessage.at), body: cut(redact(t.lastMessage.body), 100) } : null,
          link: `/team/discussions/${t.id}`,
        })),
      } satisfies DiscussionsData;
    },
    answer: (d: DiscussionsData, q) => {
      const page = link('Discussions', '/team/discussions');
      if (!d.total) return `You are not in any discussions yet. ${page}`;
      const unreadOnly = /\bunread\b/.test(q);
      const rows = (unreadOnly ? d.threads.filter((t) => t.unread) : d.threads).map(
        (t) => `${link(t.title, t.link)} · ${t.client ?? 'internal'}${t.unread ? ` · ${t.unread} unread` : ''}${t.last ? `: ${t.last.author} (${t.last.at}): "${t.last.body}"` : ''}`,
      );
      return [
        d.unreadThreads ? `${plural(d.unreadMessages, 'unread message')} in ${plural(d.unreadThreads, 'discussion')} (of ${d.total}).` : `No unread messages in your ${plural(d.total, 'discussion')}.`,
        bullets(rows),
        `Open ${page}.`,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },
  {
    name: 'page_sops',
    label: 'SOP library',
    href: '/team/sops',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(sops?|sop library|standard operating procedures?)\b/,
    examples: ['What SOPs do we have?', 'Is there an SOP for client onboarding?'],
    description: 'Published SOPs (title, department, version). Words in the question narrow the list to matching titles.',
    load: async (ref, me) => {
      const rows = await svc(ref, TeamWorkspaceService).sops(me);
      return { count: rows.length, sops: rows.slice(0, 100).map((s) => ({ title: s.title, department: s.department.name, version: s.version, link: `/team/sops/${s.id}` })) } satisfies SopsData;
    },
    answer: (d: SopsData, q) => {
      const page = link('SOP library', '/team/sops');
      if (!d.count) return `No SOPs are published yet. ${page}`;
      const ignore = new Set(['sops', 'there', 'about', 'what', 'which', 'have', 'show', 'library', 'standard', 'operating', 'procedure', 'procedures']);
      const terms = words(q).filter((w) => !ignore.has(w));
      const hits = terms.length ? d.sops.filter((s) => terms.some((t) => s.title.toLowerCase().includes(t) || s.department.toLowerCase().includes(t))) : [];
      const row = (s: SopsData['sops'][number]) => `${link(s.title, s.link)} · ${s.department} (v${s.version})`;
      if (hits.length) return [`${plural(hits.length, 'SOP')} matching your question:`, bullets(hits.map(row)), `Open ${page}.`].join('\n');
      const byDept = new Map<string, number>();
      for (const s of d.sops) byDept.set(s.department, (byDept.get(s.department) ?? 0) + 1);
      return [
        `${terms.length ? 'No SOP title matches that. ' : ''}${plural(d.count, 'published SOP')}: ${[...byDept].map(([k, n]) => `${k} ${n}`).join(', ')}.`,
        bullets(d.sops.map(row)),
        `Open ${page}.`,
      ].join('\n');
    },
  },
  {
    name: 'page_docs',
    label: 'Documents',
    href: '/team/docs',
    surface: 'team',
    can: team.everyone,
    keywords: /\b(docs|documents?|team docs?)\b/,
    examples: ['Which documents were updated recently?', 'Show the docs for Metro Dental'],
    description: 'Shared documents you can open (title, kind, client, who last edited and when), most recently updated first. A client name in the question narrows the list.',
    load: async (ref, me) => {
      const rows = await svc(ref, DocsService).list(me, {});
      const sorted = [...rows].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return {
        count: rows.length,
        docs: sorted.slice(0, 50).map((x) => ({ title: redact(x.title), kind: x.kind.replace(/_/g, ' '), client: x.client?.name ?? x.lead?.name ?? null, updatedBy: x.updatedBy, updated: dayShort(x.updatedAt), clientVisible: x.clientVisible, link: `/team/docs/${x.id}` })),
      } satisfies DocsData;
    },
    answer: (d: DocsData, q) => {
      const page = link('Documents', '/team/docs');
      if (!d.count) return `No documents you can open yet. ${page}`;
      const forClient = d.docs.filter((x) => x.client && (q.includes(x.client.toLowerCase()) || x.client.toLowerCase().split(/\s+/).some((w) => w.length > 3 && q.includes(w))));
      const rows = (forClient.length ? forClient : d.docs).map((x) => `${link(x.title, x.link)} · ${x.kind}${x.client ? ` · ${x.client}` : ''} · updated ${x.updated}${x.updatedBy ? ` by ${x.updatedBy}` : ''}${x.clientVisible ? ' · client can see it' : ''}`);
      return [forClient.length ? `${plural(forClient.length, 'document')} for ${forClient[0].client}:` : `${plural(d.count, 'document')}, most recently updated first:`, bullets(rows), `Open ${page}.`].join('\n');
    },
  },
];

