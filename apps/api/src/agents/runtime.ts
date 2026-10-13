// v15 agent runtime: the one gate every agent action goes through, whatever planned it (the AI model or the
// built-in basic plan). Order of checks for each action:
//   1. known action, and one of this agent's actions        → otherwise blocked
//   2. policy "never"                                       → blocked, nothing runs
//   3. input valid                                          → otherwise blocked
//   4. the acting person may do it (their own permissions)  → otherwise blocked
//   5. policy "auto"    → applied as the acting person, logged with its undo rows
//      policy "confirm" → an AgentProposal waits in the Agent Inbox; on approval it is checked again as the acting
//                         person AND as the approver, then applied as the approver.
// Every step is written to the run log; undo restores the stored rows (no time limit).
import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { AGENT_ACTIONS, agentActionInfo, agentInfo, type AgentAction, type AgentDecideInput, type AgentKey, type AgentPolicy, type AgentStepKind, type Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { UndoRow } from '../actions/registry.js';
import { AuditService } from '../audit/audit.service.js';
import { MeService } from '../auth/me.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ACTIONS, AGENT_UNDO_MODELS, type ActCtx } from './catalogue.js';

export type RunCtx = {
  runId: string;
  orgId: string;
  agentId: string;
  agentKey: AgentKey;
  label: string;
  acting: Me;
  allowed: Set<AgentAction>;
  seq: number;
  stats: { actions: number; proposals: number; blocked: number; reads: number };
};

export type ActOutcome = { status: 'done' | 'proposed' | 'blocked' | 'failed'; message: string; proposalId?: string; link?: string | null };

const PROPOSAL_DAYS = 7;
const isAdmin = (me: Me) => me.type === 'staff' && me.roles.some((r) => r === 'founder' || r === 'admin');
const json = (v: unknown) => JSON.parse(JSON.stringify(v ?? null)) as Prisma.InputJsonValue;

@Injectable()
export class AgentRuntime {
  private readonly log = new Logger('Agents');

  constructor(
    private readonly prisma: PrismaService,
    private readonly ref: ModuleRef,
    private readonly meService: MeService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  actCtx(me: Me, agentKey: AgentKey): ActCtx {
    return { me, ref: this.ref, agentLabel: agentInfo[agentKey].label };
  }

  async step(ctx: RunCtx, s: { kind: AgentStepKind; title: string; tool?: string | null; detail?: string | null; input?: unknown; output?: unknown; policy?: AgentPolicy | 'read' | null; ok?: boolean; link?: string | null; undo?: UndoRow[] | null; proposalId?: string | null }) {
    ctx.seq++;
    return this.prisma.agentStep.create({
      data: {
        orgId: ctx.orgId,
        runId: ctx.runId,
        seq: ctx.seq,
        kind: s.kind,
        tool: s.tool ?? null,
        title: s.title.slice(0, 300),
        detail: s.detail?.slice(0, 4000) ?? null,
        input: json(s.input ?? {}),
        output: s.output === undefined ? undefined : json(s.output),
        policy: s.policy ?? null,
        ok: s.ok ?? true,
        link: s.link ?? null,
        undo: s.undo?.length ? json(s.undo) : undefined,
        proposalId: s.proposalId ?? null,
      },
    });
  }

  /** The single entry point for agent actions. Never throws for a refused action: it logs and explains. */
  async act(ctx: RunCtx, name: string, rawInput: unknown): Promise<ActOutcome> {
    const blocked = async (title: string, detail: string, policy: AgentPolicy | null = null): Promise<ActOutcome> => {
      ctx.stats.blocked++;
      await this.step(ctx, { kind: 'blocked', tool: name, title, detail, input: rawInput, policy, ok: false });
      return { status: 'blocked', message: `${title}. ${detail}` };
    };
    if (!(AGENT_ACTIONS as readonly string[]).includes(name)) return blocked(`Refused an unknown action "${name.slice(0, 60)}"`, 'Agents can only use actions from the catalogue.');
    const action = name as AgentAction;
    const info = agentActionInfo[action];
    if (info.policy === 'never') return blocked(`Refused: ${info.label.toLowerCase()}`, `Agents are never allowed to do this (${info.why.toLowerCase()}).`, 'never');
    if (!ctx.allowed.has(action)) return blocked(`Refused: ${info.label.toLowerCase()}`, `This is not one of the ${ctx.label}'s actions.`, info.policy);
    const impl = ACTIONS[action];
    const parsed = impl.schema.safeParse(rawInput ?? {});
    if (!parsed.success) return blocked(`Could not ${info.label.toLowerCase()}`, `The details were not valid: ${parsed.error.issues[0]?.message ?? 'invalid input'}.`, info.policy);
    const input = parsed.data;
    const actx = this.actCtx(ctx.acting, ctx.agentKey);
    try {
      await impl.check(input, actx);
    } catch (e) {
      const msg = (e as Error).message;
      if (e instanceof ForbiddenException || e instanceof NotFoundException) return blocked(`Refused: ${info.label.toLowerCase()}`, `${ctx.acting.name}, who this agent acts for, is not allowed to do this: ${msg}`, info.policy);
      if (e instanceof BadRequestException) return blocked(`Could not ${info.label.toLowerCase()}`, msg, info.policy);
      throw e;
    }
    const d = await impl.describe(input, actx).catch(() => ({ title: info.label, summary: '', link: null, target: null }));

    if (info.policy === 'auto') {
      try {
        const r = await impl.apply(input, actx);
        ctx.stats.actions++;
        await this.step(ctx, { kind: 'action', tool: action, title: d.title, detail: [d.summary, r.message].filter(Boolean).join(' · '), input, output: r.output ?? { message: r.message }, policy: 'auto', link: r.link ?? d.link, undo: r.undo });
        return { status: 'done', message: r.message, link: r.link ?? d.link };
      } catch (e) {
        if (!(e instanceof ForbiddenException || e instanceof NotFoundException || e instanceof BadRequestException)) throw e;
        await this.step(ctx, { kind: 'error', tool: action, title: `Could not ${info.label.toLowerCase()}`, detail: (e as Error).message, input, policy: 'auto', ok: false });
        return { status: 'failed', message: (e as Error).message };
      }
    }

    // confirm: one pending proposal per action and record.
    if (d.target) {
      const dup = await this.prisma.agentProposal.findFirst({ where: { orgId: ctx.orgId, action, targetType: d.target.type, targetId: d.target.id, status: 'pending' } });
      if (dup) {
        await this.step(ctx, { kind: 'note', tool: action, title: `Already waiting in the Agent Inbox: ${dup.title}`, policy: 'confirm', proposalId: dup.id, link: '/team/agent-inbox' });
        return { status: 'proposed', message: 'A suggestion for this is already waiting in the Agent Inbox.', proposalId: dup.id };
      }
    }
    const fields = (await impl.fields?.(input, actx).catch(() => [])) ?? [];
    const deciders = [...new Set([ctx.acting.id, ...((await impl.deciders?.(input, actx).catch(() => [])) ?? [])].filter((x): x is string => !!x))];
    const p = await this.prisma.agentProposal.create({
      data: {
        orgId: ctx.orgId,
        agentId: ctx.agentId,
        agentKey: ctx.agentKey,
        runId: ctx.runId,
        action,
        title: d.title,
        summary: d.summary,
        payload: json(input),
        fields: json(fields),
        targetType: d.target?.type ?? null,
        targetId: d.target?.id ?? null,
        link: d.link,
        actingUserId: ctx.acting.id,
        deciderIds: deciders,
        expiresAt: new Date(Date.now() + PROPOSAL_DAYS * 86_400_000),
      },
    });
    ctx.stats.proposals++;
    await this.step(ctx, { kind: 'proposal', tool: action, title: `Asked first: ${d.title}`, detail: d.summary, input, policy: 'confirm', link: d.link, proposalId: p.id });
    await this.notifications.notify(ctx.orgId, deciders, { kind: 'agent_proposal', title: `${ctx.label} suggests: ${d.title}`, body: `${info.why}. Approve, edit or reject it in the Agent Inbox.`, link: '/team/agent-inbox', noEmail: true });
    return { status: 'proposed', message: 'Waiting for a person to approve it in the Agent Inbox.', proposalId: p.id };
  }

  // -------------------------------------------------------------------------- Agent Inbox decisions

  canDecide(me: Me, p: { deciderIds: string[] }) {
    return isAdmin(me) || p.deciderIds.includes(me.id);
  }

  async decide(me: Me, id: string, input: AgentDecideInput) {
    const p = await this.prisma.agentProposal.findFirst({ where: { id, orgId: me.orgId } });
    if (!p) throw new NotFoundException('Suggestion not found');
    if (!this.canDecide(me, p)) throw new ForbiddenException('You are not one of the people who can decide this');
    if (p.status !== 'pending') throw new BadRequestException(`Already ${p.status}`);
    if (p.expiresAt < new Date()) {
      await this.prisma.agentProposal.update({ where: { id }, data: { status: 'expired' } });
      throw new BadRequestException('This suggestion has expired');
    }
    const run = await this.prisma.agentRun.findUniqueOrThrow({ where: { id: p.runId } });
    const seq = (await this.prisma.agentStep.aggregate({ where: { runId: run.id }, _max: { seq: true } }))._max.seq ?? 0;
    const acting = await this.meService.load(p.actingUserId);
    const ctx: RunCtx = { runId: run.id, orgId: me.orgId, agentId: p.agentId, agentKey: p.agentKey as AgentKey, label: agentInfo[p.agentKey as AgentKey].label, acting: acting ?? me, allowed: new Set(), seq, stats: { actions: 0, proposals: 0, blocked: 0, reads: 0 } };

    if (input.decision === 'reject') {
      await this.prisma.agentProposal.update({ where: { id }, data: { status: 'rejected', decidedById: me.id, decidedAt: new Date(), decisionNote: input.note ?? null } });
      await this.step(ctx, { kind: 'note', tool: p.action, title: `${me.name} rejected: ${p.title}`, detail: input.note ?? null, policy: 'confirm', proposalId: p.id });
      return;
    }

    const action = p.action as AgentAction;
    const impl = ACTIONS[action];
    const fieldKeys = new Set(((p.fields ?? []) as { key: string }[]).map((f) => f.key));
    const edits = Object.fromEntries(Object.entries(input.edits ?? {}).filter(([k]) => fieldKeys.has(k)));
    const parsed = impl.schema.safeParse({ ...(p.payload as object), ...edits });
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Check the details');
    if (!acting) throw new BadRequestException('The person this agent acted for is no longer active, so this suggestion cannot be applied');
    // Both must be allowed: the agent's acting person (no agent beyond its person) and the approver (no approval beyond your own rights).
    for (const who of [acting, me]) {
      try {
        await impl.check(parsed.data, this.actCtx(who, ctx.agentKey));
      } catch (e) {
        if (e instanceof ForbiddenException || e instanceof NotFoundException) throw new ForbiddenException(`${who.id === me.id ? 'You are' : `${who.name} is`} not allowed to do this: ${(e as Error).message}`);
        throw e;
      }
    }
    const r = await impl.apply(parsed.data, this.actCtx(me, ctx.agentKey));
    const d = await impl.describe(parsed.data, this.actCtx(me, ctx.agentKey)).catch(() => ({ title: p.title, summary: p.summary, link: p.link }));
    await this.prisma.agentProposal.update({ where: { id }, data: { status: 'approved', decidedById: me.id, decidedAt: new Date(), decisionNote: input.note ?? null, payload: json(parsed.data), result: json({ message: r.message }) } });
    await this.step(ctx, { kind: 'action', tool: action, title: `${me.name} approved: ${d.title}`, detail: [Object.keys(edits).length ? 'Edited before approving' : null, r.message].filter(Boolean).join(' · '), input: parsed.data, output: { message: r.message }, policy: 'confirm', link: r.link ?? d.link, undo: r.undo, proposalId: p.id });
    await this.audit.log(me, 'agent.proposal_approved', 'AgentProposal', p.id, null, { action, title: d.title, agent: ctx.label, edited: Object.keys(edits) });
  }

  // -------------------------------------------------------------------------- Undo from the run log

  async canUndo(me: Me, run: { actingUserId: string | null; startedById: string | null }, step?: { proposalId: string | null }) {
    if (me.type !== 'staff') return false;
    if (isAdmin(me) || run.actingUserId === me.id || run.startedById === me.id) return true;
    if (step?.proposalId) {
      const p = await this.prisma.agentProposal.findUnique({ where: { id: step.proposalId }, select: { decidedById: true } });
      return p?.decidedById === me.id;
    }
    return false;
  }

  private async restore(rows: UndoRow[]) {
    await this.prisma.$transaction(async (tx) => {
      for (const r of [...rows].reverse()) {
        if (!AGENT_UNDO_MODELS.has(r.model)) continue;
        const delegate = (tx as unknown as Record<string, { updateMany: (a: unknown) => Promise<unknown>; deleteMany: (a: unknown) => Promise<unknown> }>)[r.model];
        if (!delegate) continue;
        if (r.delete) await delegate.deleteMany({ where: { id: r.id } });
        else if (r.data) await delegate.updateMany({ where: { id: r.id }, data: r.data });
      }
    });
  }

  async undoStep(me: Me, runId: string, stepId: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id: runId, orgId: me.orgId } });
    if (!run) throw new NotFoundException('Run not found');
    const step = await this.prisma.agentStep.findFirst({ where: { id: stepId, runId } });
    if (!step) throw new NotFoundException('Step not found');
    if (!step.undo) throw new BadRequestException('There is nothing to undo for this step');
    if (step.undoneAt) throw new BadRequestException('Already undone');
    if (!(await this.canUndo(me, run, step))) throw new ForbiddenException('Only the Founder, Branch Managers, the person the agent acts for, or the person who approved it can undo this');
    const claimed = await this.prisma.agentStep.updateMany({ where: { id: step.id, undoneAt: null }, data: { undoneAt: new Date(), undoneById: me.id } });
    if (!claimed.count) throw new BadRequestException('Already undone');
    await this.restore(step.undo as unknown as UndoRow[]);
    await this.audit.log(me, 'agent.undone', 'AgentRun', run.id, null, { step: step.title });
    await this.markRunUndone(run.id);
  }

  async undoRun(me: Me, runId: string) {
    const run = await this.prisma.agentRun.findFirst({ where: { id: runId, orgId: me.orgId } });
    if (!run) throw new NotFoundException('Run not found');
    const todo = (await this.prisma.agentStep.findMany({ where: { runId, undoneAt: null }, orderBy: { seq: 'desc' } })).filter((s) => s.undo !== null);
    if (!todo.length) throw new BadRequestException('There is nothing left to undo in this run');
    for (const s of todo) if (!(await this.canUndo(me, run, s))) throw new ForbiddenException('Only the Founder, Branch Managers, the person the agent acts for, or the person who approved it can undo this');
    for (const s of todo) {
      const claimed = await this.prisma.agentStep.updateMany({ where: { id: s.id, undoneAt: null }, data: { undoneAt: new Date(), undoneById: me.id } });
      if (claimed.count) await this.restore(s.undo as unknown as UndoRow[]);
    }
    await this.audit.log(me, 'agent.run_undone', 'AgentRun', run.id, null, { steps: todo.length });
    await this.markRunUndone(run.id);
  }

  private async markRunUndone(runId: string) {
    const left = (await this.prisma.agentStep.findMany({ where: { runId, undoneAt: null }, select: { undo: true } })).filter((s) => s.undo !== null).length;
    if (!left) await this.prisma.agentRun.update({ where: { id: runId }, data: { status: 'undone' } });
  }
}

