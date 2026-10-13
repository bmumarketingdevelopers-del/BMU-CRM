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

export function staffTools(ref: ModuleRef, me: Me): CopilotTool[] {
  return fieldSafe(ref, me, rawStaffTools(ref, me));
}

export function clientTools(ref: ModuleRef, me: Me): CopilotTool[] {
  return fieldSafe(ref, me, rawClientTools(ref, me));
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
      description: 'Search the client accounts this person can see, by name or industry. Returns id, name, industry, health colour, account manager and services.',
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
              activeClients: w.activeClients,
              openLeads: w.openLeads,
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

/** Client app assistant: only the signed-in client's own account, through the client-facing services. */
function rawClientTools(ref: ModuleRef, me: Me): CopilotTool[] {
  return [
    {
      name: 'my_account',
      description: 'The client’s services, milestones (gates), requirements still pending, account manager and invoices due (if they may see billing).',
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
              services: o.engagements.map((e) => ({ service: e.serviceName, status: e.status, milestone: e.currentGate, requirementsPending: e.requirementsPending })),
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
