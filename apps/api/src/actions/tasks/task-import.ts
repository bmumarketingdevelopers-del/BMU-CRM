// v11 core: CSV import of tasks (the first ImportEntity; other areas copy this shape for people, clients, leads, creators).
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { CORE_TASK_PRIORITIES, type Me } from '@bmu/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hasRole, isLeader, OPEN_TASK } from '../people.js';
import { ActionsRegistry } from '../registry.js';
import { TasksActionsService } from './tasks.service.js';

const gateNo = (g: string) => Number(/^G(\d)/.exec(g)?.[1] ?? 0);

@Injectable()
export class TaskImport implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ActionsRegistry,
    private readonly tasks: TasksActionsService,
  ) {}

  onModuleInit() {
    this.registry.registerImportEntity({
      entity: 'tasks',
      label: 'Tasks',
      fields: [
        { key: 'title', label: 'Title', required: true },
        { key: 'client', label: 'Client', required: true, hint: 'Client name, or "Internal"' },
        { key: 'department', label: 'Department', required: true },
        { key: 'assignee', label: 'Assignee', required: true, hint: 'Email or full name' },
        { key: 'deadline', label: 'Deadline', required: true, hint: 'YYYY-MM-DD' },
        { key: 'priority', label: 'Priority', required: false, hint: 'urgent, high, normal or low' },
        { key: 'description', label: 'Description', required: false },
        { key: 'estimate_hours', label: 'Estimate (hours)', required: false },
      ],
      sampleCsv: 'Title,Client,Department,Assignee,Deadline,Priority,Description,Estimate (hours)\nMonthly report,Internal,Account Management,am@bmu.demo,2026-10-20,normal,Prepare the October report,2\n',
      canImport: (me) => hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'account_manager'),
      validate: (me, rows) => this.validate(me, rows),
      commit: async (me, rows, ip) => {
        const resolved = await this.resolve(me, rows);
        const ids: string[] = [];
        for (const r of resolved) {
          const res = await this.tasks.create(me, { title: r.title, engagementId: r.engagementId, internal: r.internal, departmentId: r.departmentId!, ownerId: r.ownerId!, deadline: r.deadline, priority: r.priority, description: r.description || undefined, estimateHours: r.estimate ?? undefined }, ip);
          ids.push(res.task.id);
        }
        return ids;
      },
    });
  }

  private async resolve(me: Me, rows: Record<string, string>[]) {
    const [depts, people, engs] = await Promise.all([
      this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, name: true } }),
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: 'active' }, select: { id: true, name: true, email: true } }),
      this.prisma.engagement.findMany({ where: { orgId: me.orgId, deletedAt: null, archivedAt: null, ...(isLeader(me) || hasRole(me, 'department_head') ? {} : { amId: me.id }) }, include: { clientOrg: { select: { name: true } } }, orderBy: { createdAt: 'desc' } }),
    ]);
    const lc = (s: string | undefined) => (s ?? '').trim().toLowerCase();
    return rows.map((r) => {
      const internal = lc(r.client) === 'internal';
      const clientEngs = internal ? [] : engs.filter((e) => lc(e.clientOrg.name) === lc(r.client));
      const eng = clientEngs.sort((a, b) => gateNo(b.currentGate) - gateNo(a.currentGate))[0] ?? null;
      const dept = depts.find((d) => lc(d.name) === lc(r.department)) ?? null;
      const owner = people.find((p) => lc(p.email ?? '') === lc(r.assignee)) ?? people.find((p) => lc(p.name) === lc(r.assignee)) ?? null;
      const pr = lc(r.priority) || 'normal';
      const est = r.estimate_hours ? Number(r.estimate_hours) : null;
      return { title: (r.title ?? '').trim(), internal, engagementId: eng?.id ?? null, eng, departmentId: dept?.id ?? null, ownerId: owner?.id ?? null, deadline: (r.deadline ?? '').trim(), priority: (CORE_TASK_PRIORITIES as readonly string[]).includes(pr) ? (pr as (typeof CORE_TASK_PRIORITIES)[number]) : ('normal' as const), priorityOk: (CORE_TASK_PRIORITIES as readonly string[]).includes(pr), description: r.description ?? '', estimate: est, estimateOk: est === null || (Number.isFinite(est) && est > 0 && est <= 500) };
    });
  }

  private async validate(me: Me, rows: Record<string, string>[]) {
    const resolved = await this.resolve(me, rows);
    const manager = hasRole(me, 'founder', 'admin', 'am_lead', 'department_head', 'account_manager', 'strategist');
    const out: { errors: string[]; duplicate: string | null }[] = [];
    for (const [i, r] of resolved.entries()) {
      const errors: string[] = [];
      if (r.title && r.title.length < 3) errors.push('Title is too short');
      if (rows[i].client && !r.internal && !r.eng) errors.push(`No client you manage is called "${rows[i].client}"`);
      if (r.eng && gateNo(r.eng.currentGate) < 3) errors.push(`${r.eng.clientOrg.name} is at ${r.eng.currentGate} (tasks need Gate 3 or later)`);
      if (rows[i].department && !r.departmentId) errors.push(`Unknown department "${rows[i].department}"`);
      if (rows[i].assignee && !r.ownerId) errors.push(`Nobody active matches "${rows[i].assignee}"`);
      if (r.ownerId && !manager && r.ownerId !== me.id) errors.push('You can only import tasks for yourself');
      if (r.deadline && (!/^\d{4}-\d{2}-\d{2}$/.test(r.deadline) || Number.isNaN(Date.parse(r.deadline)))) errors.push('Deadline must look like 2026-10-20');
      if (!r.priorityOk) errors.push('Priority must be urgent, high, normal or low');
      if (!r.estimateOk) errors.push('Estimate must be a number of hours');
      let duplicate: string | null = null;
      if (r.title && r.ownerId) {
        const dup = await this.prisma.task.findFirst({ where: { orgId: me.orgId, title: { equals: r.title, mode: 'insensitive' }, ownerId: r.ownerId, status: { in: [...OPEN_TASK] }, archivedAt: null }, select: { id: true } });
        if (dup) duplicate = 'An open task with this title already exists for this person';
      }
      out.push({ errors, duplicate });
    }
    return out;
  }
}
