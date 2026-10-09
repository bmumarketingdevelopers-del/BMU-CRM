import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import {
  clientSubmitRequirementSchema,
  GATES,
  planContentSchema,
  type ClientInvoice,
  type ClientOnboarding,
  type ClientOverview,
  type ClientPlanView,
  type ClientRow,
  type GateTrack,
  type Me,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { engagementInclude, toPlanView, toRequirement } from '../engagements/engagements.service.js';
import { parse } from '../common/zod.js';
import type { Prisma } from '../generated/prisma/client.js';
import { ClientIp, CurrentUser } from '../common/decorators.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { generateProductionTasks } from '../production/generate.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { approvalStatus, pendingUserIds, planRound } from '../deliver/approval-policy.js';

const trackFor = (currentGate: string, status?: string): GateTrack => {
  if (status === 'delivered') return Object.fromEntries(GATES.map((g) => [g.id, 'passed'])) as GateTrack;
  const idx = GATES.findIndex((g) => g.id === currentGate);
  return Object.fromEntries(GATES.map((g, i) => [g.id, i < idx ? 'passed' : i === idx ? 'open' : 'locked'])) as GateTrack;
};

const toInvoice = (i: Prisma.InvoiceGetPayload<{ include: { payments: true } }>): ClientInvoice => ({
  id: i.id,
  number: i.number,
  status: i.status,
  subtotalPaise: i.subtotalPaise,
  gstPaise: i.gstPaise,
  totalPaise: i.totalPaise,
  paidPaise: i.payments.reduce((s, p) => s + p.amountPaise, 0),
  dueDate: i.dueDate.toISOString(),
  createdAt: i.createdAt.toISOString(),
});

/** Client-facing data. Returns only what client_hidden_data allows: no internal notes, QC, costs or staff below AM. */
@Controller('client')
export class ClientPortalController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private clientOrgId(me: Me) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    return me.clientOrg.id;
  }

  @Get('overview')
  async overview(@CurrentUser() me: Me): Promise<ClientOverview> {
    const clientOrgId = this.clientOrgId(me);
    const org = await this.prisma.clientOrg.findUniqueOrThrow({
      where: { id: clientOrgId },
      include: {
        am: { select: { name: true, email: true, phone: true } },
        engagements: {
          where: { deletedAt: null },
          include: { service: true, cycles: { include: { requirements: true }, orderBy: { period: 'desc' }, take: 1 } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    const canSeeBilling = (me.permissions.invoices_payments?.scope ?? 'none') !== 'none';
    const invoices = canSeeBilling
      ? await this.prisma.invoice.findMany({
          where: { clientOrgId, status: { in: ['issued', 'partially_paid', 'overdue'] } },
          include: { payments: true },
          orderBy: { dueDate: 'asc' },
        })
      : [];
    return {
      clientOrg: { id: org.id, name: org.name },
      accountManager: org.am,
      engagements: org.engagements.map((e) => ({
        id: e.id,
        serviceName: e.service.name,
        tier: e.tier,
        billingType: e.billingType,
        status: e.status,
        currentGate: e.currentGate,
        track: trackFor(e.currentGate, e.status),
        requirementsPending: e.cycles[0]?.requirements.filter((r) => r.status !== 'received').length ?? 0,
      })),
      invoicesDue: invoices.map(toInvoice),
    };
  }

  @Get('invoices')
  async invoices(@CurrentUser() me: Me): Promise<ClientInvoice[]> {
    const clientOrgId = this.clientOrgId(me);
    if ((me.permissions.invoices_payments?.scope ?? 'none') === 'none') throw new ForbiddenException('Billing is not part of your access');
    const rows = await this.prisma.invoice.findMany({ where: { clientOrgId }, include: { payments: true }, orderBy: { createdAt: 'desc' } });
    return rows.map(toInvoice);
  }

  @Get('onboarding')
  async onboarding(@CurrentUser() me: Me): Promise<ClientOnboarding> {
    const clientOrgId = this.clientOrgId(me);
    const rows = await this.prisma.engagement.findMany({
      where: { clientOrgId, deletedAt: null },
      include: engagementInclude,
      orderBy: { createdAt: 'asc' },
    });
    return {
      engagements: rows.map((e) => ({
        id: e.id,
        serviceName: e.service.name,
        rcdAt: e.cycles[0]?.rcdAt?.toISOString() ?? null,
        requirements: (e.cycles[0]?.requirements ?? []).map(toRequirement),
      })),
    };
  }

  /** Client sends an item (note or link); the AM then confirms it as received. */
  @Post('requirements/:id/submit')
  @HttpCode(200)
  async submitRequirement(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const clientOrgId = this.clientOrgId(me);
    const { note } = parse(clientSubmitRequirementSchema, body);
    const item = await this.prisma.requirementItem.findFirst({ where: { id, cycle: { engagement: { clientOrgId } } }, include: { cycle: true } });
    if (!item) throw new NotFoundException('Item not found');
    if (item.status === 'received') throw new BadRequestException('Already received. Thank you!');
    await this.prisma.$transaction([
      this.prisma.requirementItem.update({ where: { id }, data: { status: 'waiting', waitingFor: 'BMU to review', blockedReason: null } }),
      this.prisma.comment.create({ data: { orgId: me.orgId, targetType: 'requirement', targetId: id, body: note, authorId: me.id } }),
    ]);
    await this.audit.log(me, 'requirement.submitted_by_client', 'RequirementItem', id, { status: item.status }, { status: 'waiting' }, ip);
    const eng = await this.prisma.engagement.findUnique({ where: { id: item.cycle.engagementId }, select: { amId: true, clientOrg: { select: { name: true } } } });
    await this.notifications.notify(me.orgId, [eng?.amId], { kind: 'requirement_sent', title: `${eng?.clientOrg.name} sent "${item.label}"`, body: 'Check it and mark it received.', link: `/team/projects/${item.cycle.engagementId}` });
    return this.onboarding(me);
  }

  @Get('plans')
  async plans(@CurrentUser() me: Me): Promise<ClientPlanView[]> {
    const clientOrgId = this.clientOrgId(me);
    const rows = await this.prisma.engagement.findMany({ where: { clientOrgId, deletedAt: null }, include: engagementInclude });
    const out: ClientPlanView[] = [];
    for (const e of rows) {
      const plan = e.cycles[0]?.plans[0];
      // Clients only ever see plans that BMU has presented to them.
      if (plan && ['sent_to_client', 'changes_requested', 'approved'].includes(plan.status)) {
        const view = (await toPlanView(this.prisma, plan))!;
        out.push({
          engagementId: e.id,
          serviceName: e.service.name,
          plan: view,
          period: e.cycles[0]?.period,
          youApproved: plan.status === 'sent_to_client' && !!view.approvalStatus?.approvers.some((a) => a.userId === me.id && a.approvedAt),
        });
      }
    }
    return out;
  }

  private async clientPlan(me: Me, planId: string) {
    const clientOrgId = this.clientOrgId(me);
    if (me.permissions.plan_and_calendar?.rule !== 'approve') throw new ForbiddenException('Only the account owner or an approver can decide on plans');
    const plan = await this.prisma.plan.findFirst({ where: { id: planId, cycle: { engagement: { clientOrgId } } }, include: { cycle: { include: { engagement: true } } } });
    if (!plan) throw new NotFoundException('Plan not found');
    if (plan.status !== 'sent_to_client') throw new BadRequestException('This plan is not waiting for your decision');
    return plan;
  }

  /** Gate 2: written in-app approval. Stored immutably; the plan becomes read-only and deliverables are created. */
  @Post('plans/:id/approve')
  @HttpCode(200)
  async approvePlan(@CurrentUser() me: Me, @Param('id') id: string, @ClientIp() ip?: string) {
    const plan = await this.clientPlan(me, id);
    const content = planContentSchema.parse(plan.content);
    // v10: the client's approval rule (any one / owner must / all approvers). Each approval is recorded immutably.
    const round = await planRound(this.prisma, plan.id);
    if (await this.prisma.approval.findFirst({ where: { targetType: 'plan_vote', targetId: plan.id, versionId: round, userId: me.id } })) {
      throw new BadRequestException('You have already approved this plan');
    }
    await this.prisma.approval.create({ data: { orgId: me.orgId, targetType: 'plan_vote', targetId: plan.id, userId: me.id, versionId: round } });
    const rule = await approvalStatus(this.prisma, { clientOrgId: plan.cycle.engagement.clientOrgId, target: 'plan', targetId: plan.id, round });
    const engagement = await this.prisma.engagement.findUniqueOrThrow({ where: { id: plan.cycle.engagementId }, include: { service: true, clientOrg: true } });
    if (!rule.satisfied) {
      await this.audit.log(me, 'plan.approval_recorded', 'Plan', id, undefined, { pending: rule.pending }, ip);
      await this.notifications.notify(me.orgId, [engagement.amId], { kind: 'approval_partial', title: `${me.name} approved the ${engagement.service.name} plan`, body: rule.summary, link: `/team/projects/${engagement.id}` });
      await this.notifications.notify(me.orgId, pendingUserIds(rule).filter((x) => x !== me.id), {
        kind: 'approval_needed',
        title: `The ${engagement.service.name} plan needs your approval too`,
        body: rule.summary,
        link: '/client/approvals',
        critical: true,
      });
      return this.plans(me);
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.plan.update({ where: { id }, data: { status: 'approved', approvedById: me.id, approvedAt: now } }),
      this.prisma.approval.create({ data: { orgId: me.orgId, targetType: 'plan', targetId: id, gate: 'G2', userId: me.id, at: now } }),
      this.prisma.engagement.update({ where: { id: plan.cycle.engagementId }, data: { currentGate: 'G3', status: 'in_production' } }),
      this.prisma.cycle.update({ where: { id: plan.cycleId }, data: { status: 'production' } }),
      ...content.deliverables.map((d) =>
        this.prisma.deliverable.create({
          data: { orgId: me.orgId, cycleId: plan.cycleId, type: d.type, title: d.title, dueAt: d.due ? new Date(`${d.due}T18:30:00+05:30`) : undefined },
        }),
      ),
    ]);
    await this.audit.log(me, 'gate.G2.passed', 'Plan', id, { status: 'sent_to_client' }, { status: 'approved', deliverables: content.deliverables.length }, ip);
    // Automation: plan approved → department tasks from flow templates, then the Gate 3 check.
    const result = await generateProductionTasks(this.prisma, plan.cycleId, now);
    await this.audit.logSystem(me.orgId, result.g3Passed ? 'gate.G3.passed' : 'gate.G3.waiting', 'Engagement', plan.cycle.engagementId, result);
    // Tell the AM and everyone who just got work.
    const owners = await this.prisma.task.findMany({ where: { deliverable: { cycleId: plan.cycleId }, ownerId: { not: null } }, select: { ownerId: true } });
    await this.notifications.notify(me.orgId, [engagement.amId], {
      kind: 'plan_approved',
      title: `${engagement.clientOrg.name} approved the ${engagement.service.name} plan`,
      body: result.g3Passed ? `${result.created} tasks created and assigned. Production has started.` : result.unassigned ? `${result.unassigned} task(s) have no owner yet. Assign them to start production.` : 'Production is on hold until the overdue invoice is paid.',
      link: `/team/projects/${engagement.id}`,
      critical: !result.g3Passed,
    });
    await this.notifications.notify(
      me.orgId,
      [...new Set(owners.map((o) => o.ownerId))].filter((x) => x !== engagement.amId),
      { kind: 'tasks_assigned', title: `New tasks for ${engagement.clientOrg.name}`, body: `${engagement.service.name}: the client approved the plan.`, link: '/team/tasks' },
    );
    return this.plans(me);
  }

  @Post('plans/:id/request-changes')
  @HttpCode(200)
  async requestPlanChanges(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string) {
    const plan = await this.clientPlan(me, id);
    const { comment } = parse(z.object({ comment: z.string().trim().min(3, 'Tell us what to change') }), body);
    await this.prisma.$transaction([
      this.prisma.plan.update({ where: { id }, data: { status: 'changes_requested' } }),
      this.prisma.comment.create({ data: { orgId: me.orgId, targetType: 'plan', targetId: id, body: comment, authorId: me.id } }),
      this.prisma.engagement.update({ where: { id: plan.cycle.engagementId }, data: { status: 'planning' } }),
    ]);
    await this.audit.log(me, 'plan.changes_requested', 'Plan', id, undefined, { comment }, ip);
    // The planner picks the plan up again.
    const planning = await this.prisma.task.findFirst({ where: { engagementId: plan.cycle.engagementId, kind: 'planning' }, orderBy: { createdAt: 'desc' } });
    if (planning) await this.prisma.task.update({ where: { id: planning.id }, data: { status: 'in_progress', completedAt: null } });
    await this.notifications.notify(me.orgId, [plan.cycle.engagement.amId, planning?.ownerId], {
      kind: 'plan_changes',
      title: `${me.name} asked for changes to the plan`,
      body: comment,
      link: `/team/projects/${plan.cycle.engagementId}`,
      critical: true,
    });
    return this.plans(me);
  }
}

/** Staff list of clients: Founder/Admin/AM Lead see all, Account Managers their own. */
@Controller('clients')
export class ClientsController {
  constructor(private readonly prisma: PrismaService) {}

  @Get(':id')
  async one(@CurrentUser() me: Me, @Param('id') id: string): Promise<ClientRow> {
    const row = (await this.list(me)).find((c) => c.id === id);
    if (!row) throw new NotFoundException('Client not found');
    return row;
  }

  @Get()
  async list(@CurrentUser() me: Me): Promise<ClientRow[]> {
    let where: Prisma.ClientOrgWhereInput = { orgId: me.orgId, deletedAt: null };
    if (me.roles.some((r) => ['founder', 'admin', 'am_lead', 'finance', 'department_head'].includes(r))) {
      // all clients
    } else if (me.roles.includes('account_manager')) {
      where = { ...where, amUserId: me.id };
    } else if (me.roles.includes('strategist')) {
      const self = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { teamId: true } });
      where = { ...where, am: { teamId: self.teamId ?? '__none__' } };
    } else {
      throw new ForbiddenException("You don't have access to the client list");
    }
    const rows = await this.prisma.clientOrg.findMany({
      where,
      include: { am: { select: { id: true, name: true } }, engagements: { include: { service: true } } },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((c) => ({
      id: c.id,
      name: c.name,
      industry: c.industry,
      health: c.health,
      am: c.am,
      engagements: c.engagements.map((e) => ({ id: e.id, serviceName: e.service.name, status: e.status, currentGate: e.currentGate })),
      createdAt: c.createdAt.toISOString(),
    }));
  }
}
