// Ask BMU tools: read-only lookups that call the existing services with the signed-in user's own scope.
// A tool the person is not allowed to use returns "not allowed" (the service's own 403), so the copilot can
// never read more than the person could open on screen. Clients get a separate, own-account-only tool set.
import type Anthropic from '@anthropic-ai/sdk';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { formatINR, leadStageLabels, type AiCitation, type Me } from '@bmu/shared';
import { z } from 'zod';
import { AnalyticsService } from '../analytics/analytics.service.js';
import { ClientPortalController, ClientsController } from '../clients/clients.controller.js';
import { FinanceService } from '../insights/finance.service.js';
import { InsightsService } from '../insights/insights.service.js';
import { LeadsController } from '../leads/leads.controller.js';
import { OpsTeamService } from '../ops-analytics/team.service.js';
import { ProductionService } from '../production/production.service.js';
import { RequestsService } from '../requests/requests.service.js';
import { SellService } from '../sell/sell.service.js';
import { TeamWorkspaceService } from '../workspace/team.service.js';
import { FieldAccessService } from '../security/field-access.service.js';
import { skillTools } from './pages/index.js';
import { ApprovalsService } from '../actions/approvals.service.js';
import { MeetingsService } from '../comms/meetings.service.js';
import { GoalsService } from '../intelligence/goals.service.js';
import { ExpensesService } from '../money/expenses.service.js';
import { OpsSelfService } from '../ops-analytics/self.service.js';
import { TimesheetsService } from '../team-flows/timesheets.service.js';
import { redact } from './ai-safety.js';

export type ToolOutput = { data: unknown; citations: AiCitation[] };
export type CopilotTool = {
  name: string;
  description: string;
  schema: z.ZodType;
  properties: Record<string, unknown>;
  /** One-line status shown while it runs, e.g. "Looking up invoices…". */
  status: string;
  run: (input: Record<string, unknown>) => Promise<ToolOutput>;
};

const day = (iso: string | null | undefined) =>
  iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : null;
const day_ = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : null);
const time = (iso: string | null | undefined) => (iso ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' }).format(new Date(iso)) : null);
const has = (hay: string | null | undefined, needle?: string) => !needle || (hay ?? '').toLowerCase().includes(needle.toLowerCase());
const get = <T>(ref: ModuleRef, cls: new (...args: never[]) => T): T => ref.get(cls as never, { strict: false }) as T;

/** Runs a lookup; a 403/404 from the service becomes a plain answer for the model instead of an error. */
async function guarded(fn: () => Promise<ToolOutput>): Promise<ToolOutput> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ForbiddenException) return { data: { notAllowed: true, message: `Not allowed for this person's role: ${e.message}` }, citations: [] };
    if (e instanceof NotFoundException) return { data: { notFound: true, message: e.message }, citations: [] };
    throw e;
  }
}

const str = (d: string) => ({ type: 'string', description: d });
const bool = (d: string) => ({ type: 'boolean', description: d });

/** v20: every tool result passes the same field-level redactor as the API, so the AI never sees a field the person can't. */
function fieldSafe(ref: ModuleRef, me: Me, tools: CopilotTool[]): CopilotTool[] {
  return tools.map((t) => ({
    ...t,
    run: async (input) => {
      const out = await t.run(input);
      const fields = ref.get(FieldAccessService, { strict: false });
      return fields ? { ...out, data: await fields.forMe(me, out.data) } : out;
    },
  }));
}

/** Staff tools: the core lookups plus one per tab in this person's Team app and Command Centre menus. */
export function staffTools(ref: ModuleRef, me: Me): CopilotTool[] {
  return fieldSafe(ref, me, [...rawStaffTools(ref, me), ...skillTools(ref, me)]);
}

/** Client tools: their own account plus one per tab in their portal menu. */
export function clientTools(ref: ModuleRef, me: Me): CopilotTool[] {
  return fieldSafe(ref, me, [...rawClientTools(ref, me), ...skillTools(ref, me)]);
}

function rawStaffTools(ref: ModuleRef, me: Me): CopilotTool[] {
  const clients = () => get(ref, ClientsController).list(me);
  const findClient = async (name: string) => {
    const list = await clients();
    return list.find((c) => c.name.toLowerCase() === name.toLowerCase()) ?? list.find((c) => has(c.name, name)) ?? null;
  };
  return [
    {
      name: 'find_clients',
      description: 'Search the client accounts this person can see, by name or industry. Returns id, name, industry, health colour, client manager and services.',
      schema: z.object({ query: z.string().optional() }),
      properties: { query: str('Part of the client name or industry. Leave empty for all clients.') },
      status: 'Looking up clients…',
      run: (i) =>
        guarded(async () => {
          const q = i.query as string | undefined;
          const rows = (await clients()).filter((c) => has(c.name, q) || has(c.industry, q)).slice(0, 25);
          return {
            data: rows.map((c) => ({ id: c.id, name: c.name, industry: c.industry, health: c.health, am: c.am?.name ?? null, services: c.engagements.map((e) => `${e.serviceName} (${e.status}, ${e.currentGate})`), link: `/team/clients/${c.id}` })),
            citations: rows.map((c) => ({ label: c.name, href: `/team/clients/${c.id}` })),
          };
        }),
    },
    {
      name: 'client_360',
      description: 'Full picture of one client: services and milestones, deliverables, open requests, invoices (only if this person may see money), recent messages and activity.',
      schema: z.object({ client: z.string().min(1) }),
      properties: { client: str('Client id, or the client name') },
      status: 'Opening the client 360…',
      run: (i) =>
        guarded(async () => {
          const key = String(i.client);
          const match = (await clients()).find((c) => c.id === key) ?? (await findClient(key));
          if (!match) return { data: { notFound: true, message: `No client called "${key}" that this person can see` }, citations: [] };
          const c = await get(ref, TeamWorkspaceService).client360(me, match.id);
          return {
            data: {
              client: { name: c.client.name, industry: c.client.industry, health: c.client.health, since: day(c.client.since), am: c.client.am?.name ?? null },
              stats: { ...c.stats, outstanding: c.stats.outstandingPaise === null ? 'not visible to this role' : formatINR(c.stats.outstandingPaise) },
              services: c.services.map((s) => ({ service: s.serviceName, tier: s.tier, status: s.status, gate: s.currentGate, approved: `${s.approved}/${s.total}` })),
              deliverables: c.deliverables.slice(0, 15).map((d) => ({ title: d.title, status: d.status, due: day(d.dueAt), overdue: d.overdue, link: `/team/deliverables/${d.id}` })),
              requests: c.requests.slice(0, 10).map((r) => ({ type: r.type, status: r.status, text: redact(r.description).slice(0, 200), link: `/team/requests/${r.id}` })),
              invoices: c.invoices
                ? { outstanding: formatINR(c.invoices.outstandingPaise), paid: formatINR(c.invoices.paidPaise), recent: c.invoices.recent.map((v) => ({ number: v.number, status: v.status, total: formatINR(v.totalPaise), paid: formatINR(v.paidPaise), due: day(v.dueDate), link: `/admin/finance/invoices/${v.id}` })) }
                : 'not visible to this role',
              recentMessages: c.messages.filter((m) => !m.internal).slice(0, 6).map((m) => ({ from: m.fromClient ? 'client' : m.author, at: day(m.at), text: redact(m.body).slice(0, 240) })),
              link: `/team/clients/${match.id}`,
            },
            citations: [{ label: c.client.name, href: `/team/clients/${match.id}` }],
          };
        }),
    },
    {
      name: 'clients_at_risk',
      description: 'Client health scores (0-100) with the reasons each client is losing points (overdue invoices, missed reply times, extra revisions, blocked requirements, silence). Leadership only.',
      schema: z.object({}),
      properties: {},
      status: 'Checking client health…',
      run: () =>
        guarded(async () => {
          const rows = await get(ref, InsightsService).clientHealth(me);
          const risky = rows.filter((r) => r.risk !== 'healthy').slice(0, 15);
          return {
            data: { atRiskOrWatch: risky.map((r) => ({ name: r.name, score: r.score, risk: r.risk, reasons: r.reasons, am: r.am, link: `/team/clients/${r.id}` })), healthyCount: rows.length - risky.length },
            citations: risky.map((r) => ({ label: r.name, href: `/team/clients/${r.id}` })),
          };
        }),
    },
    {
      name: 'find_leads',
      description: 'Search sales leads this person can see (by contact name, company or need), optionally by stage.',
      schema: z.object({ query: z.string().optional(), stage: z.string().optional() }),
      properties: { query: str('Part of the contact name, company or what they need'), stage: str('new, contacted, discovery, proposal_sent, won or lost') },
      status: 'Searching leads…',
      run: (i) =>
        guarded(async () => {
          if ((me.permissions.leads_pipeline?.scope ?? 'none') === 'none') throw new ForbiddenException('Leads are for the sales team');
          const q = i.query as string | undefined;
          const rows = (await get(ref, LeadsController).list(me))
            .filter((l) => (!i.stage || l.stage === i.stage) && (has(l.contact.name, q) || has(l.contact.company, q) || has(l.need, q)))
            .slice(0, 25);
          return {
            data: rows.map((l) => ({ id: l.id, name: l.contact.name, company: l.contact.company ?? null, stage: leadStageLabels[l.stage], need: redact(l.need).slice(0, 160), budget: l.budgetPaise ? formatINR(l.budgetPaise) : null, score: l.score, owner: l.owner?.name ?? null, nextFollowUp: day(l.nextFollowUpAt), link: `/team/leads/${l.id}` })),
            citations: rows.map((l) => ({ label: l.contact.company || l.contact.name, href: `/team/leads/${l.id}` })),
          };
        }),
    },
    {
      name: 'lead_details',
      description: 'One lead in detail: score with reasons, stage, proposals, follow-up date and recent activity.',
      schema: z.object({ lead_id: z.string().min(1) }),
      properties: { lead_id: str('The lead id from find_leads') },
      status: 'Opening the lead…',
      run: (i) =>
        guarded(async () => {
          if ((me.permissions.leads_pipeline?.scope ?? 'none') === 'none') throw new ForbiddenException('Leads are for the sales team');
          const d = await get(ref, SellService).detail(me, String(i.lead_id));
          return {
            data: {
              name: d.lead.contact.name,
              company: d.lead.contact.company ?? null,
              stage: leadStageLabels[d.lead.stage],
              need: redact(d.lead.need),
              score: d.score,
              nextFollowUp: day(d.nextFollowUpAt),
              proposals: d.proposals.map((p) => ({ version: p.version, status: p.status, total: formatINR(p.totalPaise), sent: day(p.sentAt), views: p.viewCount })),
              recent: d.timeline.slice(0, 8).map((t) => ({ kind: t.kind, title: t.title, note: redact(t.body).slice(0, 200) })),
              link: `/team/leads/${d.lead.id}`,
            },
            citations: [{ label: d.lead.contact.company || d.lead.contact.name, href: `/team/leads/${d.lead.id}` }],
          };
        }),
    },
    {
      name: 'find_invoices',
      description: 'Invoices with amounts owed. Only Founder, Branch Manager and Finance may see invoices; others get "not allowed".',
      schema: z.object({ client: z.string().optional(), status: z.string().optional() }),
      properties: { client: str('Part of the client name'), status: str('overdue, issued, partially_paid, paid or all (default: anything still owed)') },
      status: 'Looking up invoices…',
      run: (i) =>
        guarded(async () => {
          const list = await get(ref, FinanceService).invoices(me, {});
          const status = (i.status as string | undefined) ?? 'owed';
          const rows = list.rows
            .filter((r) => has(r.client, i.client as string | undefined))
            .filter((r) => (status === 'all' ? true : status === 'owed' ? r.balancePaise > 0 && r.status !== 'void' : r.status === status))
            .slice(0, 30);
          const owed = rows.reduce((s, r) => s + r.balancePaise, 0);
          return {
            data: { count: rows.length, totalOwed: formatINR(owed), invoices: rows.map((r) => ({ number: r.number, client: r.client, status: r.status, total: formatINR(r.totalPaise), balance: formatINR(r.balancePaise), due: day(r.dueDate), link: `/admin/finance/invoices/${r.id}` })) },
            citations: rows.slice(0, 10).map((r) => ({ label: `${r.number} · ${r.client}`, href: `/admin/finance/invoices/${r.id}` })),
          };
        }),
    },
    {
      name: 'find_tasks',
      description: "Production tasks this person can see (their own, their team's or everyone's depending on role), filtered by person, client or status.",
      schema: z.object({ person: z.string().optional(), client: z.string().optional(), only_open: z.boolean().optional(), only_overdue: z.boolean().optional() }),
      properties: { person: str('Part of the owner name, e.g. Meera'), client: str('Part of the client name'), only_open: bool('Only tasks not done yet (default true)'), only_overdue: bool('Only overdue tasks') },
      status: 'Looking up tasks…',
      run: (i) =>
        guarded(async () => {
          const rows = (await get(ref, ProductionService).tasks(me, 'team'))
            .filter((t) => has(t.owner?.name, i.person as string | undefined) && has(t.client?.name, i.client as string | undefined))
            .filter((t) => (i.only_open === false ? true : t.status !== 'done'))
            .filter((t) => (i.only_overdue ? t.overdue : true))
            .slice(0, 30);
          const href = (t: (typeof rows)[number]) => (t.deliverable ? `/team/deliverables/${t.deliverable.id}` : '/team/tasks');
          return {
            data: rows.map((t) => ({ title: t.title, owner: t.owner?.name ?? 'unassigned', client: t.client?.name ?? null, status: t.status, due: day(t.deadline), overdue: t.overdue, blocked: t.blockedReason, hoursLogged: Math.round(t.timeLoggedMin / 6) / 10, link: href(t) })),
            citations: rows.filter((t) => t.deliverable).slice(0, 8).map((t) => ({ label: t.deliverable!.title, href: href(t) })),
          };
        }),
    },
    {
      name: 'find_requests',
      description: 'Client requests on the requests desk (changes, new scope, urgent, questions, billing) with reply-time status.',
      schema: z.object({ client: z.string().optional(), only_open: z.boolean().optional() }),
      properties: { client: str('Part of the client name'), only_open: bool('Only requests that are not closed (default true)') },
      status: 'Checking the requests desk…',
      run: (i) =>
        guarded(async () => {
          const rows = (await get(ref, RequestsService).list(me))
            .filter((r) => has(r.client.name, i.client as string | undefined))
            .filter((r) => (i.only_open === false ? true : !['done', 'declined'].includes(r.status)))
            .slice(0, 25);
          return {
            data: rows.map((r) => ({ client: r.client.name, type: r.type, status: r.status, text: redact(r.description).slice(0, 200), replyTime: r.sla.state, created: day(r.createdAt), link: `/team/requests/${r.id}` })),
            citations: rows.slice(0, 8).map((r) => ({ label: `${r.client.name} request`, href: `/team/requests/${r.id}` })),
          };
        }),
    },
    {
      name: 'my_week',
      description:
        "This person's own week, from their own dashboard (My Day): their open, overdue, due-today, due-this-week and blocked tasks, tasks done this week, QC checks waiting for them, work waiting to be sent to the client, the clients they manage with open requests, their open leads and follow-ups (sales), delivery steps at risk, today's attendance (check-in/out, late, working hours, holiday, leave, work from home), their end-of-day report and how many of their team filed theirs. Any team member can use it; use it for 'summary of the week', 'my tasks', 'what should I do', attendance and EOD questions, and when the company-wide summary is not allowed.",
      schema: z.object({}),
      properties: {},
      status: 'Reading your week…',
      run: async () => {
        const prod = get(ref, ProductionService);
        const now = Date.now();
        const weekEnd = now + 7 * 86_400_000;
        const safe = async <T>(fn: () => Promise<T>): Promise<T | null> => {
          try {
            return await fn();
          } catch {
            return null;
          }
        };
        const [day, mine, clientRows, requests, leads] = await Promise.all([
          prod.myDay(me),
          prod.tasks(me, 'mine'),
          safe(() => clients()),
          safe(() => get(ref, RequestsService).list(me)),
          (me.permissions.leads_pipeline?.scope ?? 'none') !== 'none' ? safe(() => get(ref, LeadsController).list(me)) : Promise.resolve(null),
        ]);
        const open = [...day.tasks.overdue, ...day.tasks.today, ...day.tasks.upcoming, ...day.tasks.blocked];
        const link = (t: { id: string; deliverable: { id: string } | null }) => (t.deliverable ? `/team/deliverables/${t.deliverable.id}` : `/team/tasks/${t.id}`);
        const row = (t: (typeof open)[number]) => ({ title: t.title, client: t.client?.name ?? null, status: t.status, due: day_(t.deadline), link: link(t) });
        const dueThisWeek = open.filter((t) => t.deadline && new Date(t.deadline).getTime() >= now && new Date(t.deadline).getTime() < weekEnd && t.status !== 'blocked');
        // Done in the last 7 days (the list keeps 14 days of finished work).
        const doneThisWeek = mine.filter((t) => t.status === 'done').length;
        const myClients = (clientRows ?? []).filter((c) => c.am?.id === me.id);
        const openRequests = (requests ?? []).filter((r) => !['done', 'declined'].includes(r.status));
        const myLeads = (leads ?? []).filter((l) => l.owner?.id === me.id && !['won', 'lost'].includes(l.stage));
        const followUps = myLeads.filter((l) => l.nextFollowUpAt && new Date(l.nextFollowUpAt).getTime() < weekEnd);
        return {
          data: {
            name: me.name,
            tasks: {
              open: open.length,
              overdue: day.tasks.overdue.map(row),
              dueToday: day.tasks.today.map(row),
              dueThisWeek: dueThisWeek.map(row),
              blocked: day.tasks.blocked.map((t) => ({ ...row(t), reason: t.blockedReason })),
              doneRecently: doneThisWeek,
            },
            qc: {
              sentBackToMe: (day as { taskQc?: { failed: unknown[] } }).taskQc?.failed ?? [],
              waitingForMyCheck: (day as { taskQc?: { toReview: unknown[] } }).taskQc?.toReview ?? [],
              versionsWaitingForQc: day.qcWaiting,
            },
            myClients: myClients.length ? myClients.map((c) => ({ name: c.name, health: c.health, link: `/team/clients/${c.id}` })) : undefined,
            openRequests: requests ? { count: openRequests.length, replyOverdue: openRequests.filter((r) => r.sla.state === 'overdue').length } : undefined,
            leads: leads ? { open: myLeads.length, followUpsThisWeek: followUps.map((l) => ({ name: l.contact.company || l.contact.name, due: day_(l.nextFollowUpAt ?? null), link: `/team/leads/${l.id}` })) } : undefined,
            deliveryAtRisk: (day.deliverSla ?? []).slice(0, 8).map((s) => ({ title: s.title, state: s.state, client: s.client.name })),
            sendToClientWaiting: day.sendToClientWaiting,
            onLeave: day.onLeave ?? null,
            attendance: {
              workday: day.workday?.kind ?? 'working',
              holiday: day.workday?.kind === 'holiday' ? day.workday.label : null,
              checkIn: time(day.checkIn),
              checkOut: time(day.checkOut),
              late: !!day.late,
              wfh: !!day.wfh,
              workingHours: day.workingHours ? `${day.workingHours.start}–${day.workingHours.end} (${day.workingHours.graceMinutes} min grace)` : null,
              missedCheckOut: day_(day.missedCheckOut ?? null),
              nextCheckIn: day_(day.nextCheckIn ?? null),
              leaveDecision: day.leaveNotice ? { status: day.leaveNotice.status, title: day.leaveNotice.title } : null,
            },
            eod: { submitted: day.eod.submitted, exempt: !!day.eodExempt, completed: day.eod.completed.length, pending: day.eod.pending.length, blocked: day.eod.blocked.length, waiting: day.eod.waiting.length },
            teamReports: day.teamReports ?? null,
          },
          citations: [{ label: 'My Day', href: '/team' }, { label: 'My tasks', href: '/team/tasks' }],
        };
      },
    },
    ...pageTools(ref, me),
    {
      name: 'business_summary',
      description: "This week's Weekly Review: revenue this vs last month (money roles only), active clients, open leads, overdue tasks, reply-time breaches, QC pass rate and what needs attention. Command Centre roles only.",
      schema: z.object({}),
      properties: {},
      status: 'Reading the Weekly Review…',
      run: () =>
        guarded(async () => {
          const w = await get(ref, InsightsService).weekly(me);
          return {
            data: {
              money: w.money ? { revenueThisMonth: formatINR(w.money.revenueThisMonthPaise), revenueLastMonth: formatINR(w.money.revenueLastMonthPaise), collectedThisMonth: formatINR(w.money.collectedThisMonthPaise), outstanding: formatINR(w.money.outstandingPaise) } : 'not visible to this role',
              // Leads only in the full view (Founder, Branch Manager, Sales); a Department Head gets their team's clients and tasks.
              ...(w.scope === 'department'
                ? { teamClients: w.activeClients, openDepartmentTasks: w.openTasks }
                : w.scope === 'organisation'
                  ? { activeClients: w.activeClients, openTasks: w.openTasks }
                  : { activeClients: w.activeClients, openLeads: w.openLeads }),
              overdueTasks: w.overdueTasks,
              replyTimeBreachesThisWeek: w.slaBreachesThisWeek,
              qcPassRatePct: w.qcPassRate,
              overdueInvoices: w.attention.overdueInvoices?.map((v) => ({ number: v.number, client: v.client, balance: formatINR(v.balancePaise), daysOverdue: v.daysOverdue, link: `/admin/finance/invoices/${v.id}` })) ?? 'not visible to this role',
              atRiskClients: w.attention.atRiskClients.map((c) => ({ name: c.name, score: c.score, reasons: c.reasons, link: `/team/clients/${c.id}` })),
              blockedTasks: w.attention.blockedTasks.map((t) => ({ title: t.title, owner: t.owner, reason: t.reason })),
            },
            citations: [{ label: 'Weekly Review', href: '/admin' }],
          };
        }),
    },
    {
      name: 'sales_numbers',
      description: 'Sales scorecard for this month: revenue vs target, projection and key figures compared with the previous period. Money roles only.',
      schema: z.object({}),
      properties: {},
      status: 'Reading the sales scorecard…',
      run: () =>
        guarded(async () => {
          const s = await get(ref, AnalyticsService).scorecard(me);
          return {
            data: { month: { ...s.month, revenue: formatINR(s.month.revenuePaise), target: formatINR(s.month.targetPaise), projected: formatINR(s.month.projectedPaise) }, kpis: s.kpis.map((k) => ({ label: k.label, value: k.value, previous: k.previous, unit: k.unit })) },
            citations: [{ label: 'Scorecard', href: '/admin/analytics' }],
          };
        }),
    },
    {
      name: 'team_performance',
      description: 'Team performance for the last 30 days per person: tasks completed, on-time %, hours, utilisation, overdue now. Leadership only.',
      schema: z.object({}),
      properties: {},
      status: 'Reading team performance…',
      run: () =>
        guarded(async () => {
          const t = await get(ref, OpsTeamService).team(me, {});
          return { data: { totals: t.totals, people: t.people.slice(0, 30) }, citations: [{ label: 'Team Performance', href: '/admin/analytics/team' }] };
        }),
    },
  ];
}

/** Pages in the team menu that everyone has (You section, Goals, Meetings), read with the person's own scope. */
function pageTools(ref: ModuleRef, me: Me): CopilotTool[] {
  const none = { schema: z.object({}), properties: {} };
  return [
    {
      name: 'my_goals',
      ...none,
      description: 'Goals this person can see on the Goals page (company, department and their own): progress, current value against target, status (on track, at risk, behind, done, missed) and end date.',
      status: 'Reading your goals…',
      run: () =>
        guarded(async () => {
          const { goals } = await get(ref, GoalsService).list(me, {});
          return {
            data: goals.slice(0, 25).map((g) => ({ title: g.title, level: g.level, owner: g.owner?.name ?? null, department: g.department?.name ?? null, mine: g.owner?.id === me.id, current: g.display.current, target: g.display.target, progressPct: Math.round(g.progress), status: g.status, ends: day(g.endDate), link: '/team/goals' })),
            citations: [{ label: 'Goals', href: '/team/goals' }],
          };
        }),
    },
    {
      name: 'my_meetings',
      ...none,
      description: 'Meetings this person hosts or attends: upcoming ones (date, time, client or lead, place), requests still being arranged, and recent past meetings.',
      status: 'Checking your meetings…',
      run: () =>
        guarded(async () => {
          const svc = get(ref, MeetingsService);
          const m = me.type === 'client' ? await svc.clientList(me) : await svc.list(me);
          const row = (x: (typeof m.upcoming)[number]) => ({ title: x.title, when: `${day_(x.startAt)} ${time(x.startAt)}`, with: x.client?.name ?? x.lead?.name ?? x.guest.name ?? null, host: x.host.name, place: x.location, status: x.status });
          return { data: { upcoming: m.upcoming.slice(0, 10).map(row), beingArranged: m.requests.slice(0, 10).map(row), recent: m.past.slice(0, 5).map(row) }, citations: [{ label: 'Meetings', href: me.type === 'client' ? '/client/meetings' : '/team/meetings' }] };
        }),
    },
    {
      name: 'my_leave',
      ...none,
      description: "This person's leave balance (casual and sick: allowed, used, pending, left), unpaid days, work-from-home days, their leave requests and status, this month's attendance (days present, hours) and upcoming holidays.",
      status: 'Reading your leave and attendance…',
      run: () =>
        guarded(async () => {
          const p = await get(ref, TeamWorkspaceService).profile(me);
          const today = new Date().toISOString().slice(0, 10);
          return {
            data: {
              balance: p.leave.balance,
              unpaidUsed: p.leave.unpaidUsed,
              wfhDays: p.leave.wfhDays ?? 0,
              canApply: p.leave.canApply !== false,
              requests: p.leave.requests.slice(0, 8).map((r) => ({ from: day_(r.from), to: day_(r.to), type: r.type, days: r.days, status: r.status })),
              attendanceThisMonth: { daysPresent: p.attendance.daysPresent, workingDaysSoFar: p.attendance.workingDaysSoFar, totalHours: Math.round(p.attendance.totalHours * 10) / 10 },
              upcomingHolidays: p.holidays.filter((h) => h.date >= today).slice(0, 5).map((h) => ({ date: day(h.date), name: h.name })),
            },
            citations: [{ label: 'Profile, leave & attendance', href: '/team/profile' }],
          };
        }),
    },
    {
      name: 'my_timesheet',
      ...none,
      description: "This person's timesheet for the current week: hours logged in total and per day, by category, and whether it is submitted, approved or sent back.",
      status: 'Reading your timesheet…',
      run: () =>
        guarded(async () => {
          const t = await get(ref, TimesheetsService).week(me);
          const h = (min: number) => Math.round((min / 60) * 10) / 10;
          return {
            data: { week: `${day_(t.weekStart)} – ${day_(t.weekEnd)}`, status: t.status, hours: h(t.totalMinutes), byDay: t.days.filter((d) => d.workingDay).map((d) => ({ date: day_(d.date), hours: h(d.taskMinutes + d.otherMinutes) })), byCategory: t.byCategory.map((c) => ({ category: c.category, hours: h(c.minutes) })), comment: t.comment, canSubmit: t.canSubmit },
            citations: [{ label: 'My timesheet', href: '/team/timesheet' }],
          };
        }),
    },
    {
      name: 'my_expenses',
      ...none,
      description: "Expense claims this person submitted: amount, what for, date and status (submitted, approved, rejected, paid), with totals waiting and approved but unpaid.",
      status: 'Checking your expenses…',
      run: () =>
        guarded(async () => {
          const e = await get(ref, ExpensesService).list(me, { mine: '1' });
          return {
            data: { waiting: formatINR(e.totals.waitingPaise), approvedUnpaid: formatINR(e.totals.approvedUnpaidPaise), claims: e.rows.slice(0, 12).map((r) => ({ what: redact(r.description).slice(0, 80), amount: formatINR(r.amountPaise + r.gstPaise), date: day_(r.date), status: r.status })) },
            citations: [{ label: 'My expenses', href: '/team/expenses' }],
          };
        }),
    },
    {
      name: 'my_approvals',
      ...none,
      description: 'How many approval requests are waiting for this person to decide (Approvals page).',
      status: 'Checking approvals…',
      run: () => guarded(async () => ({ data: await get(ref, ApprovalsService).count(me), citations: [{ label: 'Approvals', href: '/team/approvals' }] })),
    },
    {
      name: 'my_performance',
      ...none,
      description: "This person's own performance for the last 30 days (My performance page): tasks completed, on-time %, hours, QC first-pass %, streak, compared with the previous period and the team average, and upcoming deadlines.",
      status: 'Reading your performance…',
      run: () =>
        guarded(async () => {
          const p = await get(ref, OpsSelfService).me(me, {});
          return {
            data: { stats: p.stats, teamAverage: p.teamAverage, upcoming: p.upcoming.tasks.slice(0, 6).map((t) => ({ title: t.title, client: t.client, due: day_(t.deadline) })), insights: p.insights.slice(0, 3) },
            citations: [{ label: 'My performance', href: '/team/performance' }],
          };
        }),
    },
  ];
}

/** Client app assistant: only the signed-in client's own account, through the client-facing services. */
function rawClientTools(ref: ModuleRef, me: Me): CopilotTool[] {
  return [
    ...pageTools(ref, me).filter((t) => t.name === 'my_meetings'),
    {
      name: 'my_account',
      description: 'The client’s services, milestones (gates), requirements still pending, client manager (name, email, phone) and invoices due (if they may see billing).',
      schema: z.object({}),
      properties: {},
      status: 'Opening your account…',
      run: () =>
        guarded(async () => {
          const o = await get(ref, ClientPortalController).overview(me);
          return {
            data: {
              company: o.clientOrg.name,
              accountManager: o.accountManager?.name ?? null,
              accountManagerContact: o.accountManager ? { email: o.accountManager.email, phone: o.accountManager.phone } : null,
              services: o.engagements.map((e) => ({ service: e.serviceName, status: e.status, milestone: e.currentGate, requirementsPending: e.requirementsPending, accessPending: e.accessPending })),
              invoicesDue: o.invoicesDue.map((i) => ({ number: i.number, total: formatINR(i.totalPaise), paid: formatINR(i.paidPaise), due: day(i.dueDate), status: i.status })),
            },
            citations: [{ label: 'Home', href: '/client' }],
          };
        }),
    },
    {
      name: 'my_invoices',
      description: 'All invoices of the client with what is paid and still due. Only for client owners and finance users.',
      schema: z.object({}),
      properties: {},
      status: 'Looking up your invoices…',
      run: () =>
        guarded(async () => {
          const rows = await get(ref, ClientPortalController).invoices(me);
          return { data: rows.map((i) => ({ number: i.number, status: i.status, total: formatINR(i.totalPaise), paid: formatINR(i.paidPaise), due: day(i.dueDate) })), citations: [{ label: 'Billing', href: '/client/billing' }] };
        }),
    },
    {
      name: 'my_requests',
      description: 'The client’s requests to BMU and their status.',
      schema: z.object({}),
      properties: {},
      status: 'Checking your requests…',
      run: () =>
        guarded(async () => {
          const rows = (await get(ref, RequestsService).list(me)).slice(0, 20);
          return {
            data: rows.map((r) => ({ type: r.type, status: r.status, text: r.description.slice(0, 200), created: day(r.createdAt), link: `/client/requests/${r.id}` })),
            citations: rows.slice(0, 6).map((r) => ({ label: `Request: ${r.description.slice(0, 40)}`, href: `/client/requests/${r.id}` })),
          };
        }),
    },
    {
      name: 'my_reviews',
      description: 'Drafts and deliverables, including the ones waiting for the client’s approval.',
      schema: z.object({}),
      properties: {},
      status: 'Checking drafts waiting for you…',
      run: () =>
        guarded(async () => {
          const rows = (await get(ref, ProductionService).clientReviews(me)).slice(0, 25);
          return {
            data: rows.map((d) => ({ title: d.title, service: d.serviceName, status: d.statusLabel, waitingOnYou: d.waitingOnYou, link: `/client/reviews/${d.id}` })),
            citations: rows.filter((d) => d.waitingOnYou).slice(0, 6).map((d) => ({ label: d.title, href: `/client/reviews/${d.id}` })),
          };
        }),
    },
    {
      name: 'my_requirements',
      description: 'The onboarding checklist: what BMU still needs from the client for each service (documents, logins, brand files, approvals), with status pending, waiting, blocked or received.',
      schema: z.object({}),
      properties: {},
      status: 'Checking what we need from you…',
      run: () =>
        guarded(async () => {
          const o = await get(ref, ClientPortalController).onboarding(me);
          return {
            data: o.engagements.map((e) => ({
              service: e.serviceName,
              needed: e.requirements.filter((r) => r.status !== 'received').map((r) => ({ item: r.label, status: r.status, note: r.blockedReason ?? r.waitingFor })),
              received: e.requirements.filter((r) => r.status === 'received').length,
            })),
            citations: [{ label: 'Onboarding', href: '/client/onboarding' }],
          };
        }),
    },
    {
      name: 'my_plans',
      description: 'Monthly content plans and project plans BMU has sent to the client, and whether each is waiting for their approval, has changes requested or is approved.',
      schema: z.object({}),
      properties: {},
      status: 'Checking your plans…',
      run: () =>
        guarded(async () => {
          const rows = await get(ref, ClientPortalController).plans(me);
          return {
            data: rows.map((p) => ({ service: p.serviceName, period: p.period ?? null, status: p.plan.status, youApproved: !!p.youApproved, approvedAt: day(p.plan.approvedAt) })),
            citations: [{ label: 'Approvals', href: '/client/approvals' }],
          };
        }),
    },
  ];
}

/** SDK tool definitions (strict JSON schema, eager input streaming since the copilot streams). */
export function toolDefs(tools: CopilotTool[]): Anthropic.Beta.BetaTool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    eager_input_streaming: true,
    input_schema: { type: 'object' as const, properties: t.properties, additionalProperties: false, required: Object.keys(t.properties).filter((k) => ['client', 'lead_id'].includes(k)) },
  }));
}
