// v11 core: the reassignment engine's built-in targets: `task`, `deliverable` (its open work) and `qc` (QC reviewer).
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { addWorkingDays, craftSpecialtyForStep, istDate, type Me } from '@bmu/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { calendarFor } from '../../production/generate.js';
import { hasRole, isLeader, OPEN_TASK } from '../people.js';
import { ActionsRegistry, type ReassignApplyInput, type ReassignItem, type ReassignTarget, type UndoRow } from '../registry.js';
import { TaskAccess, type TaskFull } from './task-access.js';

/** Base roles that make up the assignable team (same as the Manager workspace). */
export const TASK_TEAM_ROLES = ['producer', 'strategist', 'qc_reviewer', 'intern', 'account_manager', 'am_lead', 'department_head'];
const QC_ROLES = ['qc_reviewer', 'department_head', 'founder'];
const REVIEW_ROLES = ['account_manager', 'am_lead', 'founder', 'admin'];

const isOpenTask = (t: { status: string; archivedAt: Date | null; isDraft: boolean }) => (OPEN_TASK as readonly string[]).includes(t.status) && !t.archivedAt && !t.isDraft;

@Injectable()
export class TaskTargets implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TaskAccess,
    private readonly registry: ActionsRegistry,
  ) {}

  onModuleInit() {
    this.registry.registerReassignTarget(this.taskTarget('task', 'Task'));
    this.registry.registerReassignTarget(this.taskTarget('qc', 'QC review'));
    this.registry.registerReassignTarget(this.deliverableTarget());
  }

  // -------------------------------------------------------------------------
  // Shared bits

  async toItems(rows: TaskFull[]): Promise<ReassignItem[]> {
    const ids = rows.map((t) => t.id);
    const dependents = ids.length ? await this.prisma.task.findMany({ where: { dependsOn: { hasSome: ids }, status: { in: [...OPEN_TASK] }, archivedAt: null }, select: { title: true, dependsOn: true } }) : [];
    const engs = new Map<string, { amId: string | null; clientOrgId: string }>();
    const missing = rows.filter((t) => !t.deliverable && t.engagementId).map((t) => t.engagementId!);
    if (missing.length) for (const e of await this.prisma.engagement.findMany({ where: { id: { in: missing } }, select: { id: true, amId: true, clientOrgId: true } })) engs.set(e.id, e);
    return rows.map((t) => {
      const eng = t.deliverable?.cycle.engagement;
      return {
        id: t.id,
        title: t.title,
        ownerId: t.ownerId,
        deadline: t.deadline,
        status: t.status,
        inProgress: ['in_progress', 'blocked', 'in_qc'].includes(t.status) || !!t.startedAt || t.timeLoggedMin > 0,
        clientDueAt: t.kind === 'client_review' ? t.deadline : (t.deliverable?.dueAt ?? null),
        clientOrgId: eng?.clientOrg.id ?? (t.engagementId ? engs.get(t.engagementId)?.clientOrgId : null) ?? null,
        amId: eng?.amId ?? (t.engagementId ? engs.get(t.engagementId)?.amId : null) ?? null,
        departmentId: t.departmentId ?? t.deliverable?.departmentId ?? null,
        specialty: t.specialty ?? craftSpecialtyForStep(t.flowStep),
        hours: t.estimateMin ? t.estimateMin / 60 : 4,
        dependents: dependents.filter((d) => d.dependsOn.includes(t.id)).map((d) => d.title),
        href: `/team/tasks/${t.id}`,
      };
    });
  }

  private async loadTasks(me: Me, ids: string[], kind?: string) {
    const rows: TaskFull[] = [];
    for (const id of ids) {
      const t = await this.access.load(me, id);
      if (kind && t.kind !== kind) throw new BadRequestException(`"${t.title}" is not a ${kind === 'qc' ? 'QC review' : kind} task`);
      if (!isOpenTask(t)) throw new BadRequestException(`"${t.title}" is ${t.archivedAt ? 'archived' : t.isDraft ? 'a draft' : t.status === 'done' ? 'already done' : 'cancelled'} and can't be reassigned`);
      rows.push(t);
    }
    return rows;
  }

  private async deptScope(me: Me): Promise<Prisma.UserWhereInput> {
    if (isLeader(me) || !hasRole(me, 'department_head')) return {};
    const dept = await this.access.myDepartment(me);
    return dept ? { departmentId: dept } : {};
  }

  private snapshotTasks(rows: { id: string; ownerId: string | null; deadline: Date | null; deadlineChanges?: number }[]): UndoRow[] {
    return rows.map((t) => ({ model: 'task', id: t.id, data: { ownerId: t.ownerId, deadline: t.deadline?.toISOString() ?? null, ...(t.deadlineChanges !== undefined ? { deadlineChanges: t.deadlineChanges } : {}) } }));
  }

  // -------------------------------------------------------------------------
  // task / qc

  private taskTarget(type: 'task' | 'qc', label: string): ReassignTarget {
    const kind = type === 'qc' ? 'qc' : undefined;
    const rowsById = new Map<string, TaskFull>();
    return {
      type,
      label,
      auditEntity: 'Task',
      href: (i) => `/team/tasks/${i.id}`,
      load: async (me, ids) => {
        const rows = await this.loadTasks(me, ids, kind);
        for (const r of rows) rowsById.set(r.id, r);
        return this.toItems(rows);
      },
      assertCanReassign: async (me, items) => {
        if (!hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'account_manager', 'strategist')) {
          throw new ForbiddenException('Producers can’t assign work to other people. Use “Can’t take this” to hand a task back to your manager.');
        }
        if (type === 'qc' && !hasRole(me, 'founder', 'admin', 'am_lead', 'department_head')) throw new ForbiddenException('Only a department head can assign QC reviewers');
        for (const i of items) {
          const t = rowsById.get(i.id) ?? (await this.access.load(me, i.id));
          await this.access.assertManage(me, t);
        }
      },
      eligibility: async (me, items) => {
        const rows = items.map((i) => rowsById.get(i.id)).filter((x): x is TaskFull => !!x);
        const kinds = new Set(rows.map((r) => r.kind));
        const roles = type === 'qc' || kinds.has('qc') ? QC_ROLES : kinds.has('client_review') ? REVIEW_ROLES : TASK_TEAM_ROLES;
        const uploaders = new Set(rows.filter((r) => r.kind === 'qc').map((r) => r.deliverable?.versions[0]?.uploadedById).filter(Boolean));
        return {
          where: { AND: [{ roles: { some: { role: { baseRole: { in: roles } } } } }, await this.deptScope(me)] },
          departmentId: items[0]?.departmentId ?? null,
          specialty: items[0]?.specialty ?? null,
          blocked: (u) => {
            if (uploaders.has(u.id)) return `${u.name} uploaded the version, so they can't QC it`;
            if (kinds.has('qc') && kinds.size > 1) return null;
            return null;
          },
        };
      },
      snapshot: async (items) => {
        const rows = await this.prisma.task.findMany({ where: { id: { in: items.map((i) => i.id) } }, select: { id: true, ownerId: true, deadline: true, deadlineChanges: true } });
        return this.snapshotTasks(rows);
      },
      apply: async (_me, items, change: ReassignApplyInput) => {
        for (const i of items) {
          const due = change.deadlines.get(i.id);
          const data: Prisma.TaskUncheckedUpdateInput = { ownerId: change.to.id };
          if (due !== undefined) {
            data.deadline = due;
            if ((due?.getTime() ?? 0) !== (i.deadline?.getTime() ?? 0)) data.deadlineChanges = { increment: 1 };
          }
          await this.prisma.task.update({ where: { id: i.id }, data });
        }
      },
      openWorkOf: async (orgId, userId) => {
        const rows = await this.prisma.task.findMany({
          where: { orgId, ownerId: userId, status: { in: [...OPEN_TASK] }, archivedAt: null, isDraft: false, ...(kind ? { kind } : { kind: { not: 'qc' } }) },
          include: { deliverable: { select: { cycle: { select: { engagement: { select: { clientOrg: { select: { name: true } } } } } } } } },
          orderBy: { deadline: 'asc' },
          take: 300,
        });
        return rows.map((t) => ({ id: t.id, title: t.title, deadline: t.deadline, status: t.status, client: t.deliverable?.cycle.engagement.clientOrg.name ?? null }));
      },
    };
  }

  // -------------------------------------------------------------------------
  // deliverable: moves the deliverable's open work tasks (the maker), keeps QC and client review as they are

  private deliverableTarget(): ReassignTarget {
    const work = (id: string) => this.prisma.task.findMany({ where: { deliverableId: id, kind: { in: ['work', 'planning'] }, status: { in: [...OPEN_TASK] }, archivedAt: null, isDraft: false }, orderBy: { sort: 'asc' } });
    return {
      type: 'deliverable',
      label: 'Deliverable',
      auditEntity: 'Deliverable',
      href: (i) => `/team/deliverables/${i.id}`,
      load: async (me, ids) => {
        if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
        const items: ReassignItem[] = [];
        for (const id of ids) {
          const d = await this.prisma.deliverable.findFirst({ where: { id, orgId: me.orgId }, include: { cycle: { select: { engagement: { select: { id: true, amId: true, clientOrgId: true } } } } } });
          if (!d) throw new NotFoundException('Deliverable not found');
          const tasks = await work(id);
          if (!tasks.length) throw new BadRequestException(`"${d.title}" has no open work to reassign`);
          const owner = tasks.find((t) => t.ownerId)?.ownerId ?? null;
          items.push({
            id: d.id,
            title: d.title,
            ownerId: owner,
            deadline: tasks.find((t) => t.ownerId === owner)?.deadline ?? d.dueAt,
            status: d.status,
            inProgress: tasks.some((t) => t.status === 'in_progress' || t.timeLoggedMin > 0),
            clientDueAt: d.dueAt,
            clientOrgId: d.cycle.engagement.clientOrgId,
            amId: d.cycle.engagement.amId,
            departmentId: d.departmentId,
            specialty: craftSpecialtyForStep(tasks[0]?.flowStep),
            hours: tasks.filter((t) => t.ownerId === owner).reduce((s, t) => s + (t.estimateMin ? t.estimateMin / 60 : 4), 0) || 4,
            href: `/team/deliverables/${d.id}`,
          });
        }
        return items;
      },
      assertCanReassign: async (me, items) => {
        for (const i of items) {
          if (isLeader(me)) continue;
          if (hasRole(me, 'department_head') && i.departmentId && i.departmentId === (await this.access.myDepartment(me))) continue;
          if (hasRole(me, 'account_manager') && i.amId === me.id) continue;
          throw new ForbiddenException('Only the department head or the client manager can reassign this deliverable');
        }
      },
      eligibility: async (me, items) => ({ where: { AND: [{ roles: { some: { role: { baseRole: { in: TASK_TEAM_ROLES } } } } }, await this.deptScope(me)] }, departmentId: items[0]?.departmentId ?? null, specialty: items[0]?.specialty ?? null }),
      snapshot: async (items) => {
        const rows = (await Promise.all(items.map((i) => work(i.id)))).flat();
        return this.snapshotTasks(rows.filter((t) => items.some((i) => i.id === t.deliverableId && t.ownerId === i.ownerId)));
      },
      apply: async (me, items, change) => {
        const cal = await calendarFor(this.prisma, me.orgId);
        const handling = change.input.deadline;
        for (const i of items) {
          const tasks = (await work(i.id)).filter((t) => t.ownerId === i.ownerId || !t.ownerId);
          for (const t of tasks) {
            const data: Prisma.TaskUncheckedUpdateInput = { ownerId: change.to.id };
            if (handling?.mode === 'extend' && t.deadline) data.deadline = new Date(`${istDate(addWorkingDays(t.deadline, handling.days, cal))}T18:00:00+05:30`);
            if (handling?.mode === 'set') data.deadline = change.deadlines.get(i.id) ?? t.deadline;
            if (data.deadline) data.deadlineChanges = { increment: 1 };
            await this.prisma.task.update({ where: { id: t.id }, data });
          }
        }
      },
    };
  }
}
