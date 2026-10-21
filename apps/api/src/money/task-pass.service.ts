// v23 pass a task: anyone hands one of their own open tasks to a colleague in the same department. The colleague gets
// an approval request (only they can decide it, on Workload or in Approvals); the task moves to them when they accept,
// with the handover note in the task's history. The Department Head is told, but does not need to approve.
// Same rules as the workload heatmap: never to someone on approved leave on the deadline, or with no working hours
// that week; going past their free hours is only a warning (accepting is their call).
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { taskPassSchema, TASK_PASS_STATUSES, type Me, type PassableTask, type PassCandidate, type PassRequestRow, type TaskPassView } from '@bmu/shared';
import { ApprovalsService } from '../actions/approvals.service.js';
import { PeopleDirectory } from '../actions/people.js';
import { ActionsRegistry, type ApprovalRow } from '../actions/registry.js';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CapacityService, type WeekLoad } from './capacity.service.js';
import { isoOf, mondayOf, todayIst } from './dates.js';

export const TASK_PASS_ACTION = 'task.pass';
/** QC reviews and client-review steps belong to whoever the flow chose: they are never passed. */
const NOT_PASSABLE_KINDS = ['qc', 'client_review'];
/** Same as the heatmap: a task without an estimate counts as two hours. */
const DEFAULT_TASK_MIN = 120;
/** The previous owner can still open the task for a week (same as a reassignment). */
const READ_ACCESS_DAYS = 7;
const round1 = (n: number) => Math.round(n * 10) / 10;
const istDay = (d: Date) => isoOf(new Date(d.getTime() + 330 * 60_000));

type TaskRow = { id: string; orgId: string; title: string; ownerId: string | null; status: string; kind: string; archivedAt: Date | null; isDraft: boolean; deadline: Date | null; estimateMin: number | null; departmentId: string | null };
type Person = { id: string; name: string; specialty: string | null; departmentId: string | null };

@Injectable()
export class TaskPassService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capacity: CapacityService,
    private readonly approvals: ApprovalsService,
    private readonly registry: ActionsRegistry,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly people: PeopleDirectory,
  ) {}

  onModuleInit() {
    this.registry.registerApprovalHandler({
      action: TASK_PASS_ACTION,
      label: 'Task handover',
      href: (r) => `/team/tasks/${r.targetId}`,
      // Only the colleague it was offered to can take it: not the Founder or Branch Manager on their behalf.
      approvers: (me, r) => me.id === r.approverId,
      decisionWords: { approve: 'accepted', reject: 'declined' },
      apply: ({ approver, req }) => this.accept(approver, req),
      onReject: async ({ approver, req }) => {
        await this.audit.log(approver, 'task.pass_declined', 'Task', req.targetId, null, { approvalId: req.id, from: req.requestedById }, undefined);
      },
    });
  }

  // -------------------------------------------------------------------------
  // Reads

  async view(me: Me): Promise<TaskPassView> {
    this.assertStaff(me);
    const self = await this.person(me.orgId, me.id);
    const dept = self?.departmentId ? await this.prisma.department.findFirst({ where: { id: self.departmentId, orgId: me.orgId }, select: { name: true } }) : null;
    const [tasks, pending] = await Promise.all([
      this.prisma.task.findMany({
        where: { orgId: me.orgId, ownerId: me.id, status: { in: [...TASK_PASS_STATUSES] }, archivedAt: null, isDraft: false, kind: { notIn: NOT_PASSABLE_KINDS } },
        select: { id: true, title: true, status: true, deadline: true, estimateMin: true, engagementId: true },
        orderBy: [{ deadline: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        take: 200,
      }),
      this.prisma.approvalRequest.findMany({
        where: { orgId: me.orgId, action: TASK_PASS_ACTION, status: 'pending', expiresAt: { gt: new Date() }, OR: [{ requestedById: me.id }, { approverId: me.id }] },
        orderBy: { createdAt: 'asc' },
        take: 100,
      }),
    ]);
    const rows = await this.rows(pending);
    const clients = await this.clientNames(tasks.map((t) => t.engagementId));
    const offered = new Map(rows.filter((r) => r.fromId === me.id).map((r) => [r.taskId, r]));
    return {
      department: dept?.name ?? null,
      tasks: tasks.map((t): PassableTask => {
        const p = offered.get(t.id);
        return {
          id: t.id,
          title: t.title,
          status: t.status,
          deadline: t.deadline?.toISOString() ?? null,
          hours: round1((t.estimateMin ?? DEFAULT_TASK_MIN) / 60),
          client: (t.engagementId && clients.get(t.engagementId)) || null,
          pending: p ? { id: p.id, to: p.to } : null,
        };
      }),
      sent: rows.filter((r) => r.fromId === me.id),
      received: rows.filter((r) => r.toId === me.id),
    };
  }

  /** Colleagues in the same department, with their free hours in the week the task counts in. */
  async candidates(me: Me, taskId: string): Promise<PassCandidate[]> {
    this.assertStaff(me);
    const task = await this.task(me.orgId, taskId);
    const why = this.taskProblem(task, me.id);
    if (why) throw new BadRequestException(why);
    const self = await this.person(me.orgId, me.id);
    if (!self?.departmentId) throw new BadRequestException("You aren't in a department yet. Ask HR to add you to one.");
    const colleagues = await this.prisma.user.findMany({
      where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, departmentId: self.departmentId, id: { not: me.id } },
      select: { id: true, name: true, specialty: true, departmentId: true },
      orderBy: { name: 'asc' },
      take: 200,
    });
    const week = this.weekOf(task);
    const loads = await this.capacity.loads(me.orgId, colleagues.map((c) => c.id), [week]);
    return colleagues
      .map((c): PassCandidate => {
        const fit = this.fit(c, task, loads.get(c.id)![0]);
        return { userId: c.id, name: c.name, specialty: c.specialty, weekStart: week, availableHours: fit.available, freeHours: fit.free, blocked: fit.blocked, warning: fit.warning };
      })
      .sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked) || b.freeHours - a.freeHours || a.name.localeCompare(b.name));
  }

  // -------------------------------------------------------------------------
  // Writes

  async request(me: Me, body: unknown, ip?: string): Promise<PassRequestRow> {
    this.assertStaff(me);
    const input = parse(taskPassSchema, body);
    const task = await this.task(me.orgId, input.taskId);
    const to = await this.check(me.orgId, task, me.id, input.toUserId);
    const req = await this.approvals.create(
      me,
      {
        action: TASK_PASS_ACTION,
        targetType: 'task',
        targetId: task.id,
        summary: `Pass "${task.title}" to ${to.name}`,
        payload: { toUserId: to.id, note: input.note },
        reason: input.note,
        approverId: to.id,
        diff: [{ field: 'Owner', before: me.name, after: to.name }],
        notice: { title: `${me.name} wants to pass you a task: ${task.title}`, link: '/team/workload' },
      },
      ip,
    );
    return (await this.rows([req]))[0];
  }

  /** The colleague accepted: everything is checked again, since the task or their week may have changed. */
  private async accept(approver: Me, req: ApprovalRow) {
    const p = req.payload as { toUserId?: string; note?: string };
    if (p.toUserId !== approver.id) throw new ForbiddenException('This task was offered to someone else');
    const task = await this.task(req.orgId, req.targetId);
    if (task.ownerId !== req.requestedById) throw new BadRequestException('This task has moved to someone else since it was offered. Decline it.');
    const to = await this.check(req.orgId, task, req.requestedById, approver.id);
    const from = await this.person(req.orgId, req.requestedById);
    await this.prisma.task.update({ where: { id: task.id }, data: { ownerId: to.id } });
    await this.prisma.assignment.create({
      data: {
        orgId: req.orgId,
        targetType: 'task',
        targetId: task.id,
        role: 'owner',
        fromUserId: req.requestedById,
        toUserId: to.id,
        reason: 'other',
        note: `Passed on by ${from?.name ?? 'a colleague'}`,
        handoverNote: p.note ?? null,
        approvalRequestId: req.id,
        readAccessUntil: new Date(Date.now() + READ_ACCESS_DAYS * 86_400_000),
        byId: to.id,
      },
    });
    await this.audit.log(approver, 'task.reassigned', 'Task', task.id, { ownerId: req.requestedById }, { ownerId: to.id, owner: to.name, reason: 'Passed on by a colleague', handover: p.note ?? null, approvalId: req.id }, undefined);
    // The Department Head is told (no approval needed from them).
    const head = await this.people.departmentHead(req.orgId, to.departmentId);
    if (head && head !== to.id && head !== req.requestedById) {
      await this.notifications.notify(req.orgId, [head], {
        kind: 'task_assigned',
        title: `${to.name} took over "${task.title}" from ${from?.name ?? 'a colleague'}`,
        body: p.note ? `Handover: ${p.note}` : undefined,
        link: `/team/tasks/${task.id}`,
      });
    }
    return { taskId: task.id, ownerId: to.id };
  }

  // -------------------------------------------------------------------------
  // Rules

  /** Throws unless `fromId` may pass `task` to `toId` now; returns the colleague. */
  private async check(orgId: string, task: TaskRow, fromId: string, toId: string): Promise<Person> {
    const why = this.taskProblem(task, fromId);
    if (why) throw new BadRequestException(why);
    if (toId === fromId) throw new BadRequestException('Pick a colleague, not yourself');
    const [from, to] = await Promise.all([this.person(orgId, fromId), this.person(orgId, toId, true)]);
    if (!from?.departmentId) throw new BadRequestException("You aren't in a department yet. Ask HR to add you to one.");
    if (!to) throw new BadRequestException('That person is not an active team member');
    if (to.departmentId !== from.departmentId) throw new ForbiddenException('You can pass tasks only to people in your own department. Ask your Department Head to move it elsewhere.');
    const week = this.weekOf(task);
    const cell = (await this.capacity.loads(orgId, [to.id], [week])).get(to.id)![0];
    const fit = this.fit(to, task, cell);
    if (fit.blocked) throw new BadRequestException(fit.blocked);
    return to;
  }

  private taskProblem(task: TaskRow, fromId: string): string | null {
    if (task.ownerId !== fromId) return 'Only the person doing the task can pass it';
    if (task.archivedAt) return 'This task is archived';
    if (task.isDraft) return 'Drafts are assigned when they are activated';
    if (NOT_PASSABLE_KINDS.includes(task.kind)) return 'QC reviews and client-review steps can’t be passed. Ask your Department Head.';
    if (!(TASK_PASS_STATUSES as readonly string[]).includes(task.status)) return task.status === 'in_qc' ? 'This task is in QC: it can’t be passed now' : 'Only open tasks can be passed';
    return null;
  }

  /** Leave on the deadline or no hours that week blocks; going past free hours only warns. */
  private fit(p: { name: string }, task: TaskRow, cell: WeekLoad) {
    const available = cell.availableHours;
    const free = round1(available - cell.bookedHours - cell.taskHours);
    const due = task.deadline ? istDay(task.deadline) : null;
    const hours = round1((task.estimateMin ?? DEFAULT_TASK_MIN) / 60);
    let blocked: string | null = null;
    if (due && due >= todayIst() && cell.leaveDates.includes(due)) blocked = `${p.name} is on approved leave on ${due} (the deadline)`;
    else if (available <= 0) blocked = cell.leaveDays ? `${p.name} is on approved leave that week` : `${p.name} has no working hours that week (holidays)`;
    const warning = !blocked && hours > free ? `${p.name} has only ${Math.max(0, free)}h free that week; this task is about ${hours}h` : null;
    return { available, free, blocked, warning };
  }

  /** The week the task counts in on the heatmap: its deadline week, or this week when overdue or undated. */
  private weekOf(task: TaskRow) {
    const thisWeek = mondayOf(todayIst());
    if (!task.deadline) return thisWeek;
    const wk = mondayOf(istDay(task.deadline));
    return wk < thisWeek ? thisWeek : wk;
  }

  // -------------------------------------------------------------------------
  // Loading

  private assertStaff(me: Me) {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
  }

  private async task(orgId: string, id: string): Promise<TaskRow> {
    const t = await this.prisma.task.findFirst({
      where: { id, orgId },
      select: { id: true, orgId: true, title: true, ownerId: true, status: true, kind: true, archivedAt: true, isDraft: true, deadline: true, estimateMin: true, departmentId: true },
    });
    if (!t) throw new NotFoundException('Task not found');
    return t;
  }

  private person(orgId: string, id: string, activeOnly = false): Promise<Person | null> {
    return this.prisma.user.findFirst({
      where: { id, orgId, type: 'staff', deletedAt: null, ...(activeOnly ? { status: 'active' } : {}) },
      select: { id: true, name: true, specialty: true, departmentId: true },
    });
  }

  private async clientNames(engagementIds: (string | null)[]) {
    const ids = [...new Set(engagementIds.filter((x): x is string => !!x))];
    if (!ids.length) return new Map<string, string>();
    const engs = await this.prisma.engagement.findMany({ where: { id: { in: ids } }, select: { id: true, clientOrg: { select: { name: true } } } });
    return new Map(engs.map((e) => [e.id, e.clientOrg.name]));
  }

  private async rows(reqs: ApprovalRow[]): Promise<PassRequestRow[]> {
    if (!reqs.length) return [];
    const [tasks, names] = await Promise.all([
      this.prisma.task.findMany({ where: { id: { in: reqs.map((r) => r.targetId) } }, select: { id: true, title: true, deadline: true } }),
      this.people.names(reqs.flatMap((r) => [r.requestedById, r.approverId])),
    ]);
    const byId = new Map(tasks.map((t) => [t.id, t]));
    return reqs.map((r) => {
      const t = byId.get(r.targetId);
      const p = r.payload as { note?: string };
      return {
        id: r.id,
        taskId: r.targetId,
        task: t?.title ?? 'Task',
        deadline: t?.deadline?.toISOString() ?? null,
        fromId: r.requestedById,
        from: names.get(r.requestedById) ?? 'Someone',
        toId: r.approverId ?? '',
        to: (r.approverId && names.get(r.approverId)) || 'Someone',
        note: p.note ?? null,
        createdAt: r.createdAt.toISOString(),
        expiresAt: r.expiresAt.toISOString(),
      };
    });
  }
}
