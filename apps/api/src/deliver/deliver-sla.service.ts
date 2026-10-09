// v10 deliver: delivery SLA and escalation. Each deliverable has a due date from the plan and each step a
// deadline. At-risk (due within a working day) and overdue items show on Projects and My Day; a step overdue by
// more than one working day is escalated once to the department head (built-in job, see DeliverJobsService).
import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { addWorkingDays, isWorkingDay, type DeliverSlaItem, type DeliverSlaView, type Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { isLeadership, visibleEngagementWhere } from '../engagements/engagement-access.js';

const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
/** Deliverables whose clock is on BMU (not done, not waiting on the client). */
const OPEN_DELIVERABLE = ['planned', 'in_production', 'in_qc', 'qc_failed', 'qc_passed', 'changes_requested'] as const;
const LOOKBACK_DAYS = 45;

@Injectable()
export class DeliverSlaService {
  private readonly log = new Logger('DeliverySLA');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private async holidays(orgId: string) {
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: orgId }, select: { settings: true } });
    return ((org.settings ?? {}) as { holidays?: string[] }).holidays ?? [];
  }

  private workingDaysLate(due: Date, now: Date, holidays: string[]) {
    let n = 0;
    const d = new Date(due);
    while (n < 60) {
      d.setUTCDate(d.getUTCDate() + 1);
      if (d > now) break;
      if (isWorkingDay(d, holidays)) n++;
    }
    return n;
  }

  /** Items the person can see. `mine` narrows to what they should act on (My Day). */
  async view(me: Me, opts: { mine?: boolean } = {}): Promise<DeliverSlaView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
    const now = new Date();
    const holidays = await this.holidays(me.orgId);
    const soon = addWorkingDays(now, 1, holidays);
    const since = new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000);
    const engagementScope = await visibleEngagementWhere(this.prisma, me);
    const myDept = (await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } }))?.departmentId ?? null;
    const isHead = me.roles.includes('department_head');

    const taskWhere: Prisma.TaskWhereInput = {
      orgId: me.orgId,
      status: { in: [...OPEN_TASK] },
      kind: { not: 'client_review' },
      deadline: { gte: since, lte: soon },
    };
    const mineTask: Prisma.TaskWhereInput[] = [{ ownerId: me.id }];
    if (isHead && myDept) mineTask.push({ departmentId: myDept });
    if (me.roles.includes('account_manager')) mineTask.push({ deliverable: { cycle: { engagement: { amId: me.id } } } });
    const [tasks, deliverables, escalations] = await Promise.all([
      this.prisma.task.findMany({
        where: opts.mine || !(isLeadership(me) || isHead) ? { AND: [taskWhere, { OR: opts.mine ? mineTask : [...mineTask, { deliverable: { cycle: { engagement: engagementScope } } }] }] } : taskWhere,
        include: { owner: { select: { name: true } }, deliverable: { select: { id: true, title: true, cycle: { select: { engagementId: true, engagement: { select: { clientOrg: { select: { id: true, name: true } } } } } } } } },
        orderBy: { deadline: 'asc' },
        take: 300,
      }),
      this.prisma.deliverable.findMany({
        where: {
          orgId: me.orgId,
          status: { in: [...OPEN_DELIVERABLE] },
          dueAt: { gte: since, lte: soon },
          AND: [
            { cycle: { engagement: engagementScope } },
            ...(opts.mine ? [{ OR: [{ cycle: { engagement: { amId: me.id } } }, { tasks: { some: { ownerId: me.id } } }, ...(isHead && myDept ? [{ departmentId: myDept }] : [])] }] : []),
          ],
        },
        include: { cycle: { select: { engagementId: true, engagement: { select: { clientOrg: { select: { id: true, name: true } } } } } } },
        orderBy: { dueAt: 'asc' },
        take: 300,
      }),
      this.prisma.auditEvent.findMany({ where: { orgId: me.orgId, action: 'task.escalated', at: { gte: since } }, select: { entityId: true } }),
    ]);
    const escalated = new Set(escalations.map((e) => e.entityId));
    const depts = new Map((await this.prisma.department.findMany({ where: { orgId: me.orgId }, select: { id: true, name: true } })).map((d) => [d.id, d.name]));
    const engagementIds = [...new Set(tasks.filter((t) => !t.deliverable && t.engagementId).map((t) => t.engagementId!))];
    const engagements = new Map(
      (await this.prisma.engagement.findMany({ where: { id: { in: engagementIds } }, select: { id: true, clientOrg: { select: { id: true, name: true } } } })).map((e) => [e.id, e.clientOrg]),
    );

    const items: DeliverSlaItem[] = [];
    for (const t of tasks) {
      const client = t.deliverable?.cycle.engagement.clientOrg ?? (t.engagementId ? engagements.get(t.engagementId) : undefined);
      const engagementId = t.deliverable?.cycle.engagementId ?? t.engagementId;
      if (!client || !engagementId) continue;
      const overdue = t.deadline! < now;
      items.push({
        key: `t-${t.id}`,
        state: overdue ? 'overdue' : 'at_risk',
        kind: 'task',
        title: t.deliverable?.title ?? t.title,
        step: t.title.split(':')[0],
        client,
        engagementId,
        deliverableId: t.deliverable?.id ?? null,
        taskId: t.id,
        owner: t.owner?.name ?? null,
        department: t.departmentId ? (depts.get(t.departmentId) ?? null) : null,
        dueAt: t.deadline!.toISOString(),
        workingDaysLate: overdue ? this.workingDaysLate(t.deadline!, now, holidays) : 0,
        escalated: escalated.has(t.id),
      });
    }
    for (const d of deliverables) {
      const overdue = d.dueAt! < now;
      items.push({
        key: `d-${d.id}`,
        state: overdue ? 'overdue' : 'at_risk',
        kind: 'deliverable',
        title: d.title,
        step: null,
        client: d.cycle.engagement.clientOrg,
        engagementId: d.cycle.engagementId,
        deliverableId: d.id,
        taskId: null,
        owner: null,
        department: d.departmentId ? (depts.get(d.departmentId) ?? null) : null,
        dueAt: d.dueAt!.toISOString(),
        workingDaysLate: overdue ? this.workingDaysLate(d.dueAt!, now, holidays) : 0,
        escalated: false,
      });
    }
    items.sort((a, b) => (a.state === b.state ? a.dueAt.localeCompare(b.dueAt) : a.state === 'overdue' ? -1 : 1));
    return {
      overdue: items.filter((i) => i.state === 'overdue').length,
      atRisk: items.filter((i) => i.state === 'at_risk').length,
      escalated: items.filter((i) => i.escalated).length,
      items,
    };
  }

  /** Escalates every step overdue by more than one working day to its department head, once per step. */
  async escalate(now = new Date(), onlyTaskIds?: string[], onlyOrgId?: string): Promise<{ escalated: number }> {
    const orgs = await this.prisma.organisation.findMany({ where: { deletedAt: null, ...(onlyOrgId ? { id: onlyOrgId } : {}) }, select: { id: true } });
    let count = 0;
    for (const org of orgs) {
      const holidays = await this.holidays(org.id);
      const tasks = await this.prisma.task.findMany({
        where: {
          orgId: org.id,
          status: { in: [...OPEN_TASK] },
          kind: { not: 'client_review' },
          deadline: { gte: new Date(now.getTime() - LOOKBACK_DAYS * 86_400_000), lt: now },
          ...(onlyTaskIds ? { id: { in: onlyTaskIds } } : {}),
        },
        include: {
          owner: { select: { name: true } },
          deliverable: { select: { id: true, title: true, cycle: { select: { engagement: { select: { id: true, amId: true, deletedAt: true, clientOrg: { select: { name: true } } } } } } } },
        },
      });
      const late = tasks.filter((t) => addWorkingDays(t.deadline!, 1, holidays) < now);
      if (!late.length) continue;
      const done = new Set(
        (await this.prisma.auditEvent.findMany({ where: { orgId: org.id, action: 'task.escalated', entityId: { in: late.map((t) => t.id) } }, select: { entityId: true } })).map((a) => a.entityId),
      );
      const heads = new Map((await this.prisma.department.findMany({ where: { orgId: org.id }, select: { id: true, headUserId: true } })).map((d) => [d.id, d.headUserId]));
      const amLeads = (
        await this.prisma.user.findMany({ where: { orgId: org.id, status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'am_lead' } } } }, select: { id: true } })
      ).map((u) => u.id);
      for (const t of late) {
        if (done.has(t.id) || t.deliverable?.cycle.engagement.deletedAt) continue;
        let engagementAm = t.deliverable?.cycle.engagement.amId ?? null;
        let client = t.deliverable?.cycle.engagement.clientOrg.name;
        let engagementId = t.deliverable?.cycle.engagement.id ?? t.engagementId;
        if (!t.deliverable && t.engagementId) {
          const e = await this.prisma.engagement.findUnique({ where: { id: t.engagementId }, select: { amId: true, deletedAt: true, clientOrg: { select: { name: true } } } });
          if (!e || e.deletedAt) continue;
          engagementAm = e.amId;
          client = e.clientOrg.name;
          engagementId = t.engagementId;
        }
        const head = t.departmentId ? heads.get(t.departmentId) : null;
        const to = head ? [head] : amLeads;
        if (!to.length) continue;
        const late = this.workingDaysLate(t.deadline!, now, holidays);
        await this.audit.logSystem(org.id, 'task.escalated', 'Task', t.id, { to, workingDaysLate: late, owner: t.owner?.name ?? null, engagementId });
        await this.notifications.notify(org.id, to, {
          kind: 'sla_escalation',
          title: `Overdue ${late} working day${late === 1 ? '' : 's'}: ${t.title}`,
          body: `${client ?? 'Client'} · owner ${t.owner?.name ?? 'unassigned'}. Step deadline was ${t.deadline!.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}.`,
          link: t.deliverable ? `/team/deliverables/${t.deliverable.id}` : `/team/projects/${engagementId}`,
          critical: true,
        });
        await this.notifications.notify(org.id, [t.ownerId, engagementAm].filter((x) => x && !to.includes(x)), {
          kind: 'sla_escalated',
          title: `Escalated to the department head: ${t.title}`,
          body: 'This step is more than a working day late.',
          link: t.deliverable ? `/team/deliverables/${t.deliverable.id}` : `/team/projects/${engagementId}`,
        });
        count++;
      }
    }
    if (count) this.log.log(`Escalated ${count} overdue step(s)`);
    return { escalated: count };
  }
}
