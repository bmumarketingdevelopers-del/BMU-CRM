import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  addWorkingDays,
  planContentSchema,
  type EngagementDetail,
  type EngagementRow,
  type Me,
  type PlanContent,
  type PlanView,
  type RequirementItemView,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { isLeadership, visibleEngagementWhere } from './engagement-access.js';
import { approvalStatus, planRound } from '../deliver/approval-policy.js';

export const engagementInclude = {
  clientOrg: { select: { id: true, name: true } },
  service: true,
  am: { select: { id: true, name: true } },
  cycles: {
    orderBy: { period: 'desc' as const },
    take: 1,
    include: {
      requirements: { orderBy: [{ dateRequested: 'asc' as const }, { label: 'asc' as const }] },
      plans: { orderBy: { id: 'desc' as const }, take: 1 },
      deliverables: true,
    },
  },
} satisfies Prisma.EngagementInclude;
export type EngagementFull = Prisma.EngagementGetPayload<{ include: typeof engagementInclude }>;

export const toRequirement = (r: EngagementFull['cycles'][number]['requirements'][number]): RequirementItemView => ({
  id: r.id,
  label: r.label,
  type: r.type,
  status: r.status,
  blockedReason: r.blockedReason,
  waitingFor: r.waitingFor,
  dateRequested: r.dateRequested.toISOString(),
});

export async function toPlanView(prisma: PrismaService, plan: EngagementFull['cycles'][number]['plans'][number] | undefined): Promise<PlanView | null> {
  if (!plan) return null;
  const comments = await prisma.comment.findMany({
    where: { targetType: 'plan', targetId: plan.id, isInternal: false },
    orderBy: { createdAt: 'asc' },
  });
  const authors = await prisma.user.findMany({ where: { id: { in: comments.map((c) => c.authorId) } }, select: { id: true, name: true } });
  const approver = plan.approvedById ? await prisma.user.findUnique({ where: { id: plan.approvedById }, select: { name: true } }) : null;
  // v10: approval rule progress while the plan is with the client (and who approved once it is approved).
  let rule = null;
  if (plan.status === 'sent_to_client' || plan.status === 'approved') {
    const cycle = await prisma.cycle.findUnique({ where: { id: plan.cycleId }, select: { engagement: { select: { clientOrgId: true } } } });
    if (cycle) {
      rule = await approvalStatus(prisma, {
        clientOrgId: cycle.engagement.clientOrgId,
        target: 'plan',
        targetId: plan.id,
        round: await planRound(prisma, plan.id),
        finalApproverId: plan.status === 'approved' ? plan.approvedById : null,
        finalAt: plan.approvedAt,
      });
    }
  }
  return {
    id: plan.id,
    status: plan.status,
    content: planContentSchema.parse(plan.content ?? {}),
    approvedAt: plan.approvedAt?.toISOString() ?? null,
    approvedBy: approver?.name ?? null,
    clientComments: comments.map((c) => ({ body: c.body, at: c.createdAt.toISOString(), author: authors.find((a) => a.id === c.authorId)?.name ?? '' })),
    approvalStatus: rule,
  };
}

@Injectable()
export class EngagementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async load(me: Me, id: string): Promise<EngagementFull> {
    const e = await this.prisma.engagement.findFirst({ where: { ...(await visibleEngagementWhere(this.prisma, me)), id }, include: engagementInclude });
    if (!e) throw new NotFoundException('Engagement not found');
    return e;
  }

  /** RCD and requirement checks: the client's AM, AM Lead or Founder (mark_rcd_gate1). */
  private canManageRequirements(me: Me, e: EngagementFull) {
    const rule = me.permissions.mark_rcd_gate1?.scope ?? 'none';
    return rule === 'all' || (rule === 'own' && e.amId === me.id);
  }

  private canEditPlan(me: Me, e: EngagementFull) {
    return (me.permissions.plan_and_calendar?.scope ?? 'none') !== 'none' && me.type === 'staff' && !!e.cycles[0]?.rcdAt;
  }

  private canSendPlan(me: Me, e: EngagementFull) {
    return e.amId === me.id || isLeadership(me) || me.roles.includes('department_head');
  }

  async list(me: Me): Promise<EngagementRow[]> {
    const rows = await this.prisma.engagement.findMany({
      where: await visibleEngagementWhere(this.prisma, me),
      include: engagementInclude,
      orderBy: { createdAt: 'desc' },
    });
    // v10 delivery SLA: open deliverables past due or due within one working day (not those waiting on the client).
    const org = await this.prisma.organisation.findUniqueOrThrow({ where: { id: me.orgId }, select: { settings: true } });
    const soon = addWorkingDays(new Date(), 1, ((org.settings ?? {}) as { holidays?: string[] }).holidays ?? []);
    const nowMs = Date.now();
    const open = (d: { status: string; dueAt: Date | null }) => !!d.dueAt && !['approved', 'scheduled', 'published', 'ready_for_client'].includes(d.status);
    return rows.map((e) => {
      const cycle = e.cycles[0];
      const ds = (cycle?.deliverables ?? []).filter(open);
      return {
        slaOverdue: ds.filter((d) => d.dueAt!.getTime() < nowMs).length,
        slaAtRisk: ds.filter((d) => d.dueAt!.getTime() >= nowMs && d.dueAt! <= soon).length,
        billingType: e.billingType,
        period: cycle?.period ?? null,
        id: e.id,
        client: e.clientOrg,
        serviceName: e.service.name,
        tier: e.tier,
        status: e.status,
        currentGate: e.currentGate,
        am: e.am,
        requirementsOutstanding: (cycle?.requirements ?? []).filter((r) => r.status !== 'received').length,
        rcdAt: cycle?.rcdAt?.toISOString() ?? null,
        planningDue: cycle?.planningDue?.toISOString() ?? null,
        planStatus: cycle?.plans[0]?.status ?? null,
      };
    });
  }

  async detail(me: Me, id: string): Promise<EngagementDetail> {
    const e = await this.load(me, id);
    const cycle = e.cycles[0];
    const plan = await toPlanView(this.prisma, cycle?.plans[0]);
    const notes = await this.prisma.comment.findMany({
      where: { targetType: 'requirement', targetId: { in: (cycle?.requirements ?? []).map((r) => r.id) } },
      orderBy: { createdAt: 'asc' },
    });
    const noteFor = (id: string) => notes.filter((n) => n.targetId === id).at(-1)?.body ?? null;
    return {
      id: e.id,
      client: e.clientOrg,
      serviceName: e.service.name,
      tier: e.tier,
      billingType: e.billingType,
      status: e.status,
      currentGate: e.currentGate,
      am: e.am,
      cycle: cycle
        ? {
            id: cycle.id,
            period: cycle.period,
            rcdAt: cycle.rcdAt?.toISOString() ?? null,
            planningDue: cycle.planningDue?.toISOString() ?? null,
            requirements: cycle.requirements.map((r) => ({ ...toRequirement(r), clientNote: noteFor(r.id) })),
          }
        : null,
      plan,
      deliverables: (cycle?.deliverables ?? [])
        .map((d) => ({ id: d.id, type: d.type, title: d.title, status: d.status, dueAt: d.dueAt?.toISOString() ?? null, scheduledAt: d.scheduledAt?.toISOString() ?? null }))
        .sort((a, b) => (a.dueAt ?? '9').localeCompare(b.dueAt ?? '9') || a.title.localeCompare(b.title)),
      can: {
        markRcd: this.canManageRequirements(me, e) && !cycle?.rcdAt,
        editPlan: this.canEditPlan(me, e) && (!plan || plan.status === 'draft' || plan.status === 'changes_requested'),
        approvePlanInternally: plan?.status === 'internal_review' && this.canSendPlan(me, e),
        sendPlan: plan?.status === 'internal_review' && this.canSendPlan(me, e),
      },
    };
  }

  async updateRequirement(me: Me, itemId: string, input: { status: string; blockedReason?: string; waitingFor?: string }, ip?: string) {
    const item = await this.prisma.requirementItem.findFirst({ where: { id: itemId, orgId: me.orgId }, include: { cycle: true } });
    if (!item) throw new NotFoundException('Item not found');
    const e = await this.load(me, item.cycle.engagementId);
    if (!this.canManageRequirements(me, e)) throw new ForbiddenException("Only the client's Account Manager can update requirements");
    if (item.cycle.rcdAt) throw new BadRequestException('Requirements are locked once the project start date (RCD) is set');
    const updated = await this.prisma.requirementItem.update({
      where: { id: itemId },
      data: {
        status: input.status as never,
        blockedReason: input.status === 'blocked' ? input.blockedReason : null,
        waitingFor: input.status === 'waiting' || input.status === 'blocked' ? (input.waitingFor ?? null) : null,
      },
    });
    await this.audit.log(me, `requirement.${input.status}`, 'RequirementItem', itemId, { status: item.status }, { status: updated.status, blockedReason: updated.blockedReason }, ip);
    if (input.status === 'blocked') {
      await this.prisma.engagement.update({ where: { id: e.id }, data: { status: 'blocked' } });
    } else if (e.status === 'blocked') {
      await this.prisma.engagement.update({ where: { id: e.id }, data: { status: 'onboarding' } });
    }
    return this.detail(me, e.id);
  }

  async addRequirement(me: Me, id: string, label: string, type: string, ip?: string) {
    const e = await this.load(me, id);
    if (!this.canManageRequirements(me, e)) throw new ForbiddenException("Only the client's Account Manager can add requirements");
    const cycle = e.cycles[0];
    if (!cycle || cycle.rcdAt) throw new BadRequestException('Requirements are locked once the project start date (RCD) is set');
    const item = await this.prisma.requirementItem.create({ data: { orgId: me.orgId, cycleId: cycle.id, label, type, ownerId: me.id } });
    await this.audit.log(me, 'requirement.added', 'RequirementItem', item.id, undefined, { label, type }, ip);
    return this.detail(me, id);
  }

  /**
   * Gate 1. Only when every requirement is received ("no complete requirements = no project clock").
   * Starts the project clock, sets the planning deadline (Gate rules setting, default 4 working days) and creates the planning task.
   */
  async markRcd(me: Me, id: string, ip?: string) {
    const e = await this.load(me, id);
    if (!this.canManageRequirements(me, e)) throw new ForbiddenException("Only the client's Account Manager or above can set the project start date");
    const cycle = e.cycles[0];
    if (!cycle) throw new BadRequestException('No active cycle');
    if (cycle.rcdAt) throw new BadRequestException('RCD is already set');
    // v11 clients: a manual client's first payment must be confirmed (paid online or confirmed by Finance) first.
    if (e.paymentPending) throw new BadRequestException('Waiting for the first payment. Gate 1 can pass once it is paid in the client app or Finance confirms it.');
    const outstanding = cycle.requirements.filter((r) => r.status !== 'received');
    if (outstanding.length) throw new BadRequestException(`Still waiting on ${outstanding.length} requirement item(s): ${outstanding.map((r) => r.label).join(', ')}`);

    // Holidays and the working days set in Command Centre → Holidays & Working Hours.
    const holidays = await calendarFor(this.prisma, me.orgId);
    const now = new Date();
    const { planDeadlineWorkingDays } = await this.settings.get(me.orgId, 'gateRules');
    const planningDue = addWorkingDays(now, planDeadlineWorkingDays, holidays);

    // Strategist in the AM's pod owns planning; falls back to the AM.
    const am = e.amId ? await this.prisma.user.findUnique({ where: { id: e.amId }, select: { teamId: true } }) : null;
    const strategist = am?.teamId
      ? await this.prisma.user.findFirst({ where: { teamId: am.teamId, status: 'active', roles: { some: { role: { baseRole: 'strategist' } } } } })
      : null;

    await this.prisma.$transaction([
      this.prisma.cycle.update({ where: { id: cycle.id }, data: { rcdAt: now, planningDue, status: 'planning' } }),
      this.prisma.engagement.update({ where: { id: e.id }, data: { status: 'planning', currentGate: 'G2' } }),
      this.prisma.approval.create({ data: { orgId: me.orgId, targetType: 'engagement', targetId: e.id, gate: 'G1', userId: me.id, at: now } }),
      this.prisma.task.create({
        data: {
          orgId: me.orgId,
          title: `Plan ${e.service.name} for ${e.clientOrg.name}`,
          flowStep: 'planning',
          kind: 'planning',
          engagementId: e.id,
          ownerId: strategist?.id ?? e.amId,
          deadline: planningDue,
        },
      }),
    ]);
    await this.audit.log(me, 'gate.G1.passed', 'Engagement', e.id, { rcdAt: null }, { rcdAt: now.toISOString(), planningDue: planningDue.toISOString() }, ip);
    const planner = strategist?.id ?? e.amId;
    await this.notifications.notify(me.orgId, [planner === me.id ? null : planner], {
      kind: 'planning_assigned',
      title: `Plan ${e.service.name} for ${e.clientOrg.name}`,
      body: `Everything is in. The plan is due ${planningDue.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' })}.`,
      link: `/team/projects/${e.id}`,
    });
    await this.notifications.notify(me.orgId, await this.notifications.clientDeciders(e.clientOrgId), {
      kind: 'project_started',
      title: `${e.service.name}: we have everything, your project has started`,
      body: 'Your plan comes to you for approval next.',
      link: '/client/journey',
    });
    return this.detail(me, id);
  }

  async savePlan(me: Me, id: string, content: PlanContent, ip?: string) {
    const e = await this.load(me, id);
    const cycle = e.cycles[0];
    if (!cycle?.rcdAt) throw new BadRequestException('Planning cannot start before the project start date (RCD) is set');
    if (!this.canEditPlan(me, e)) throw new ForbiddenException("You can't edit this plan");
    const plan = cycle.plans[0];
    if (plan && !['draft', 'changes_requested'].includes(plan.status)) throw new BadRequestException('This plan is locked while under review or after approval');
    if (plan) await this.prisma.plan.update({ where: { id: plan.id }, data: { content, status: 'draft' } });
    else await this.prisma.plan.create({ data: { orgId: me.orgId, cycleId: cycle.id, content } });
    await this.audit.log(me, 'plan.saved', 'Engagement', id, undefined, { deliverables: content.deliverables.length }, ip);
    return this.detail(me, id);
  }

  async submitPlan(me: Me, id: string, ip?: string) {
    const e = await this.load(me, id);
    const plan = e.cycles[0]?.plans[0];
    if (!plan || plan.status !== 'draft') throw new BadRequestException('Save a draft plan first');
    if (!this.canEditPlan(me, e)) throw new ForbiddenException("You can't submit this plan");
    if (planContentSchema.parse(plan.content).deliverables.length === 0) throw new BadRequestException('Add at least one deliverable to the plan');
    await this.prisma.$transaction([
      this.prisma.plan.update({ where: { id: plan.id }, data: { status: 'internal_review' } }),
      this.prisma.task.updateMany({ where: { engagementId: e.id, kind: 'planning', status: { notIn: ['done', 'cancelled'] } }, data: { status: 'done', completedAt: new Date() } }),
    ]);
    await this.audit.log(me, 'plan.submitted', 'Engagement', id, undefined, undefined, ip);
    await this.notifications.notify(me.orgId, [e.amId === me.id ? null : e.amId], {
      kind: 'plan_review',
      title: `${e.clientOrg.name}: plan ready for internal review`,
      body: `${me.name} submitted the ${e.service.name} plan. Approve and send it to the client.`,
      link: `/team/projects/${e.id}`,
    });
    return this.detail(me, id);
  }

  /** Internal approval (Strategist → Dept Head / AM) then presentation to the client. */
  async sendPlan(me: Me, id: string, ip?: string) {
    const e = await this.load(me, id);
    const plan = e.cycles[0]?.plans[0];
    if (!plan || plan.status !== 'internal_review') throw new BadRequestException('The plan must be submitted for internal review first');
    if (!this.canSendPlan(me, e)) throw new ForbiddenException("Only the client's AM, a Department Head or leadership can approve and send the plan");
    await this.prisma.$transaction([
      this.prisma.plan.update({ where: { id: plan.id }, data: { status: 'sent_to_client' } }),
      this.prisma.engagement.update({ where: { id: e.id }, data: { status: 'awaiting_plan_approval' } }),
      this.prisma.approval.create({ data: { orgId: me.orgId, targetType: 'plan_internal', targetId: plan.id, userId: me.id } }),
    ]);
    await this.audit.log(me, 'plan.sent_to_client', 'Engagement', id, undefined, undefined, ip);
    await this.notifications.notify(me.orgId, await this.notifications.clientDeciders(e.clientOrgId), {
      kind: 'plan_ready',
      title: `Your ${e.service.name} plan is ready for approval`,
      body: 'Approve it to start production, or tell us what to change.',
      link: '/client/approvals',
      critical: true,
    });
    return this.detail(me, id);
  }
}
