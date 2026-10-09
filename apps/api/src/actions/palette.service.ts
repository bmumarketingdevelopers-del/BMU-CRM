// v11 core: Ctrl/Cmd+K actions. Parses a typed phrase ("new task for Aroma", "reassign Reel 03 to Arjun",
// "add user to Design") and resolves the names to records the person can see, so the palette opens the right drawer
// pre-filled.
import { ForbiddenException, Injectable } from '@nestjs/common';
import { coreParsePaletteIntent, type CorePaletteResult, type Me } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { hasRole, isLeader } from './people.js';
import { TaskAccess } from './tasks/task-access.js';

const LIVE = ['onboarding', 'blocked', 'planning', 'awaiting_plan_approval', 'in_production', 'in_review', 'awaiting_final_payment', 'active_retainer', 'paused'] as const;

@Injectable()
export class PaletteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: TaskAccess,
  ) {}

  async resolve(me: Me, q: string | undefined): Promise<CorePaletteResult> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const intent = coreParsePaletteIntent(q ?? '');
    const out: CorePaletteResult = { intent, actions: [] };
    if (!intent) return out;
    if (intent.kind === 'new_task') {
      if (!intent.client) {
        out.actions.push({ label: 'New task', hint: 'Opens the task form', action: 'new', entity: 'task', prefill: intent.title ? { title: intent.title } : {} });
        return out;
      }
      const engWhere = isLeader(me) || hasRole(me, 'department_head') ? {} : { OR: [{ amId: me.id }, { id: { in: await this.access.strategistEngagements(me) } }] };
      const engs = await this.prisma.engagement.findMany({
        where: { orgId: me.orgId, deletedAt: null, archivedAt: null, status: { in: [...LIVE] }, clientOrg: { name: { contains: intent.client, mode: 'insensitive' } }, ...engWhere },
        include: { clientOrg: { select: { name: true } }, service: { select: { name: true } } },
        take: 5,
        orderBy: { createdAt: 'desc' },
      });
      for (const e of engs) out.actions.push({ label: `New task for ${e.clientOrg.name}`, hint: `${e.service.name} · ${e.currentGate}`, action: 'new', entity: 'task', prefill: { engagementId: e.id, ...(intent.title ? { title: intent.title } : {}) } });
      if (!engs.length) out.actions.push({ label: `New task (no client matches “${intent.client}”)`, hint: 'Pick the client in the form', action: 'new', entity: 'task', prefill: intent.title ? { title: intent.title } : {} });
      return out;
    }
    if (intent.kind === 'reassign_task') {
      const visible = await this.access.visibleWhere(me);
      const [tasks, people] = await Promise.all([
        this.prisma.task.findMany({ where: { AND: [visible, { title: { contains: intent.task, mode: 'insensitive' } }, { status: { in: ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] }, archivedAt: null, isDraft: false }] }, select: { id: true, title: true, owner: { select: { name: true } } }, take: 3 }),
        this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: 'active', name: { contains: intent.person, mode: 'insensitive' } }, select: { id: true, name: true }, take: 2 }),
      ]);
      for (const t of tasks) for (const p of people) out.actions.push({ label: `Reassign “${t.title}” to ${p.name}`, hint: t.owner ? `Now with ${t.owner.name}` : 'Unassigned', action: 'reassign', entity: 'task', targetIds: [t.id], prefill: { toUserId: p.id } });
      if (!out.actions.length) out.actions.push({ label: tasks.length ? `Nobody called “${intent.person}”` : `No open task matches “${intent.task}”`, hint: 'Try a shorter name', action: 'navigate', entity: 'task', prefill: {}, href: '/team/tasks' });
      return out;
    }
    if (intent.kind === 'add_user') {
      const depts = await this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null, name: { contains: intent.department, mode: 'insensitive' } }, select: { id: true, name: true }, take: 3 });
      for (const d of depts) out.actions.push({ label: `Add a person to ${d.name}`, hint: 'Opens the add person form', action: 'new', entity: 'person', prefill: { departmentId: d.id }, href: `/admin/users?invite=1&department=${d.id}` });
      if (!depts.length) out.actions.push({ label: `No department matches “${intent.department}”`, hint: 'Open Departments & Teams', action: 'navigate', entity: 'person', prefill: {}, href: '/admin/departments' });
      return out;
    }
    out.actions.push({ label: `New ${intent.entity}`, hint: 'Opens the form', action: 'new', entity: intent.entity, prefill: {} });
    return out;
  }
}
