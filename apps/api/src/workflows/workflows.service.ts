import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  automationTrigger,
  compileWorkflow,
  hierarchyData,
  WORKFLOW_TEMPLATES,
  workflowFieldSpecs,
  workflowDateFields,
  workflowInputSchema,
  workflowRunStatusLabels,
  workflowStepPhrase,
  workflowSummary,
  workflowWalk,
  type AutomationAction,
  type AutomationCondition,
  type AutomationRunDetail,
  type AutomationTriggerKey,
  type Me,
  type WorkflowData,
  type WorkflowDetail,
  type WorkflowMoveResult,
  type WorkflowOptions,
  type WorkflowOverview,
  type WorkflowRow,
  type WorkflowRunDetail,
  type WorkflowRunFilters,
  type WorkflowRunRow,
  type WorkflowRunStatus,
  type WorkflowStep,
  type WorkflowTestResult,
  type WhatsAppQueueRow,
} from '@bmu/shared';
import type { Prisma, WorkflowDef, WorkflowRun } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { canManageAutomations, canViewAutomations } from '../automations/automations.service.js';
import { findSubjects } from '../automations/subjects.js';
import { webhookUrlProblem } from '../automations/url-guard.js';
import { isFoundingAdmin } from '../customise/custom-fields.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { conditionKeys, evaluate, loadFacts } from './facts.js';
import { fmt, parseStart, parseSteps, WorkflowEngine } from './engine.js';

const DAY = 86_400_000;
const ACTIVE = ['running', 'waiting', 'waiting_approval'];

function assertView(me: Me) {
  if (!canViewAutomations(me)) throw new ForbiddenException('Workflows are for Founder, Branch Manager, department heads, the AM Lead and Finance');
}
function assertManage(me: Me) {
  if (!canManageAutomations(me)) throw new ForbiddenException('Only the Founder and Branch Managers can change workflows');
}

const snapshot = (w: WorkflowDef) => ({ name: w.name, enabled: w.enabled, trigger: w.trigger, triggerArgs: w.triggerArgs, start: w.start, steps: w.steps, version: w.versionNumber });

@Injectable()
export class WorkflowsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly engine: WorkflowEngine,
  ) {}

  private async names(orgId: string) {
    const [users, forms] = await Promise.all([
      this.prisma.user.findMany({ where: { orgId, type: 'staff' }, select: { id: true, name: true } }),
      this.prisma.formDef.findMany({ where: { orgId }, select: { id: true, name: true } }),
    ]);
    return Object.fromEntries([...users.map((u) => [u.id, u.name]), ...forms.map((f) => [f.id, f.name])]) as Record<string, string>;
  }

  private row(w: WorkflowDef, names: Record<string, string>, active = 0, failures30d = 0): WorkflowRow {
    const t = automationTrigger(w.trigger);
    return {
      id: w.id,
      name: w.name,
      description: w.description,
      enabled: w.enabled,
      trigger: w.trigger as AutomationTriggerKey,
      triggerLabel: t?.label ?? w.trigger,
      area: t?.area ?? 'Sales',
      summary: workflowSummary({ trigger: w.trigger, triggerArgs: w.triggerArgs as Record<string, unknown>, steps: parseSteps(w.steps) }, names),
      version: w.versionNumber,
      templateKey: w.templateKey,
      movedFromRule: !!w.movedFromRuleId,
      runCount: w.runCount,
      active,
      failures30d,
      lastRunAt: w.lastRunAt?.toISOString() ?? null,
      createdAt: w.createdAt.toISOString(),
    };
  }

  private async find(me: Me, id: string) {
    const w = await this.prisma.workflowDef.findFirst({ where: { id, orgId: me.orgId, deletedAt: null } });
    if (!w) throw new NotFoundException('Workflow not found');
    return w;
  }

  // -------------------------------------------------------------------------
  // Read

  async overview(me: Me): Promise<WorkflowOverview> {
    assertView(me);
    const since7 = new Date(Date.now() - 7 * DAY);
    const since30 = new Date(Date.now() - 30 * DAY);
    const [defs, names, active, failures, runs7d, waiting, approvals, failures7d, toMove] = await Promise.all([
      this.prisma.workflowDef.findMany({ where: { orgId: me.orgId, deletedAt: null }, orderBy: [{ enabled: 'desc' }, { createdAt: 'asc' }] }),
      this.names(me.orgId),
      this.prisma.workflowRun.groupBy({ by: ['workflowId'], where: { orgId: me.orgId, status: { in: ACTIVE } }, _count: true }),
      this.prisma.workflowRun.groupBy({ by: ['workflowId'], where: { orgId: me.orgId, status: 'failed', startedAt: { gte: since30 } }, _count: true }),
      this.prisma.workflowRun.count({ where: { orgId: me.orgId, startedAt: { gte: since7 }, NOT: { meta: { path: ['imported'], equals: 'true' } } } }),
      this.prisma.workflowRun.count({ where: { orgId: me.orgId, status: 'waiting' } }),
      this.prisma.workflowRun.count({ where: { orgId: me.orgId, status: 'waiting_approval' } }),
      this.prisma.workflowRun.count({ where: { orgId: me.orgId, status: 'failed', finishedAt: { gte: since7 } } }),
      this.prisma.automationRule.count({ where: { orgId: me.orgId, deletedAt: null, movedToWorkflowId: null } }),
    ]);
    const installed = new Set(defs.map((d) => d.templateKey).filter(Boolean));
    return {
      canManage: canManageAutomations(me),
      stats: { active: defs.filter((d) => d.enabled).length, total: defs.length, runs7d, waiting, awaitingApproval: approvals, failures7d },
      workflows: defs.map((d) => this.row(d, names, active.find((a) => a.workflowId === d.id)?._count ?? 0, failures.find((a) => a.workflowId === d.id)?._count ?? 0)),
      templates: WORKFLOW_TEMPLATES.map((t) => ({ ...t, installed: installed.has(t.key), summary: workflowSummary(workflowInputSchema.parse(t.workflow)) })),
      automationsToMove: toMove,
    };
  }

  async options(me: Me): Promise<WorkflowOptions> {
    assertView(me);
    const [users, forms, custom] = await Promise.all([
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' } }, select: { id: true, name: true, roles: { select: { role: { select: { baseRole: true } } } } }, orderBy: { name: 'asc' } }),
      this.prisma.formDef.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.engine.customRefs(me.orgId),
    ]);
    return {
      canManage: canManageAutomations(me),
      users: users.map((u) => ({ id: u.id, name: u.name, roles: [...new Set(u.roles.map((r) => r.role.baseRole))] })),
      roles: hierarchyData.team_roles.map((r) => ({ value: r.id, label: r.name })),
      forms: forms.map((f) => ({ value: f.id, label: f.name })),
      customFields: custom,
    };
  }

  async get(me: Me, id: string): Promise<WorkflowDetail> {
    assertView(me);
    const w = await this.find(me, id);
    const [names, versions, active, failures, creator, logs] = await Promise.all([
      this.names(me.orgId),
      this.prisma.workflowVersion.findMany({ where: { workflowId: id }, orderBy: { number: 'desc' }, include: { _count: { select: { runs: true } } } }),
      this.prisma.workflowRun.count({ where: { workflowId: id, status: { in: ACTIVE } } }),
      this.prisma.workflowRun.count({ where: { workflowId: id, status: 'failed', startedAt: { gte: new Date(Date.now() - 30 * DAY) } } }),
      w.createdById ? this.prisma.user.findUnique({ where: { id: w.createdById }, select: { name: true } }) : null,
      this.prisma.workflowRunStep.groupBy({ by: ['stepId'], where: { run: { workflowId: id, versionId: w.currentVersionId ?? undefined } }, _count: true }),
    ]);
    // Runs waiting on each step right now (the step they last logged).
    const current = await this.prisma.workflowRun.findMany({ where: { workflowId: id, status: { in: ['waiting', 'waiting_approval'] } }, select: { id: true } });
    const lastSteps = current.length
      ? await this.prisma.workflowRunStep.findMany({ where: { runId: { in: current.map((c) => c.id) } }, orderBy: { at: 'desc' }, distinct: ['runId'], select: { stepId: true } })
      : [];
    const stepCounts: WorkflowDetail['stepCounts'] = {};
    for (const l of logs) stepCounts[l.stepId] = { at: 0, done: l._count };
    for (const l of lastSteps) stepCounts[l.stepId] = { at: (stepCounts[l.stepId]?.at ?? 0) + 1, done: stepCounts[l.stepId]?.done ?? 0 };
    const creators = await this.prisma.user.findMany({ where: { id: { in: versions.map((v) => v.createdById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return {
      ...this.row(w, names, active, failures),
      triggerArgs: w.triggerArgs as Record<string, string | number>,
      start: parseStart(w.start),
      steps: parseSteps(w.steps),
      watermark: w.watermark.toISOString(),
      createdBy: creator?.name ?? null,
      versions: versions.map((v) => {
        let n = 0;
        workflowWalk(parseSteps(v.steps), () => n++);
        return { id: v.id, number: v.number, createdAt: v.createdAt.toISOString(), createdBy: creators.find((c) => c.id === v.createdById)?.name ?? null, steps: n, runs: v._count.runs };
      }),
      stepCounts,
    };
  }

  private async approvals(ids: (string | null)[]) {
    const list = ids.filter((x): x is string => !!x);
    if (!list.length) return new Map<string, { summary: string; approverId: string | null; approverRoles: string[] }>();
    const rows = await this.prisma.approvalRequest.findMany({ where: { id: { in: list } }, select: { id: true, summary: true, approverId: true, approverRoles: true } });
    return new Map(rows.map((r) => [r.id, r]));
  }

  private runRow(r: WorkflowRun & { workflow: { name: string }; version: { number: number } }, names: Record<string, string>, approvals: Map<string, { summary: string; approverId: string | null; approverRoles: string[] }>): WorkflowRunRow {
    const status = r.status as WorkflowRunStatus;
    const a = r.approvalId ? approvals.get(r.approvalId) : undefined;
    const meta = (r.meta ?? {}) as { imported?: string; summary?: string };
    const where =
      status === 'waiting' && r.wakeAt
        ? `Waiting until ${fmt(r.wakeAt)}`
        : status === 'waiting_approval'
          ? `Waiting for ${a?.approverId ? (names[a.approverId] ?? 'the approver') : (a?.approverRoles ?? []).map((x) => x.replace(/_/g, ' ')).join(' or ') || 'approval'}${a ? `: ${a.summary}` : ''}`
          : status === 'failed'
            ? `Finished with ${r.failures || 1} problem${r.failures === 1 ? '' : 's'}`
            : meta.imported
              ? `Moved from Automations: ${meta.summary ?? 'ran before the move'}`
              : workflowRunStatusLabels[status];
    return {
      id: r.id,
      workflowId: r.workflowId,
      workflowName: r.workflow.name,
      version: r.version.number,
      entity: r.entity,
      entityId: r.entityId,
      record: r.record,
      link: r.link,
      status,
      where,
      wakeAt: r.wakeAt?.toISOString() ?? null,
      failures: r.failures,
      startedAt: r.startedAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  }

  async whatsappQueue(me: Me): Promise<WhatsAppQueueRow[]> {
    if (!isFoundingAdmin(me)) throw new ForbiddenException('The WhatsApp queue is for the Founder and Branch Managers');
    const rows = await this.prisma.whatsAppMessage.findMany({ where: { orgId: me.orgId }, orderBy: { createdAt: 'desc' }, take: 200 });
    const base: Record<string, string> = { Lead: '/team/leads/', Engagement: '/team/projects/', Request: '/team/requests/' };
    return rows.map((r) => ({ id: r.id, toName: r.toName, toPhone: r.toPhone, body: r.body, status: r.status, link: r.entity && r.entityId && base[r.entity] ? `${base[r.entity]}${r.entityId}` : null, source: r.source, createdAt: r.createdAt.toISOString() }));
  }

  async runs(me: Me, f: WorkflowRunFilters & { entity?: string }): Promise<WorkflowRunRow[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    // Anyone on the team can see the workflow history of a record they opened; the full log is for viewers.
    if (!f.entityId) assertView(me);
    const where: Prisma.WorkflowRunWhereInput = { orgId: me.orgId };
    if (f.workflowId) where.workflowId = f.workflowId;
    if (f.entityId) where.entityId = f.entityId;
    if (f.status === 'active') where.status = { in: ACTIVE };
    else if (f.status && (workflowRunStatusLabels as Record<string, string>)[f.status]) where.status = f.status;
    const rows = await this.prisma.workflowRun.findMany({ where, orderBy: { startedAt: 'desc' }, take: f.entityId ? 30 : 500, include: { workflow: { select: { name: true } }, version: { select: { number: true } } } });
    const [names, approvals] = await Promise.all([this.names(me.orgId), this.approvals(rows.map((r) => r.approvalId))]);
    return rows.map((r) => this.runRow(r, names, approvals));
  }

  async run(me: Me, id: string): Promise<WorkflowRunDetail> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const r = await this.prisma.workflowRun.findFirst({ where: { id, orgId: me.orgId }, include: { workflow: { select: { name: true, trigger: true, orgId: true } }, version: { select: { number: true, steps: true } }, steps: { orderBy: { at: 'asc' } } } });
    if (!r) throw new NotFoundException('Workflow run not found');
    const [names, approvals, custom] = await Promise.all([this.names(me.orgId), this.approvals([r.approvalId]), this.engine.customRefs(me.orgId)]);
    const specs = workflowFieldSpecs(r.workflow.trigger, custom);
    const dateLabels = Object.fromEntries(workflowDateFields(r.workflow.trigger, custom).map((d) => [d.value, d.label]));
    const logged = new Set(r.steps.map((s) => s.stepId));
    const last = r.steps.at(-1)?.stepId;
    const active = ACTIVE.includes(r.status);
    const outline: WorkflowRunDetail['outline'] = [];
    workflowWalk(parseSteps(r.version.steps), (s: WorkflowStep, depth) => {
      outline.push({ stepId: s.id, depth, text: workflowStepPhrase(s, specs, names, dateLabels), state: active && s.id === last ? 'current' : logged.has(s.id) ? 'done' : active ? 'todo' : 'skipped' });
    });
    return {
      ...this.runRow(r, names, approvals),
      steps: r.steps.map((s) => ({ id: s.id, stepId: s.stepId, kind: s.kind, ok: s.ok, skipped: s.skipped, text: s.text, at: s.at.toISOString() })),
      canCancel: active && canManageAutomations(me),
      approvalId: r.approvalId,
      outline,
    };
  }

  async cancelRun(me: Me, id: string, ip?: string) {
    assertManage(me);
    const r = await this.prisma.workflowRun.findFirst({ where: { id, orgId: me.orgId } });
    if (!r) throw new NotFoundException('Workflow run not found');
    if (!ACTIVE.includes(r.status)) throw new BadRequestException('This run has already finished');
    await this.engine.cancel(id, me.name);
    await this.audit.log(me, 'workflow.run_cancelled', 'WorkflowRun', id, { status: r.status }, { status: 'cancelled' }, ip);
    return this.run(me, id);
  }

  // -------------------------------------------------------------------------
  // Write

  private async validate(me: Me, raw: unknown): Promise<WorkflowData> {
    const parsed = workflowInputSchema.safeParse(raw);
    if (!parsed.success) {
      const i = parsed.error.issues[0];
      throw new BadRequestException(i?.message ?? 'Check the workflow');
    }
    const d = parsed.data;
    const users = new Set<string>();
    const customKeys = new Set<string>();
    workflowWalk(d.steps, (s) => {
      if (s.kind === 'approval' && s.approverId) users.add(s.approverId);
      if (s.kind === 'wait_until' && s.field.startsWith('custom.')) customKeys.add(s.field);
      if (s.kind === 'if') s.conditions.filter((c) => c.field.startsWith('custom.')).forEach((c) => customKeys.add(c.field));
      if (s.kind !== 'action') return;
      const a = s.action;
      if (a.type === 'webhook') {
        const p = webhookUrlProblem(a.url);
        if (p) throw new BadRequestException(p);
      }
      if ((a.type === 'notify' || a.type === 'email' || a.type === 'ai_draft') && a.to === 'users') a.userIds?.forEach((x) => users.add(x));
      if (a.type === 'create_task' && a.assignTo === 'user' && a.userId) users.add(a.userId);
      if (a.type === 'reassign_open_work' && a.to === 'user' && a.userId) users.add(a.userId);
      if (a.type === 'set_custom_field') customKeys.add(a.field);
    });
    d.start.conditions.filter((c) => c.field.startsWith('custom.')).forEach((c) => customKeys.add(c.field));
    if (users.size) {
      const n = await this.prisma.user.count({ where: { id: { in: [...users] }, orgId: me.orgId, type: 'staff', deletedAt: null } });
      if (n !== users.size) throw new BadRequestException('One of the chosen people is not on the team');
    }
    if (customKeys.size) {
      const defs = await this.engine.customRefs(me.orgId);
      for (const k of customKeys) if (!defs.some((x) => `custom.${x.entity}.${x.key}` === k)) throw new BadRequestException(`The custom field "${k.split('.').pop()}" does not exist (or was archived)`);
    }
    const formId = d.triggerArgs.formId;
    if (d.trigger === 'form_submitted' && formId) {
      const f = await this.prisma.formDef.findFirst({ where: { id: String(formId), orgId: me.orgId, deletedAt: null } });
      if (!f) throw new BadRequestException('Pick one of your forms');
    }
    return d;
  }

  private async saveVersion(me: Me | null, w: WorkflowDef, d: WorkflowData) {
    const number = (await this.prisma.workflowVersion.count({ where: { workflowId: w.id } })) + 1;
    const v = await this.prisma.workflowVersion.create({
      data: {
        workflowId: w.id,
        number,
        trigger: d.trigger,
        triggerArgs: d.triggerArgs as Prisma.InputJsonValue,
        start: d.start as unknown as Prisma.InputJsonValue,
        steps: d.steps as unknown as Prisma.InputJsonValue,
        program: compileWorkflow(d.steps) as unknown as Prisma.InputJsonValue,
        createdById: me?.id ?? null,
      },
    });
    await this.prisma.workflowDef.update({ where: { id: w.id }, data: { currentVersionId: v.id, versionNumber: number } });
    return v;
  }

  private dbData(d: WorkflowData) {
    return {
      name: d.name,
      description: d.description ?? null,
      enabled: d.enabled,
      trigger: d.trigger,
      triggerArgs: d.triggerArgs as Prisma.InputJsonValue,
      start: d.start as unknown as Prisma.InputJsonValue,
      steps: d.steps as unknown as Prisma.InputJsonValue,
    };
  }

  async create(me: Me, raw: unknown, ip?: string, extra: { templateKey?: string; movedFromRuleId?: string; watermark?: Date } = {}) {
    assertManage(me);
    const d = await this.validate(me, raw);
    const w = await this.prisma.workflowDef.create({ data: { ...this.dbData(d), orgId: me.orgId, createdById: me.id, templateKey: extra.templateKey ?? null, movedFromRuleId: extra.movedFromRuleId ?? null, watermark: extra.watermark ?? new Date() } });
    await this.saveVersion(me, w, d);
    await this.audit.log(me, 'workflow.created', 'WorkflowDef', w.id, undefined, snapshot(w), ip);
    return this.get(me, w.id);
  }

  async fromTemplate(me: Me, templateKey: string, ip?: string) {
    assertManage(me);
    const t = WORKFLOW_TEMPLATES.find((x) => x.key === templateKey);
    if (!t) throw new NotFoundException('Template not found');
    return this.create(me, { ...t.workflow, description: t.description, enabled: true }, ip, { templateKey: t.key });
  }

  async update(me: Me, id: string, raw: unknown, ip?: string) {
    assertManage(me);
    const before = await this.find(me, id);
    const d = await this.validate(me, raw);
    const restart = (!before.enabled && d.enabled) || before.trigger !== d.trigger;
    const changed = before.trigger !== d.trigger || JSON.stringify(before.triggerArgs) !== JSON.stringify(d.triggerArgs) || JSON.stringify(before.start) !== JSON.stringify(d.start) || JSON.stringify(before.steps) !== JSON.stringify(d.steps);
    const w = await this.prisma.workflowDef.update({ where: { id }, data: { ...this.dbData(d), ...(restart ? { watermark: new Date() } : {}) } });
    // Runs already going stay on the version they started with; new runs use the new one.
    if (changed) await this.saveVersion(me, w, d);
    await this.audit.log(me, 'workflow.updated', 'WorkflowDef', id, snapshot(before), snapshot(w), ip);
    return this.get(me, id);
  }

  async setEnabled(me: Me, id: string, enabled: boolean, ip?: string) {
    assertManage(me);
    const before = await this.find(me, id);
    if (before.enabled !== enabled) {
      await this.prisma.workflowDef.update({ where: { id }, data: { enabled, ...(enabled ? { watermark: new Date() } : {}) } });
      await this.audit.log(me, enabled ? 'workflow.enabled' : 'workflow.disabled', 'WorkflowDef', id, { enabled: before.enabled }, { enabled }, ip);
    }
    return this.get(me, id);
  }

  async remove(me: Me, id: string, ip?: string) {
    assertManage(me);
    const before = await this.find(me, id);
    const active = await this.prisma.workflowRun.findMany({ where: { workflowId: id, status: { in: ACTIVE } }, select: { id: true } });
    for (const r of active) await this.engine.cancel(r.id, me.name);
    await this.prisma.workflowDef.update({ where: { id }, data: { deletedAt: new Date(), enabled: false } });
    await this.audit.log(me, 'workflow.deleted', 'WorkflowDef', id, snapshot(before), { stoppedRuns: active.length }, ip);
    return { ok: true as const };
  }

  // -------------------------------------------------------------------------
  // Test and run now

  async test(me: Me, raw: unknown, id?: string): Promise<WorkflowTestResult> {
    assertView(me);
    const d = await this.validate(me, raw);
    const now = new Date();
    const existing = id ? await this.find(me, id) : null;
    const { event, start } = this.engine.bounds({ trigger: d.trigger, watermark: existing?.watermark ?? now }, now);
    const testFrom = event ? new Date(Math.min(start.getTime(), now.getTime() - 7 * DAY)) : new Date(Math.min(start.getTime(), now.getTime() - 30 * DAY));
    const subjects = await findSubjects(d.trigger, { prisma: this.prisma, orgId: me.orgId, args: d.triggerArgs, from: testFrom, now });
    const started = existing
      ? new Set((await this.prisma.workflowRun.findMany({ where: { workflowId: existing.id, entityId: { in: subjects.map((s) => s.entityId) } }, select: { entity: true, entityId: true, dedupeKey: true } })).map((r) => `${r.entity}|${r.entityId}|${r.dedupeKey}`))
      : new Set<string>();
    const [names, custom] = await Promise.all([this.names(me.orgId), this.engine.customRefs(me.orgId)]);
    const specs = workflowFieldSpecs(d.trigger, custom);
    const dateLabels = Object.fromEntries(workflowDateFields(d.trigger, custom).map((x) => [x.value, x.label]));
    const matches: WorkflowTestResult['matches'] = [];
    for (const s of subjects.slice(0, 50)) {
      let passes = true;
      let failedCondition: string | undefined;
      if (d.start.conditions.length) {
        const r = evaluate(d.start.conditions, d.start.match, await loadFacts(this.prisma, s, conditionKeys(d.start.conditions), now), specs);
        passes = r.passes;
        if (!r.passes) failedCondition = r.text;
      }
      matches.push({ entity: s.entity, entityId: s.entityId, record: s.record, link: s.link, alreadyStarted: started.has(`${s.entity}|${s.entityId}|${s.dedupeKey}`), beforeStart: s.at < start, passes, failedCondition });
    }
    const outline: string[] = [];
    workflowWalk(d.steps, (s, depth) => outline.push(`${'  '.repeat(depth)}${workflowStepPhrase(s, specs, names, dateLabels)}`));
    const t = automationTrigger(d.trigger);
    return {
      summary: workflowSummary(d, names),
      considered: subjects.length,
      willStart: matches.filter((m) => m.passes && !m.alreadyStarted && !m.beforeStart).length,
      matches,
      outline,
      note: t?.event
        ? 'This trigger starts runs only for records that arrive after the workflow is switched on. Recent older records are shown as examples.'
        : 'This trigger checks every open record. When a workflow is switched on it also catches records that crossed the line in the 7 days before.',
    };
  }

  async runNow(me: Me, ip?: string) {
    assertManage(me);
    const r = await this.engine.tick(new Date(), { orgId: me.orgId });
    if (!r) throw new ConflictException('Workflows are already running. Try again in a few seconds.');
    await this.audit.log(me, 'workflow.run_now', 'WorkflowDef', 'all', undefined, r, ip);
    return r;
  }

  // -------------------------------------------------------------------------
  // Moving v9 automations into workflows

  async moveAutomations(me: Me, ruleId?: string, ip?: string): Promise<WorkflowMoveResult> {
    assertManage(me);
    const rules = await this.prisma.automationRule.findMany({ where: { orgId: me.orgId, deletedAt: null, movedToWorkflowId: null, ...(ruleId ? { id: ruleId } : {}) }, orderBy: { createdAt: 'asc' } });
    if (ruleId && !rules.length) throw new NotFoundException('This automation was already moved or deleted');
    const moved: WorkflowMoveResult['moved'] = [];
    for (const rule of rules) {
      const actions = (Array.isArray(rule.actions) ? rule.actions : []) as AutomationAction[];
      const input = {
        name: rule.name,
        description: rule.description ?? `Moved from Automations on ${fmt(new Date())}`,
        enabled: rule.enabled,
        trigger: rule.trigger,
        triggerArgs: rule.triggerArgs,
        start: { match: 'all', conditions: (Array.isArray(rule.conditions) ? rule.conditions : []) as AutomationCondition[] },
        steps: actions.map((a, i) => ({ id: `m${i + 1}`, kind: 'action', action: a })),
      };
      const parsed = workflowInputSchema.safeParse(input);
      if (!parsed.success) throw new BadRequestException(`"${rule.name}" could not be moved: ${parsed.error.issues[0]?.message}`);
      const w = await this.prisma.workflowDef.create({ data: { ...this.dbData(parsed.data), orgId: me.orgId, createdById: rule.createdById ?? me.id, templateKey: rule.templateKey ? `auto:${rule.templateKey}` : null, movedFromRuleId: rule.id, watermark: rule.watermark, runCount: rule.runCount, lastRunAt: rule.lastRunAt } });
      const v = await this.saveVersion(me, w, parsed.data);
      // Records the rule already handled are marked as done, so the workflow never repeats them.
      const old = await this.prisma.automationRun.findMany({ where: { ruleId: rule.id }, select: { entity: true, entityId: true, dedupeKey: true, status: true, at: true, detail: true } });
      const program = compileWorkflow(parsed.data.steps);
      for (let i = 0; i < old.length; i += 500) {
        await this.prisma.workflowRun.createMany({
          skipDuplicates: true,
          data: old.slice(i, i + 500).map((o) => {
            const det = (o.detail ?? {}) as AutomationRunDetail;
            return {
              orgId: me.orgId,
              workflowId: w.id,
              versionId: v.id,
              entity: o.entity,
              entityId: o.entityId,
              dedupeKey: o.dedupeKey,
              record: (det.record ?? `${o.entity} ${o.entityId}`).slice(0, 300),
              link: det.link ?? null,
              status: o.status === 'failed' ? 'failed' : 'done',
              pc: program.length,
              meta: { imported: 'true', summary: (det.summary ?? '').slice(0, 300) },
              startedAt: o.at,
              finishedAt: o.at,
            };
          }),
        });
      }
      await this.prisma.automationRule.update({ where: { id: rule.id }, data: { enabled: false, movedToWorkflowId: w.id } });
      await this.audit.log(me, 'automation.moved_to_workflow', 'AutomationRule', rule.id, { enabled: rule.enabled }, { workflowId: w.id, importedRuns: old.length }, ip);
      moved.push({ ruleId: rule.id, ruleName: rule.name, workflowId: w.id, importedRuns: old.length });
    }
    return { moved };
  }
}
