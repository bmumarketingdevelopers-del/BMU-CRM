// v11 core: tasks end to end (spec actions.tasks_work). Create from anywhere with the scope rules, edit, status
// (blocked details, subtasks, dependencies, done → QC), deadline change (producers request), duplicate, archive /
// restore, hand back ("Can't take this"), out-of-scope drafts, bulk actions, flow templates and recurring tasks.
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  addWorkingDays,
  CORE_TASK_EDIT_KEYS,
  coreReassignReasonLabels,
  coreRepeatRuleLabels,
  coreTaskCreateSchema,
  coreTaskDraftSchema,
  craftSpecialtyForStep,
  flowStepSchema,
  istDate,
  taskStatusLabels,
  type CoreRecurrence,
  type CoreTaskBulk,
  type CoreTaskCan,
  type CoreTaskDetail,
  type CoreTaskEdit,
  type CoreTaskFormOptions,
  type CoreTaskMutation,
  type CoreTaskQuery,
  type CoreTaskRow,
  type CoreTemplatePreview,
  type CoreTemplatePreviewInput,
  type CoreUndo,
  type FlowStep,
  type Me,
  type TaskStatus,
} from '@bmu/shared';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../../audit/audit.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { calendarFor } from '../../production/generate.js';
import { ApprovalsService } from '../approvals.service.js';
import { DAY_MS, dbDay, hasRole, isLeader, OPEN_TASK, parseDue, PeopleDirectory, ymd } from '../people.js';
import { ReassignService } from '../reassign.service.js';
import { podDefaultAssignee } from '../../people-actions/pod-defaults.js';
import { RecordsService } from '../records.service.js';
import { ActionsRegistry, type UndoRow } from '../registry.js';
import { UndoService } from '../undo.service.js';
import { TaskAccess, taskDetailInclude, type TaskFull } from './task-access.js';
import { TASK_TEAM_ROLES, TaskTargets } from './task-targets.js';

const fmt = new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
const short = (d: Date | null | undefined) => (d ? fmt.format(d) : 'no deadline');
const isOpen = (s: string) => (OPEN_TASK as readonly string[]).includes(s);
const gateNo = (g: string | null | undefined) => Number(/^G(\d)/.exec(g ?? '')?.[1] ?? 0);
const ADDON_OK = ['approved', 'paid', 'in_progress', 'done'];
const MANAGER_ROLES = ['founder', 'admin', 'am_lead', 'department_head', 'account_manager', 'strategist'];

type Ctx = { me: Me; leader: boolean; dept: string | null; am: Set<string>; strat: Set<string> };
type DraftInput = z.infer<typeof coreTaskDraftSchema>;

@Injectable()
export class TasksActionsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly access: TaskAccess,
    private readonly targets: TaskTargets,
    private readonly engine: ReassignService,
    private readonly approvals: ApprovalsService,
    private readonly undo: UndoService,
    private readonly records: RecordsService,
    private readonly registry: ActionsRegistry,
    private readonly people: PeopleDirectory,
  ) {}

  onModuleInit() {
    this.records.visibility.set('task', async (me, id) => {
      await this.access.load(me, id);
    });
    this.registry.registerApprovalHandler({
      action: 'task.assign_new',
      label: 'Assign a new task',
      href: (r) => `/team/tasks/${r.targetId}`,
      apply: async ({ approver, req }) => {
        const p = req.payload as { ownerId: string };
        const t = await this.prisma.task.findFirst({ where: { id: req.targetId, orgId: approver.orgId } });
        if (!t) throw new NotFoundException('Task not found');
        if (t.ownerId) throw new BadRequestException('Someone already took this task');
        await this.prisma.task.update({ where: { id: t.id }, data: { ownerId: p.ownerId } });
        await this.engine.record(approver, 'task', [{ id: t.id, fromUserId: null, toUserId: p.ownerId }], 'new_task', 'Approved by the Department Head');
        await this.audit.log(approver, 'task.assigned', 'Task', t.id, { ownerId: null }, { ownerId: p.ownerId, approvalId: req.id }, undefined);
        await this.notifications.notify(approver.orgId, [p.ownerId], { kind: 'task_assigned', title: `New task for you: ${t.title}`, body: t.deadline ? `Due ${short(t.deadline)}` : undefined, link: `/team/tasks/${t.id}` });
        return { taskId: t.id };
      },
    });
    this.registry.registerApprovalHandler({
      action: 'task.deadline_change',
      label: 'Deadline change request',
      href: (r) => `/team/tasks/${r.targetId}`,
      apply: async ({ approver, req }) => {
        const p = req.payload as { deadline: string; reason: string };
        const t = await this.access.load(approver, req.targetId);
        return this.applyDeadline(approver, t, parseDue(p.deadline), `${p.reason} (requested)`);
      },
    });
    this.registry.registerApprovalHandler({
      action: 'task.handback',
      label: "Can't take this task",
      approveNeeds: 'assignee',
      href: (r) => `/team/tasks/${r.targetId}`,
      apply: async ({ approver, req, input }) => {
        const toUserId = typeof input?.toUserId === 'string' ? input.toUserId : null;
        if (!toUserId) throw new BadRequestException('Pick who takes the task instead');
        const requester = await this.prisma.user.findUnique({ where: { id: req.requestedById }, select: { name: true } });
        return this.engine.run(approver, 'task', { ids: [req.targetId], toUserId, reason: 'other', note: `Handed back by ${requester?.name ?? 'the owner'}: ${req.reason ?? ''}`.trim(), handoverNote: req.reason ?? 'Handed back', deadline: { mode: 'keep' } }, { approved: true, approvalId: req.id });
      },
      onReject: async ({ approver, req }) => {
        await this.audit.log(approver, 'task.handback_rejected', 'Task', req.targetId, null, { approvalId: req.id }, undefined);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Access context (computed once per request)

  private async ctx(me: Me): Promise<Ctx> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const leader = isLeader(me);
    const [dept, am, strat] = await Promise.all([
      this.access.myDepartment(me),
      hasRole(me, 'account_manager') && !leader ? this.access.amEngagements(me) : Promise.resolve([]),
      hasRole(me, 'strategist') && !leader ? this.access.strategistEngagements(me) : Promise.resolve([]),
    ]);
    return { me, leader, dept, am: new Set(am), strat: new Set(strat) };
  }

  private engId(t: { engagementId: string | null; deliverable?: { cycle: { engagementId: string } } | null }) {
    return t.deliverable?.cycle.engagementId ?? t.engagementId;
  }

  private manageDenied(c: Ctx, t: TaskFull, eng: { id: string; amId: string | null } | null): string | null {
    const { me } = c;
    if (c.leader) return null;
    if (t.isInternal && t.createdById === me.id && hasRole(me, 'department_head', 'account_manager', 'strategist')) return null;
    if (hasRole(me, 'department_head') && c.dept && (t.departmentId === c.dept || t.owner?.departmentId === c.dept || t.deliverable?.departmentId === c.dept)) return null;
    if (hasRole(me, 'account_manager') && eng && (eng.amId === me.id || c.am.has(eng.id))) return null;
    if (hasRole(me, 'strategist') && eng && c.strat.has(eng.id)) return null;
    if (hasRole(me, 'department_head', 'account_manager', 'strategist')) return eng ? "This task belongs to another manager's client" : 'This task is outside your department';
    return 'Only a department head, the client manager or the strategist can do this';
  }

  private can(c: Ctx, t: TaskFull, eng: { id: string; amId: string | null } | null, openSubtasks: number): CoreTaskCan {
    const { me } = c;
    const denied = this.manageDenied(c, t, eng);
    const manage = !denied;
    const mine = t.ownerId === me.id;
    const open = isOpen(t.status) && !t.archivedAt && !t.isDraft;
    const blocked: CoreTaskCan['blocked'] = {};
    if (!open && !t.archivedAt) blocked.reassign = t.isDraft ? 'Drafts are assigned when they are activated' : 'Finished tasks can’t be reassigned';
    if (openSubtasks > 0 && open) blocked.status = `${openSubtasks} subtask${openSubtasks > 1 ? 's are' : ' is'} still open, so this can’t be marked done yet`;
    return {
      edit: manage || mine,
      reassign: manage && open && hasRole(me, ...MANAGER_ROLES),
      deadline: open ? (manage && hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'account_manager', 'strategist') ? 'change' : mine ? 'request' : null) : null,
      status: open && (mine || (manage && hasRole(me, 'founder', 'admin', 'am_lead', 'department_head'))),
      duplicate: manage && hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'account_manager', 'strategist'),
      archive: manage && !t.archivedAt && hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'account_manager'),
      restore: manage && !!t.archivedAt && hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'account_manager'),
      handback: open && mine && !manage,
      addSubtask: open && (manage || mine),
      blocked,
    };
  }

  // -------------------------------------------------------------------------
  // Views

  private async rows(c: Ctx, tasks: TaskFull[]): Promise<CoreTaskRow[]> {
    const ids = tasks.map((t) => t.id);
    const depIds = [...new Set(tasks.flatMap((t) => t.dependsOn))];
    const engIds = [...new Set(tasks.filter((t) => !t.deliverable && t.engagementId).map((t) => t.engagementId!))];
    const deptIds = [...new Set(tasks.map((t) => t.departmentId ?? t.deliverable?.departmentId).filter((x): x is string => !!x))];
    const [deps, subs, engs, depts, tags] = await Promise.all([
      depIds.length ? this.prisma.task.findMany({ where: { id: { in: depIds } }, select: { id: true, status: true, title: true } }) : [],
      ids.length ? this.prisma.task.groupBy({ by: ['parentId', 'status'], where: { parentId: { in: ids }, archivedAt: null, isDraft: false }, _count: true }) : [],
      engIds.length ? this.prisma.engagement.findMany({ where: { id: { in: engIds } }, select: { id: true, amId: true, clientOrg: { select: { id: true, name: true } } } }) : [],
      deptIds.length ? this.prisma.department.findMany({ where: { id: { in: deptIds } }, select: { id: true, name: true } }) : [],
      this.records.tagsFor(c.me.orgId, 'task', ids),
    ]);
    const now = Date.now();
    return tasks.map((t) => {
      const eng = t.deliverable?.cycle.engagement ?? engs.find((e) => e.id === t.engagementId) ?? null;
      const mySubs = subs.filter((s) => s.parentId === t.id);
      const openSubs = mySubs.filter((s) => isOpen(s.status)).reduce((s, x) => s + x._count, 0);
      const waitingOn = t.dependsOn.map((id) => deps.find((d) => d.id === id)).filter((d) => d && d.status !== 'done').map((d) => d!.title);
      const deptId = t.departmentId ?? t.deliverable?.departmentId ?? null;
      return {
        id: t.id,
        title: t.title,
        kind: t.kind as CoreTaskRow['kind'],
        status: t.status,
        flowStep: t.flowStep,
        role: t.role,
        owner: t.owner ? { id: t.owner.id, name: t.owner.name } : null,
        deadline: t.deadline?.toISOString() ?? null,
        overdue: !!t.deadline && t.deadline.getTime() < now && isOpen(t.status) && !t.archivedAt,
        blockedReason: t.blockedReason,
        timeLoggedMin: t.timeLoggedMin,
        dependsOn: t.dependsOn,
        ready: waitingOn.length === 0,
        deliverable: t.deliverable ? { id: t.deliverable.id, title: t.deliverable.title, type: t.deliverable.type, status: t.deliverable.status } : null,
        client: eng?.clientOrg ? { id: eng.clientOrg.id, name: eng.clientOrg.name } : null,
        engagementId: this.engId(t),
        priority: t.priority,
        departmentId: deptId,
        department: depts.find((d) => d.id === deptId)?.name ?? null,
        archivedAt: t.archivedAt?.toISOString() ?? null,
        archivedReason: t.archivedReason,
        isDraft: t.isDraft,
        draftReason: t.draftReason,
        isInternal: t.isInternal,
        parentId: t.parentId,
        subtaskCount: mySubs.reduce((s, x) => s + x._count, 0),
        subtasksOpen: openSubs,
        waitingOn,
        tags: tags.get(t.id) ?? [],
        can: this.can(c, t, eng ? { id: eng.id, amId: eng.amId } : null, openSubs),
      };
    });
  }

  async query(me: Me, q: CoreTaskQuery): Promise<CoreTaskRow[]> {
    const c = await this.ctx(me);
    const and: Prisma.TaskWhereInput[] = [q.scope === 'mine' ? { orgId: me.orgId, ownerId: me.id } : await this.access.visibleWhere(me)];
    if (q.archived === '1') and.push({ archivedAt: { not: null } });
    else if (q.drafts === '1') and.push({ isDraft: true, archivedAt: null });
    else if (q.completed === '1') and.push({ archivedAt: null, isDraft: false, status: 'done' });
    else {
      and.push({ archivedAt: null, isDraft: false });
      and.push({ OR: [{ status: { notIn: ['done', 'cancelled'] } }, { completedAt: { gte: new Date(Date.now() - 30 * DAY_MS) } }] });
    }
    if (q.q?.trim()) and.push({ title: { contains: q.q.trim(), mode: 'insensitive' } });
    if (q.ownerId) and.push(q.ownerId === 'none' ? { ownerId: null } : { ownerId: q.ownerId });
    if (q.departmentId) and.push({ OR: [{ departmentId: q.departmentId }, { deliverable: { departmentId: q.departmentId } }] });
    if (q.clientId) and.push(q.clientId === 'internal' ? { isInternal: true } : { OR: [{ deliverable: { cycle: { engagement: { clientOrgId: q.clientId } } } }, { engagementId: { in: (await this.prisma.engagement.findMany({ where: { clientOrgId: q.clientId }, select: { id: true } })).map((e) => e.id) } }] });
    if (q.status) and.push(q.status === 'overdue' ? { status: { in: [...OPEN_TASK] }, deadline: { lt: new Date() } } : { status: q.status as TaskStatus });
    if (q.from) and.push({ deadline: { gte: new Date(`${q.from}T00:00:00+05:30`) } });
    if (q.to) and.push({ deadline: { lt: new Date(new Date(`${q.to}T00:00:00+05:30`).getTime() + DAY_MS) } });
    if (q.tag) and.push({ id: { in: (await this.prisma.tagLink.findMany({ where: { orgId: me.orgId, targetType: 'task', tag: { name: q.tag } }, select: { targetId: true } })).map((l) => l.targetId) } });
    // Completed: most recently finished first. Otherwise by deadline.
    const orderBy: Prisma.TaskOrderByWithRelationInput[] = q.completed === '1' ? [{ completedAt: { sort: 'desc', nulls: 'last' } }] : [{ deadline: { sort: 'asc', nulls: 'last' } }, { sort: 'asc' }];
    const rows = await this.prisma.task.findMany({ where: { AND: and }, include: taskDetailInclude, orderBy, take: 500 });
    return this.rows(c, rows);
  }

  async get(me: Me, id: string): Promise<CoreTaskDetail> {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    const [row] = await this.rows(c, [t]);
    const [eng, subtasks, deps, dependents, watchers, assignments, pending, parent, responsible, createdBy] = await Promise.all([
      this.access.engagementOf(t),
      this.prisma.task.findMany({ where: { parentId: t.id, archivedAt: null }, include: taskDetailInclude, orderBy: [{ createdAt: 'asc' }] }),
      t.dependsOn.length ? this.prisma.task.findMany({ where: { id: { in: t.dependsOn } }, select: { id: true, title: true, status: true } }) : [],
      this.prisma.task.findMany({ where: { dependsOn: { has: t.id }, archivedAt: null }, select: { id: true, title: true, status: true } }),
      this.records.watchers(me, 'task', t.id),
      this.prisma.assignment.findMany({ where: { orgId: me.orgId, targetType: { in: ['task', 'qc'] }, targetId: t.id }, orderBy: { at: 'desc' }, take: 30 }),
      this.prisma.approvalRequest.findMany({ where: { orgId: me.orgId, targetId: t.id, status: 'pending' } }),
      t.parentId ? this.prisma.task.findUnique({ where: { id: t.parentId }, select: { id: true, title: true } }) : null,
      t.blockedResponsibleId ? this.prisma.user.findUnique({ where: { id: t.blockedResponsibleId }, select: { name: true } }) : null,
      t.createdById ? this.prisma.user.findUnique({ where: { id: t.createdById }, select: { name: true } }) : null,
    ]);
    const names = await this.people.names(assignments.flatMap((a) => [a.fromUserId, a.toUserId, a.byId]));
    return {
      ...row,
      description: t.description,
      brief: t.brief,
      references: t.references,
      checklist: (t.checklist as { id: string; label: string; done: boolean }[]) ?? [],
      estimateHours: t.estimateMin ? Math.round((t.estimateMin / 60) * 100) / 100 : null,
      preProduction: t.preProduction,
      outOfScope: t.outOfScope,
      addOnRequestId: t.addOnRequestId,
      engagement: eng ? { id: eng.id, client: eng.clientOrg.name, service: eng.service.name, gate: eng.currentGate } : null,
      parent,
      subtasks: await this.rows(c, subtasks),
      dependencies: deps.map((d) => ({ id: d.id, title: d.title, status: d.status })),
      dependents: dependents.map((d) => ({ id: d.id, title: d.title, status: d.status })),
      watchers: watchers.people,
      blocked: t.status === 'blocked' ? { reason: t.blockedReason, waitingFor: t.blockedWaitingFor, responsible: responsible?.name ?? null, expectedAt: t.blockedExpectedAt ? istDate(t.blockedExpectedAt) : null, since: t.blockedAt?.toISOString() ?? null } : null,
      assignments: assignments.map((a) => ({ id: a.id, at: a.at.toISOString(), from: a.fromUserId ? (names.get(a.fromUserId) ?? null) : null, to: a.toUserId ? (names.get(a.toUserId) ?? null) : null, by: names.get(a.byId) ?? '', reason: coreReassignReasonLabels[a.reason as keyof typeof coreReassignReasonLabels] ?? ({ new_task: 'New task', cover: 'Leave cover', template: 'From a template' } as Record<string, string>)[a.reason] ?? a.reason.replace(/_/g, ' '), note: a.note, handoverNote: a.handoverNote })),
      pendingApprovals: pending.map((p) => ({ id: p.id, action: p.action, summary: p.summary, status: p.status })),
      createdBy: createdBy?.name ?? null,
      createdAt: t.createdAt.toISOString(),
    };
  }

  private async mutation(me: Me, id: string, undo: CoreUndo | null, message?: string, approval?: { id: string; summary: string } | null): Promise<CoreTaskMutation> {
    return { task: await this.get(me, id), undo, message, approval: approval ?? null };
  }

  // -------------------------------------------------------------------------
  // Form options

  async formOptions(me: Me, engagementId?: string): Promise<CoreTaskFormOptions> {
    const c = await this.ctx(me);
    const manager = hasRole(me, ...MANAGER_ROLES);
    const live = ['onboarding', 'blocked', 'planning', 'awaiting_plan_approval', 'in_production', 'in_review', 'awaiting_final_payment', 'active_retainer', 'paused'] as const;
    const engWhere: Prisma.EngagementWhereInput = { orgId: me.orgId, deletedAt: null, archivedAt: null, status: { in: [...live] } };
    if (!c.leader && !hasRole(me, 'department_head')) {
      const ids = [...c.am, ...c.strat];
      engWhere.OR = [{ amId: me.id }, { id: { in: ids } }];
      if (!manager) engWhere.OR.push({ id: { in: (await this.prisma.task.findMany({ where: { ownerId: me.id, engagementId: { not: null } }, select: { engagementId: true }, distinct: ['engagementId'] })).map((t) => t.engagementId!) } });
    }
    if (engagementId) engWhere.OR = [...(engWhere.OR ?? [{}]), { id: engagementId }];
    const [engs, depts, templates, people, self] = await Promise.all([
      this.prisma.engagement.findMany({ where: engWhere, include: { clientOrg: { select: { id: true, name: true } }, service: { select: { name: true } }, cycles: { select: { deliverables: { where: { archivedAt: null }, select: { id: true, title: true, departmentId: true } } }, orderBy: { createdAt: 'desc' }, take: 2 } }, orderBy: [{ clientOrg: { name: 'asc' } }], take: 300 }),
      this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.flowTemplate.findMany({ where: { orgId: me.orgId, active: true }, include: { department: { select: { name: true } } }, orderBy: [{ name: 'asc' }, { version: 'desc' }] }),
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: 'active', roles: { some: { role: { baseRole: { in: TASK_TEAM_ROLES } } } } }, include: { roles: { include: { role: { select: { baseRole: true } } } } }, orderBy: { name: 'asc' } }),
      this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } }),
    ]);
    // Visibility already checked above; filter engagements by engagementId param only if visible.
    const visibleEngs = engagementId && !c.leader && !hasRole(me, 'department_head') && !c.am.has(engagementId) && !c.strat.has(engagementId) ? engs.filter((e) => e.id !== engagementId || e.amId === me.id) : engs;
    const addOns = await this.prisma.request.findMany({ where: { engagementId: { in: visibleEngs.map((e) => e.id) }, type: 'new_scope', status: { in: ADDON_OK as never[] } }, select: { id: true, engagementId: true, description: true } });
    const latest = templates.filter((t, i) => templates.findIndex((x) => x.departmentId === t.departmentId && x.name === t.name) === i);
    const pods = await this.prisma.clientPod.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { clientIds: true, producerIds: true, strategistUserId: true, amUserId: true } });
    return {
      engagements: visibleEngs.map((e) => ({
        id: e.id,
        client: e.clientOrg.name,
        clientId: e.clientOrg.id,
        service: e.service.name,
        gate: e.currentGate,
        productionOpen: gateNo(e.currentGate) >= 3,
        amId: e.amId,
        departmentIds: [...new Set(e.cycles.flatMap((cy) => cy.deliverables.map((d) => d.departmentId)).filter((x): x is string => !!x))],
        podMemberIds: ((p) => (p ? [...p.producerIds, p.strategistUserId, p.amUserId].filter((x): x is string => !!x) : undefined))(pods.find((p) => p.clientIds.includes(e.clientOrg.id))),
      })),
      departments: depts,
      deliverables: visibleEngs.flatMap((e) => e.cycles.flatMap((cy) => cy.deliverables.map((d) => ({ id: d.id, title: d.title, engagementId: e.id })))),
      addOnRequests: addOns.map((a) => ({ id: a.id, engagementId: a.engagementId, description: a.description.slice(0, 120) })),
      templates: latest.map((t) => ({ id: t.id, name: t.name, department: t.department.name, steps: Array.isArray(t.steps) ? t.steps.length : 0 })),
      people: people.map((p) => ({ id: p.id, name: p.name, departmentId: p.departmentId, roles: p.roles.map((r) => r.role.baseRole) })),
      canAssignOthers: manager,
      me: { id: me.id, name: me.name, departmentId: self?.departmentId ?? null },
    };
  }

  // -------------------------------------------------------------------------
  // Create

  private async checkEngagement(c: Ctx, engagementId: string, preProduction: boolean) {
    const e = await this.prisma.engagement.findFirst({ where: { id: engagementId, orgId: c.me.orgId, deletedAt: null }, include: { clientOrg: { select: { id: true, name: true } } } });
    if (!e) throw new NotFoundException('Engagement not found');
    if (e.archivedAt) throw new BadRequestException('That engagement is archived');
    const me = c.me;
    if (!c.leader && !hasRole(me, 'department_head')) {
      const mine = e.amId === me.id || c.am.has(e.id) || c.strat.has(e.id);
      if (hasRole(me, 'account_manager', 'strategist') && !mine) throw new ForbiddenException("You can only add tasks to your own clients' work");
      if (!hasRole(me, ...MANAGER_ROLES) && !mine) {
        const works = await this.prisma.task.count({ where: { ownerId: me.id, engagementId: e.id } });
        if (!works) throw new ForbiddenException('You can only add tasks to clients you work on');
      }
    }
    if (gateNo(e.currentGate) < 3 && !preProduction) throw new BadRequestException(`${e.clientOrg.name} is at ${e.currentGate}. Client tasks need Gate 3 (tasks assigned) or later, or tick "Pre-production" for planning or onboarding work.`);
    return e;
  }

  async create(me: Me, body: unknown, ip?: string): Promise<CoreTaskMutation> {
    const isDraft = !!(body && typeof body === 'object' && (body as { draft?: boolean }).draft);
    const parsed = (isDraft ? coreTaskDraftSchema : coreTaskCreateSchema).safeParse(body);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues[0]?.message ?? 'Check the form');
    const input = parsed.data as DraftInput & { references: string[]; checklist: { id: string; label: string; done: boolean }[]; subtasks: { title: string; ownerId?: string; deadline?: string }[]; dependsOn: string[]; watcherIds: string[]; attachmentIds: string[] };
    const c = await this.ctx(me);
    const manager = hasRole(me, ...MANAGER_ROLES);

    // Parent (subtask): visible, and the subtask inherits the client / department.
    let parent: TaskFull | null = null;
    if (input.parentId) {
      parent = await this.access.load(me, input.parentId);
      if (!isOpen(parent.status) || parent.archivedAt) throw new BadRequestException('You can only add subtasks to an open task');
      const eng = await this.access.engagementOf(parent);
      if (parent.ownerId !== me.id && this.manageDenied(c, parent, eng)) throw new ForbiddenException('Only the task owner or a manager can add subtasks');
      input.engagementId = input.engagementId ?? this.engId(parent);
      input.internal = input.internal ?? parent.isInternal;
      input.departmentId = input.departmentId || parent.departmentId || parent.deliverable?.departmentId || undefined;
      input.preProduction = input.preProduction || parent.preProduction;
      input.deliverableId = input.deliverableId ?? parent.deliverableId;
    }

    // Producers: only for themselves (or subtasks of their own work).
    let ownerId = input.ownerId || (isDraft ? null : me.id);
    if (!manager && ownerId && ownerId !== me.id) throw new ForbiddenException('Producers can add tasks only for themselves. Ask your department head, client manager or strategist to assign work to someone else.');

    let engagement: Awaited<ReturnType<TasksActionsService['checkEngagement']>> | null = null;
    if (input.engagementId && !input.internal) engagement = await this.checkEngagement(c, input.engagementId, !!input.preProduction || isDraft);
    else if (!input.internal && !isDraft) throw new BadRequestException('Pick the client engagement, or mark the task Internal');

    let departmentId = input.departmentId || null;
    if (departmentId && !(await this.prisma.department.findFirst({ where: { id: departmentId, orgId: me.orgId, deletedAt: null } }))) throw new BadRequestException('Pick a department');
    if (!c.leader && hasRole(me, 'department_head') && !hasRole(me, 'account_manager', 'strategist') && departmentId && departmentId !== c.dept && !input.parentId) throw new ForbiddenException('Department heads add tasks for their own department');
    if (!departmentId && !isDraft) throw new BadRequestException('Pick a department');
    // v11 people: a client in a client pod gets new tasks assigned to a pod member when nobody was picked.
    if (!input.ownerId && manager && engagement && !isDraft) ownerId = (await podDefaultAssignee(this.prisma, me.orgId, engagement.clientOrg.id, departmentId)) ?? ownerId;

    let deliverable: { id: string; departmentId: string | null; cycle: { engagementId: string } } | null = null;
    if (input.deliverableId) {
      deliverable = await this.prisma.deliverable.findFirst({ where: { id: input.deliverableId, orgId: me.orgId }, select: { id: true, departmentId: true, cycle: { select: { engagementId: true } } } });
      if (!deliverable) throw new NotFoundException('Deliverable not found');
      if (engagement && deliverable.cycle.engagementId !== engagement.id) throw new BadRequestException('That deliverable belongs to a different engagement');
      departmentId = departmentId ?? deliverable.departmentId;
    }

    // Out of scope: needs an approved add-on request, otherwise it is saved as a draft and the CM is alerted.
    let draftReason: string | null = isDraft ? 'author' : null;
    if (input.outOfScope && engagement) {
      const ok = input.addOnRequestId ? await this.prisma.request.findFirst({ where: { id: input.addOnRequestId, engagementId: engagement.id, type: 'new_scope', status: { in: ADDON_OK as never[] } } }) : null;
      if (input.addOnRequestId && !ok) throw new BadRequestException('That add-on request is not approved for this client yet');
      if (!ok) draftReason = 'out_of_scope';
    }

    const deadline = input.deadline ? parseDue(input.deadline) : null;
    if (deadline && Number.isNaN(deadline.getTime())) throw new BadRequestException('Pick a valid deadline');
    const estimateMin = input.estimateHours ? Math.round(input.estimateHours * 60) : null;

    // Dependencies must be tasks you can see.
    for (const d of input.dependsOn ?? []) await this.access.load(me, d);

    // Leave / capacity rules for the assignee (same as the reassignment engine).
    let assess: Awaited<ReturnType<ReassignService['assessNew']>> | null = null;
    if (ownerId && !draftReason) {
      assess = await this.engine.assessNew(me, { toUserId: ownerId, deadline, hours: estimateMin ? estimateMin / 60 : 4, departmentId, overrideLeave: input.overrideLeave });
      if (assess.blocked) throw new BadRequestException(assess.blocked);
    }
    if (input.repeat && !draftReason) {
      if (!hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'account_manager')) throw new ForbiddenException('Only a department head or client manager can set up recurring tasks');
      return this.createRecurring(me, input as Required<Pick<DraftInput, 'title'>> & DraftInput, { ownerId: assess?.approval ? null : ownerId, departmentId, engagementId: engagement?.id ?? null, deadline, estimateMin }, ip);
    }
    const holdOwner = assess?.approval ? null : ownerId;

    const created = await this.prisma.task.create({
      data: {
        orgId: me.orgId,
        title: input.title,
        engagementId: engagement?.id ?? null,
        deliverableId: deliverable?.id ?? null,
        parentId: parent?.id ?? null,
        ownerId: holdOwner,
        departmentId,
        deadline,
        priority: input.priority ?? 'normal',
        specialty: input.specialty ?? null,
        kind: 'work',
        status: draftReason ? 'cancelled' : 'todo',
        isDraft: !!draftReason,
        draftReason,
        sort: 900,
        description: input.description || null,
        brief: input.brief || null,
        references: (input.references ?? []).filter(Boolean),
        checklist: input.checklist ?? [],
        estimateMin,
        isInternal: !!input.internal,
        preProduction: !!input.preProduction,
        outOfScope: !!input.outOfScope,
        addOnRequestId: input.addOnRequestId ?? null,
        dependsOn: input.dependsOn ?? [],
        createdById: me.id,
      },
    });
    await this.audit.log(me, draftReason ? 'task.drafted' : 'task.created', 'Task', created.id, undefined, { title: created.title, ownerId: holdOwner, engagementId: created.engagementId, deadline, priority: created.priority, internal: created.isInternal, draftReason, source: input.source ?? null, parentId: created.parentId }, ip);
    if (holdOwner && !draftReason) await this.engine.record(me, 'task', [{ id: created.id, fromUserId: null, toUserId: holdOwner }], 'new_task');

    // Subtasks, watchers, attachments.
    for (const s of input.subtasks ?? []) {
      const sOwner = s.ownerId && manager ? s.ownerId : (holdOwner ?? me.id);
      await this.prisma.task.create({ data: { orgId: me.orgId, title: s.title, parentId: created.id, engagementId: created.engagementId, deliverableId: created.deliverableId, ownerId: draftReason ? sOwner : sOwner, departmentId, deadline: s.deadline ? parseDue(s.deadline) : deadline, priority: created.priority, kind: 'work', status: draftReason ? 'cancelled' : 'todo', isDraft: !!draftReason, draftReason, isInternal: created.isInternal, preProduction: created.preProduction, createdById: me.id, sort: 901 } });
    }
    const watchers = [...new Set([...(input.watcherIds ?? [])])];
    if (watchers.length) await this.records.watch(me, 'task', created.id, watchers);
    if (input.attachmentIds?.length) {
      const files = await this.prisma.file.findMany({ where: { id: { in: input.attachmentIds }, orgId: me.orgId }, select: { id: true, name: true } });
      if (files.length) await this.prisma.task.update({ where: { id: created.id }, data: { references: [...created.references, ...files.map((f) => `file:${f.id}:${f.name ?? 'file'}`)] } });
    }
    if (input.source) await this.audit.log(me, 'task.created_from', input.source.type === 'message' ? 'Message' : 'Comment', input.source.id, null, { taskId: created.id, title: created.title }, ip);

    // Notifications: assignee and watchers; out-of-scope → CM.
    let message = draftReason === 'out_of_scope' ? 'Saved as a draft: it adds work beyond the agreed scope. The client manager has been told to raise an add-on request.' : draftReason ? 'Saved as a draft' : 'Task added';
    let approval: { id: string; summary: string } | null = null;
    if (draftReason === 'out_of_scope' && engagement) {
      await this.notifications.notify(me.orgId, [engagement.amId].filter((x) => x !== me.id), { kind: 'task_out_of_scope', title: `Out-of-scope task needs an add-on: ${created.title}`, body: `${me.name} added work beyond ${engagement.clientOrg.name}'s scope. It stays a draft until an add-on request is approved by the client.`, link: `/team/tasks/${created.id}`, critical: true });
    }
    if (!draftReason) {
      if (assess?.approval && ownerId) {
        const req = await this.approvals.create(me, { action: 'task.assign_new', targetType: 'task', targetId: created.id, summary: `Assign new task "${created.title}" to ${assess.person.name}`, payload: { ownerId }, reason: assess.approval.why, approverId: assess.approval.approverId, diff: [{ field: 'Owner', before: 'Unassigned', after: assess.person.name }] }, ip);
        approval = { id: req.id, summary: req.summary };
        message = `Task added. Assigning it to ${assess.person.name} needs Department Head approval: ${assess.approval.why}.`;
      } else if (holdOwner && holdOwner !== me.id) {
        await this.notifications.notify(me.orgId, [holdOwner], { kind: 'task_assigned', title: `${me.name} assigned you: ${created.title}`, body: [engagement?.clientOrg.name ?? (created.isInternal ? 'Internal' : null), deadline ? `Due ${short(deadline)}` : null].filter(Boolean).join(' · ') || undefined, link: `/team/tasks/${created.id}` });
      }
      if (assess?.warning) message = `${message}. ${assess.warning}`;
      const notifyWatchers = watchers.filter((w) => w !== me.id && w !== holdOwner);
      if (notifyWatchers.length) await this.notifications.notify(me.orgId, notifyWatchers, { kind: 'task_watch', title: `You are watching: ${created.title}`, body: `Added by ${me.name}`, link: `/team/tasks/${created.id}` });
    }
    return this.mutation(me, created.id, null, message, approval);
  }

  /** Turns an out-of-scope or author draft into an active task (out of scope needs an approved add-on). */
  async activate(me: Me, id: string, addOnRequestId: string | undefined, ip?: string): Promise<CoreTaskMutation> {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    if (!t.isDraft) throw new BadRequestException('This task is already active');
    const eng = await this.access.engagementOf(t);
    if (t.createdById !== me.id && this.manageDenied(c, t, eng)) throw new ForbiddenException('Only the author or a manager can activate this draft');
    if (t.outOfScope && eng) {
      const ok = addOnRequestId ? await this.prisma.request.findFirst({ where: { id: addOnRequestId, engagementId: eng.id, type: 'new_scope', status: { in: ADDON_OK as never[] } } }) : null;
      if (!ok) throw new BadRequestException('Out-of-scope work can’t go active until the client approves an add-on request. Link the approved add-on.');
    }
    if (!t.title || !t.departmentId || !t.deadline || !t.ownerId) throw new BadRequestException('Fill in the department, owner and deadline before activating');
    if (!t.isInternal && eng && gateNo(eng.currentGate) < 3 && !t.preProduction) throw new BadRequestException(`${eng.clientOrg.name} is at ${eng.currentGate}. Client tasks need Gate 3 or later, or "Pre-production".`);
    await this.prisma.task.updateMany({ where: { OR: [{ id: t.id }, { parentId: t.id, isDraft: true }] }, data: { isDraft: false, draftReason: null, status: 'todo', addOnRequestId: addOnRequestId ?? t.addOnRequestId } });
    await this.audit.log(me, 'task.activated', 'Task', t.id, { isDraft: true, draftReason: t.draftReason }, { isDraft: false, addOnRequestId: addOnRequestId ?? null }, ip);
    if (t.ownerId !== me.id) await this.notifications.notify(me.orgId, [t.ownerId], { kind: 'task_assigned', title: `New task for you: ${t.title}`, body: `Due ${short(t.deadline)}`, link: `/team/tasks/${t.id}` });
    return this.mutation(me, t.id, null, 'Task is now active');
  }

  // -------------------------------------------------------------------------
  // Edit

  async edit(me: Me, id: string, input: CoreTaskEdit, ip?: string): Promise<CoreTaskMutation> {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    const eng = await this.access.engagementOf(t);
    const denied = this.manageDenied(c, t, eng);
    const ownerOnly: (keyof CoreTaskEdit)[] = ['description', 'brief', 'references', 'checklist', 'estimateHours'];
    const keys = (Object.keys(input) as (keyof CoreTaskEdit)[]).filter((k) => input[k] !== undefined);
    if (!keys.length) throw new BadRequestException('Nothing to change');
    if (denied) {
      if (t.ownerId !== me.id) throw new ForbiddenException(denied);
      const extra = keys.filter((k) => !ownerOnly.includes(k));
      if (extra.length) throw new ForbiddenException('As the owner you can change the description, brief, references, checklist and estimate. Ask a manager for the rest.');
    }
    if (t.archivedAt) throw new BadRequestException('Restore the task before editing it');
    const data: Prisma.TaskUncheckedUpdateInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const set = (field: string, value: unknown, current: unknown) => {
      if (JSON.stringify(value) === JSON.stringify(current)) return;
      (data as Record<string, unknown>)[field] = value;
      before[field] = current;
      after[field] = value;
    };
    if (input.title !== undefined) set('title', input.title, t.title);
    if (input.description !== undefined) set('description', input.description || null, t.description);
    if (input.brief !== undefined) set('brief', input.brief || null, t.brief);
    if (input.references !== undefined) set('references', input.references.filter(Boolean), t.references);
    if (input.checklist !== undefined) set('checklist', input.checklist, t.checklist);
    if (input.estimateHours !== undefined) set('estimateMin', input.estimateHours ? Math.round(input.estimateHours * 60) : null, t.estimateMin);
    if (input.priority !== undefined) set('priority', input.priority, t.priority);
    if (input.preProduction !== undefined) set('preProduction', input.preProduction, t.preProduction);
    if (input.departmentId !== undefined) {
      if (!(await this.prisma.department.findFirst({ where: { id: input.departmentId, orgId: me.orgId, deletedAt: null } }))) throw new BadRequestException('Pick a department');
      set('departmentId', input.departmentId, t.departmentId);
    }
    if (input.deliverableId !== undefined) {
      if (input.deliverableId) {
        const d = await this.prisma.deliverable.findFirst({ where: { id: input.deliverableId, orgId: me.orgId }, select: { cycle: { select: { engagementId: true } } } });
        if (!d) throw new NotFoundException('Deliverable not found');
        if (eng && d.cycle.engagementId !== eng.id) throw new BadRequestException('That deliverable belongs to a different engagement');
      }
      set('deliverableId', input.deliverableId, t.deliverableId);
    }
    if (!Object.keys(data).length) return this.mutation(me, t.id, null, 'No changes');
    await this.prisma.task.update({ where: { id: t.id }, data });
    await this.audit.log(me, 'task.edited', 'Task', t.id, before, after, ip);
    if (after.priority === 'urgent' && t.ownerId && t.ownerId !== me.id) await this.notifications.notify(me.orgId, [t.ownerId], { kind: 'task_updated', title: `${t.title} is now urgent`, body: `Changed by ${me.name}`, link: `/team/tasks/${t.id}`, critical: true });
    const undo = await this.undo.create(me, `Edited "${t.title}"`, [{ model: 'task', id: t.id, data: before }]);
    return this.mutation(me, t.id, undo, 'Saved');
  }

  // -------------------------------------------------------------------------
  // Status

  async status(me: Me, id: string, input: { status: TaskStatus; blocked?: { reason: string; waitingFor: string; responsibleId?: string | null; responsibleName?: string; expectedAt: string } }, ip?: string): Promise<CoreTaskMutation> {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    const eng = await this.access.engagementOf(t);
    const head = hasRole(me, 'founder', 'admin', 'am_lead', 'department_head') && !this.manageDenied(c, t, eng);
    if (t.ownerId !== me.id && !head) throw new ForbiddenException('Only the assignee or the department head can change the status');
    if (t.archivedAt || t.isDraft) throw new BadRequestException(t.archivedAt ? 'Restore the task first' : 'Activate the draft first');
    if (t.status === input.status) return this.mutation(me, t.id, null, 'No change');
    if (input.status === 'done' && t.kind === 'qc') throw new BadRequestException('QC tasks complete when the QC checklist is submitted');
    if (input.status === 'done' && t.kind === 'client_review') throw new BadRequestException('Client review completes when the client approves');
    if (['in_progress', 'done'].includes(input.status) && t.dependsOn.length) {
      const open = await this.prisma.task.findMany({ where: { id: { in: t.dependsOn }, status: { not: 'done' } }, select: { title: true } });
      if (open.length) throw new BadRequestException(`Waiting on: ${open.map((d) => d.title).join(', ')}`);
    }
    if (input.status === 'done') {
      const openSubs = await this.prisma.task.count({ where: { parentId: t.id, status: { in: [...OPEN_TASK] }, archivedAt: null, isDraft: false } });
      if (openSubs) throw new BadRequestException(`${openSubs} subtask${openSubs > 1 ? 's are' : ' is'} still open. Finish or archive them first.`);
    }
    const data: Prisma.TaskUncheckedUpdateInput = { status: input.status };
    const before = { status: t.status, blockedReason: t.blockedReason, blockedWaitingFor: t.blockedWaitingFor, blockedResponsibleId: t.blockedResponsibleId, blockedExpectedAt: t.blockedExpectedAt?.toISOString() ?? null, blockedAt: t.blockedAt?.toISOString() ?? null, startedAt: t.startedAt?.toISOString() ?? null, completedAt: t.completedAt?.toISOString() ?? null };
    const now = new Date();
    if (input.status === 'blocked') {
      const b = input.blocked;
      if (!b) throw new BadRequestException('Blocked needs a reason, what you are waiting for, who is responsible and when you expect it resolved');
      let responsibleId: string | null = null;
      if (b.responsibleId) {
        const r = await this.prisma.user.findFirst({ where: { id: b.responsibleId, orgId: me.orgId, deletedAt: null }, select: { id: true } });
        if (!r) throw new BadRequestException('Pick who is responsible');
        responsibleId = r.id;
      } else if (!b.responsibleName?.trim()) throw new BadRequestException('Say who is responsible for unblocking it');
      Object.assign(data, { blockedReason: b.reason, blockedWaitingFor: b.responsibleName?.trim() && !responsibleId ? `${b.waitingFor} (${b.responsibleName.trim()})` : b.waitingFor, blockedResponsibleId: responsibleId, blockedExpectedAt: dbDay(b.expectedAt), blockedAt: now });
    } else Object.assign(data, { blockedReason: null, blockedWaitingFor: null, blockedResponsibleId: null, blockedExpectedAt: null, blockedAt: null });
    if (input.status === 'in_progress' && !t.startedAt) data.startedAt = now;
    if (input.status === 'done') data.completedAt = now;
    await this.prisma.task.update({ where: { id: t.id }, data });
    await this.audit.log(me, `task.${input.status === 'done' ? 'completed' : input.status === 'blocked' ? 'blocked' : 'status_changed'}`, 'Task', t.id, { status: t.status }, { status: input.status, ...(input.blocked ?? {}) }, ip);
    let message = `Moved to ${taskStatusLabels[input.status]}`;
    // Done on deliverable work routes to QC, never straight to the client.
    if (input.status === 'done' && t.deliverableId && t.kind === 'work' && !t.flowStep) message = await this.routeToQc(me, t);
    if (input.status === 'blocked') {
      const notify = [input.blocked?.responsibleId, t.ownerId !== me.id ? t.ownerId : null, eng?.amId, await this.people.departmentHead(me.orgId, t.departmentId ?? t.deliverable?.departmentId)].filter((x): x is string => !!x && x !== me.id);
      await this.notifications.notify(me.orgId, notify, { kind: 'task_blocked', title: `Blocked: ${t.title}`, body: `${input.blocked?.reason} · Waiting for ${input.blocked?.waitingFor} · Expected ${input.blocked?.expectedAt}`, link: `/team/tasks/${t.id}` });
    }
    const watchers = (await this.records.watcherIds(me.orgId, 'task', t.id)).filter((w) => w !== me.id);
    if (watchers.length) await this.notifications.notify(me.orgId, watchers, { kind: 'task_watch', title: `${t.title}: ${taskStatusLabels[input.status]}`, body: `By ${me.name}`, link: `/team/tasks/${t.id}` });
    const undo = await this.undo.create(me, `"${t.title}" moved to ${taskStatusLabels[input.status]}`, [{ model: 'task', id: t.id, data: before }]);
    return this.mutation(me, t.id, undo, message);
  }

  /** An ad-hoc task on a deliverable is done: make sure the deliverable has an open QC step. */
  private async routeToQc(me: Me, t: TaskFull) {
    const open = await this.prisma.task.findFirst({ where: { deliverableId: t.deliverableId, kind: 'qc', status: { in: [...OPEN_TASK] }, archivedAt: null } });
    if (open) return 'Done. The deliverable goes through QC before the client sees it.';
    const qc = await this.people.loads(me.orgId, { roles: { some: { role: { baseRole: 'qc_reviewer' } } }, id: { not: t.ownerId ?? '' } });
    const pick = qc.filter((p) => !p.onLeaveToday).sort((a, b) => a.loadPct - b.loadPct)[0] ?? null;
    const cal = await calendarFor(this.prisma, me.orgId);
    const created = await this.prisma.task.create({
      data: { orgId: me.orgId, title: `QC: ${t.deliverable?.title ?? t.title}`, deliverableId: t.deliverableId, engagementId: this.engId(t), kind: 'qc', ownerId: pick?.id ?? null, departmentId: t.departmentId, deadline: addWorkingDays(new Date(), 1, cal), dependsOn: [t.id], createdById: me.id, sort: 950 },
    });
    await this.audit.log(me, 'task.created', 'Task', created.id, undefined, { title: created.title, ownerId: pick?.id ?? null, kind: 'qc', routedFrom: t.id }, undefined);
    if (pick) await this.notifications.notify(me.orgId, [pick.id], { kind: 'task_assigned', title: `QC needed: ${t.deliverable?.title ?? t.title}`, body: `${t.title} is done. Check it before it goes to the client.`, link: `/team/tasks/${created.id}` });
    return `Done. Sent to QC${pick ? ` (${pick.name})` : ''} before it goes to the client.`;
  }

  // -------------------------------------------------------------------------
  // Deadline

  async deadline(me: Me, id: string, input: { deadline: string; reason: string }, ip?: string): Promise<CoreTaskMutation> {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    const eng = await this.access.engagementOf(t);
    const can = this.can(c, t, eng ? { id: eng.id, amId: eng.amId } : null, 0);
    const due = parseDue(input.deadline);
    if (Number.isNaN(due.getTime())) throw new BadRequestException('Pick a valid date');
    if (can.deadline === 'change') {
      const msg = await this.applyDeadline(me, t, due, input.reason, ip);
      return this.mutation(me, t.id, msg.undo, msg.message);
    }
    if (can.deadline === 'request') {
      const approverId = (await this.people.departmentHead(me.orgId, t.departmentId ?? t.deliverable?.departmentId)) ?? (await this.people.nextUp(me.orgId, me.id));
      const req = await this.approvals.create(me, { action: 'task.deadline_change', targetType: 'task', targetId: t.id, summary: `Move "${t.title}" from ${short(t.deadline)} to ${short(due)}`, payload: { deadline: input.deadline, reason: input.reason }, reason: input.reason, approverId: approverId === me.id ? undefined : approverId, diff: [{ field: 'Deadline', before: short(t.deadline), after: short(due) }] }, ip);
      return this.mutation(me, t.id, null, 'Request sent to your manager. The deadline changes when they approve it.', { id: req.id, summary: req.summary });
    }
    throw new ForbiddenException(t.archivedAt || !isOpen(t.status) ? 'Only open tasks can be re-dated' : 'Producers can request a deadline change on their own tasks; managers change it');
  }

  async applyDeadline(me: Me, t: TaskFull, due: Date, reason: string, ip?: string) {
    if (!isOpen(t.status) || t.archivedAt) throw new BadRequestException('Only open tasks can be re-dated');
    await this.prisma.task.update({ where: { id: t.id }, data: { deadline: due, deadlineChanges: { increment: 1 } } });
    await this.audit.log(me, 'task.deadline_changed', 'Task', t.id, { deadline: t.deadline }, { deadline: due, reason }, ip);
    const notify = [t.ownerId].filter((x): x is string => !!x && x !== me.id);
    if (notify.length) await this.notifications.notify(me.orgId, notify, { kind: 'task_updated', title: `${t.title}: now due ${short(due)}`, body: `Changed by ${me.name}. Reason: ${reason}`, link: `/team/tasks/${t.id}` });
    // Client-facing date moves: the CM posts an update in the client thread.
    const eng = await this.access.engagementOf(t);
    const clientDue = t.kind === 'client_review' ? t.deadline : (t.deliverable?.dueAt ?? null);
    let message = `Deadline moved to ${short(due)}`;
    if (eng && clientDue && due > clientDue) {
      const thread = await this.prisma.thread.findFirst({ where: { clientOrgId: eng.clientOrg.id, OR: [{ engagementId: eng.id }, { engagementId: null }] }, orderBy: { engagementId: { sort: 'desc', nulls: 'last' } }, select: { id: true } });
      if (eng.amId) await this.notifications.notify(me.orgId, [eng.amId], { kind: 'client_date_moved', title: `Client-facing date moved: ${t.title}`, body: `Now ${short(due)} (was ${short(clientDue)}). Please post an update for ${eng.clientOrg.name} in the client thread. Reason: ${reason}`, link: thread ? `/team/messages/${thread.id}` : `/team/clients/${eng.clientOrg.id}`, critical: true });
      message += `. This moves a client-facing date: the client manager has been asked to update ${eng.clientOrg.name}.`;
    }
    const undo = await this.undo.create(me, `Deadline of "${t.title}" changed`, [{ model: 'task', id: t.id, data: { deadline: t.deadline?.toISOString() ?? null, deadlineChanges: t.deadlineChanges } }]);
    return { message, undo };
  }

  // -------------------------------------------------------------------------
  // Duplicate, archive, restore, hand back, dependencies

  async duplicate(me: Me, id: string, input: { withSubtasks: boolean; count: number }, ip?: string) {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    const eng = await this.access.engagementOf(t);
    if (!this.can(c, t, eng ? { id: eng.id, amId: eng.amId } : null, 0).duplicate) throw new ForbiddenException(this.manageDenied(c, t, eng) ?? 'Only a department head, client manager or strategist can duplicate tasks');
    const subs = input.withSubtasks ? await this.prisma.task.findMany({ where: { parentId: t.id, archivedAt: null } }) : [];
    const ids: string[] = [];
    const undoRows: UndoRow[] = [];
    for (let n = 0; n < input.count; n++) {
      const copy = await this.prisma.task.create({
        data: { orgId: t.orgId, title: input.count > 1 ? `${t.title} (copy ${n + 1})` : `${t.title} (copy)`, engagementId: t.engagementId, deliverableId: t.deliverableId, parentId: t.parentId, ownerId: t.ownerId, departmentId: t.departmentId, deadline: t.deadline, priority: t.priority, specialty: t.specialty, kind: t.kind === 'work' || t.kind === 'planning' ? t.kind : 'work', status: 'todo', description: t.description, brief: t.brief, references: t.references, checklist: (t.checklist as { id: string; label: string }[]).map((i) => ({ ...i, done: false })), estimateMin: t.estimateMin, isInternal: t.isInternal, preProduction: t.preProduction, createdById: me.id, sort: t.sort },
      });
      ids.push(copy.id);
      undoRows.push({ model: 'task', id: copy.id, delete: true });
      for (const s of subs) {
        const sc = await this.prisma.task.create({ data: { orgId: t.orgId, title: s.title, parentId: copy.id, engagementId: s.engagementId, deliverableId: s.deliverableId, ownerId: s.ownerId, departmentId: s.departmentId, deadline: s.deadline, priority: s.priority, kind: 'work', status: 'todo', description: s.description, isInternal: s.isInternal, preProduction: s.preProduction, createdById: me.id } });
        undoRows.unshift({ model: 'task', id: sc.id, delete: true });
      }
      await this.audit.log(me, 'task.duplicated', 'Task', copy.id, undefined, { from: t.id, title: copy.title }, ip);
    }
    const undo = await this.undo.create(me, `Duplicated "${t.title}"`, undoRows);
    return { ids, undo };
  }

  async archive(me: Me, id: string, reason: string, ip?: string): Promise<CoreTaskMutation> {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    const eng = await this.access.engagementOf(t);
    if (t.archivedAt) throw new BadRequestException('Already archived');
    const denied = this.manageDenied(c, t, eng);
    if (denied || !hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'account_manager')) throw new ForbiddenException(denied ?? 'Only a department head or client manager can archive tasks');
    if (t.kind !== 'work' && t.kind !== 'planning' && isOpen(t.status)) throw new BadRequestException('QC and client review steps can’t be archived while open; they close with the deliverable');
    const subs = await this.prisma.task.findMany({ where: { parentId: t.id, archivedAt: null }, select: { id: true, status: true } });
    const now = new Date();
    const undoRows: UndoRow[] = [{ model: 'task', id: t.id, data: { status: t.status, archivedAt: null, archivedReason: null, archivedFromStatus: null } }];
    await this.prisma.task.update({ where: { id: t.id }, data: { archivedAt: now, archivedReason: reason, archivedFromStatus: t.status, status: 'cancelled' } });
    for (const s of subs) {
      undoRows.push({ model: 'task', id: s.id, data: { status: s.status, archivedAt: null, archivedReason: null, archivedFromStatus: null } });
      await this.prisma.task.update({ where: { id: s.id }, data: { archivedAt: now, archivedReason: `Parent archived: ${reason}`, archivedFromStatus: s.status, status: 'cancelled' } });
    }
    await this.audit.log(me, 'task.archived', 'Task', t.id, { status: t.status }, { archivedAt: now, reason, subtasks: subs.length }, ip);
    if (t.ownerId && t.ownerId !== me.id) await this.notifications.notify(me.orgId, [t.ownerId], { kind: 'task_updated', title: `Archived: ${t.title}`, body: `By ${me.name}. Reason: ${reason}`, link: `/team/tasks/${t.id}` });
    const undo = await this.undo.create(me, `Archived "${t.title}"`, undoRows);
    return this.mutation(me, t.id, undo, 'Archived. You can restore it from the Archived view.');
  }

  async restore(me: Me, id: string, ip?: string): Promise<CoreTaskMutation> {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    const eng = await this.access.engagementOf(t);
    if (!t.archivedAt) throw new BadRequestException('This task is not archived');
    const denied = this.manageDenied(c, t, eng);
    if (denied || !hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'account_manager')) throw new ForbiddenException(denied ?? 'Only a department head or client manager can restore tasks');
    const back = (s: string | null) => (s && s !== 'cancelled' ? (s as TaskStatus) : 'todo');
    await this.prisma.task.update({ where: { id: t.id }, data: { archivedAt: null, archivedReason: null, archivedFromStatus: null, status: back(t.archivedFromStatus) } });
    const subs = await this.prisma.task.findMany({ where: { parentId: t.id, archivedAt: { not: null }, archivedReason: { startsWith: 'Parent archived' } } });
    for (const s of subs) await this.prisma.task.update({ where: { id: s.id }, data: { archivedAt: null, archivedReason: null, archivedFromStatus: null, status: back(s.archivedFromStatus) } });
    await this.audit.log(me, 'task.restored', 'Task', t.id, { archivedAt: t.archivedAt, reason: t.archivedReason }, { status: back(t.archivedFromStatus) }, ip);
    return this.mutation(me, t.id, null, 'Restored');
  }

  async handback(me: Me, id: string, reason: string, ip?: string): Promise<CoreTaskMutation> {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    const eng = await this.access.engagementOf(t);
    if (t.ownerId !== me.id) throw new ForbiddenException('Only the person doing the task can hand it back');
    if (!isOpen(t.status) || t.archivedAt) throw new BadRequestException('Only open tasks can be handed back');
    if (!this.manageDenied(c, t, eng)) throw new BadRequestException('You manage this task: reassign it instead');
    const approverId = (await this.people.departmentHead(me.orgId, t.departmentId ?? t.deliverable?.departmentId)) ?? (await this.people.nextUp(me.orgId, me.id));
    const req = await this.approvals.create(me, { action: 'task.handback', targetType: 'task', targetId: t.id, summary: `${me.name} can't take "${t.title}"`, payload: {}, reason, approverId: approverId === me.id ? undefined : approverId, diff: [{ field: 'Owner', before: me.name, after: 'Someone else' }] }, ip);
    return this.mutation(me, t.id, null, 'Sent to your manager. They will reassign it or ask you to keep it.', { id: req.id, summary: req.summary });
  }

  async addDependency(me: Me, id: string, dependsOnId: string, ip?: string): Promise<CoreTaskMutation> {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    const eng = await this.access.engagementOf(t);
    if (t.ownerId !== me.id && this.manageDenied(c, t, eng)) throw new ForbiddenException('Only the task owner, the department head or the strategist can add dependencies');
    if (dependsOnId === t.id) throw new BadRequestException('A task can’t wait on itself');
    const dep = await this.access.load(me, dependsOnId);
    // No cycles: the predecessor must not (transitively) wait on this task.
    const seen = new Set<string>();
    const stack = [...dep.dependsOn];
    while (stack.length) {
      const x = stack.pop()!;
      if (x === t.id) throw new BadRequestException(`"${dep.title}" already waits on this task`);
      if (seen.has(x)) continue;
      seen.add(x);
      const n = await this.prisma.task.findUnique({ where: { id: x }, select: { dependsOn: true } });
      stack.push(...(n?.dependsOn ?? []));
    }
    if (t.dependsOn.includes(dep.id)) return this.mutation(me, t.id, null, 'Already linked');
    await this.prisma.task.update({ where: { id: t.id }, data: { dependsOn: [...t.dependsOn, dep.id] } });
    await this.audit.log(me, 'task.dependency_added', 'Task', t.id, { dependsOn: t.dependsOn }, { dependsOn: [...t.dependsOn, dep.id], waitsOn: dep.title }, ip);
    return this.mutation(me, t.id, null, dep.status === 'done' ? 'Linked' : `Waiting on "${dep.title}"`);
  }

  async removeDependency(me: Me, id: string, dependsOnId: string, ip?: string): Promise<CoreTaskMutation> {
    const c = await this.ctx(me);
    const t = await this.access.load(me, id);
    const eng = await this.access.engagementOf(t);
    if (t.ownerId !== me.id && this.manageDenied(c, t, eng)) throw new ForbiddenException('Only the task owner, the department head or the strategist can change dependencies');
    if (t.flowStep && t.deliverableId) throw new BadRequestException('Flow steps keep their order; change the flow template instead');
    await this.prisma.task.update({ where: { id: t.id }, data: { dependsOn: t.dependsOn.filter((d) => d !== dependsOnId) } });
    await this.audit.log(me, 'task.dependency_removed', 'Task', t.id, { dependsOn: t.dependsOn }, { dependsOn: t.dependsOn.filter((d) => d !== dependsOnId) }, ip);
    return this.mutation(me, t.id, null, 'Removed');
  }

  // -------------------------------------------------------------------------
  // Bulk (reassign goes through the engine endpoint)

  async bulk(me: Me, input: CoreTaskBulk & { ids: string[] }, ip?: string) {
    const c = await this.ctx(me);
    const ids = [...new Set(input.ids)];
    const tasks: TaskFull[] = [];
    for (const id of ids) tasks.push(await this.access.load(me, id));
    const engs = await Promise.all(tasks.map((t) => this.access.engagementOf(t)));
    const undoRows: UndoRow[] = [];
    // Check every task first: all or nothing.
    for (const [i, t] of tasks.entries()) {
      const can = this.can(c, t, engs[i] ? { id: engs[i]!.id, amId: engs[i]!.amId } : null, 0);
      const why = (ok: boolean, msg: string) => {
        if (!ok) throw new ForbiddenException(`"${t.title}": ${msg}`);
      };
      if (input.action === 'status') why(can.status, 'only the assignee or the department head can change the status');
      if (input.action === 'deadline' || input.action === 'priority') why(can.deadline === 'change', 'you can’t change this one (managers only, open tasks)');
      if (input.action === 'archive') why(can.archive, 'only a department head or client manager can archive');
      if (input.action === 'tag') why(can.edit, 'you can’t edit this task');
    }
    let changed = 0;
    if (input.action === 'status') {
      if (!input.status || input.status === 'blocked') throw new BadRequestException(input.status === 'blocked' ? 'Mark tasks blocked one by one: each needs its reason' : 'Pick a status');
      for (const t of tasks) {
        if (t.status === input.status) continue;
        await this.status(me, t.id, { status: input.status }, ip).then((r) => {
          if (r.undo) undoRows.push(...this.undoRowsFor(t));
        });
        changed++;
      }
    } else if (input.action === 'deadline') {
      if (!input.deadline || !input.reason || input.reason.trim().length < 3) throw new BadRequestException('Pick the new date and give a reason');
      const due = parseDue(input.deadline);
      for (const t of tasks) {
        undoRows.push({ model: 'task', id: t.id, data: { deadline: t.deadline?.toISOString() ?? null, deadlineChanges: t.deadlineChanges } });
        await this.applyDeadline(me, t, due, input.reason, ip);
        changed++;
      }
    } else if (input.action === 'priority') {
      if (!input.priority) throw new BadRequestException('Pick a priority');
      for (const t of tasks) {
        undoRows.push({ model: 'task', id: t.id, data: { priority: t.priority } });
        await this.prisma.task.update({ where: { id: t.id }, data: { priority: input.priority } });
        await this.audit.log(me, 'task.edited', 'Task', t.id, { priority: t.priority }, { priority: input.priority, bulk: true }, ip);
        changed++;
      }
    } else if (input.action === 'archive') {
      if (!input.reason || input.reason.trim().length < 3) throw new BadRequestException('Give a short reason for archiving');
      for (const t of tasks) {
        if (t.archivedAt) continue;
        undoRows.push({ model: 'task', id: t.id, data: { status: t.status, archivedAt: null, archivedReason: null, archivedFromStatus: null } });
        await this.prisma.task.update({ where: { id: t.id }, data: { archivedAt: new Date(), archivedReason: input.reason, archivedFromStatus: t.status, status: 'cancelled' } });
        await this.audit.log(me, 'task.archived', 'Task', t.id, { status: t.status }, { reason: input.reason, bulk: true }, ip);
        changed++;
      }
    } else if (input.action === 'tag') {
      if (!input.tag) throw new BadRequestException('Type a tag');
      await this.records.addTag(me, 'task', tasks.map((t) => t.id), input.tag);
      for (const t of tasks) await this.audit.log(me, 'record.tagged', 'Task', t.id, null, { added: input.tag, bulk: true }, ip);
      changed = tasks.length;
    }
    const label = `${changed} task${changed === 1 ? '' : 's'} updated`;
    const undo = undoRows.length ? await this.undo.create(me, label, undoRows) : null;
    return { ok: true as const, changed, undo, message: label };
  }

  private undoRowsFor(t: TaskFull): UndoRow[] {
    return [{ model: 'task', id: t.id, data: { status: t.status, blockedReason: t.blockedReason, startedAt: t.startedAt?.toISOString() ?? null, completedAt: t.completedAt?.toISOString() ?? null } }];
  }

  // -------------------------------------------------------------------------
  // Flow templates

  private async template(me: Me, input: CoreTemplatePreviewInput): Promise<CoreTemplatePreview & { _steps: FlowStep[]; _departmentId: string; _engagementId: string | null; _deliverableId: string | null }> {
    if (!hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'strategist', 'account_manager')) throw new ForbiddenException('Only a department head, strategist or client manager can add tasks from a template');
    const c = await this.ctx(me);
    const tpl = await this.prisma.flowTemplate.findFirst({ where: { id: input.templateId, orgId: me.orgId }, include: { department: { select: { name: true } } } });
    if (!tpl) throw new NotFoundException('Template not found');
    const steps = z.array(flowStepSchema).parse(tpl.steps) as FlowStep[];
    let amId: string | null = null;
    let label = input.title?.trim() || null;
    const warnings: string[] = [];
    if (input.engagementId) {
      const e = await this.checkEngagement(c, input.engagementId, false);
      amId = e.amId;
      label = label ?? e.clientOrg.name;
    }
    if (input.deliverableId) {
      const d = await this.prisma.deliverable.findFirst({ where: { id: input.deliverableId, orgId: me.orgId }, include: { tasks: { select: { id: true } }, cycle: { select: { engagementId: true } } } });
      if (!d) throw new NotFoundException('Deliverable not found');
      if (input.engagementId && d.cycle.engagementId !== input.engagementId) throw new BadRequestException('That deliverable belongs to a different engagement');
      if (d.tasks.length) warnings.push(`${d.title} already has ${d.tasks.length} task(s); these will be added alongside.`);
      label = input.title?.trim() || d.title;
    }
    if (!label) throw new BadRequestException('Give the work a name (it goes after each step name)');
    const cal = await calendarFor(this.prisma, me.orgId);
    const roles = [...new Set(steps.map((s) => s.role))];
    const loads = await this.people.loads(me.orgId, { roles: { some: { role: { baseRole: { in: [...roles.filter((r) => r !== 'am'), 'account_manager', 'am_lead'] } } } } });
    const people = input.people ?? {};
    const roleRows = roles.map((role) => {
      const pool = loads.filter((p) => (role === 'am' ? p.roles.some((r) => ['account_manager', 'am_lead'].includes(r)) : p.roles.includes(role)));
      const pref = role === 'am' ? amId : null;
      const chosen = people[role] ?? pref ?? [...pool].filter((p) => !p.onLeaveToday).sort((a, b) => Number(b.departmentId === tpl.departmentId) - Number(a.departmentId === tpl.departmentId) || a.loadPct - b.loadPct)[0]?.id ?? null;
      const u = loads.find((p) => p.id === chosen);
      if (!u && chosen) warnings.push(`The person picked for ${role.replace(/_/g, ' ')} is not available`);
      return {
        role,
        label: role === 'am' ? 'Client manager' : role.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()),
        userId: u?.id ?? null,
        userName: u?.name ?? null,
        options: pool.map((p) => ({ id: p.id, name: p.name, role: p.role, department: p.department, specialty: p.specialty, skills: p.skills, loadPct: p.loadPct, loadAfterPct: p.loadPct, openTasks: p.openTasks, hoursOpen: p.hoursOpen, capacityHours: p.capacityHours, onLeave: false, leaveNote: p.onLeaveToday ? 'On leave today' : null, onLeaveToday: p.onLeaveToday, suggested: p.id === u?.id, current: false, blockedReason: null })),
      };
    });
    if (!hasRole(me, 'founder', 'admin', 'am_lead') && hasRole(me, 'department_head') && !hasRole(me, 'account_manager', 'strategist') && tpl.departmentId !== c.dept) throw new ForbiddenException('Department heads use their own department’s templates');
    let prev: Date = new Date(`${input.startDate}T09:30:00+05:30`);
    const tasks = steps.map((s, i) => {
      const deadline = addWorkingDays(new Date(prev.getTime() - DAY_MS), Math.max(s.days, 1), cal);
      prev = new Date(`${istDate(deadline)}T09:30:00+05:30`);
      const r = roleRows.find((x) => x.role === s.role)!;
      if (r.userId) {
        const p = loads.find((x) => x.id === r.userId)!;
        if (p.leaveDays.has(istDate(deadline))) warnings.push(`${p.name} is on leave on ${short(deadline)} (${s.name})`);
      }
      return { step: s.key, title: `${s.name}: ${label}`, role: s.role, ownerId: r.userId, ownerName: r.userName, deadline: deadline.toISOString(), kind: s.kind, dependsOnStep: i > 0 ? steps[i - 1].key : null };
    });
    return { template: { id: tpl.id, name: tpl.name, department: tpl.department.name }, roles: roleRows, tasks, warnings: [...new Set(warnings)], _steps: steps, _departmentId: tpl.departmentId, _engagementId: input.engagementId ?? null, _deliverableId: input.deliverableId ?? null };
  }

  async templatePreview(me: Me, input: CoreTemplatePreviewInput): Promise<CoreTemplatePreview> {
    const { _steps: _s, _departmentId: _d, _engagementId: _e, _deliverableId: _v, ...view } = await this.template(me, input);
    return view;
  }

  async fromTemplate(me: Me, input: CoreTemplatePreviewInput, ip?: string) {
    const p = await this.template(me, input);
    if (p.tasks.some((t) => !t.ownerId)) throw new BadRequestException('Pick a person for every role first');
    const ids: string[] = [];
    let prevId: string | null = null;
    for (const [i, t] of p.tasks.entries()) {
      const created: { id: string } = await this.prisma.task.create({
        data: { orgId: me.orgId, title: t.title, engagementId: p._engagementId, deliverableId: p._deliverableId, flowStep: p._steps[i].key, kind: p._steps[i].kind, role: t.role, ownerId: t.ownerId, departmentId: p._departmentId, deadline: new Date(t.deadline), dependsOn: prevId ? [prevId] : [], specialty: craftSpecialtyForStep(p._steps[i].key), isInternal: !p._engagementId, createdById: me.id, sort: i },
      });
      ids.push(created.id);
      prevId = created.id;
    }
    await this.engine.record(me, 'task', ids.map((id, i) => ({ id, fromUserId: null, toUserId: p.tasks[i].ownerId! })), 'new_task', `From template ${p.template.name}`);
    for (const id of ids) await this.audit.log(me, 'task.created', 'Task', id, undefined, { template: p.template.name, fromTemplate: true }, ip);
    const byOwner = new Map<string, number>();
    for (const t of p.tasks) byOwner.set(t.ownerId!, (byOwner.get(t.ownerId!) ?? 0) + 1);
    for (const [owner, n] of byOwner) if (owner !== me.id) await this.notifications.notify(me.orgId, [owner], { kind: 'task_assigned', title: `${me.name} assigned you ${n} task${n > 1 ? 's' : ''} from ${p.template.name}`, link: '/team/tasks' });
    const undo = await this.undo.create(me, `${ids.length} tasks from ${p.template.name}`, ids.map((id) => ({ model: 'task', id, delete: true })));
    return { ids, undo, message: `${ids.length} tasks created from ${p.template.name}` };
  }

  // -------------------------------------------------------------------------
  // Recurring tasks

  private ruleDates(rule: string, dayOf: number | null, from: string, to: string, cal: { holidays: readonly string[]; days: readonly number[] }) {
    const out: string[] = [];
    const isWork = (d: string) => cal.days.includes(new Date(`${d}T12:00:00Z`).getUTCDay()) && !cal.holidays.includes(d);
    const nextWork = (d: string) => {
      let x = d;
      for (let i = 0; i < 14 && !isWork(x); i++) x = ymd(new Date(dbDay(x).getTime() + DAY_MS));
      return x;
    };
    for (let d = from; d <= to; d = ymd(new Date(dbDay(d).getTime() + DAY_MS))) {
      const dt = dbDay(d);
      let hit: string | null = null;
      if (rule === 'daily') hit = isWork(d) ? d : null;
      else if (rule === 'weekly') hit = dt.getUTCDay() === (dayOf ?? 1) ? nextWork(d) : null;
      else if (rule === 'monthly') hit = dt.getUTCDate() === Math.min(dayOf ?? 1, 28) ? nextWork(d) : null;
      else if (rule === 'cycle_start') hit = dt.getUTCDate() === 1 ? nextWork(d) : null;
      if (hit && hit <= to && !out.includes(hit)) out.push(hit);
    }
    return out;
  }

  private async createRecurring(me: Me, input: DraftInput, base: { ownerId: string | null; departmentId: string | null; engagementId: string | null; deadline: Date | null; estimateMin: number | null }, ip?: string): Promise<CoreTaskMutation> {
    const start = base.deadline ? istDate(base.deadline) : istDate(new Date());
    const rule = input.repeat!;
    if (rule.end < start) throw new BadRequestException('The end date is before the first date');
    const dayOf = rule.dayOf ?? (rule.rule === 'weekly' ? dbDay(start).getUTCDay() : rule.rule === 'monthly' ? dbDay(start).getUTCDate() : null);
    const rec = await this.prisma.taskRecurrence.create({
      data: {
        orgId: me.orgId,
        template: { title: input.title, ownerId: base.ownerId, departmentId: base.departmentId, engagementId: base.engagementId, isInternal: !!input.internal, priority: input.priority ?? 'normal', description: input.description ?? null, estimateMin: base.estimateMin, preProduction: !!input.preProduction },
        rule: rule.rule,
        dayOf,
        startDate: dbDay(start),
        endDate: dbDay(rule.end),
        createdById: me.id,
      },
    });
    await this.audit.log(me, 'task.recurring_created', 'Task', rec.id, undefined, { title: input.title, rule: rule.rule, end: rule.end }, ip);
    const created = await this.generateFor(rec.id);
    const first = created[0];
    if (!first) throw new BadRequestException('No working days fall inside that repeat window. Pick another rule or end date.');
    if (base.ownerId && base.ownerId !== me.id) await this.notifications.notify(me.orgId, [base.ownerId], { kind: 'task_assigned', title: `${me.name} set up a recurring task for you: ${input.title}`, body: coreRepeatRuleLabels[rule.rule], link: '/team/tasks' });
    return this.mutation(me, first, null, `Recurring task set up (${coreRepeatRuleLabels[rule.rule].toLowerCase()}). ${created.length} upcoming instance${created.length === 1 ? '' : 's'} created; more are added 7 days ahead.`);
  }

  /** Creates the missing instances of one rule up to 7 days ahead. Idempotent (lastDate). */
  async generateFor(recId: string, now = new Date()): Promise<string[]> {
    const rec = await this.prisma.taskRecurrence.findUnique({ where: { id: recId } });
    if (!rec || !rec.active) return [];
    const cal = await calendarFor(this.prisma, rec.orgId);
    const today = istDate(now);
    const horizon = ymd(new Date(dbDay(today).getTime() + 7 * DAY_MS));
    const from = [ymd(rec.startDate), rec.lastDate ? ymd(new Date(rec.lastDate.getTime() + DAY_MS)) : '0000', today].sort().pop()!;
    const to = [horizon, rec.endDate ? ymd(rec.endDate) : horizon].sort()[0];
    if (from > to) return [];
    const dates = this.ruleDates(rec.rule, rec.dayOf, from, to, cal);
    const tpl = rec.template as { title: string; ownerId: string | null; departmentId: string | null; engagementId: string | null; isInternal: boolean; priority: string; description: string | null; estimateMin: number | null; preProduction: boolean };
    const ids: string[] = [];
    for (const d of dates) {
      const t = await this.prisma.task.create({ data: { orgId: rec.orgId, title: tpl.title, ownerId: tpl.ownerId, departmentId: tpl.departmentId, engagementId: tpl.engagementId, isInternal: tpl.isInternal, priority: tpl.priority, description: tpl.description, estimateMin: tpl.estimateMin, preProduction: tpl.preProduction, deadline: new Date(`${d}T18:00:00+05:30`), kind: 'work', status: 'todo', recurrenceId: rec.id, createdById: rec.createdById, sort: 800 } });
      ids.push(t.id);
    }
    await this.prisma.taskRecurrence.update({ where: { id: rec.id }, data: { lastDate: dbDay(to), active: rec.endDate ? ymd(rec.endDate) > to : true } });
    return ids;
  }

  async generateAll(now = new Date(), orgId?: string) {
    const recs = await this.prisma.taskRecurrence.findMany({ where: { active: true, ...(orgId ? { orgId } : {}) }, select: { id: true } });
    let n = 0;
    for (const r of recs) n += (await this.generateFor(r.id, now)).length;
    return n;
  }

  async recurring(me: Me): Promise<CoreRecurrence[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const where: Prisma.TaskRecurrenceWhereInput = isLeader(me) ? { orgId: me.orgId } : { orgId: me.orgId, OR: [{ createdById: me.id }, { template: { path: ['ownerId'], equals: me.id } }] };
    const rows = await this.prisma.taskRecurrence.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
    const names = await this.people.names(rows.map((r) => (r.template as { ownerId?: string }).ownerId));
    const cal = await calendarFor(this.prisma, me.orgId);
    const today = istDate(new Date());
    return rows.map((r) => {
      const tpl = r.template as { title: string; ownerId?: string };
      const end = r.endDate ? ymd(r.endDate) : ymd(new Date(Date.now() + 60 * DAY_MS));
      return { id: r.id, title: tpl.title, rule: r.rule, ruleLabel: coreRepeatRuleLabels[r.rule as keyof typeof coreRepeatRuleLabels] ?? r.rule, dayOf: r.dayOf, owner: tpl.ownerId ? (names.get(tpl.ownerId) ?? null) : null, startDate: ymd(r.startDate), endDate: r.endDate ? ymd(r.endDate) : null, nextDates: r.active ? this.ruleDates(r.rule, r.dayOf, today > ymd(r.startDate) ? today : ymd(r.startDate), end, cal).slice(0, 3) : [], active: r.active };
    });
  }

  async stopRecurring(me: Me, id: string, ip?: string) {
    const r = await this.prisma.taskRecurrence.findFirst({ where: { id, orgId: me.orgId } });
    if (!r) throw new NotFoundException('Recurring task not found');
    if (r.createdById !== me.id && !isLeader(me) && !hasRole(me, 'department_head')) throw new ForbiddenException('Only the person who set it up or a manager can stop it');
    await this.prisma.taskRecurrence.update({ where: { id }, data: { active: false } });
    await this.audit.log(me, 'task.recurring_stopped', 'Task', id, { active: true }, { active: false }, ip);
    return this.recurring(me);
  }

  // -------------------------------------------------------------------------
  // Jobs: not started 1 working day before the deadline; leave cover suggestions

  /** Task still "To do" within 1 working day of its deadline → Department Head alert with one-tap reassign (once per task). */
  async notStartedAlerts(now = new Date(), orgId?: string) {
    const orgs = orgId ? [{ id: orgId }] : await this.prisma.organisation.findMany({ select: { id: true } });
    let n = 0;
    for (const org of orgs) {
      const cal = await calendarFor(this.prisma, org.id);
      const limit = addWorkingDays(now, 1, cal);
      const tasks = await this.prisma.task.findMany({ where: { orgId: org.id, status: 'todo', archivedAt: null, isDraft: false, kind: { in: ['work', 'planning'] }, ownerId: { not: null }, deadline: { gt: now, lte: limit }, startedAt: null }, include: { owner: { select: { name: true, departmentId: true } } }, take: 300 });
      if (!tasks.length) continue;
      const done = await this.prisma.auditEvent.findMany({ where: { orgId: org.id, action: 'task.not_started_alert', entityId: { in: tasks.map((t) => t.id) } }, select: { entityId: true } });
      for (const t of tasks.filter((x) => !done.some((d) => d.entityId === x.id))) {
        const head = (await this.people.departmentHead(org.id, t.departmentId ?? t.owner?.departmentId)) ?? (await this.people.admin(org.id));
        if (!head || head === t.ownerId) continue;
        await this.notifications.notify(org.id, [head], { kind: 'task_not_started', title: `Not started, due ${short(t.deadline)}: ${t.title}`, body: `${t.owner?.name ?? 'The owner'} hasn't started it. Reassign it in one tap if needed.`, link: `/team/tasks/${t.id}?reassign=1`, critical: true });
        await this.audit.logSystem(org.id, 'task.not_started_alert', 'Task', t.id, { headId: head, ownerId: t.ownerId });
        n++;
      }
    }
    return n;
  }

  /** Approved leave starting within 2 working days with tasks due during it → suggest reassignment to the Department Head (once per leave). */
  async leaveCoverSuggestions(now = new Date(), orgId?: string) {
    const orgs = orgId ? [{ id: orgId }] : await this.prisma.organisation.findMany({ select: { id: true } });
    let n = 0;
    for (const org of orgs) {
      const cal = await calendarFor(this.prisma, org.id);
      const soon = addWorkingDays(now, 2, cal);
      const leaves = await this.prisma.leaveRequest.findMany({ where: { orgId: org.id, status: 'approved', type: { not: 'wfh' }, from: { lte: dbDay(istDate(soon)) }, to: { gte: dbDay(istDate(now)) } }, take: 200 });
      if (!leaves.length) continue;
      const done = await this.prisma.auditEvent.findMany({ where: { orgId: org.id, action: 'leave.cover_suggested', entityId: { in: leaves.map((l) => l.id) } }, select: { entityId: true } });
      for (const l of leaves.filter((x) => !done.some((d) => d.entityId === x.id))) {
        const due = await this.prisma.task.count({ where: { orgId: org.id, ownerId: l.userId, status: { in: [...OPEN_TASK] }, archivedAt: null, deadline: { gte: new Date(`${ymd(l.from)}T00:00:00+05:30`), lt: new Date(new Date(`${ymd(l.to)}T00:00:00+05:30`).getTime() + DAY_MS) } } });
        if (!due) continue;
        const user = await this.prisma.user.findUnique({ where: { id: l.userId }, select: { name: true, departmentId: true } });
        const head = (await this.people.departmentHead(org.id, user?.departmentId)) ?? (await this.people.nextUp(org.id, l.userId));
        if (!head) continue;
        await this.notifications.notify(org.id, [head], { kind: 'leave_cover', title: `${user?.name ?? 'Someone'} is on leave from ${short(l.from)}: ${due} task${due > 1 ? 's' : ''} need cover`, body: 'Pick who covers each task before the leave starts.', link: `/team/leave/${l.id}`, critical: true });
        await this.audit.logSystem(org.id, 'leave.cover_suggested', 'LeaveRequest', l.id, { headId: head, tasks: due });
        n++;
      }
    }
    return n;
  }

  /** Fields the existing PATCH /tasks/:id passes on to edit(). */
  static editKeys = CORE_TASK_EDIT_KEYS;
}
