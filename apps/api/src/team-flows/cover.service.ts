import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { istDate, type Me, type TeamLeaveCover, type TeamWhoIsOut } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { ReassignService } from '../actions/reassign.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { addDays, dayStr, dbDay, hasRole, isHrApprover, isStaff } from './access.js';

const OPEN = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const DAY = 86_400_000;

/** Leave cover: tasks due while someone is away, and who is out on which day. */
@Injectable()
export class CoverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly reassignEngine: ReassignService,
  ) {}

  private async leaveFor(me: Me, id: string) {
    if (!isStaff(me)) throw new ForbiddenException('Team accounts only');
    const l = await this.prisma.leaveRequest.findFirst({ where: { id, orgId: me.orgId } });
    if (!l) throw new NotFoundException('Leave request not found');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: l.userId }, select: { id: true, name: true, managerId: true, departmentId: true } });
    const isHead = hasRole(me, 'department_head') && !!user.departmentId && !!(await this.prisma.department.findFirst({ where: { id: user.departmentId, headUserId: me.id } }));
    const manages = isHrApprover(me) || user.managerId === me.id || isHead || hasRole(me, 'am_lead');
    if (!manages) throw new ForbiddenException("Only this person's manager, department head or HR can arrange cover");
    return { l, user };
  }

  async cover(me: Me, id: string): Promise<TeamLeaveCover> {
    const { l, user } = await this.leaveFor(me, id);
    const from = dayStr(l.from);
    const to = dayStr(l.to);
    const tasks = await this.prisma.task.findMany({
      where: { orgId: me.orgId, ownerId: l.userId, status: { in: [...OPEN] }, deadline: { gte: new Date(`${from}T00:00:00+05:30`), lt: new Date(new Date(`${to}T00:00:00+05:30`).getTime() + DAY) } },
      include: { deliverable: { select: { id: true, cycle: { select: { engagement: { select: { clientOrg: { select: { name: true } } } } } } } } },
      orderBy: { deadline: 'asc' },
    });
    // Suggested cover: people in the same department first, then everyone, with their open load.
    const staff = await this.prisma.user.findMany({
      where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, id: { not: l.userId } },
      select: { id: true, name: true, departmentId: true },
      orderBy: { name: 'asc' },
    });
    const [load, away] = await Promise.all([
      this.prisma.task.groupBy({ by: ['ownerId'], where: { orgId: me.orgId, ownerId: { in: staff.map((s) => s.id) }, status: { in: [...OPEN] } }, _count: true }),
      this.prisma.leaveRequest.findMany({ where: { orgId: me.orgId, status: 'approved', from: { lte: l.to }, to: { gte: l.from }, userId: { in: staff.map((s) => s.id) } }, select: { userId: true } }),
    ]);
    const people = staff
      .map((s) => ({ id: s.id, name: s.name, onLeave: away.some((a) => a.userId === s.id), openTasks: load.find((x) => x.ownerId === s.id)?._count ?? 0, same: s.departmentId === user.departmentId }))
      .sort((a, b) => Number(b.same) - Number(a.same) || Number(a.onLeave) - Number(b.onLeave) || a.openTasks - b.openTasks)
      .map(({ same: _same, ...p }) => p);
    return {
      leave: { id: l.id, user: { id: user.id, name: user.name }, from, to, type: l.type, status: l.status, stage: l.stage },
      tasks: tasks.map((t) => ({
        id: t.id,
        title: t.title,
        deadline: t.deadline?.toISOString() ?? null,
        client: t.deliverable?.cycle.engagement.clientOrg.name ?? null,
        href: t.deliverableId ? `/team/deliverables/${t.deliverableId}` : t.engagementId ? `/team/projects/${t.engagementId}` : null,
      })),
      people,
    };
  }

  async reassign(me: Me, id: string, taskIds: string[], toUserId: string, ip?: string) {
    const { l, user } = await this.leaveFor(me, id);
    if (!taskIds.length) throw new BadRequestException('Pick at least one task');
    const to = await this.prisma.user.findFirst({ where: { id: toUserId, orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null } });
    if (!to) throw new BadRequestException('Pick an active team member');
    if (to.id === l.userId) throw new BadRequestException(`${user.name} is the one on leave`);
    const movable = await this.prisma.task.findMany({ where: { id: { in: taskIds }, orgId: me.orgId, ownerId: l.userId }, select: { id: true } });
    const moved = await this.prisma.task.updateMany({ where: { id: { in: taskIds }, orgId: me.orgId, ownerId: l.userId }, data: { ownerId: to.id } });
    if (!moved.count) throw new BadRequestException('Those tasks were already moved');
    await this.audit.log(me, 'leave.cover_assigned', 'LeaveRequest', id, { ownerId: l.userId }, { toUserId: to.id, toName: to.name, tasks: moved.count }, ip);
    await this.reassignEngine.record(me, 'task', movable.map((t) => ({ id: t.id, fromUserId: l.userId, toUserId: to.id })), 'leave', 'Leave cover');
    for (const tid of taskIds) await this.audit.log(me, 'task.reassigned', 'Task', tid, { ownerId: l.userId }, { ownerId: to.id, reason: 'leave cover' }, ip);
    await this.notifications.notify(me.orgId, [to.id], { kind: 'task_assigned', title: `You are covering ${moved.count} task${moved.count > 1 ? 's' : ''} for ${user.name} (on leave ${dayStr(l.from)} to ${dayStr(l.to)})`, link: '/team/tasks' });
    return this.cover(me, id);
  }

  /** Approved leave per day in a window (default: today + 13 days). Every team member can see who is out. */
  async whoIsOut(me: Me, fromRaw?: string, toRaw?: string): Promise<TeamWhoIsOut> {
    if (!isStaff(me)) throw new ForbiddenException('Team accounts only');
    const valid = (s?: string) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined);
    const from = valid(fromRaw) ?? istDate(new Date());
    let to = valid(toRaw) ?? addDays(from, 13);
    if (to < from) throw new BadRequestException('The end date is before the start date');
    if (dbDay(to).getTime() - dbDay(from).getTime() > 62 * DAY) to = addDays(from, 62);
    const leaves = await this.prisma.leaveRequest.findMany({ where: { orgId: me.orgId, status: 'approved', from: { lte: dbDay(to) }, to: { gte: dbDay(from) } } });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(leaves.map((l) => l.userId))] }, deletedAt: null }, select: { id: true, name: true } });
    const out: TeamWhoIsOut = [];
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const people = leaves
        .filter((l) => dayStr(l.from) <= d && dayStr(l.to) >= d)
        .map((l) => ({ id: l.userId, name: users.find((u) => u.id === l.userId)?.name ?? '', type: l.type, to: dayStr(l.to) }))
        .filter((p) => p.name);
      if (people.length) out.push({ date: d, people });
    }
    return out;
  }
}
