// The workflow engine. Every 30 seconds (and a few seconds after records change) it:
//   1. starts runs for records that match an enabled workflow's trigger and start checks (once per record + key);
//   2. moves every running run forward, and wakes runs whose wait is over or whose approval was decided.
// A run's position (pc) in the compiled program and its wake time are stored, so runs carry on after a restart.
// tick(now) takes the clock as an argument, which is how tests fast-forward days in a second.
import { Injectable, Logger, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  addWorkingDays,
  automationFill,
  automationTrigger,
  compileWorkflow,
  workflowFieldSpecs,
  workflowStepSchema,
  workflowConditionSchema,
  type AutomationStep,
  type AutomationTriggerKey,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowCustomFieldRef,
  type WorkflowInstr,
  type WorkflowMatch,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowTickResult,
} from '@bmu/shared';
import { z } from 'zod';
import { Prisma, type WorkflowDef, type WorkflowRun } from '../generated/prisma/client.js';
import { ActionsRegistry } from '../actions/registry.js';
import { AiDigestService } from '../ai/ai-digest.js';
import { AuditService } from '../audit/audit.service.js';
import { runAction, type ActionCtx } from '../automations/actions.js';
import { findSubjects, type Subject } from '../automations/subjects.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { eventBus, type BusEvent } from '../platform/event-bus.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { EmailService } from '../service/email.service.js';
import { conditionKeys, evaluate, loadFacts } from './facts.js';
import { isExtraAction, runExtraAction } from './extra-actions.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const INTERVAL_MS = 30_000;
const EVENT_LOOKBACK_MS = 14 * DAY;
const STATE_CATCH_UP_MS = 7 * DAY;
/** Instructions one run may execute in one go (stops runaway loops; the next tick carries on). */
const MAX_STEPS_PER_TICK = 50;
const MAX_NEW_RUNS = 200;
const MAX_ADVANCE = 300;
export const WORKFLOW_SYSTEM_REQUESTER = 'system:workflow';
const ACTIVE: WorkflowRunStatus[] = ['running', 'waiting', 'waiting_approval'];

export type StartSettings = { match: WorkflowMatch; conditions: WorkflowCondition[] };
export const parseStart = (raw: unknown): StartSettings => {
  const r = (raw ?? {}) as { match?: string; conditions?: unknown };
  return { match: r.match === 'any' ? 'any' : 'all', conditions: z.array(workflowConditionSchema).catch([]).parse(r.conditions ?? []) as WorkflowCondition[] };
};
export const parseSteps = (raw: unknown): WorkflowStep[] => z.array(workflowStepSchema).catch([]).parse(raw);
const parsedArgs = (raw: unknown) => (raw && typeof raw === 'object' ? (raw as Record<string, string | number>) : {});

/** A stored subject back to a Subject (dates revived). */
export const reviveSubject = (raw: unknown): Subject => {
  const s = raw as Subject & { at: string | Date };
  return { ...s, at: new Date(s.at), fields: s.fields ?? {}, vars: s.vars ?? {}, people: s.people ?? {} };
};

type Version = { id: string; number: number; trigger: string; program: WorkflowInstr[] };
type DefWithVersion = WorkflowDef & { version: Version };

@Injectable()
export class WorkflowEngine implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Workflows');
  private job?: JobHandle;
  private nudge?: ReturnType<typeof setTimeout>;
  private unsubscribe?: () => void;
  private running = false;
  private readonly versions = new Map<string, Version>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly registry: ActionsRegistry,
    @Optional() private readonly ai?: AiDigestService,
  ) {}

  onModuleInit() {
    this.registry.registerApprovalHandler({
      action: 'workflow.step',
      label: 'Workflow approval',
      href: (r) => ((r.payload ?? {}) as { link?: string }).link ?? `/admin/workflows/runs?run=${r.targetId}`,
      // The engine reads the decision on its next tick and takes the approved or rejected path.
      apply: async () => ({ recorded: true }),
    });
    this.job = startJob({ name: 'workflows.engine', hint: 'Moves workflow runs along (and right after changes)', everyMs: INTERVAL_MS, firstAfterMs: 2_000, flags: ['WORKFLOWS_DISABLED'], run: () => this.safeTick() });
    if (!this.job) return;
    // Changes (a new lead, a paid invoice, a decided approval) move workflows along within seconds.
    this.unsubscribe = eventBus.subscribe('workflows', (e: BusEvent) => this.onEvent(e), ['change']);
    this.log.log('Workflow engine started (every 30 seconds, and after changes)');
  }

  onModuleDestroy() {
    this.job?.stop();
    if (this.nudge) clearTimeout(this.nudge);
    this.unsubscribe?.();
  }

  private onEvent(e: BusEvent) {
    if (e.kind !== 'change' || e.entity.startsWith('Workflow') || e.entity === 'Notification') return;
    if (this.nudge) return;
    this.nudge = setTimeout(() => {
      this.nudge = undefined;
      this.safeTick();
    }, 3_000);
    this.nudge.unref?.();
  }

  private safeTick() {
    return this.tick().catch((e: Error) => this.log.error(`Tick failed: ${e.message}`));
  }

  // -------------------------------------------------------------------------

  /** One pass: start new runs, then move active runs forward. Returns null when a pass is already running. */
  async tick(now: Date = new Date(), opts: { orgId?: string; workflowId?: string } = {}): Promise<WorkflowTickResult | null> {
    if (this.running) return null;
    this.running = true;
    const startedAt = Date.now();
    const out: WorkflowTickResult = { started: 0, advanced: 0, finished: 0, failed: 0, tookMs: 0 };
    try {
      const defs = await this.prisma.workflowDef.findMany({
        where: { enabled: true, deletedAt: null, currentVersionId: { not: null }, ...(opts.orgId ? { orgId: opts.orgId } : {}), ...(opts.workflowId ? { id: opts.workflowId } : {}) },
        orderBy: { createdAt: 'asc' },
      });
      for (const d of defs) {
        try {
          const version = await this.version(d.currentVersionId!);
          if (version) out.started += await this.startRuns({ ...d, version }, now);
        } catch (e) {
          this.log.error(`Workflow "${d.name}" (${d.id}) could not start runs: ${(e as Error).message}`);
        }
      }
      const due = await this.prisma.workflowRun.findMany({
        where: {
          ...(opts.orgId ? { orgId: opts.orgId } : {}),
          ...(opts.workflowId ? { workflowId: opts.workflowId } : {}),
          OR: [{ status: 'running' }, { status: 'waiting', wakeAt: { lte: now } }, { status: 'waiting_approval' }],
        },
        orderBy: { updatedAt: 'asc' },
        take: MAX_ADVANCE,
      });
      for (const run of due) {
        const r = await this.advance(run, now);
        if (r === 'moved') out.advanced++;
        else if (r === 'done') out.finished++;
        else if (r === 'failed') out.failed++;
      }
    } finally {
      this.running = false;
    }
    out.tookMs = Date.now() - startedAt;
    if (out.started + out.advanced + out.finished + out.failed > 0) this.log.log(`Tick: ${out.started} started, ${out.advanced} moved on, ${out.finished} finished, ${out.failed} with problems`);
    return out;
  }

  async version(id: string): Promise<Version | null> {
    const cached = this.versions.get(id);
    if (cached) return cached;
    const v = await this.prisma.workflowVersion.findUnique({ where: { id } });
    if (!v) return null;
    const program = Array.isArray(v.program) && v.program.length ? (v.program as WorkflowInstr[]) : compileWorkflow(parseSteps(v.steps));
    const out = { id: v.id, number: v.number, trigger: v.trigger, program };
    this.versions.set(id, out);
    return out;
  }

  bounds(d: { trigger: string; watermark: Date }, now: Date) {
    const event = automationTrigger(d.trigger)?.event ?? true;
    const start = event ? new Date(Math.max(d.watermark.getTime(), now.getTime() - EVENT_LOOKBACK_MS)) : new Date(d.watermark.getTime() - STATE_CATCH_UP_MS);
    return { event, start };
  }

  async customRefs(orgId: string): Promise<WorkflowCustomFieldRef[]> {
    const rows = await this.prisma.customFieldDef.findMany({ where: { orgId, archivedAt: null }, select: { entity: true, key: true, label: true, type: true, options: true } });
    return rows.map((r) => ({ entity: r.entity as WorkflowCustomFieldRef['entity'], key: r.key, label: r.label, type: r.type, options: Array.isArray(r.options) ? (r.options as string[]) : [] }));
  }

  private async startRuns(d: DefWithVersion, now: Date) {
    const { start } = this.bounds(d, now);
    const subjects = await findSubjects(d.trigger as AutomationTriggerKey, { prisma: this.prisma, orgId: d.orgId, args: parsedArgs(d.triggerArgs), from: start, now });
    if (!subjects.length) return 0;
    const seen = new Set(
      (await this.prisma.workflowRun.findMany({ where: { workflowId: d.id, entityId: { in: subjects.map((s) => s.entityId) } }, select: { entity: true, entityId: true, dedupeKey: true } })).map((r) => `${r.entity}|${r.entityId}|${r.dedupeKey}`),
    );
    const startSettings = parseStart(d.start);
    const specs = startSettings.conditions.length ? workflowFieldSpecs(d.trigger, await this.customRefs(d.orgId)) : [];
    let started = 0;
    for (const s of subjects) {
      if (started >= MAX_NEW_RUNS) break;
      const key = `${s.entity}|${s.entityId}|${s.dedupeKey}`;
      if (seen.has(key) || s.at < start) continue;
      if (startSettings.conditions.length) {
        const facts = await loadFacts(this.prisma, s, conditionKeys(startSettings.conditions), now);
        if (!evaluate(startSettings.conditions, startSettings.match, facts, specs).passes) continue;
      }
      seen.add(key);
      try {
        await this.prisma.workflowRun.create({
          data: { orgId: d.orgId, workflowId: d.id, versionId: d.version.id, entity: s.entity, entityId: s.entityId, dedupeKey: s.dedupeKey, record: s.record.slice(0, 300), link: s.link, status: 'running', subject: JSON.parse(JSON.stringify(s)), startedAt: now },
        });
        started++;
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') continue;
        throw e;
      }
    }
    if (started) await this.prisma.workflowDef.update({ where: { id: d.id }, data: { runCount: { increment: started }, lastRunAt: now } });
    return started;
  }

  private async systemAuthor(orgId: string) {
    const f = await this.prisma.user.findFirst({ where: { orgId, deletedAt: null, type: 'staff', roles: { some: { role: { baseRole: 'founder' } } } }, select: { id: true } });
    return f?.id ?? null;
  }

  private async logStep(run: WorkflowRun, stepId: string, kind: string, ok: boolean, text: string, skipped = false, at = new Date()) {
    await this.prisma.workflowRunStep.create({ data: { orgId: run.orgId, runId: run.id, stepId, kind, ok, skipped, text: text.slice(0, 1000), at } });
  }

  /** Moves one run as far as it can go now. */
  async advance(run: WorkflowRun, now: Date): Promise<'moved' | 'done' | 'failed' | 'idle'> {
    // Claim the run so a slow pass and a fast one never both act on it.
    const claimed = await this.prisma.workflowRun.updateMany({ where: { id: run.id, status: { in: ACTIVE }, OR: [{ lockedUntil: null }, { lockedUntil: { lt: new Date() } }] }, data: { lockedUntil: new Date(Date.now() + 2 * MINUTE) } });
    if (!claimed.count) return 'idle';
    const def = await this.prisma.workflowDef.findUnique({ where: { id: run.workflowId } });
    const version = await this.version(run.versionId);
    if (!def || !version || def.deletedAt) {
      await this.prisma.workflowRun.update({ where: { id: run.id }, data: { status: 'cancelled', lockedUntil: null, finishedAt: now, error: 'The workflow was deleted' } });
      return 'done';
    }
    const subject = reviveSubject(run.subject);
    const meta = { ...((run.meta ?? {}) as Record<string, string>) };
    const program = version.program;
    let pc = run.pc;
    let status = run.status as WorkflowRunStatus;
    let wakeAt: Date | null = run.wakeAt;
    let approvalId = run.approvalId;
    let failures = run.failures;
    let moved = false;
    let error: string | null = null;
    const ctxBase = { calendar: await calendarFor(this.prisma, run.orgId), systemAuthorId: await this.systemAuthor(run.orgId) };
    let specs: ReturnType<typeof workflowFieldSpecs> | null = null;
    const fill = (tpl: string) => automationFill(tpl, { record: subject.record, ...subject.vars });

    if (status === 'waiting') status = 'running';
    try {
      for (let n = 0; n < MAX_STEPS_PER_TICK; n++) {
        if (pc >= program.length) {
          status = failures ? 'failed' : 'done';
          break;
        }
        const ins = program[pc];
        if (ins.op === 'jump') {
          pc = ins.to;
          continue;
        }
        if (ins.op === 'stop') {
          await this.logStep(run, ins.step, 'stop', true, ins.reason ? `Stopped: ${ins.reason}` : 'Stopped here', false, now);
          status = failures ? 'failed' : 'done';
          moved = true;
          break;
        }
        if (ins.op === 'action') {
          const state = (def.state ?? {}) as { lastAssignedUserId?: string };
          const lastAssigned = new Map<string, string>(state.lastAssignedUserId ? [[def.id, state.lastAssignedUserId]] : []);
          const ctx: ActionCtx = {
            prisma: this.prisma,
            audit: this.audit,
            orgId: run.orgId,
            rule: { id: def.id, name: def.name, trigger: def.trigger, createdById: def.createdById },
            subject,
            dryRun: false,
            now,
            calendar: ctxBase.calendar,
            lastAssigned,
            systemAuthorId: ctxBase.systemAuthorId,
            meta,
            notifications: this.notifications,
            email: this.email,
            ai: this.ai,
          };
          let res: AutomationStep;
          try {
            res = await this.doAction(ctx, ins.action);
          } catch (e) {
            res = { action: 'notify', ok: false, text: `Could not ${ins.action.type.replace(/_/g, ' ')}: ${(e as Error).message.split('\n')[0].slice(0, 200)}` };
          }
          if (!res.ok) failures++;
          if (meta.assignedUserId && meta.assignedUserId !== state.lastAssignedUserId) {
            await this.prisma.workflowDef.update({ where: { id: def.id }, data: { state: { ...state, lastAssignedUserId: meta.assignedUserId } } });
            def.state = { ...state, lastAssignedUserId: meta.assignedUserId };
          }
          await this.logStep(run, ins.step, 'action', res.ok, res.text, !!res.skipped, now);
          pc++;
          moved = true;
          continue;
        }
        if (ins.op === 'wait') {
          const until = ins.unit === 'working_days' ? addWorkingDays(now, ins.amount, ctxBase.calendar) : new Date(now.getTime() + ins.amount * (ins.unit === 'minutes' ? MINUTE : ins.unit === 'hours' ? HOUR : DAY));
          await this.logStep(run, ins.step, 'wait', true, `Waiting ${ins.amount} ${ins.unit.replace('_', ' ')} (until ${fmt(until)})`, false, now);
          wakeAt = until;
          status = 'waiting';
          pc++;
          moved = true;
          break;
        }
        if (ins.op === 'wait_until') {
          const facts = await loadFacts(this.prisma, subject, [ins.field], now);
          const base = facts.dates[ins.field];
          if (!base) {
            await this.logStep(run, ins.step, 'wait_until', true, 'No date on the record to wait for, so it carried on', true, now);
            pc++;
            moved = true;
            continue;
          }
          const target = new Date(base.getTime() + ins.offsetDays * DAY);
          if (target <= now) {
            await this.logStep(run, ins.step, 'wait_until', true, `The date (${fmt(target)}) has passed, carried on`, false, now);
            pc++;
            moved = true;
            continue;
          }
          await this.logStep(run, ins.step, 'wait_until', true, `Waiting until ${fmt(target)}`, false, now);
          wakeAt = target;
          status = 'waiting';
          pc++;
          moved = true;
          break;
        }
        if (ins.op === 'if') {
          specs ??= workflowFieldSpecs(def.trigger, await this.customRefs(run.orgId));
          const facts = await loadFacts(this.prisma, subject, conditionKeys(ins.conditions), now);
          const r = evaluate(ins.conditions, ins.match, facts, specs);
          await this.logStep(run, ins.step, 'if', true, `${r.passes ? 'Yes' : 'No'}: ${r.text}`, false, now);
          pc = r.passes ? pc + 1 : ins.else;
          moved = true;
          continue;
        }
        if (ins.op === 'approval') {
          if (!approvalId) {
            approvalId = await this.askApproval(run, def, subject, ins, fill(ins.title), now);
            status = 'waiting_approval';
            wakeAt = null;
            moved = true;
            break;
          }
          const a = await this.prisma.approvalRequest.findUnique({ where: { id: approvalId } });
          let decision = a?.status ?? 'cancelled';
          if (a && decision === 'pending' && a.expiresAt <= now) {
            await this.prisma.approvalRequest.updateMany({ where: { id: a.id, status: 'pending' }, data: { status: 'expired', decidedAt: now } });
            decision = 'expired';
          }
          if (decision === 'pending') {
            status = 'waiting_approval';
            break;
          }
          const who = a?.decidedById ? (await this.prisma.user.findUnique({ where: { id: a.decidedById }, select: { name: true } }))?.name : null;
          const words = decision === 'approved' ? `Approved${who ? ` by ${who}` : ''}` : decision === 'rejected' ? `Rejected${who ? ` by ${who}` : ''}${a?.decisionNote ? `: ${a.decisionNote}` : ''}` : decision === 'expired' ? 'Nobody decided in time (expired), took the "no" path' : 'The approval was withdrawn, took the "no" path';
          await this.logStep(run, ins.step, 'approval', true, words, false, now);
          approvalId = null;
          pc = decision === 'approved' ? pc + 1 : ins.rejected;
          status = 'running';
          moved = true;
          continue;
        }
      }
    } catch (e) {
      error = (e as Error).message.split('\n')[0].slice(0, 300);
      meta.errors = String(Number(meta.errors ?? 0) + 1);
      this.log.error(`Run ${run.id} (${def.name}) hit a problem: ${error}`);
      // Three problems in a row (database down, a record gone) end the run rather than retrying forever.
      if (Number(meta.errors) >= 3) {
        status = 'failed';
        await this.logStep(run, 'engine', 'error', false, `Stopped after repeated problems: ${error}`, false, now).catch(() => undefined);
      }
    }
    if (!error) delete meta.errors;
    const finished = status === 'done' || status === 'failed';
    await this.prisma.workflowRun.update({
      where: { id: run.id },
      data: {
        pc,
        status,
        wakeAt: status === 'waiting' ? wakeAt : null,
        approvalId,
        failures,
        meta: JSON.parse(JSON.stringify(meta)),
        subject: JSON.parse(JSON.stringify(subject)),
        error,
        lockedUntil: null,
        finishedAt: finished ? now : null,
      },
    });
    if (finished) return status === 'failed' ? 'failed' : 'done';
    return moved ? 'moved' : 'idle';
  }

  private async doAction(ctx: ActionCtx, a: WorkflowAction): Promise<AutomationStep> {
    if (isExtraAction(a)) return runExtraAction(ctx, a);
    return runAction(ctx, a);
  }

  private async askApproval(run: WorkflowRun, def: WorkflowDef, s: Subject, ins: Extract<WorkflowInstr, { op: 'approval' }>, summary: string, now: Date) {
    const approverId = ins.approverId ?? null;
    const approverRoles = approverId ? [] : [ins.approverRole ?? 'founder'];
    const req = await this.prisma.approvalRequest.create({
      data: {
        orgId: run.orgId,
        action: 'workflow.step',
        targetType: 'workflow_run',
        targetId: run.id,
        payload: JSON.parse(JSON.stringify({ runId: run.id, stepId: ins.step, workflowId: def.id, link: s.link, _diff: [] })),
        summary: summary.slice(0, 300),
        requestedById: WORKFLOW_SYSTEM_REQUESTER,
        approverId,
        approverRoles,
        reason: `Workflow "${def.name}" · ${s.record}`.slice(0, 500),
        expiresAt: new Date(now.getTime() + ins.expiresInDays * DAY),
      },
    });
    const recipients = approverId
      ? [approverId]
      : (await this.prisma.user.findMany({ where: { orgId: run.orgId, type: 'staff', deletedAt: null, status: 'active', roles: { some: { role: { baseRole: { in: approverRoles } } } } }, select: { id: true } })).map((u) => u.id);
    if (recipients.length) await this.notifications.notify(run.orgId, recipients, { kind: 'approval_needed', title: `Workflow "${def.name}" needs your approval: ${summary}`.slice(0, 200), body: s.record, link: '/team/approvals' });
    const names = approverId ? (await this.prisma.user.findUnique({ where: { id: approverId }, select: { name: true } }))?.name : approverRoles.join(', ').replace(/_/g, ' ');
    await this.logStep(run, ins.step, 'approval', true, `Asked ${names ?? 'an approver'} to approve: ${summary}`, false, now);
    return req.id;
  }

  /** Stops a run (and withdraws its pending approval). */
  async cancel(runId: string, byName: string) {
    const run = await this.prisma.workflowRun.findUnique({ where: { id: runId } });
    if (!run || !ACTIVE.includes(run.status as WorkflowRunStatus)) return run;
    if (run.approvalId) await this.prisma.approvalRequest.updateMany({ where: { id: run.approvalId, status: 'pending' }, data: { status: 'cancelled', decidedAt: new Date(), decisionNote: `The workflow run was stopped by ${byName}` } });
    await this.logStep(run, 'engine', 'stop', true, `Stopped by ${byName}`);
    return this.prisma.workflowRun.update({ where: { id: runId }, data: { status: 'cancelled', finishedAt: new Date(), wakeAt: null, approvalId: null, lockedUntil: null } });
  }

}

const dtFmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZone: 'Asia/Kolkata' });
export const fmt = (d: Date) => dtFmt.format(d);
