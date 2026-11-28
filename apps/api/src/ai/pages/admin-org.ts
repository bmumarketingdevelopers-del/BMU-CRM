// Ask BMU page skills for the Command Centre's Flow, Agents, Organisation and Clients sections.
// See ./types.ts for the contract and ./access.ts for who sees each tab. Every lookup goes through the same service
// call (and permission check) the page's API endpoint makes; nothing here writes.
import { ForbiddenException } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';
import { formatINR, requestStatusLabels, requestTypeLabels, workflowRunStatusLabels, type Me } from '@bmu/shared';
import { ClientsAdminService } from '../../admin-org/clients-admin.service.js';
import { AttendanceService } from '../../admin-org/attendance.service.js';
import { StructureService } from '../../admin-org/structure.service.js';
import { AgentsService } from '../../agents/agents.service.js';
import { AutomationsService } from '../../automations/automations.service.js';
import { ClientsManageService } from '../../clients-actions/clients-manage.service.js';
import { FlowsService } from '../../flows/flows.service.js';
import { OrgService } from '../../org/org.service.js';
import { PeopleActionsService } from '../../people-actions/people-actions.service.js';
import { RequestsService } from '../../requests/requests.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { PeopleService } from '../../team-flows/people.service.js';
import { TimesheetsService } from '../../team-flows/timesheets.service.js';
import { WorkflowsService } from '../../workflows/workflows.service.js';
import { redact } from '../ai-safety.js';
import { admin } from './access.js';
import { bullets, day, link, plural, svc, type PageSkill } from './types.js';

/** A skill whose answer() is typed by what its load() returns. */
const skill = <T>(s: Omit<PageSkill, 'load' | 'answer'> & { load: (ref: ModuleRef, me: Me) => Promise<T>; answer: (d: T, q: string) => string }): PageSkill => s as unknown as PageSkill;

const IST = 330 * 60_000;
const istDay = (d = new Date()) => new Date(d.getTime() + IST).toISOString().slice(0, 10);
const istMonth = (d = new Date()) => istDay(d).slice(0, 7);
const words = (s: string) => s.replace(/_/g, ' ');
const countBy = <T>(rows: T[], key: (r: T) => string) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }));
};
const counts = (rows: { name: string; count: number }[]) => rows.map((r) => `${r.count} ${r.name}`).join(', ');
const hours = (min: number) => `${Math.round((min / 60) * 10) / 10} h`;
const short = (s: string | null | undefined, n = 80) => {
  const t = redact(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ------------------------------------------------------------------ Flow

type FlowData = {
  period: string;
  inFlow: number;
  stuck: number;
  avgLeadToPaidDays: number | null;
  avgPaidToG5Days: number | null;
  stages: { label: string; count: number; stuck: number; avgDays: number | null; severity: string }[];
  insights: string[];
  stuckItems: { title: string; stage: string; days: number; reason: string | null; owner: string | null }[];
};

const flowMap = skill<FlowData>({
  name: 'page_flow_map',
  label: 'Business Flow Map',
  href: '/admin/flow',
  surface: 'admin',
  can: admin('Business Flow Map'),
  keywords: /\b(business flow( map)?|flow map|lead[- ]to[- ]paid|paid[- ]to[- ]g5|stuck in the flow|flow stages?)\b/,
  examples: ['What does the business flow map show?', 'How long from lead to paid on average?'],
  description: 'Work in each stage from lead to retainer (count, stuck, average days), flow health, insights and the stuck items.',
  load: async (ref, me) => {
    const m = await svc(ref, FlowsService).map(me);
    return {
      period: `${day(m.from)} to ${day(m.to)}`,
      inFlow: m.health.inFlow,
      stuck: m.health.stuck,
      avgLeadToPaidDays: m.health.avgLeadToPaidDays,
      avgPaidToG5Days: m.health.avgPaidToG5Days,
      stages: m.nodes.map((n) => ({ label: n.label, count: n.count, stuck: n.stuckCount, avgDays: n.avgDays, severity: n.severity })),
      insights: m.insights.slice(0, 5).map((i) => short(i.text, 160)),
      stuckItems: m.nodes
        .flatMap((n) => n.items.filter((i) => i.severity !== 'ok').map((i) => ({ title: short(i.title, 60), stage: n.label, days: i.days, reason: i.reason ? short(i.reason, 100) : null, owner: i.owner })))
        .sort((a, b) => b.days - a.days)
        .slice(0, 10),
    };
  },
  answer: (d) => {
    const out = [`**${plural(d.inFlow, 'item')} in the flow, ${d.stuck} stuck** (${d.period}).`];
    const avg = [d.avgLeadToPaidDays != null ? `lead to paid takes ${d.avgLeadToPaidDays} days on average` : '', d.avgPaidToG5Days != null ? `paid to G5 takes ${d.avgPaidToG5Days} days` : ''].filter(Boolean);
    if (avg.length) out.push(`${avg.join('; ')}.`.replace(/^./, (c) => c.toUpperCase()));
    if (d.stages.length) out.push(`By stage:\n${bullets(d.stages.map((s) => `${s.label}: ${s.count}${s.stuck ? ` (${s.stuck} stuck)` : ''}${s.avgDays != null ? ` · avg ${s.avgDays} days` : ''}`), 12)}`);
    if (d.stuckItems.length) out.push(`Stuck longest:\n${bullets(d.stuckItems.map((i) => `${i.title} · ${i.stage} · ${i.days} days${i.reason ? ` · ${i.reason}` : ''}${i.owner ? ` · ${i.owner}` : ''}`))}`);
    if (d.insights.length) out.push(`Insights:\n${bullets(d.insights, 5)}`);
    out.push(`Open ${link('Business Flow Map', '/admin/flow')}.`);
    return out.join('\n\n');
  },
});

type WorkflowRunsData = { total: number; byStatus: { name: string; count: number }[]; recent: { workflow: string; record: string; status: string; where: string; started: string | null }[] };

const workflowRuns = skill<WorkflowRunsData>({
  name: 'page_workflow_runs',
  label: 'Workflow Runs',
  href: '/admin/workflows/runs',
  surface: 'admin',
  can: admin('Workflow Runs'),
  keywords: /\b(workflow runs?|workflows? (that )?(failed|are waiting|running|in progress)|failed workflows?|runs? of (the )?workflows?)\b/,
  examples: ['Show recent workflow runs', 'Which workflow runs failed?'],
  description: 'Recent workflow runs: counts by status and the latest runs with the record and where each one is.',
  load: async (ref, me) => {
    const rows = await svc(ref, WorkflowsService).runs(me, {});
    return {
      total: rows.length,
      byStatus: countBy(rows, (r) => workflowRunStatusLabels[r.status] ?? words(r.status)),
      recent: rows.slice(0, 30).map((r) => ({ workflow: r.workflowName, record: short(r.record, 60), status: r.status, where: short(r.where, 80), started: day(r.startedAt) })),
    };
  },
  answer: (d, q) => {
    if (!d.total) return `No workflow runs yet. Open ${link('Workflow Runs', '/admin/workflows/runs')}.`;
    const failed = /\b(fail|failed|problems?|errors?)\b/.test(q);
    const rows = failed ? d.recent.filter((r) => r.status === 'failed') : d.recent;
    const head = `**${plural(d.total, 'workflow run')}** in the log: ${counts(d.byStatus)}.`;
    const list = rows.length
      ? `${failed ? 'Failed runs' : 'Latest runs'}:\n${bullets(rows.map((r) => `${r.workflow} · ${r.record} · ${workflowRunStatusLabels[r.status as keyof typeof workflowRunStatusLabels] ?? words(r.status)}${r.where ? ` · ${r.where}` : ''}${r.started ? ` · started ${r.started}` : ''}`))}`
      : 'None of the recent runs failed.';
    return `${head}\n\n${list}\n\nOpen ${link('Workflow Runs', '/admin/workflows/runs')}.`;
  },
});

type WorkflowsData = {
  stats: { active: number; total: number; runs7d: number; waiting: number; awaitingApproval: number; failures7d: number };
  workflows: { name: string; enabled: boolean; trigger: string; runs: number; active: number; failures30d: number; lastRun: string | null }[];
  automationsToMove: number;
};

const workflows = skill<WorkflowsData>({
  name: 'page_workflows',
  label: 'Workflows',
  href: '/admin/workflows',
  surface: 'admin',
  can: admin('Workflows'),
  keywords: /\bworkflows?\b/,
  examples: ['Which workflows are switched on?', 'How many workflows do we have?'],
  description: 'Workflows: how many are on, runs in the last 7 days, waiting and failed runs, and each workflow with its trigger.',
  load: async (ref, me) => {
    const o = await svc(ref, WorkflowsService).overview(me);
    return {
      stats: o.stats,
      workflows: o.workflows.slice(0, 20).map((w) => ({ name: w.name, enabled: w.enabled, trigger: w.triggerLabel, runs: w.runCount, active: w.active, failures30d: w.failures30d, lastRun: day(w.lastRunAt) })),
      automationsToMove: o.automationsToMove,
    };
  },
  answer: (d) => {
    const s = d.stats;
    if (!s.total) return `No workflows are set up yet. Start one from a template on ${link('Workflows', '/admin/workflows')}.`;
    const out = [`**${s.active} of ${plural(s.total, 'workflow')} switched on.** ${plural(s.runs7d, 'run')} in the last 7 days, ${s.waiting} waiting, ${s.awaitingApproval} waiting for a decision, ${s.failures7d} failed.`];
    out.push(bullets(d.workflows.map((w) => `${w.name} · ${w.enabled ? 'on' : 'off'} · when ${w.trigger} · ${plural(w.runs, 'run')}${w.active ? `, ${w.active} in progress` : ''}${w.failures30d ? ` · ${w.failures30d} failed in 30 days` : ''}${w.lastRun ? ` · last ran ${w.lastRun}` : ''}`)));
    if (d.automationsToMove) out.push(`${plural(d.automationsToMove, 'automation')} can be moved into workflows.`);
    out.push(`Open ${link('Workflows', '/admin/workflows')}.`);
    return out.join('\n\n');
  },
});

type AutomationLogData = { total: number; byStatus: { name: string; count: number }[]; recent: { rule: string; status: string; summary: string; record: string | null; at: string | null }[] };

const automationLog = skill<AutomationLogData>({
  name: 'page_automation_log',
  label: 'Automation Log',
  href: '/admin/automations/runs',
  surface: 'admin',
  can: admin('Automation Log'),
  keywords: /\b(automation (log|runs?|history)|automations? (that )?(failed|ran|fired)|failed automations?)\b/,
  examples: ['Show the automation log', 'Which automations failed this week?'],
  description: 'Recent automation runs: counts by result and the latest runs with what they did.',
  load: async (ref, me) => {
    const rows = await svc(ref, AutomationsService).runs(me, {});
    return {
      total: rows.length,
      byStatus: countBy(rows, (r) => r.status),
      recent: rows.slice(0, 30).map((r) => ({ rule: r.ruleName, status: r.status, summary: short(r.summary, 100), record: r.record ? short(r.record, 60) : null, at: day(r.at) })),
    };
  },
  answer: (d, q) => {
    if (!d.total) return `No automation has run yet. Open ${link('Automation Log', '/admin/automations/runs')}.`;
    const failed = /\b(fail|failed|problems?|errors?)\b/.test(q);
    const rows = failed ? d.recent.filter((r) => r.status === 'failed') : d.recent;
    const head = `**${plural(d.total, 'automation run')}** in the log: ${counts(d.byStatus)}.`;
    const list = rows.length ? `${failed ? 'Failed runs' : 'Latest runs'}:\n${bullets(rows.map((r) => `${r.rule} · ${r.status}${r.record ? ` · ${r.record}` : ''}${r.summary ? ` · ${r.summary}` : ''}${r.at ? ` · ${r.at}` : ''}`))}` : 'None of the recent runs failed.';
    return `${head}\n\n${list}\n\nOpen ${link('Automation Log', '/admin/automations/runs')}.`;
  },
});

type AutomationsData = {
  stats: { activeRules: number; totalRules: number; runs7d: number; runsPrev7d: number; actions7d: number; failures7d: number };
  rules: { name: string; enabled: boolean; sentence: string; runs: number; failures30d: number; lastRun: string | null }[];
};

const automations = skill<AutomationsData>({
  name: 'page_automations',
  label: 'Automations',
  href: '/admin/automations',
  surface: 'admin',
  can: admin('Automations'),
  keywords: /\b(automations?|automation rules?)\b/,
  examples: ['Which automations are switched on?', 'How many automation rules do we have?'],
  description: 'Automation rules: how many are on, runs and failures in the last 7 days, and each rule in plain words.',
  load: async (ref, me) => {
    const o = await svc(ref, AutomationsService).overview(me);
    return { stats: o.stats, rules: o.rules.slice(0, 20).map((r) => ({ name: r.name, enabled: r.enabled, sentence: short(r.sentence, 140), runs: r.runCount, failures30d: r.failures30d, lastRun: day(r.lastRunAt) })) };
  },
  answer: (d) => {
    const s = d.stats;
    if (!s.totalRules) return `No automations are set up yet. Add one from a template on ${link('Automations', '/admin/automations')}.`;
    const out = [`**${s.activeRules} of ${plural(s.totalRules, 'automation')} switched on.** ${plural(s.runs7d, 'run')} in the last 7 days (${s.runsPrev7d} the week before), ${plural(s.actions7d, 'action')} done, ${s.failures7d} failed.`];
    out.push(bullets(d.rules.map((r) => `${r.name} · ${r.enabled ? 'on' : 'off'}${r.sentence ? ` · ${r.sentence}` : ''} · ${plural(r.runs, 'run')}${r.failures30d ? ` · ${r.failures30d} failed in 30 days` : ''}`)));
    out.push(`Open ${link('Automations', '/admin/automations')}.`);
    return out.join('\n\n');
  },
});

// ------------------------------------------------------------------ Agents

type AgentRunsData = { total: number; byStatus: { name: string; count: number }[]; recent: { agent: string; status: string; subject: string | null; summary: string; actions: number; proposals: number; blocked: number; at: string | null }[] };

const agentRuns = skill<AgentRunsData>({
  name: 'page_agent_runs',
  label: 'Agent Run Log',
  href: '/admin/agents/runs',
  surface: 'admin',
  can: admin('Agent Run Log'),
  keywords: /\b(agent run( log)?s?|agent log|runs? of (the )?(ai )?agents?|what (did|have) the (ai )?agents? (do|did|done)|agent runs? (that )?failed)\b/,
  examples: ['Show the agent run log', 'What did the AI agents do recently?'],
  description: 'Recent AI agent runs: counts by status and the latest runs with what each one did (actions, proposals, blocked steps).',
  load: async (ref, me) => {
    const rows = await svc(ref, AgentsService).runs(me, {});
    return {
      total: rows.length,
      byStatus: countBy(rows, (r) => r.status),
      recent: rows.slice(0, 15).map((r) => ({ agent: r.agentLabel, status: r.status, subject: r.subject ? short(r.subject.label, 60) : null, summary: short(r.summary, 120), actions: r.actions, proposals: r.proposals, blocked: r.blocked, at: day(r.createdAt) })),
    };
  },
  answer: (d) => {
    if (!d.total) return `The AI agents have not run yet. Open ${link('Agent Run Log', '/admin/agents/runs')}.`;
    const rows = d.recent.map((r) => `${r.agent} · ${r.status}${r.subject ? ` · ${r.subject}` : ''}${r.summary ? ` · ${r.summary}` : ''} · ${plural(r.actions, 'action')}, ${plural(r.proposals, 'proposal')}${r.blocked ? `, ${r.blocked} blocked` : ''}${r.at ? ` · ${r.at}` : ''}`);
    return `**${plural(d.total, 'agent run')}**: ${counts(d.byStatus)}.\n\nLatest:\n${bullets(rows)}\n\nOpen ${link('Agent Run Log', '/admin/agents/runs')}.`;
  },
});

type AgentsData = {
  aiMode: string;
  pendingProposals: number;
  agents: { label: string; summary: string; enabled: boolean; actsFor: string | null; budget: string; spent: string; runsThisMonth: number; lastRun: string | null }[];
};

const aiAgents = skill<AgentsData>({
  name: 'page_ai_agents',
  label: 'AI Agents',
  href: '/admin/agents',
  surface: 'admin',
  can: admin('AI Agents'),
  keywords: /\b(ai agents?|agents? (are )?(enabled|switched on|turned on)|agent (budgets?|spend(ing)?)|which agents)\b/,
  examples: ['Which AI agents are switched on?', 'How much have the AI agents spent this month?'],
  description: 'The AI agents: which are on, who they act for, monthly budget and spend, runs this month, and suggestions waiting for a decision.',
  load: async (ref, me) => {
    const o = await svc(ref, AgentsService).overview(me);
    return {
      aiMode: o.aiMode,
      pendingProposals: o.pendingProposals,
      agents: o.agents.map((a) => ({ label: a.label, summary: short(a.summary, 100), enabled: a.enabled, actsFor: a.actsFor?.name ?? null, budget: formatINR(a.monthlyBudgetPaise), spent: formatINR(a.spentPaise), runsThisMonth: a.runsThisMonth, lastRun: day(a.lastRunAt) })),
    };
  },
  answer: (d) => {
    if (!d.agents.length) return `No AI agents are set up. Open ${link('AI Agents', '/admin/agents')}.`;
    const on = d.agents.filter((a) => a.enabled).length;
    const mode = d.aiMode === 'ai' ? 'AI is connected' : d.aiMode === 'basic' ? 'AI is not connected, so agents run in basic mode' : 'AI is switched off';
    const rows = d.agents.map((a) => `${a.label} · ${a.enabled ? 'on' : 'off'}${a.actsFor ? ` · acts for ${a.actsFor}` : ''} · spent ${a.spent} of ${a.budget} this month · ${plural(a.runsThisMonth, 'run')}${a.lastRun ? ` · last ran ${a.lastRun}` : ''}`);
    return `**${on} of ${plural(d.agents.length, 'agent')} switched on** (${mode}).${d.pendingProposals ? ` ${plural(d.pendingProposals, 'suggestion')} waiting for a decision.` : ''}\n\n${bullets(rows)}\n\nOpen ${link('AI Agents', '/admin/agents')}.`;
  },
});

// ------------------------------------------------------------------ Organisation

type HierarchyData = {
  org: string;
  people: number;
  former: number;
  unplaced: number;
  branches: { name: string; city: string; departments: { name: string; head: string | null; members: number; teams: { name: string; lead: string | null; members: number }[] }[] }[];
  managers: { name: string; reports: number }[];
  pods: { name: string; cm: string | null; producers: number; clients: number }[];
};

const hierarchy = skill<HierarchyData>({
  name: 'page_hierarchy',
  label: 'Hierarchy Tree',
  href: '/admin/hierarchy',
  surface: 'admin',
  can: admin('Hierarchy Tree'),
  keywords: /\b(hierarchy( tree)?|org(anisation|anization)? chart|org tree|reporting lines?|who reports to|reports to whom|pods?)\b/,
  examples: ['Show the hierarchy tree', 'Who reports to whom in the org chart?'],
  description: 'The organisation tree: branches, departments with heads and teams with leads, who manages the most people, and client pods.',
  load: async (ref, me) => {
    const t = await svc(ref, PeopleActionsService).tree(me);
    const reports = countBy(
      t.people.filter((p) => p.manager),
      (p) => p.manager!.name,
    );
    return {
      org: t.org.name,
      people: t.people.length,
      former: t.former.length,
      unplaced: t.unplacedIds.length,
      branches: t.branches.map((b) => ({
        name: b.name,
        city: b.city,
        departments: b.departments.map((d) => ({ name: d.name, head: d.head?.name ?? null, members: d.memberIds.length, teams: d.teams.map((tm) => ({ name: tm.name, lead: tm.lead?.name ?? null, members: tm.memberIds.length })) })),
      })),
      managers: reports.slice(0, 10).map((r) => ({ name: r.name, reports: r.count })),
      pods: t.pods.slice(0, 15).map((p) => ({ name: p.name, cm: p.am?.name ?? null, producers: p.producers.length, clients: p.clients.length })),
    };
  },
  answer: (d, q) => {
    const out = [`**${d.org}: ${plural(d.people, 'person', 'people')}** in ${plural(d.branches.length, 'branch', 'branches')}${d.unplaced ? `, ${d.unplaced} not in a department yet` : ''}${d.former ? ` (${d.former} former)` : ''}.`];
    if (/\bpods?\b/.test(q)) {
      out.push(d.pods.length ? `Pods:\n${bullets(d.pods.map((p) => `${p.name}${p.cm ? ` · CM ${p.cm}` : ''} · ${plural(p.producers, 'producer')} · ${plural(p.clients, 'client')}`), 15)}` : 'There are no pods yet.');
    } else {
      const lines = d.branches.flatMap((b) => [
        `**${b.name}** (${b.city})`,
        ...b.departments.map((dep) => `- ${dep.name}${dep.head ? ` · head ${dep.head}` : ' · no head'} · ${plural(dep.members, 'person', 'people')}${dep.teams.length ? ` · teams: ${dep.teams.map((t) => `${t.name}${t.lead ? ` (lead ${t.lead})` : ''}`).join(', ')}` : ''}`),
      ]);
      if (lines.length) out.push(lines.slice(0, 30).join('\n'));
      if (d.managers.length) out.push(`Most direct reports:\n${bullets(d.managers.map((m) => `${m.name}: ${m.reports}`), 5)}`);
    }
    out.push(`Open ${link('Hierarchy Tree', '/admin/hierarchy')}.`);
    return out.join('\n\n');
  },
});

type UsersData = {
  total: number;
  byStatus: { name: string; count: number }[];
  byDepartment: { name: string; count: number }[];
  onLeaveToday: number;
  invited: { name: string; department: string | null }[];
  suspended: { name: string; department: string | null }[];
  recent: { name: string; roles: string; department: string | null; joined: string | null }[];
};

const users = skill<UsersData>({
  name: 'page_users',
  label: 'Users',
  href: '/admin/users',
  surface: 'admin',
  can: admin('Users'),
  keywords: /\b(users?|staff (list|accounts?)|(invited|suspended) (people|users|staff|accounts?)|headcount)\b/,
  examples: ['How many users are active?', 'Which staff accounts are still invited?'],
  description: 'Team accounts the person can see: counts by status and department, invited and suspended accounts, and the latest joiners (no contact details).',
  load: async (ref, me) => {
    const rows = await svc(ref, PeopleActionsService).list(me, {});
    const pick = (status: string) => rows.filter((r) => r.status === status).slice(0, 15).map((r) => ({ name: r.name, department: r.department?.name ?? null }));
    return {
      total: rows.length,
      byStatus: countBy(rows, (r) => r.status),
      byDepartment: countBy(rows, (r) => r.department?.name ?? 'No department').slice(0, 12),
      onLeaveToday: rows.filter((r) => r.onLeaveToday).length,
      invited: pick('invited'),
      suspended: pick('suspended'),
      recent: [...rows]
        .filter((r) => r.joiningDate)
        .sort((a, b) => (b.joiningDate ?? '').localeCompare(a.joiningDate ?? ''))
        .slice(0, 8)
        .map((r) => ({ name: r.name, roles: r.roles.map((x) => x.name).join(', '), department: r.department?.name ?? null, joined: day(r.joiningDate) })),
    };
  },
  answer: (d, q) => {
    if (!d.total) return `No team accounts you can see. Open ${link('Users', '/admin/users')}.`;
    const out = [`**${plural(d.total, 'user')}**: ${counts(d.byStatus)}.${d.onLeaveToday ? ` ${d.onLeaveToday} on leave today.` : ''}`];
    if (/\binvited?\b/.test(q)) out.push(d.invited.length ? `Still invited (not signed in yet):\n${bullets(d.invited.map((u) => `${u.name}${u.department ? ` · ${u.department}` : ''}`), 15)}` : 'Nobody is waiting on an invite.');
    else if (/\bsuspended\b/.test(q)) out.push(d.suspended.length ? `Suspended:\n${bullets(d.suspended.map((u) => `${u.name}${u.department ? ` · ${u.department}` : ''}`), 15)}` : 'No account is suspended.');
    else {
      out.push(`By department: ${counts(d.byDepartment)}.`);
      if (d.recent.length) out.push(`Latest joiners:\n${bullets(d.recent.map((u) => `${u.name}${u.roles ? ` · ${u.roles}` : ''}${u.department ? ` · ${u.department}` : ''}${u.joined ? ` · joined ${u.joined}` : ''}`))}`);
    }
    out.push(`Open ${link('Users', '/admin/users')}.`);
    return out.join('\n\n');
  },
});

type RolesData = { roles: { name: string; baseRole: string; custom: boolean; access: { capability: string; scope: string; rule: string }[] }[] };

const roles = skill<RolesData>({
  name: 'page_roles',
  label: 'Roles & Permissions',
  href: '/admin/roles',
  surface: 'admin',
  can: admin('Roles & Permissions'),
  keywords: /\b(roles? (and|&) permissions|permissions?|custom roles?|access (rights|levels?))\b/,
  examples: ['Which custom roles do we have?', 'What permissions does the finance role have?'],
  description: 'Every role (standard and custom) with the capabilities it has and their scope.',
  load: async (ref, me) => {
    // The /org endpoints need users_roles_hierarchy access (RequireCapability on OrgController).
    if ((me.permissions.users_roles_hierarchy?.scope ?? 'none') === 'none') throw new ForbiddenException("You don't have access to roles and permissions");
    const rows = await svc(ref, OrgService).roles(me);
    return { roles: rows.map((r) => ({ name: r.name, baseRole: r.baseRole, custom: r.isCustom, access: r.permissions.filter((p) => p.scope !== 'none').map((p) => ({ capability: words(p.capability), scope: p.scope, rule: words(p.rule) })) })) };
  },
  answer: (d, q) => {
    if (!d.roles.length) return `No roles found. Open ${link('Roles & Permissions', '/admin/roles')}.`;
    const named = d.roles.find((r) => q.includes(r.name.toLowerCase()) || q.includes(words(r.baseRole)));
    if (named) {
      const body = named.access.length ? bullets(named.access.map((a) => `${a.capability}: ${a.scope}${a.rule && a.rule !== 'none' ? ` (${a.rule})` : ''}`), 40) : 'This role has no access switched on.';
      return `**${named.name}**${named.custom ? ' (custom role)' : ''} can use ${plural(named.access.length, 'area')}:\n${body}\n\nOpen ${link('Roles & Permissions', '/admin/roles')}.`;
    }
    const custom = d.roles.filter((r) => r.custom);
    const out = [`**${plural(d.roles.length, 'role')}**, ${custom.length} custom.`];
    const list = /\bcustom\b/.test(q) ? custom : d.roles;
    out.push(list.length ? bullets(list.map((r) => `${r.name}${r.custom ? ` (custom, based on ${words(r.baseRole)})` : ''} · ${plural(r.access.length, 'area')}`), 20) : 'There are no custom roles yet.');
    out.push(`Open ${link('Roles & Permissions', '/admin/roles')}.`);
    return out.join('\n\n');
  },
});

type StructureData = {
  branches: { name: string; city: string; headcount: number; departments: { name: string; head: string | null; headcount: number; teams: { name: string; lead: string | null; members: number }[]; unassigned: number }[] }[];
  staff: number;
};

const loadStructure = async (ref: ModuleRef, me: Me): Promise<StructureData> => {
  const v = await svc(ref, StructureService).view(me);
  return {
    staff: v.staff.length,
    branches: v.branches.map((b) => ({
      name: b.name,
      city: b.city,
      headcount: b.headcount,
      departments: b.departments.map((d) => ({ name: d.name, head: d.head?.name ?? null, headcount: d.headcount, teams: d.teams.map((t) => ({ name: t.name, lead: t.lead?.name ?? null, members: t.members.length })), unassigned: d.unassigned.length })),
    })),
  };
};

const branches = skill<StructureData>({
  name: 'page_branches',
  label: 'Branches',
  href: '/admin/branches',
  surface: 'admin',
  can: admin('Branches'),
  keywords: /\b(branches|branch list|which branch|how many branches|each branch|branch headcount)\b/,
  examples: ['Which branches do we have?', 'How many people are in each branch?'],
  description: 'Branches with their city, headcount and departments.',
  load: loadStructure,
  answer: (d) => {
    if (!d.branches.length) return `No branches are set up yet. Open ${link('Branches', '/admin/branches')}.`;
    return `**${plural(d.branches.length, 'branch', 'branches')}**, ${plural(d.staff, 'person', 'people')} in all:\n${bullets(d.branches.map((b) => `${b.name} (${b.city}) · ${plural(b.headcount, 'person', 'people')} · ${plural(b.departments.length, 'department')}`), 20)}\n\nOpen ${link('Branches', '/admin/branches')}.`;
  },
});

const departments = skill<StructureData>({
  name: 'page_departments',
  label: 'Departments & Teams',
  href: '/admin/departments',
  surface: 'admin',
  can: admin('Departments & Teams'),
  keywords: /\b(departments? (and|&) teams|department heads?|which departments|how many departments|department list|team leads?)\b/,
  examples: ['Which departments and teams do we have?', 'Who are the department heads?'],
  description: 'Departments in each branch with their head, headcount, teams and team leads.',
  load: loadStructure,
  answer: (d) => {
    const deps = d.branches.flatMap((b) => b.departments.map((dep) => ({ ...dep, branch: b.name })));
    if (!deps.length) return `No departments are set up yet. Open ${link('Departments & Teams', '/admin/departments')}.`;
    const multi = d.branches.length > 1;
    const rows = deps.map(
      (dep) =>
        `${dep.name}${multi ? ` (${dep.branch})` : ''} · ${dep.head ? `head ${dep.head}` : 'no head'} · ${plural(dep.headcount, 'person', 'people')}${dep.teams.length ? ` · teams: ${dep.teams.map((t) => `${t.name}${t.lead ? ` (lead ${t.lead})` : ''}`).join(', ')}` : ''}${dep.unassigned ? ` · ${dep.unassigned} not in a team` : ''}`,
    );
    const noHead = deps.filter((dep) => !dep.head).length;
    return `**${plural(deps.length, 'department')}**, ${plural(deps.reduce((s, dep) => s + dep.teams.length, 0), 'team')}${noHead ? `, ${noHead} without a head` : ''}:\n${bullets(rows, 20)}\n\nOpen ${link('Departments & Teams', '/admin/departments')}.`;
  },
});

type AttendanceData = {
  today: string | null;
  todayKind: string;
  scope: string;
  byStatus: { name: string; count: number }[];
  late: { name: string; checkIn: string | null }[];
  onLeave: string[];
  notIn: string[];
  wfh: string[];
  pendingLeave: { name: string; type: string; from: string | null; to: string | null; days: number; reason: string }[];
  upcomingLeave: { name: string; type: string; from: string | null; to: string | null }[];
};

const STATUS_WORDS: Record<string, string> = { checked_in: 'in', checked_out: 'checked out', absent: 'absent', on_leave: 'on leave', holiday: 'holiday', day_off: 'day off', not_yet: 'not in yet' };

const attendance = skill<AttendanceData>({
  name: 'page_attendance_admin',
  label: 'Attendance & Leave',
  href: '/admin/attendance',
  surface: 'admin',
  can: admin('Attendance & Leave'),
  keywords: /\b(who('s| is| are)? (on leave|absent|late|not in|in the office|working from home|wfh)|team attendance|attendance (board|today|this month)|leave requests?|absent today|late today)\b/,
  examples: ['Who is on leave today?', 'Which staff leave requests are pending?'],
  description: "Today's attendance board (in, late, on leave, not in yet) for the people the person can see, plus leave requests waiting for their decision and upcoming approved leave.",
  load: async (ref, me) => {
    const a = svc(ref, AttendanceService);
    const [v, leave] = await Promise.all([a.view(me), a.leave(me)]);
    const today = istDay();
    const names = (rows: typeof v.board) => rows.map((r) => r.user.name).slice(0, 20);
    return {
      today: day(v.today),
      todayKind: v.todayKind.kind === 'working' ? 'a working day' : v.todayKind.kind === 'holiday' ? `a holiday${v.todayKind.label ? ` (${v.todayKind.label})` : ''}` : 'a weekly off',
      scope: v.scope && !v.scope.all ? v.scope.departments.join(', ') : 'everyone',
      byStatus: countBy(v.board, (r) => STATUS_WORDS[r.status] ?? words(r.status)),
      late: v.board.filter((r) => r.late).map((r) => ({ name: r.user.name, checkIn: r.checkIn })).slice(0, 20),
      onLeave: names(v.board.filter((r) => r.status === 'on_leave')),
      notIn: names(v.board.filter((r) => r.status === 'not_yet' || r.status === 'absent')),
      wfh: names(v.board.filter((r) => r.wfh)),
      pendingLeave: leave
        .filter((l) => l.status === 'pending' && l.canDecide)
        .slice(0, 10)
        .map((l) => ({ name: l.user.name, type: words(l.type), from: day(l.from), to: day(l.to), days: l.workingDays, reason: short(l.reason, 80) })),
      upcomingLeave: leave
        .filter((l) => l.status === 'approved' && l.to.slice(0, 10) >= today)
        .sort((x, y) => x.from.localeCompare(y.from))
        .slice(0, 10)
        .map((l) => ({ name: l.user.name, type: words(l.type), from: day(l.from), to: day(l.to) })),
    };
  },
  answer: (d, q) => {
    const out: string[] = [];
    const leaveQ = /\bleave requests?\b|\bpending\b|\bdecide\b/.test(q);
    if (leaveQ) {
      out.push(d.pendingLeave.length ? `**${plural(d.pendingLeave.length, 'leave request')} waiting for your decision:**\n${bullets(d.pendingLeave.map((l) => `${l.name} · ${l.type} · ${l.from}${l.to && l.to !== l.from ? ` to ${l.to}` : ''} · ${plural(l.days, 'working day')}${l.reason ? ` · "${l.reason}"` : ''}`))}` : 'No leave request is waiting for your decision.');
      if (d.upcomingLeave.length) out.push(`Approved leave coming up:\n${bullets(d.upcomingLeave.map((l) => `${l.name} · ${l.type} · ${l.from}${l.to && l.to !== l.from ? ` to ${l.to}` : ''}`))}`);
    } else {
      out.push(`**Today (${d.today}) is ${d.todayKind}.** ${d.byStatus.length ? `Attendance for ${d.scope}: ${counts(d.byStatus)}.` : 'Nobody to show.'}`);
      out.push(d.onLeave.length ? `On leave: ${d.onLeave.join(', ')}.` : 'Nobody is on leave today.');
      if (d.late.length) out.push(`Late: ${d.late.map((l) => `${l.name}${l.checkIn ? ` (${l.checkIn})` : ''}`).join(', ')}.`);
      if (d.notIn.length) out.push(`Not in yet: ${d.notIn.join(', ')}.`);
      if (d.wfh.length) out.push(`Working from home: ${d.wfh.join(', ')}.`);
      if (d.pendingLeave.length) out.push(`${plural(d.pendingLeave.length, 'leave request')} waiting for your decision.`);
    }
    out.push(`Open ${link('Attendance & Leave', '/admin/attendance')}.`);
    return out.join('\n\n');
  },
});

type HolidaysData = { hours: { start: string; end: string; days: string; graceMinutes: number; timezone: string }; upcoming: { date: string | null; name: string }[]; thisYear: number; total: number };

const holidays = skill<HolidaysData>({
  name: 'page_holidays',
  label: 'Holidays & Working Hours',
  href: '/admin/holidays',
  surface: 'admin',
  can: admin('Holidays & Working Hours'),
  keywords: /\b(company holidays?|holiday calendar|office calendar|public holidays?|(company|office|org) (working )?(hours|timings?|days)|working days|grace (period|minutes))\b/,
  examples: ['What are the company holidays this year?', 'What are the company working hours?'],
  description: 'The office calendar: working hours and days, the late grace period, and upcoming holidays.',
  load: async (ref, me) => {
    // Only the two sections this page shows (settings.all also holds other settings).
    const s = await svc(ref, SettingsService).all(me);
    const today = istDay();
    const list = [...s.holidays.list].sort((a, b) => a.date.localeCompare(b.date));
    const h = s.workingHours;
    return {
      hours: { start: h.start, end: h.end, days: h.days.map((x) => DAY_NAMES[x]).join(', '), graceMinutes: h.graceMinutes ?? 15, timezone: h.timezone },
      upcoming: list.filter((x) => x.date >= today).slice(0, 12).map((x) => ({ date: day(x.date), name: short(x.name, 60) })),
      thisYear: list.filter((x) => x.date.startsWith(today.slice(0, 4))).length,
      total: list.length,
    };
  },
  answer: (d, q) => {
    const hoursLine = `Working hours are **${d.hours.start}–${d.hours.end}** on ${d.hours.days} (${d.hours.timezone}). A check-in more than ${d.hours.graceMinutes} minutes after the start counts as late.`;
    const hol = d.upcoming.length ? `**Upcoming holidays** (${d.thisYear} this year):\n${bullets(d.upcoming.map((x) => `${x.date}: ${x.name}`), 12)}` : `No upcoming holidays are on the calendar${d.total ? '' : ' yet'}.`;
    const hoursFirst = /\b(hours|timings?|working days|grace)\b/.test(q) && !/\bholidays?\b/.test(q);
    return `${hoursFirst ? `${hoursLine}\n\n${hol}` : `${hol}\n\n${hoursLine}`}\n\nOpen ${link('Holidays & Working Hours', '/admin/holidays')}.`;
  },
});

type PeopleFlowsData = {
  open: { kind: string; name: string; department: string | null; role: string | null; progressPct: number; date: string | null; buddy: string | null; openWork: number | null }[];
  openOnboarding: number;
  openOffboarding: number;
  joinedThisMonth: { name: string; department: string | null; start: string | null }[];
};

const peopleFlows = skill<PeopleFlowsData>({
  name: 'page_people_onboarding',
  label: 'Onboarding & Offboarding',
  href: '/admin/people',
  surface: 'admin',
  can: admin('Onboarding & Offboarding'),
  keywords: /\b((staff|employee|people|new hire|joiner|leaver)s? (on|off)boardings?|(on|off)boardings? (of )?(staff|employees|people|new hires?)|new joiners?|new hires?|leavers?|exit checklists?|joining checklists?)\b/,
  examples: ['Which employee onboardings are still open?', 'Who are the new joiners this month?'],
  description: 'Open staff onboarding and offboarding checklists with progress, start or last day, buddy, and work still owned by leavers.',
  load: async (ref, me) => {
    const rows = await svc(ref, PeopleService).list(me);
    const open = rows.filter((r) => r.status === 'open');
    const month = istMonth();
    return {
      openOnboarding: open.filter((r) => r.kind === 'onboarding').length,
      openOffboarding: open.filter((r) => r.kind === 'offboarding').length,
      open: open.slice(0, 15).map((r) => ({
        kind: r.kind,
        name: r.user.name,
        department: r.user.department,
        role: r.user.role,
        progressPct: r.progressPct,
        date: day(r.kind === 'onboarding' ? r.startDate : r.lastDay),
        buddy: r.buddy?.name ?? null,
        openWork: r.openWork ? Object.values(r.openWork).reduce<number>((s, v) => s + (typeof v === 'number' ? v : Array.isArray(v) ? v.length : 0), 0) : null,
      })),
      joinedThisMonth: rows
        .filter((r) => r.kind === 'onboarding' && r.status !== 'cancelled' && r.startDate && istMonth(new Date(r.startDate)) === month)
        .slice(0, 15)
        .map((r) => ({ name: r.user.name, department: r.user.department, start: day(r.startDate) })),
    };
  },
  answer: (d, q) => {
    const out = [`**${plural(d.openOnboarding, 'onboarding')} and ${plural(d.openOffboarding, 'offboarding')} open.**`];
    if (/\b(new joiners?|new hires?|joined)\b/.test(q)) {
      out.push(d.joinedThisMonth.length ? `Starting this month:\n${bullets(d.joinedThisMonth.map((p) => `${p.name}${p.department ? ` · ${p.department}` : ''}${p.start ? ` · starts ${p.start}` : ''}`), 15)}` : 'Nobody starts this month.');
    }
    const kind = /\b(leavers?|offboardings?|exit)\b/.test(q) ? 'offboarding' : /\b(onboardings?|joiners?|new hires?|joining)\b/.test(q) ? 'onboarding' : null;
    const rows = d.open.filter((r) => !kind || r.kind === kind);
    if (rows.length)
      out.push(
        bullets(
          rows.map((r) => `${r.name}${r.department ? ` · ${r.department}` : ''} · ${r.kind} ${r.progressPct}% done${r.date ? ` · ${r.kind === 'onboarding' ? 'starts' : 'last day'} ${r.date}` : ''}${r.buddy ? ` · buddy ${r.buddy}` : ''}${r.openWork ? ` · ${r.openWork} open items to hand over` : ''}`),
          15,
        ),
      );
    out.push(`Open ${link('Onboarding & Offboarding', '/admin/people')}.`);
    return out.join('\n\n');
  },
});

type TimesheetsData = { counts: Record<string, number>; approvedHours: string; waiting: { name: string; week: string | null; hours: string; submitted: string | null }[]; returned: { name: string; week: string | null; comment: string }[] };

const timesheets = skill<TimesheetsData>({
  name: 'page_timesheets_admin',
  label: 'Timesheets',
  href: '/admin/timesheets',
  surface: 'admin',
  can: admin('Timesheets'),
  keywords: /\b(team timesheets?|staff timesheets?|whose timesheets?|which timesheets?|timesheets? (to sign off|waiting|pending|submitted|returned|sent back))\b/,
  examples: ['Which team timesheets are waiting for sign-off?', 'Whose timesheets were returned?'],
  description: 'Team timesheets the person can decide on: how many are submitted, approved and returned, and the ones waiting with their hours.',
  load: async (ref, me) => {
    const rows = await svc(ref, TimesheetsService).approvals(me, 'all');
    const c: Record<string, number> = { draft: 0, submitted: 0, approved: 0, returned: 0 };
    for (const r of rows) c[r.status] = (c[r.status] ?? 0) + 1;
    return {
      counts: c,
      approvedHours: hours(rows.filter((r) => r.status === 'approved').reduce((s, r) => s + r.totalMinutes, 0)),
      waiting: rows
        .filter((r) => r.status === 'submitted')
        .slice(0, 15)
        .map((r) => ({ name: r.user.name, week: day(r.weekStart), hours: hours(r.totalMinutes), submitted: day(r.submittedAt) })),
      returned: rows
        .filter((r) => r.status === 'returned')
        .slice(0, 10)
        .map((r) => ({ name: r.user.name, week: day(r.weekStart), comment: short(r.comment, 80) })),
    };
  },
  answer: (d, q) => {
    const c = d.counts;
    const out = [`**${c.submitted} submitted**, ${c.approved} approved (${d.approvedHours}), ${c.returned} returned.`];
    if (/\b(returned|sent back)\b/.test(q)) out.push(d.returned.length ? `Returned:\n${bullets(d.returned.map((r) => `${r.name} · week of ${r.week}${r.comment ? ` · "${r.comment}"` : ''}`))}` : 'No timesheet is returned right now.');
    else out.push(d.waiting.length ? `Waiting for a decision:\n${bullets(d.waiting.map((r) => `${r.name} · week of ${r.week} · ${r.hours}${r.submitted ? ` · sent ${r.submitted}` : ''}`), 15)}` : 'No timesheet is waiting for a decision.');
    out.push(`Open ${link('Timesheets', '/admin/timesheets')}.`);
    return out.join('\n\n');
  },
});

// ------------------------------------------------------------------ Clients

type ClientOffboardingData = {
  offboarding: number;
  paused: number;
  closed: number;
  unpaidBeforeClosing: number;
  wrapping: { client: string; service: string; status: string; checks: string; unpaid: string | null; blocked: string | null; since: string | null }[];
};

const clientOffboarding = skill<ClientOffboardingData>({
  name: 'page_client_offboarding',
  label: 'Offboarding',
  href: '/admin/offboarding',
  surface: 'admin',
  can: admin('Offboarding'),
  keywords: /\b(client offboarding|offboarding (clients?|engagements?|checklists?)|clients? (are )?(being )?offboard(ed|ing)|paused engagements?|engagements? (that are )?(paused|offboarding|being offboarded|to close)|closing engagements?)\b/,
  examples: ['Which clients are being offboarded?', 'Show paused engagements'],
  description: 'Engagements that are paused or being offboarded: checklist progress, unpaid invoices that block closing, plus counts of closed ones.',
  load: async (ref, me) => {
    const rows = await svc(ref, ClientsAdminService).offboarding(me);
    const wrapping = rows.filter((r) => r.status === 'paused' || r.status === 'offboarding');
    return {
      offboarding: rows.filter((r) => r.status === 'offboarding').length,
      paused: rows.filter((r) => r.status === 'paused').length,
      closed: rows.filter((r) => r.status === 'closed').length,
      unpaidBeforeClosing: wrapping.filter((r) => r.unpaidInvoices.length).length,
      wrapping: wrapping.slice(0, 15).map((r) => {
        const checks = Object.values(r.checklist);
        const unpaid = r.unpaidInvoices.reduce((s, i) => s + i.totalPaise, 0);
        return {
          client: r.client.name,
          service: r.serviceName,
          status: r.status,
          checks: `${checks.filter((c) => c.done).length}/${checks.length} checks done`,
          unpaid: r.unpaidInvoices.length ? `${plural(r.unpaidInvoices.length, 'unpaid invoice')} (${formatINR(unpaid)})` : null,
          blocked: r.closeBlockedReason ? short(r.closeBlockedReason, 80) : null,
          since: r.lastChange ? day(r.lastChange.at) : null,
        };
      }),
    };
  },
  answer: (d, q) => {
    const onlyPaused = /\bpaused\b/.test(q) && !/\boffboard/.test(q);
    const rows = onlyPaused ? d.wrapping.filter((r) => r.status === 'paused') : d.wrapping;
    const out = [`**${d.offboarding} offboarding, ${d.paused} paused**, ${d.closed} closed.${d.unpaidBeforeClosing ? ` ${plural(d.unpaidBeforeClosing, 'engagement')} still ${d.unpaidBeforeClosing === 1 ? 'has' : 'have'} unpaid invoices.` : ''}`];
    out.push(rows.length ? bullets(rows.map((r) => `${r.client} · ${r.service} · ${r.status}${r.since ? ` since ${r.since}` : ''} · ${r.checks}${r.unpaid ? ` · ${r.unpaid}` : ''}${r.blocked ? ` · can't close: ${r.blocked}` : ''}`), 15) : `No engagement is ${onlyPaused ? 'paused' : 'paused or being offboarded'} right now.`);
    out.push(`Open ${link('Offboarding', '/admin/offboarding')}.`);
    return out.join('\n\n');
  },
});

type AdminRequestsData = {
  open: number;
  quoted: number;
  late: number;
  addOnRevenueThisMonth: string;
  approvedThisMonth: number;
  byClient: { name: string; count: number }[];
  rows: { client: string; type: string; status: string; text: string; late: boolean; quote: string | null; at: string | null }[];
};

const CLOSED_REQUESTS = ['done', 'declined'];

const adminRequests = skill<AdminRequestsData>({
  name: 'page_requests_admin',
  label: 'Requests & Add-ons',
  href: '/admin/requests',
  surface: 'admin',
  can: admin('Requests & Add-ons'),
  keywords: /\b(add-?on requests?|requests? (and|&) add-?ons|quoted requests?|requests? (that are )?(quoted|waiting for (a )?quote)|add-?on (revenue|quotes?|sales))\b/,
  examples: ['Which add-on requests are quoted?', 'How much add-on revenue came in this month?'],
  description: 'Client requests desk: open, quoted and late (past first-reply SLA) requests, add-on revenue approved this month, and the open requests.',
  load: async (ref, me) => {
    const all = await svc(ref, RequestsService).list(me);
    const month = istMonth();
    const open = all.filter((r) => !CLOSED_REQUESTS.includes(r.status));
    const approved = all.filter((r) => r.quote && r.approval && istMonth(new Date(r.approval.at)) === month);
    const rowOf = (r: (typeof all)[number]) => ({
      client: r.client.name,
      type: requestTypeLabels[r.type]?.team ?? words(r.type),
      status: requestStatusLabels[r.status]?.team ?? words(r.status),
      text: short(r.description, 70),
      late: r.sla.state === 'overdue',
      quote: r.quote ? formatINR(r.quote.totalPaise) : null,
      at: day(r.createdAt),
    });
    return {
      open: open.length,
      quoted: all.filter((r) => r.status === 'quoted').length,
      late: all.filter((r) => r.sla.state === 'overdue').length,
      addOnRevenueThisMonth: formatINR(approved.reduce((s, r) => s + (r.quote?.amountPaise ?? 0), 0)),
      approvedThisMonth: approved.length,
      byClient: countBy(open, (r) => r.client.name).slice(0, 6),
      rows: [...all.filter((r) => r.status === 'quoted'), ...open.filter((r) => r.status !== 'quoted')].slice(0, 15).map(rowOf),
    };
  },
  answer: (d, q) => {
    const out = [`**${d.open} open, ${d.quoted} quoted, ${d.late} past the first-reply SLA.** Add-on revenue approved this month: ${d.addOnRevenueThisMonth} (${plural(d.approvedThisMonth, 'request')}).`];
    const quotedOnly = /\bquot(ed|e|es)\b/.test(q) && !/\brevenue\b/.test(q);
    const rows = quotedOnly ? d.rows.filter((r) => r.quote && /quot/i.test(r.status)) : d.rows;
    if (!/\brevenue\b/.test(q)) out.push(rows.length ? bullets(rows.map((r) => `${r.client}: ${r.text} · ${r.type} · ${r.status}${r.quote ? ` · ${r.quote}` : ''}${r.late ? ' · reply overdue' : ''}`)) : quotedOnly ? 'No request is waiting on a quote decision.' : 'No open requests.');
    else if (d.byClient.length) out.push(`Most open requests: ${counts(d.byClient)}.`);
    out.push(`Open ${link('Requests & Add-ons', '/admin/requests')}.`);
    return out.join('\n\n');
  },
});

type CmData = { cms: { name: string; role: string; clients: number; activeEngagements: number }[]; unassigned: { name: string; health: string }[]; clients: number };

const cmAssignment = skill<CmData>({
  name: 'page_cm_assignment',
  label: 'CM Assignment',
  href: '/admin/am-assignment',
  surface: 'admin',
  can: admin('CM Assignment'),
  keywords: /\b(cm assignments?|client manager (workload|assignments?|load)|each client manager|clients? per (client manager|cm)|(have|has|with) no client manager|without a client manager|unassigned clients|cm workload)\b/,
  examples: ['How many clients does each client manager have?', 'Which clients have no client manager?'],
  description: 'Client managers with their number of clients and active engagements, and clients with no client manager.',
  load: async (ref, me) => {
    const w = await svc(ref, ClientsAdminService).workload(me);
    return {
      clients: w.clients.length,
      cms: [...w.ams].sort((a, b) => b.clients - a.clients).map((a) => ({ name: a.name, role: words(a.role), clients: a.clients, activeEngagements: a.activeEngagements })),
      unassigned: w.clients.filter((c) => !c.am).slice(0, 15).map((c) => ({ name: c.name, health: c.health })),
    };
  },
  answer: (d, q) => {
    const out = [`**${plural(d.cms.length, 'client manager')}** across ${plural(d.clients, 'client')}; ${d.unassigned.length ? `${plural(d.unassigned.length, 'client')} without one` : 'every client has one'}.`];
    if (/\b(no|without|unassigned)\b/.test(q)) out.push(d.unassigned.length ? `No client manager:\n${bullets(d.unassigned.map((c) => `${c.name} · health ${c.health}`), 15)}` : 'Every client has a client manager.');
    else out.push(bullets(d.cms.map((a) => `${a.name} · ${plural(a.clients, 'client')} · ${plural(a.activeEngagements, 'active engagement')}`), 20));
    out.push(`Open ${link('CM Assignment', '/admin/am-assignment')}.`);
    return out.join('\n\n');
  },
});

type EngagementsData = { total: number; byStatus: { name: string; count: number }[]; byGate: { name: string; count: number }[]; byService: { name: string; count: number }[]; recent: { client: string; service: string; tier: string; status: string; gate: string; cm: string | null; start: string | null }[] };

const engagements = skill<EngagementsData>({
  name: 'page_engagements',
  label: 'Engagements',
  href: '/admin/engagements',
  surface: 'admin',
  can: admin('Engagements'),
  keywords: /\b(engagements? (list|by (gate|status|service|tier))|(active|all|open|running) engagements|how many engagements|engagements? (are )?(at )?(each gate|gate|g[1-5]|active)|engagements page)\b/,
  examples: ['How many engagements are active?', 'Which engagements are at each gate?'],
  description: 'Every engagement: counts by status, gate and service, and the latest started ones with client, tier and client manager.',
  load: async (ref, me) => {
    const rows = await svc(ref, ClientsAdminService).engagements(me);
    const live = rows.filter((r) => !['closed', 'cancelled'].includes(r.status));
    return {
      total: rows.length,
      byStatus: countBy(rows, (r) => words(r.status)),
      byGate: countBy(live, (r) => r.currentGate).sort((a, b) => a.name.localeCompare(b.name)),
      byService: countBy(live, (r) => r.serviceName).slice(0, 8),
      recent: [...rows]
        .sort((a, b) => (b.startDate ?? b.createdAt).localeCompare(a.startDate ?? a.createdAt))
        .slice(0, 10)
        .map((r) => ({ client: r.client.name, service: r.serviceName, tier: r.tier, status: words(r.status), gate: r.currentGate, cm: r.am?.name ?? null, start: day(r.startDate ?? r.createdAt) })),
    };
  },
  answer: (d, q) => {
    if (!d.total) return `No engagements yet. Open ${link('Engagements', '/admin/engagements')}.`;
    const out = [`**${plural(d.total, 'engagement')}**: ${counts(d.byStatus)}.`];
    if (d.byGate.length) out.push(`By gate (not closed): ${d.byGate.map((g) => `${g.name}: ${g.count}`).join(', ')}.`);
    if (/\bservices?\b/.test(q) && d.byService.length) out.push(`By service: ${counts(d.byService)}.`);
    if (!/\bgates?\b/.test(q)) out.push(`Latest:\n${bullets(d.recent.map((r) => `${r.client} · ${r.service} (${r.tier}) · ${r.status} · ${r.gate}${r.cm ? ` · CM ${r.cm}` : ''}${r.start ? ` · from ${r.start}` : ''}`))}`);
    out.push(`Open ${link('Engagements', '/admin/engagements')}.`);
    return out.join('\n\n');
  },
});

type ClientsPageData = {
  total: number;
  byStatus: { name: string; count: number }[];
  addedThisMonth: { name: string; status: string; cm: string | null; since: string | null }[];
  addedLastMonth: number;
  inactiveOrOnHold: { name: string; status: string; cm: string | null; payment: string }[];
  noCm: number;
};

const clientsPage = skill<ClientsPageData>({
  name: 'page_clients_admin',
  label: 'Clients',
  href: '/admin/clients',
  surface: 'admin',
  can: admin('Clients'),
  keywords: /\b(clients? (were |was |got )?(added|onboarded|signed( up)?|joined) (this|last) (month|week)|new clients (this|last) (month|week)|inactive clients?|clients? (are |is )?(inactive|on hold)|clients? (list )?by status|client list by status|client statuses)\b/,
  examples: ['How many clients were added this month?', 'Which clients are inactive or on hold?'],
  description: 'The client list by status (lead, onboarding, active, on hold, inactive), clients added this month, and inactive or on-hold clients (no contact details).',
  load: async (ref, me) => {
    const rows = await svc(ref, ClientsManageService).list(me, {});
    const month = istMonth();
    const [y, m] = month.split('-').map(Number);
    const prev = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    const added = rows.filter((r) => istMonth(new Date(r.onboardedAt ?? r.createdAt)) === month);
    return {
      total: rows.length,
      byStatus: countBy(rows, (r) => words(r.clientStatus)),
      addedThisMonth: added.slice(0, 15).map((r) => ({ name: r.name, status: words(r.clientStatus), cm: r.am?.name ?? null, since: day(r.onboardedAt ?? r.createdAt) })),
      addedLastMonth: rows.filter((r) => istMonth(new Date(r.onboardedAt ?? r.createdAt)) === prev).length,
      inactiveOrOnHold: rows
        .filter((r) => r.clientStatus === 'inactive' || r.clientStatus === 'on_hold')
        .slice(0, 15)
        .map((r) => ({ name: r.name, status: words(r.clientStatus), cm: r.am?.name ?? null, payment: words(r.paymentStatus) })),
      noCm: rows.filter((r) => !r.am).length,
    };
  },
  answer: (d, q) => {
    if (!d.total) return `No clients yet. Open ${link('Clients', '/admin/clients')}.`;
    const out = [`**${plural(d.total, 'client')}**: ${counts(d.byStatus)}.${d.noCm ? ` ${d.noCm} without a client manager.` : ''}`];
    if (/\b(added|new|onboarded|signed|joined)\b/.test(q)) {
      out.push(d.addedThisMonth.length ? `**${plural(d.addedThisMonth.length, 'client')} added this month** (${d.addedLastMonth} last month):\n${bullets(d.addedThisMonth.map((c) => `${c.name} · ${c.status}${c.cm ? ` · CM ${c.cm}` : ''}${c.since ? ` · ${c.since}` : ''}`), 15)}` : `No clients added this month (${d.addedLastMonth} last month).`);
    } else if (/\b(inactive|on hold)\b/.test(q)) {
      out.push(d.inactiveOrOnHold.length ? `Inactive or on hold:\n${bullets(d.inactiveOrOnHold.map((c) => `${c.name} · ${c.status}${c.cm ? ` · CM ${c.cm}` : ''} · payment ${c.payment}`), 15)}` : 'No client is inactive or on hold.');
    }
    out.push(`Open ${link('Clients', '/admin/clients')}.`);
    return out.join('\n\n');
  },
});

// First keyword match wins: the more specific tabs come before the broader ones that share words
// (runs before workflows/automations, client offboarding before engagements, branches before users).
export const SKILLS: PageSkill[] = [
  flowMap,
  workflowRuns,
  workflows,
  automationLog,
  automations,
  agentRuns,
  aiAgents,
  hierarchy,
  branches,
  departments,
  users,
  roles,
  attendance,
  holidays,
  peopleFlows,
  timesheets,
  clientOffboarding,
  adminRequests,
  cmAssignment,
  engagements,
  clientsPage,
];
