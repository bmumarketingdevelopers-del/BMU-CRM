// v11 core: who can see and who can manage a task. Same scopes as the Manager workspace and Production:
// leadership everything; department heads their department; AMs their clients' tasks; strategists their own
// engagements; everyone their own work, what they watch and (for 7 days) what was moved away from them.
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hasRole, isLeader } from '../people.js';

export const taskDetailInclude = {
  owner: { select: { id: true, name: true, departmentId: true } },
  deliverable: {
    select: {
      id: true,
      title: true,
      type: true,
      status: true,
      dueAt: true,
      departmentId: true,
      versions: { orderBy: { number: 'desc' as const }, take: 1, select: { uploadedById: true } },
      cycle: { select: { engagementId: true, engagement: { select: { id: true, amId: true, currentGate: true, clientOrg: { select: { id: true, name: true } }, service: { select: { name: true } } } } } },
    },
  },
} satisfies Prisma.TaskInclude;
export type TaskFull = Prisma.TaskGetPayload<{ include: typeof taskDetailInclude }>;

export type TaskCtx = { engagement: { id: string; amId: string | null; currentGate: string; clientOrg: { id: string; name: string }; service: { name: string } } | null };

@Injectable()
export class TaskAccess {
  constructor(private readonly prisma: PrismaService) {}

  async myDepartment(me: Me) {
    return (await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } }))?.departmentId ?? null;
  }

  /** Engagements a strategist works on: any task they own there, or engagements of AMs in their team. */
  async strategistEngagements(me: Me): Promise<string[]> {
    const [own, self] = await Promise.all([
      this.prisma.task.findMany({ where: { orgId: me.orgId, ownerId: me.id, engagementId: { not: null } }, select: { engagementId: true }, distinct: ['engagementId'] }),
      this.prisma.user.findUnique({ where: { id: me.id }, select: { teamId: true } }),
    ]);
    const team = self?.teamId ? await this.prisma.engagement.findMany({ where: { orgId: me.orgId, am: { teamId: self.teamId } }, select: { id: true } }) : [];
    return [...new Set([...own.map((t) => t.engagementId!), ...team.map((e) => e.id)])];
  }

  async amEngagements(me: Me): Promise<string[]> {
    return (await this.prisma.engagement.findMany({ where: { orgId: me.orgId, amId: me.id }, select: { id: true } })).map((e) => e.id);
  }

  /** Tasks `me` can see. */
  async visibleWhere(me: Me): Promise<Prisma.TaskWhereInput> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    if (isLeader(me)) return { orgId: me.orgId };
    const or: Prisma.TaskWhereInput[] = [{ ownerId: me.id }, { createdById: me.id }];
    const [watched, moved] = await Promise.all([
      this.prisma.watcher.findMany({ where: { userId: me.id, targetType: 'task' }, select: { targetId: true } }),
      this.prisma.assignment.findMany({ where: { orgId: me.orgId, targetType: 'task', fromUserId: me.id, readAccessUntil: { gt: new Date() } }, select: { targetId: true } }),
    ]);
    const extra = [...watched.map((w) => w.targetId), ...moved.map((m) => m.targetId)];
    if (extra.length) or.push({ id: { in: extra } });
    if (hasRole(me, 'department_head')) {
      const dept = await this.myDepartment(me);
      if (dept) or.push({ departmentId: dept }, { owner: { departmentId: dept } });
    }
    if (hasRole(me, 'account_manager')) {
      const ids = await this.amEngagements(me);
      or.push({ engagementId: { in: ids } }, { deliverable: { cycle: { engagement: { amId: me.id } } } });
    }
    if (hasRole(me, 'strategist')) or.push({ engagementId: { in: await this.strategistEngagements(me) } });
    if (hasRole(me, 'qc_reviewer')) or.push({ kind: 'qc' });
    return { orgId: me.orgId, OR: or };
  }

  async load(me: Me, id: string): Promise<TaskFull> {
    const t = await this.prisma.task.findFirst({ where: { AND: [{ id }, await this.visibleWhere(me)] }, include: taskDetailInclude });
    if (t) return t;
    const exists = await this.prisma.task.findFirst({ where: { id, orgId: me.orgId }, select: { id: true } });
    if (exists) throw new ForbiddenException("You don't have access to this task");
    throw new NotFoundException('Task not found');
  }

  async engagementOf(t: { engagementId: string | null; deliverable?: TaskFull['deliverable'] }): Promise<TaskCtx['engagement']> {
    if (t.deliverable?.cycle.engagement) return t.deliverable.cycle.engagement;
    if (!t.engagementId) return null;
    return this.prisma.engagement.findUnique({ where: { id: t.engagementId }, select: { id: true, amId: true, currentGate: true, clientOrg: { select: { id: true, name: true } }, service: { select: { name: true } } } });
  }

  /**
   * Manager rights on a task (edit, reassign, deadline, duplicate, archive): leadership; the department head of the
   * task's (or owner's) department; the AM of the client; a strategist on their own engagements; the author of an
   * internal task. Returns null when allowed, or the reason it isn't.
   */
  async manageDenied(me: Me, t: { departmentId: string | null; createdById: string | null; isInternal: boolean; engagementId: string | null; owner?: { departmentId: string | null } | null; deliverable?: TaskFull['deliverable'] }): Promise<string | null> {
    if (me.type !== 'staff') return 'Team accounts only';
    if (isLeader(me)) return null;
    if (t.isInternal && t.createdById === me.id && hasRole(me, 'department_head', 'account_manager', 'strategist')) return null;
    if (hasRole(me, 'department_head')) {
      const dept = await this.myDepartment(me);
      if (dept && (t.departmentId === dept || t.owner?.departmentId === dept || t.deliverable?.departmentId === dept)) return null;
    }
    const eng = await this.engagementOf(t);
    if (hasRole(me, 'account_manager') && eng?.amId === me.id) return null;
    if (hasRole(me, 'strategist') && eng && (await this.strategistEngagements(me)).includes(eng.id)) return null;
    if (hasRole(me, 'department_head', 'account_manager', 'strategist')) return eng ? "This task belongs to another manager's client" : 'This task is outside your department';
    return 'Only a department head, the account manager or the strategist can do this';
  }

  async assertManage(me: Me, t: Parameters<TaskAccess['manageDenied']>[1]) {
    const why = await this.manageDenied(me, t);
    if (why) throw new ForbiddenException(why);
  }
}
