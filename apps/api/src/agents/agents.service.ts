// v15 AI agents: settings, the scheduler (new leads and requests, the morning production check, the monthly report),
// running an agent in AI or basic mode, Ask the Analyst, the run log and the Agent Inbox.
import type Anthropic from '@anthropic-ai/sdk';
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  AGENT_KEYS,
  AGENTS_LATER,
  agentActionInfo,
  agentActions,
  agentInfo,
  type AgentAskResult,
  type AgentDecideInput,
  type AgentFeedbackInput,
  type AgentKey,
  type AgentPatch,
  type AgentProposalField,
  type AgentProposalStatus,
  type AgentProposalView,
  type AgentRunDetail,
  type AgentRunRow,
  type AgentRunStatus,
  type AgentsOverview,
  type AgentStepView,
  type AgentTickResult,
  type AgentTrigger,
  type AgentView,
  type AiCitation,
  type AiMode,
  type Me,
} from '@bmu/shared';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { MeService } from '../auth/me.service.js';
import { cleanLinks, AiCopilotService } from '../ai/ai-copilot.js';
import { SAFETY_RULES } from '../ai/ai-safety.js';
import { staffTools, toolDefs, type CopilotTool } from '../ai/ai-tools.js';
import { AiOffError, AiRefusal, AiService, textOf, type AiOut, type AiRunner } from '../ai/ai.service.js';
import { startOfMonth } from '../insights/ist.js';
import { eventBus, type BusEvent } from '../platform/event-bus.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readFile } from 'node:fs/promises';
import { ACTIONS } from './catalogue.js';
import { KnowledgeService } from './knowledge.service.js';
import {
  AGENT_RULES,
  AGENT_SYSTEM,
  ANALYST_ASK,
  ANALYST_MONTHLY,
  leadFacts,
  leadLabel,
  PRODUCER_PROMPT,
  producerBasic,
  requestFacts,
  creativeBasic,
  creativePrompt,
  versionFacts,
  salesBasic,
  salesPrompt,
  salesStalled,
  triageBasic,
  triagePrompt,
  type BasicResult,
  type PlanHelpers,
  type Subject,
} from './plans.js';
import { AgentRuntime, type RunCtx } from './runtime.js';
import { financeBasic, financeFacts, financePrompt } from './finance-plan.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';
import { localFile } from '../storage/file-store.js';

const TICK_MS = 60_000;
const MAX_TURNS = 8;
const PER_TICK = 20;
const isAdmin = (me: Me) => me.type === 'staff' && me.roles.some((r) => r === 'founder' || r === 'admin');
const istDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(d);
const istHour = (d: Date) => Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Kolkata' }).format(d));
const dateLine = (d: Date) => new Intl.DateTimeFormat('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(d);
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

/** Read-only tools each agent gets in AI mode (from Ask BMU, in the acting person's own scope). */
const READ_TOOLS: Record<AgentKey, string[]> = {
  sales_assistant: ['find_leads', 'lead_details'],
  request_triage: ['find_requests', 'client_360'],
  producer: ['find_tasks', 'team_performance'],
  creative_reviewer: [],
  finance_collector: ['find_invoices', 'find_clients'],
  analyst: ['find_clients', 'client_360', 'clients_at_risk', 'find_leads', 'lead_details', 'find_invoices', 'find_tasks', 'find_requests', 'business_summary', 'sales_numbers', 'team_performance'],
};

export type ExecOpts = {
  trigger: AgentTrigger;
  subject?: Subject | null;
  startedBy?: Me | null;
  /** Scripted model for the safety checks; skips the AI service (no real API call, no AiLog). */
  runner?: AiRunner | null;
  /** Ask the Analyst: the person asking is the acting person. */
  actingOverride?: Me | null;
  question?: string;
  isEval?: boolean;
  now?: Date;
};

type AgentRow = Awaited<ReturnType<PrismaService['agent']['findFirstOrThrow']>>;
type RunRow = Awaited<ReturnType<PrismaService['agentRun']['findFirstOrThrow']>>;

@Injectable()
export class AgentsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Agents');
  private job?: JobHandle;
  private nudge?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private ticking = false;
  /** When each organisation's knowledge was last rebuilt by the scheduler (hourly). */
  private knowledgeAt = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly ref: ModuleRef,
    private readonly ai: AiService,
    private readonly runtime: AgentRuntime,
    private readonly knowledge: KnowledgeService,
    private readonly meService: MeService,
    private readonly audit: AuditService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'agents.scheduler', hint: 'Runs AI agents on their schedules (and right after new leads and requests)', everyMs: TICK_MS, flags: ['AGENTS_DISABLED'], run: () => this.safeTick() });
    if (!this.job) return;
    // A new lead or request is picked up within seconds instead of waiting for the next minute.
    this.unsubscribe = eventBus.subscribe('agents', (e: BusEvent) => this.onEvent(e), ['change']);
    this.log.log('AI agents scheduler started (every minute, and after new leads and requests)');
  }

  onModuleDestroy() {
    this.job?.stop();
    if (this.nudge) clearTimeout(this.nudge);
    this.unsubscribe?.();
  }

  private onEvent(e: BusEvent) {
    if (e.kind !== 'change' || e.op !== 'create' || !['Lead', 'Request', 'Version'].includes(e.entity) || this.nudge) return;
    this.nudge = setTimeout(() => {
      this.nudge = undefined;
      this.safeTick();
    }, 5_000);
    this.nudge.unref?.();
  }

  private safeTick() {
    return this.tick().catch((e: Error) => this.log.error(`Agents tick failed: ${e.message}`));
  }

  // ------------------------------------------------------------------------------------------ setup

  /** Creates the four agent rows (off, acting for the Founder) the first time an organisation opens the page. */
  async ensure(orgId: string) {
    const have = await this.prisma.agent.findMany({ where: { orgId }, select: { key: true } });
    const missing = AGENT_KEYS.filter((k) => !have.some((h) => h.key === k));
    if (missing.length) {
      const founder = await this.prisma.user.findFirst({ where: { orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'founder' } } } }, select: { id: true }, orderBy: { createdAt: 'asc' } });
      await this.prisma.agent.createMany({ data: missing.map((key) => ({ orgId, key, actsForUserId: founder?.id ?? null })), skipDuplicates: true });
    }
    return this.prisma.agent.findMany({ where: { orgId } });
  }

  private assertAdmin(me: Me) {
    if (!isAdmin(me)) throw new ForbiddenException('AI agents are set up by the Founder and Branch Managers');
  }

  private async agentRow(orgId: string, key: string) {
    if (!(AGENT_KEYS as readonly string[]).includes(key)) throw new NotFoundException('Unknown agent');
    await this.ensure(orgId);
    return this.prisma.agent.findFirstOrThrow({ where: { orgId, key } });
  }

  private async spent(agentId: string, now = new Date()) {
    const agg = await this.prisma.agentRun.aggregate({ where: { agentId, createdAt: { gte: startOfMonth(now) }, isEval: false }, _sum: { costPaise: true }, _count: { _all: true } });
    return { costPaise: agg._sum.costPaise ?? 0, runs: agg._count._all };
  }

  private async people(orgId: string) {
    const users = await this.prisma.user.findMany({ where: { orgId, type: 'staff', status: 'active', deletedAt: null }, select: { id: true, name: true, roles: { select: { role: { select: { baseRole: true } } } } }, orderBy: { name: 'asc' } });
    return users.map((u) => ({ id: u.id, name: u.name, roles: u.roles.map((r) => r.role.baseRole) }));
  }

  private async view(a: AgentRow, people: { id: string; name: string; roles: string[] }[]): Promise<AgentView> {
    const key = a.key as AgentKey;
    const info = agentInfo[key];
    const s = await this.spent(a.id);
    const fb = await this.prisma.agentRun.groupBy({ by: ['feedback'], where: { agentId: a.id, feedback: { not: null } }, _count: { _all: true } });
    return {
      key,
      label: info.label,
      summary: info.summary,
      when: info.when,
      does: info.does,
      enabled: a.enabled,
      actsFor: people.find((p) => p.id === a.actsForUserId) ?? null,
      monthlyBudgetPaise: a.monthlyBudgetPaise,
      spentPaise: s.costPaise,
      runsThisMonth: s.runs,
      lastRunAt: a.lastRunAt?.toISOString() ?? null,
      actions: agentActions[key].map((action) => ({ action, label: agentActionInfo[action].label, policy: agentActionInfo[action].policy, why: agentActionInfo[action].why })),
      thumbsUp: fb.find((f) => f.feedback === 1)?._count._all ?? 0,
      thumbsDown: fb.find((f) => f.feedback === -1)?._count._all ?? 0,
    };
  }

  async overview(me: Me): Promise<AgentsOverview> {
    this.assertAdmin(me);
    const rows = await this.ensure(me.orgId);
    const people = await this.people(me.orgId);
    const status = await this.ai.status(me);
    return {
      agents: await Promise.all(AGENT_KEYS.map((k) => this.view(rows.find((r) => r.key === k)!, people))),
      later: AGENTS_LATER.map((l) => ({ ...l })),
      people,
      aiMode: !status.enabled || !status.features.agents ? 'off' : status.mode === 'ai' ? 'ai' : 'basic',
      notice: !status.enabled || !status.features.agents ? 'AI is switched off for agents, so they use their built-in basic steps. Turn it on in Command Centre → AI Copilot.' : status.mode === 'ai' ? null : 'No AI key yet, so agents use their built-in basic steps. They still score, triage, chase and suggest; add ANTHROPIC_API_KEY for smarter drafts.',
      pendingProposals: await this.prisma.agentProposal.count({ where: { orgId: me.orgId, status: 'pending', expiresAt: { gt: new Date() } } }),
      knowledge: await this.knowledge.stats(me.orgId),
      canEdit: true,
      recent: await this.runs(me, {}),
    };
  }

  async update(me: Me, key: string, patch: AgentPatch): Promise<AgentView> {
    this.assertAdmin(me);
    const a = await this.agentRow(me.orgId, key);
    const people = await this.people(me.orgId);
    if (patch.actsForUserId && !people.some((p) => p.id === patch.actsForUserId)) throw new BadRequestException('Pick an active team member');
    const turningOn = patch.enabled === true && !a.enabled;
    if (turningOn && !(patch.actsForUserId ?? a.actsForUserId)) throw new BadRequestException('Pick who this agent acts for before switching it on');
    const updated = await this.prisma.agent.update({
      where: { id: a.id },
      data: {
        enabled: patch.enabled,
        actsForUserId: patch.actsForUserId === undefined ? undefined : patch.actsForUserId,
        monthlyBudgetPaise: patch.monthlyBudgetPaise,
        // Switching on starts from now: older leads and requests are not processed in one go.
        ...(turningOn ? { scannedAt: new Date() } : {}),
      },
    });
    await this.audit.log(me, 'agent.updated', 'Agent', a.id, { enabled: a.enabled, actsForUserId: a.actsForUserId, monthlyBudgetPaise: a.monthlyBudgetPaise }, { key, ...patch });
    return this.view(updated, people);
  }

  // ------------------------------------------------------------------------------------------ scheduler

  /** One pass over every enabled agent. Returns null when a pass is already running. */
  async tick(now = new Date(), opts: { orgId?: string } = {}): Promise<AgentTickResult | null> {
    if (this.ticking) return null;
    this.ticking = true;
    const result: AgentTickResult = { runs: 0, byAgent: {} };
    const count = (k: AgentKey, n: number) => {
      result.runs += n;
      result.byAgent[k] = (result.byAgent[k] ?? 0) + n;
    };
    try {
      const agents = await this.prisma.agent.findMany({ where: { enabled: true, ...(opts.orgId ? { orgId: opts.orgId } : {}) } });
      for (const orgId of new Set(agents.map((a) => a.orgId))) {
        if (now.getTime() - (this.knowledgeAt.get(orgId) ?? 0) < 3_600_000) continue;
        this.knowledgeAt.set(orgId, now.getTime());
        await this.knowledge.refresh(orgId).catch((e: Error) => this.log.warn(`Knowledge refresh failed: ${e.message}`));
      }
      for (const a of agents) {
        const key = a.key as AgentKey;
        const settings = (a.settings ?? {}) as { lastDaily?: string; lastMonthly?: string };
        try {
          if (key === 'sales_assistant' || key === 'request_triage' || key === 'creative_reviewer') {
            const since = a.scannedAt ?? a.updatedAt;
            const subjects = await this.newSubjects(key, a.orgId, since, now);
            await this.prisma.agent.update({ where: { id: a.id }, data: { scannedAt: subjects.length >= PER_TICK ? subjects[subjects.length - 1].createdAt : now } });
            for (const s of subjects) {
              await this.execute(a, { trigger: 'event', subject: s.subject, now });
              count(key, 1);
            }
          }
          const today = istDate(now);
          const daily = (key === 'sales_assistant' || key === 'producer' || key === 'finance_collector') && settings.lastDaily !== today && istHour(now) >= 10;
          // The monthly report goes out on the 1st (IST), once.
          const monthly = key === 'analyst' && today.slice(8) === '01' && settings.lastMonthly !== today.slice(0, 7) && istHour(now) >= 9;
          if (daily || monthly) {
            await this.prisma.agent.update({ where: { id: a.id }, data: { settings: json({ ...settings, ...(daily ? { lastDaily: today } : {}), ...(monthly ? { lastMonthly: today.slice(0, 7) } : {}) }) } });
            await this.execute(a, { trigger: 'schedule', subject: monthly ? { type: 'Monthly', id: today.slice(0, 7), label: `Report for ${today.slice(0, 7)}` } : { type: 'Daily', id: today, label: key === 'producer' ? `Morning check ${today}` : key === 'finance_collector' ? `Collections ${today}` : `Quiet deals ${today}` }, now });
            count(key, 1);
          }
        } catch (e) {
          this.log.error(`${key} failed: ${(e as Error).message}`);
        }
      }
    } finally {
      this.ticking = false;
    }
    return result;
  }

  private newSubjects(key: AgentKey, orgId: string, since: Date, now: Date) {
    return key === 'sales_assistant' ? this.newLeads(orgId, since, now) : key === 'request_triage' ? this.newRequests(orgId, since, now) : this.newVersions(orgId, since, now);
  }

  /** v16: new drafts waiting for QC (the latest version of a deliverable in QC). */
  private async newVersions(orgId: string, since: Date, now: Date) {
    const versions = await this.prisma.version.findMany({
      where: { orgId, createdAt: { gt: since, lte: now }, deliverable: { status: 'in_qc' } },
      include: { deliverable: { select: { title: true, versions: { select: { id: true }, orderBy: { number: 'desc' }, take: 1 }, cycle: { select: { engagement: { select: { clientOrg: { select: { name: true } } } } } } } } },
      orderBy: { createdAt: 'asc' },
      take: PER_TICK,
    });
    const latest = versions.filter((v) => v.deliverable.versions[0]?.id === v.id);
    const done = new Set((await this.prisma.agentRun.findMany({ where: { subjectType: 'Version', subjectId: { in: latest.map((v) => v.id) }, isEval: false }, select: { subjectId: true } })).map((r) => r.subjectId));
    return latest.filter((v) => !done.has(v.id)).map((v) => ({ createdAt: v.createdAt, subject: { type: 'Version' as const, id: v.id, label: `${v.deliverable.cycle.engagement.clientOrg.name}: ${v.deliverable.title} v${v.number}` } }));
  }

  private async newLeads(orgId: string, since: Date, now: Date) {
    const leads = await this.prisma.lead.findMany({ where: { orgId, deletedAt: null, archivedAt: null, stage: 'new', createdAt: { gt: since, lte: now } }, orderBy: { createdAt: 'asc' }, take: PER_TICK });
    const done = new Set((await this.prisma.agentRun.findMany({ where: { subjectType: 'Lead', subjectId: { in: leads.map((l) => l.id) }, isEval: false }, select: { subjectId: true } })).map((r) => r.subjectId));
    return leads.filter((l) => !done.has(l.id)).map((l) => ({ createdAt: l.createdAt, subject: { type: 'Lead' as const, id: l.id, label: leadLabel(l.contact) } }));
  }

  private async newRequests(orgId: string, since: Date, now: Date) {
    const reqs = await this.prisma.request.findMany({ where: { orgId, status: 'received', createdAt: { gt: since, lte: now } }, include: { engagement: { select: { clientOrg: { select: { name: true } } } } }, orderBy: { createdAt: 'asc' }, take: PER_TICK });
    const done = new Set((await this.prisma.agentRun.findMany({ where: { subjectType: 'Request', subjectId: { in: reqs.map((r) => r.id) }, isEval: false }, select: { subjectId: true } })).map((r) => r.subjectId));
    return reqs.filter((r) => !done.has(r.id)).map((r) => ({ createdAt: r.createdAt, subject: { type: 'Request' as const, id: r.id, label: `${r.engagement.clientOrg.name}: ${r.description.slice(0, 60)}` } }));
  }

  /** Run now from the Agents page. Sales/Triage take a record id, or process anything new since the last pass. */
  async runNow(me: Me, key: string, subjectId?: string): Promise<AgentRunDetail[]> {
    this.assertAdmin(me);
    const a = await this.agentRow(me.orgId, key);
    const now = new Date();
    const subjects: Subject[] = [];
    if (key === 'sales_assistant' || key === 'request_triage' || key === 'creative_reviewer') {
      if (subjectId) {
        if (key === 'creative_reviewer') {
          const v = await this.prisma.version.findFirst({ where: { id: subjectId, orgId: me.orgId }, include: { deliverable: { select: { title: true, cycle: { select: { engagement: { select: { clientOrg: { select: { name: true } } } } } } } } } });
          if (!v) throw new NotFoundException('Version not found');
          subjects.push({ type: 'Version', id: v.id, label: `${v.deliverable.cycle.engagement.clientOrg.name}: ${v.deliverable.title} v${v.number}` });
        } else if (key === 'sales_assistant') {
          const l = await this.prisma.lead.findFirst({ where: { id: subjectId, orgId: me.orgId, deletedAt: null } });
          if (!l) throw new NotFoundException('Lead not found');
          subjects.push({ type: 'Lead', id: l.id, label: leadLabel(l.contact) });
        } else {
          const r = await this.prisma.request.findFirst({ where: { id: subjectId, orgId: me.orgId }, include: { engagement: { select: { clientOrg: { select: { name: true } } } } } });
          if (!r) throw new NotFoundException('Request not found');
          subjects.push({ type: 'Request', id: r.id, label: `${r.engagement.clientOrg.name}: ${r.description.slice(0, 60)}` });
        }
      } else {
        const found = await this.newSubjects(key as AgentKey, me.orgId, a.scannedAt ?? new Date(now.getTime() - 7 * 86_400_000), now);
        subjects.push(...found.map((f) => f.subject));
        if (key === 'sales_assistant') subjects.push({ type: 'Daily', id: istDate(now), label: `Quiet deals ${istDate(now)}` });
        await this.prisma.agent.update({ where: { id: a.id }, data: { scannedAt: now } });
      }
    } else if (key === 'producer') subjects.push({ type: 'Daily', id: istDate(now), label: `Morning check ${istDate(now)}` });
    else if (key === 'finance_collector') subjects.push({ type: 'Daily', id: istDate(now), label: `Collections ${istDate(now)}` });
    else subjects.push({ type: 'Monthly', id: istDate(now).slice(0, 7), label: `Report for ${istDate(now).slice(0, 7)}` });
    const out: AgentRunDetail[] = [];
    for (const s of subjects) out.push(await this.run(me, (await this.execute(a, { trigger: 'manual', subject: s, startedBy: me, now })).id));
    return out;
  }

  // ------------------------------------------------------------------------------------------ running an agent

  /** Runs one agent once. Always returns the finished run (failures are recorded on it, never thrown). */
  async execute(a: AgentRow, o: ExecOpts): Promise<RunRow> {
    const key = a.key as AgentKey;
    const label = agentInfo[key].label;
    const now = o.now ?? new Date();
    const acting = o.actingOverride ?? (a.actsForUserId ? await this.meService.load(a.actsForUserId) : null);
    const run = await this.prisma.agentRun.create({
      data: { orgId: a.orgId, agentId: a.id, agentKey: key, trigger: o.trigger, subjectType: o.subject?.type ?? null, subjectId: o.subject?.id ?? null, subjectLabel: o.subject?.label.slice(0, 200) ?? null, actingUserId: acting?.id ?? null, startedById: o.startedBy?.id ?? null, isEval: !!o.isEval },
    });
    await this.prisma.agent.update({ where: { id: a.id }, data: { lastRunAt: now } });
    if (!acting || acting.type !== 'staff') {
      return this.prisma.agentRun.update({ where: { id: run.id }, data: { status: 'failed', error: 'Pick an active team member for this agent to act for (Agents page).', finishedAt: new Date() } });
    }
    const ctx: RunCtx = { runId: run.id, orgId: a.orgId, agentId: a.id, agentKey: key, label, acting, allowed: new Set(agentActions[key]), seq: 0, stats: { actions: 0, proposals: 0, blocked: 0, reads: 0 } };
    const h: PlanHelpers = {
      prisma: this.prisma,
      ref: this.ref,
      acting,
      knowledge: this.knowledge,
      act: (name, input) => this.runtime.act(ctx, name, input),
      note: async (title, detail) => void (await this.runtime.step(ctx, { kind: 'note', title, detail })),
      now,
    };
    const basic = async (): Promise<AiOut> => {
      const r = await this.basicPlan(key, o, h, ctx);
      return { text: r.answer ?? r.summary, citations: (r as BasicResult & { citations?: AiCitation[] }).citations ?? [] };
    };
    const aiPlan = (run: AiRunner) => this.loop(key, o, h, ctx, run);

    let mode: AiMode = 'basic';
    let out: AiOut;
    let notice: string | null = null;
    let logId: string | null = null;
    try {
      if (o.runner) {
        out = await aiPlan(o.runner);
        mode = 'ai';
      } else {
        const budget = a.monthlyBudgetPaise > 0 && (await this.spent(a.id, now)).costPaise >= a.monthlyBudgetPaise ? `The ${label}'s monthly AI budget is used up, so it used its built-in basic steps. Raise it on the Agents page.` : null;
        try {
          const res = await this.ai.execute({ orgId: a.orgId, userId: o.trigger === 'ask' ? acting.id : null, me: acting }, o.trigger === 'ask' ? 'agent_ask' : 'agent_run', {
            target: o.subject && ['Lead', 'Request'].includes(o.subject.type) ? { type: o.subject.type, id: o.subject.id } : { type: 'AgentRun', id: run.id },
            forceBasic: budget,
            basic,
            ai: aiPlan,
          });
          out = { text: res.text, citations: res.citations };
          mode = res.mode;
          notice = res.notice;
          logId = res.logId;
        } catch (e) {
          if (!(e instanceof AiOffError)) throw e;
          out = await basic();
          notice = 'AI is switched off for agents, so this run used the built-in basic steps.';
        }
      }
    } catch (e) {
      this.log.warn(`${key} run failed: ${(e as Error).message}`);
      await this.runtime.step(ctx, { kind: 'error', title: 'The run stopped with an error', detail: (e as Error).message.slice(0, 500), ok: false });
      return this.prisma.agentRun.update({ where: { id: run.id }, data: { status: 'failed', error: (e as Error).message.slice(0, 500), finishedAt: new Date() } });
    }
    const usage = logId ? await this.prisma.aiLog.findUnique({ where: { id: logId }, select: { costPaise: true, inputTokens: true, outputTokens: true } }) : null;
    const st = ctx.stats;
    const counts = [st.actions && `${st.actions} done`, st.proposals && `${st.proposals} waiting for approval`, st.blocked && `${st.blocked} refused`].filter(Boolean).join(', ');
    const isAnswer = key === 'analyst';
    const finished = await this.prisma.agentRun.update({
      where: { id: run.id },
      data: {
        status: 'done',
        mode,
        summary: (isAnswer ? (o.trigger === 'ask' ? `Answered: ${o.question?.slice(0, 120) ?? ''}` : 'Monthly founder report ready') : [out.text.split('\n')[0].slice(0, 300), counts].filter(Boolean).join(' · ')) || counts || 'Nothing to do',
        answer: isAnswer ? out.text : null,
        citations: json(out.citations ?? []),
        notice,
        aiLogId: logId,
        costPaise: usage?.costPaise ?? 0,
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        finishedAt: new Date(),
      },
    });
    if (key === 'analyst' && o.trigger !== 'ask' && !o.isEval) {
      await this.prisma.notification.create({ data: { orgId: a.orgId, userId: acting.id, kind: 'agent', title: 'Analyst: your monthly founder report is ready', body: out.text.slice(0, 200), link: `/admin/agents/runs/${run.id}` } });
    }
    return finished;
  }

  private async basicPlan(key: AgentKey, o: ExecOpts, h: PlanHelpers, ctx: RunCtx): Promise<BasicResult & { citations?: AiCitation[] }> {
    const s = o.subject;
    if (key === 'sales_assistant') return s?.type === 'Lead' ? salesBasic(h, s.id) : salesStalled(h);
    if (key === 'request_triage') {
      if (s?.type !== 'Request') return { summary: 'Nothing to triage' };
      return triageBasic(h, s.id);
    }
    if (key === 'producer') return producerBasic(h);
    if (key === 'finance_collector') return financeBasic(h);
    if (key === 'creative_reviewer') return s?.type === 'Version' ? creativeBasic(h, s.id) : { summary: 'No new drafts to check' };
    // Analyst
    const copilot = this.ref.get(AiCopilotService, { strict: false });
    const tools = staffTools(this.ref, ctx.acting);
    if (o.trigger === 'ask' && o.question) {
      const hits = await this.knowledge.search(ctx.acting, o.question, 4);
      ctx.stats.reads++;
      await this.runtime.step(ctx, { kind: 'read', tool: 'knowledge_search', title: `Searched knowledge for "${o.question.slice(0, 80)}"`, detail: hits.length ? hits.map((x) => x.title).join(' · ') : 'Nothing found', policy: 'read', output: hits.map((x) => ({ title: x.title, link: x.link })) });
      const base = await copilot.basicStaff(ctx.acting, o.question, tools, () => {});
      const useful = !base.text.startsWith('In basic mode I can answer');
      const k = hits.filter((x) => x.link);
      const parts = [useful ? base.text : null, k.length ? `${useful ? '\n' : ''}From your knowledge:\n${k.map((x) => `- [${x.title}](${x.link}): ${x.snippet.replace(/\s+/g, ' ').slice(0, 180)}`).join('\n')}` : null].filter(Boolean);
      const citations = [...(useful ? (base.citations ?? []) : []), ...k.map((x) => ({ label: x.title, href: x.link! }))];
      return { summary: 'Answered', answer: parts.length ? parts.join('\n') : base.text, citations: dedupe(citations) };
    }
    const summary = await copilot.basicStaff(ctx.acting, 'summary of the week business numbers', tools, () => {});
    const risk = await copilot.basicStaff(ctx.acting, 'which clients are at risk', tools, () => {});
    const month = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' }).format(new Date(h.now.getTime() - 15 * 86_400_000));
    const text = `**Monthly founder report (${month})**\n\n**Business**\n${summary.text}\n\n**Client health**\n${risk.text}\n\n**Focus this month**\n- Follow up the clients marked at risk first.\n- Clear overdue invoices and tasks.\n- Keep reply times inside the SLA.`;
    return { summary: 'Monthly report', answer: text, citations: dedupe([...(summary.citations ?? []), ...(risk.citations ?? [])]) };
  }

  /** AI mode: Claude plans with read tools, knowledge search and the agent's action tools, all through the runtime gate. */
  private async loop(key: AgentKey, o: ExecOpts, h: PlanHelpers, ctx: RunCtx, run: AiRunner): Promise<AiOut> {
    const reads = staffTools(this.ref, ctx.acting).filter((t) => READ_TOOLS[key].includes(t.name));
    const knowledgeHits: { title: string; link: string }[] = [];
    const knowledgeTool: CopilotTool = {
      name: 'knowledge_search',
      description: "Search BMU's knowledge: SOPs, services and what each tier includes, approved monthly plans, brand kits and client notes. Returns titles, snippets and links.",
      schema: z.object({ query: z.string().min(2).max(300) }),
      properties: { query: { type: 'string', description: 'What to look for, in a few words' } },
      status: 'Searching knowledge…',
      run: async (i) => {
        const hits = await this.knowledge.search(ctx.acting, String(i.query), 5);
        for (const x of hits) if (x.link) knowledgeHits.push({ title: x.title, link: x.link });
        return { data: hits.map((x) => ({ title: x.title, snippet: x.snippet, link: x.link })), citations: hits.filter((x) => x.link).map((x) => ({ label: x.title, href: x.link! })) };
      },
    };
    const peopleTool: CopilotTool = {
      name: 'find_people',
      description: 'Active team members with their roles and how many open tasks and open leads each has.',
      schema: z.object({ role: z.string().max(40).optional() }),
      properties: { role: { type: 'string', description: 'Optional role filter, e.g. sales, account_manager, producer' } },
      status: 'Looking up the team…',
      run: async (i) => {
        const people = (await this.people(ctx.orgId)).filter((p) => !i.role || p.roles.some((r) => r.includes(String(i.role))));
        const tasks = await this.prisma.task.groupBy({ by: ['ownerId'], where: { orgId: ctx.orgId, status: { notIn: ['done', 'cancelled'] }, archivedAt: null }, _count: { _all: true } });
        const leads = await this.prisma.lead.groupBy({ by: ['ownerId'], where: { orgId: ctx.orgId, deletedAt: null, archivedAt: null, stage: { notIn: ['won', 'lost'] } }, _count: { _all: true } });
        return { data: people.slice(0, 60).map((p) => ({ id: p.id, name: p.name, roles: p.roles, openTasks: tasks.find((t) => t.ownerId === p.id)?._count._all ?? 0, openLeads: leads.find((l) => l.ownerId === p.id)?._count._all ?? 0 })), citations: [] };
      },
    };
    const readTools = [...reads, knowledgeTool, ...(key === 'analyst' ? [] : [peopleTool])];
    const byName = new Map(readTools.map((t) => [t.name, t]));
    const actionDefs: Anthropic.Beta.BetaTool[] = agentActions[key].map((n) => ({
      name: n,
      description: `${ACTIONS[n].description} (${agentActionInfo[n].policy === 'auto' ? 'runs straight away, can be undone' : 'waits for a person to approve'})`,
      eager_input_streaming: true,
      input_schema: { type: 'object' as const, properties: ACTIONS[n].properties, required: ACTIONS[n].required, additionalProperties: false },
    }));
    const tools = [...toolDefs(readTools), ...actionDefs];

    let task: string;
    let image: Anthropic.Beta.BetaImageBlockParam | null = null;
    if (o.subject?.type === 'Lead') task = salesPrompt(await leadFacts(h, o.subject.id));
    else if (o.subject?.type === 'Request') task = triagePrompt(await requestFacts(h, o.subject.id));
    else if (o.subject?.type === 'Version') {
      const f = await versionFacts(h, o.subject.id);
      image = await this.imageBlock(f.v.file);
      task = creativePrompt(f, !!image);
    }
    else if (key === 'sales_assistant') task = 'Check for deals that have gone quiet: use find_leads for contacted, discovery and proposal_sent leads, and notify_person each owner whose deal has had no activity for 7 days or more (at most 20). Finish with one line.';
    else if (key === 'producer') task = PRODUCER_PROMPT;
    else if (key === 'finance_collector') task = financePrompt(await financeFacts(h));
    else if (o.trigger === 'ask') task = `${ANALYST_ASK}\n\nQuestion: ${o.question ?? ''}`;
    else task = ANALYST_MONTHLY;

    const system = `${AGENT_SYSTEM[key]}\n\n${AGENT_RULES}\n\n${SAFETY_RULES}`;
    const intro = `Today is ${dateLine(h.now)} (IST). You act for ${ctx.acting.name} (role: ${ctx.acting.roles.join(', ').replaceAll('_', ' ')}).\n\n${task}`;
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: image ? [image, { type: 'text', text: intro }] : intro }];
    const allowed = new Set<string>(['/admin', '/team/tasks', '/team/agent-inbox', '/team/workload', '/admin/finance/expenses', '/admin/finance/profit', '/admin/finance/reconcile']);
    let final: Anthropic.Beta.BetaMessage | null = null;
    let jsonRetries = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      let msg: Anthropic.Beta.BetaMessage;
      try {
        msg = await run({ system, messages, tools, maxTokens: 16_000, effort: 'medium' });
        jsonRetries = 0;
      } catch (e) {
        // Once something was done, stop here instead of failing over to the basic plan (which would act twice).
        if (ctx.stats.actions + ctx.stats.proposals > 0) return { text: 'Stopped early after an AI error; the steps above were completed.', citations: [] };
        if ((e as { status?: number }).status || e instanceof AiRefusal || jsonRetries++ >= 2) throw e;
        continue;
      }
      final = msg;
      if (msg.stop_reason === 'max_tokens') break;
      const uses = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
      if (msg.stop_reason !== 'tool_use' || !uses.length) break;
      messages.push({ role: 'assistant', content: msg.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const u of uses) {
        const read = byName.get(u.name);
        if (read) {
          const parsed = read.schema.safeParse(u.input ?? {});
          if (!parsed.success) {
            results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: 'Invalid input for this tool' });
            continue;
          }
          const r = await read.run(parsed.data as Record<string, unknown>);
          ctx.stats.reads++;
          const body = JSON.stringify(r.data);
          for (const m of body.matchAll(/"link":"(\/[^"]+)"/g)) allowed.add(m[1]);
          for (const c of r.citations) allowed.add(c.href);
          await this.runtime.step(ctx, { kind: 'read', tool: u.name, title: read.status.replace(/…$/, ''), input: u.input, policy: 'read', output: { citations: r.citations.slice(0, 10) } });
          results.push({ type: 'tool_result', tool_use_id: u.id, content: body.slice(0, 30_000) });
        } else {
          // Every action, including names the agent was never given, goes through the runtime gate.
          const r = await this.runtime.act(ctx, u.name, u.input);
          if (r.link) allowed.add(r.link);
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: r.status === 'blocked' || r.status === 'failed', content: `${r.status === 'done' ? 'Done' : r.status === 'proposed' ? 'Sent to the Agent Inbox for approval (not done yet)' : r.status === 'blocked' ? 'Refused' : 'Failed'}: ${r.message}` });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    const raw = final ? textOf(final) : '';
    const cleaned = cleanLinks(raw || (key === 'analyst' ? 'I could not find an answer to that.' : 'Done.'), allowed);
    // Sources rule: when knowledge was used, the answer always lists where it came from.
    const knowledgeCited = cleaned.citations.some((c) => knowledgeHits.some((k) => k.link === c.href));
    if (knowledgeHits.length && !knowledgeCited) {
      const used = dedupe(knowledgeHits.map((k) => ({ label: k.title, href: k.link }))).slice(0, 3);
      return { text: `${cleaned.text}\n\nSources:\n${used.map((u) => `- [${u.label}](${u.href})`).join('\n')}`, citations: dedupe([...cleaned.citations, ...used]) };
    }
    return { text: cleaned.text, citations: cleaned.citations };
  }

  /** v16: a draft picture for the Creative reviewer to look at (JPG/PNG/GIF/WebP up to 3.7 MB), else null. */
  private async imageBlock(file: { kind: string; mimeType: string | null; sizeBytes: number | null; path: string }): Promise<Anthropic.Beta.BetaImageBlockParam | null> {
    if (file.kind !== 'image' || !file.mimeType || !['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimeType) || (file.sizeBytes ?? Infinity) > 3_700_000) return null;
    const abs = await localFile(file.path).catch(() => null);
    const data = abs ? await readFile(abs).catch(() => null) : null;
    return data ? { type: 'image', source: { type: 'base64', media_type: file.mimeType as 'image/png', data: data.toString('base64') } } : null;
  }

  // ------------------------------------------------------------------------------------------ Ask the Analyst

  async ask(me: Me, question: string): Promise<AgentAskResult> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const a = await this.agentRow(me.orgId, 'analyst');
    if (!a.enabled) throw new BadRequestException('The Analyst is switched off. A Founder or Branch Manager can switch it on in Command Centre → Agents.');
    const run = await this.execute(a, { trigger: 'ask', subject: { type: 'Question', id: 'ask', label: question.slice(0, 120) }, startedBy: me, actingOverride: me, question });
    if (run.status === 'failed') throw new BadRequestException(run.error ?? 'The Analyst could not answer');
    return { runId: run.id, mode: run.mode as AiMode, text: run.answer ?? '', citations: (run.citations ?? []) as AiCitation[], notice: run.notice };
  }

  // ------------------------------------------------------------------------------------------ run log

  private subjectLink(type: string | null, id: string | null, versions?: Map<string, string>) {
    if (!type || !id) return null;
    if (type === 'Version') return versions?.get(id) ? `/team/deliverables/${versions.get(id)}` : null;
    if (type === 'Lead') return `/team/leads/${id}`;
    if (type === 'Request') return `/team/requests/${id}`;
    return null;
  }

  private runWhere(me: Me): Prisma.AgentRunWhereInput {
    return { orgId: me.orgId, isEval: false, ...(isAdmin(me) ? {} : { OR: [{ actingUserId: me.id }, { startedById: me.id }] }) };
  }

  private async rows(runs: RunRow[]): Promise<AgentRunRow[]> {
    if (!runs.length) return [];
    const counts = await this.prisma.agentStep.groupBy({ by: ['runId', 'kind'], where: { runId: { in: runs.map((r) => r.id) } }, _count: { _all: true } });
    const users = await this.userNames([...runs.map((r) => r.actingUserId), ...runs.map((r) => r.startedById)]);
    const n = (runId: string, kind: string) => counts.find((c) => c.runId === runId && c.kind === kind)?._count._all ?? 0;
    const versionIds = runs.filter((r) => r.subjectType === 'Version' && r.subjectId).map((r) => r.subjectId!);
    const versions = new Map(versionIds.length ? (await this.prisma.version.findMany({ where: { id: { in: versionIds } }, select: { id: true, deliverableId: true } })).map((v) => [v.id, v.deliverableId] as const) : []);
    return runs.map((r) => ({
      id: r.id,
      agentKey: r.agentKey as AgentKey,
      agentLabel: agentInfo[r.agentKey as AgentKey]?.label ?? r.agentKey,
      trigger: r.trigger as AgentTrigger,
      subject: r.subjectType && r.subjectId ? { type: r.subjectType, id: r.subjectId, label: r.subjectLabel ?? r.subjectType, link: this.subjectLink(r.subjectType, r.subjectId, versions) } : null,
      status: r.status as AgentRunStatus,
      mode: r.mode as AiMode,
      summary: r.summary,
      actions: n(r.id, 'action'),
      proposals: n(r.id, 'proposal'),
      blocked: n(r.id, 'blocked'),
      costPaise: r.costPaise,
      actingFor: r.actingUserId ? (users.get(r.actingUserId) ?? 'Former user') : null,
      startedBy: r.startedById ? (users.get(r.startedById) ?? 'Former user') : null,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    }));
  }

  private async userNames(ids: (string | null | undefined)[]) {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    return new Map((await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  }

  async runs(me: Me, f: { agent?: string; subjectId?: string; status?: string }): Promise<AgentRunRow[]> {
    if (me.type !== 'staff') throw new ForbiddenException();
    const runs = await this.prisma.agentRun.findMany({
      where: { ...this.runWhere(me), ...(f.agent ? { agentKey: f.agent } : {}), ...(f.subjectId ? { subjectId: f.subjectId } : {}), ...(f.status ? { status: f.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return this.rows(runs);
  }

  async run(me: Me, id: string): Promise<AgentRunDetail> {
    if (me.type !== 'staff') throw new ForbiddenException();
    const r = await this.prisma.agentRun.findFirst({ where: { id, orgId: me.orgId, ...(isAdmin(me) ? {} : { OR: [{ actingUserId: me.id }, { startedById: me.id }] }) } });
    if (!r) throw new NotFoundException('Run not found');
    const [row] = await this.rows([r]);
    const steps = await this.prisma.agentStep.findMany({ where: { runId: id }, orderBy: { seq: 'asc' } });
    const names = await this.userNames([...steps.map((s) => s.undoneById), r.feedbackById]);
    const canUndoRun = await this.runtime.canUndo(me, r);
    const views: AgentStepView[] = [];
    for (const s of steps) {
      views.push({
        id: s.id,
        seq: s.seq,
        kind: s.kind as AgentStepView['kind'],
        tool: s.tool,
        title: s.title,
        detail: s.detail,
        policy: s.policy as AgentStepView['policy'],
        ok: s.ok,
        link: s.link,
        canUndo: !!s.undo && !s.undoneAt && (canUndoRun || (await this.runtime.canUndo(me, r, s))),
        undoneAt: s.undoneAt?.toISOString() ?? null,
        undoneBy: s.undoneById ? (names.get(s.undoneById) ?? 'Former user') : null,
        proposalId: s.proposalId,
        at: s.at.toISOString(),
      });
    }
    return {
      ...row,
      answer: r.answer,
      citations: (r.citations ?? []) as AiCitation[],
      notice: r.notice,
      error: r.error,
      steps: views,
      feedback: r.feedback ? { value: r.feedback as 1 | -1, by: r.feedbackById ? (names.get(r.feedbackById) ?? 'Former user') : '', note: r.feedbackNote } : null,
      canUndo: views.some((s) => s.canUndo),
    };
  }

  async undoRun(me: Me, id: string) {
    await this.runtime.undoRun(me, id);
    return this.run(me, id);
  }

  async undoStep(me: Me, runId: string, stepId: string) {
    await this.runtime.undoStep(me, runId, stepId);
    return this.run(me, runId);
  }

  async feedback(me: Me, id: string, input: AgentFeedbackInput) {
    await this.run(me, id);
    await this.prisma.agentRun.update({ where: { id }, data: { feedback: input.value, feedbackById: me.id, feedbackNote: input.note ?? null } });
    return this.run(me, id);
  }

  // ------------------------------------------------------------------------------------------ Agent Inbox

  private async proposalViews(me: Me, rows: Awaited<ReturnType<PrismaService['agentProposal']['findMany']>>): Promise<AgentProposalView[]> {
    const names = await this.userNames([...rows.map((p) => p.actingUserId), ...rows.map((p) => p.decidedById)]);
    return rows.map((p) => {
      const action = p.action as keyof typeof agentActionInfo;
      return {
        id: p.id,
        agentKey: p.agentKey as AgentKey,
        agentLabel: agentInfo[p.agentKey as AgentKey]?.label ?? p.agentKey,
        action,
        actionLabel: agentActionInfo[action]?.label ?? p.action,
        why: agentActionInfo[action]?.why ?? '',
        title: p.title,
        summary: p.summary,
        payload: (p.payload ?? {}) as Record<string, unknown>,
        fields: (p.fields ?? []) as AgentProposalField[],
        link: p.link,
        runId: p.runId,
        actingFor: names.get(p.actingUserId) ?? null,
        status: p.status as AgentProposalStatus,
        decidedBy: p.decidedById ? (names.get(p.decidedById) ?? 'Former user') : null,
        decidedAt: p.decidedAt?.toISOString() ?? null,
        decisionNote: p.decisionNote,
        error: p.error,
        canDecide: p.status === 'pending' && this.runtime.canDecide(me, p),
        createdAt: p.createdAt.toISOString(),
        expiresAt: p.expiresAt.toISOString(),
      };
    });
  }

  async inbox(me: Me, status: 'pending' | 'decided' = 'pending'): Promise<AgentProposalView[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    await this.prisma.agentProposal.updateMany({ where: { orgId: me.orgId, status: 'pending', expiresAt: { lt: new Date() } }, data: { status: 'expired' } });
    const mine: Prisma.AgentProposalWhereInput = isAdmin(me) ? {} : { deciderIds: { has: me.id } };
    const rows = await this.prisma.agentProposal.findMany({
      where: { orgId: me.orgId, ...mine, ...(status === 'pending' ? { status: 'pending' } : { status: { not: 'pending' } }) },
      orderBy: status === 'pending' ? { createdAt: 'asc' } : { decidedAt: 'desc' },
      take: status === 'pending' ? 200 : 50,
    });
    return this.proposalViews(me, rows);
  }

  async decide(me: Me, id: string, input: AgentDecideInput): Promise<AgentProposalView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    await this.runtime.decide(me, id, input);
    const p = await this.prisma.agentProposal.findFirstOrThrow({ where: { id } });
    return (await this.proposalViews(me, [p]))[0];
  }

  async refreshKnowledge(me: Me) {
    this.assertAdmin(me);
    return { chunks: await this.knowledge.refresh(me.orgId) };
  }
}

function dedupe(c: AiCitation[]): AiCitation[] {
  const seen = new Set<string>();
  return c.filter((x) => (seen.has(x.href) ? false : (seen.add(x.href), true)));
}
