import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import {
  type WorkCalendar,
  addWorkingDays,
  addWorkingMinutes,
  SLA_FIRST_REPLY_MIN,
  workingMinutesBetween,
  type CreateRequest,
  type DecideRequest,
  type Me,
  type RequestStatus,
  type RequestType,
  type RequestView,
  type ServiceRateRequest,
  type SlaState,
  SERVICE_REOPEN_DAYS,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { isLeadership } from '../engagements/engagement-access.js';
import { calendarFor } from '../production/generate.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { BillingService } from './billing.service.js';
import { ServiceBillingService } from '../service/service-billing.service.js';

const include = {
  engagement: { include: { clientOrg: { select: { id: true, name: true } }, service: { select: { name: true } } } },
} satisfies Prisma.RequestInclude;
type Row = Prisma.RequestGetPayload<{ include: typeof include }>;

const OPEN: RequestStatus[] = ['received', 'scope_check', 'in_scope', 'quoted', 'approved', 'paid', 'in_progress', 'rescheduled'];

/** Request desk: change, extra request (add-on), urgent, question, billing, with working-hours SLA timers. */
@Injectable()
export class RequestsService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly billing: BillingService,
    private readonly notifications: NotificationsService,
    private readonly settings: SettingsService,
    private readonly serviceBilling: ServiceBillingService,
  ) {}

  onModuleInit() {
    // Add-on paid → schedule the work (tasks only exist after written approval and payment).
    this.billing.onPaid(async (inv) => {
      if (inv.kind !== 'addon' || !inv.requestId) return;
      const r = await this.prisma.request.findUnique({ where: { id: inv.requestId }, include });
      if (!r || r.status !== 'approved') return;
      await this.prisma.request.update({ where: { id: r.id }, data: { status: 'paid' } });
      await this.createWorkTask(r, 'Extra request');
      await this.notifications.notify(r.orgId, [r.engagement.amId], {
        kind: 'addon_paid',
        title: `${r.engagement.clientOrg.name} paid for an extra request`,
        body: r.description.slice(0, 140),
        link: `/team/requests/${r.id}`,
      });
    });
  }

  // -------------------------------------------------------------------------

  private async scope(me: Me): Promise<Prisma.RequestWhereInput> {
    if (me.type === 'client') {
      if (!me.clientOrg) throw new ForbiddenException();
      return { orgId: me.orgId, engagement: { clientOrgId: me.clientOrg.id } };
    }
    if (isLeadership(me) || me.roles.includes('finance')) return { orgId: me.orgId };
    if (me.roles.includes('account_manager')) return { orgId: me.orgId, OR: [{ engagement: { amId: me.id } }, { assigneeId: me.id }] };
    throw new ForbiddenException('The request desk is for Account Managers and leadership');
  }

  private async load(me: Me, id: string) {
    const r = await this.prisma.request.findFirst({ where: { AND: [{ id }, await this.scope(me)] }, include });
    if (!r) throw new NotFoundException('Request not found');
    return r;
  }

  private sla(r: Row, holidays: WorkCalendar): SlaState {
    if (!r.slaDue) return { firstReplyDue: null, firstReplyAt: null, state: 'met', workingMinutesLeft: null };
    const now = new Date();
    if (r.firstReplyAt) {
      return { firstReplyDue: r.slaDue.toISOString(), firstReplyAt: r.firstReplyAt.toISOString(), state: r.firstReplyAt <= r.slaDue ? 'met' : 'breached', workingMinutesLeft: null };
    }
    const left = now <= r.slaDue ? workingMinutesBetween(now, r.slaDue, holidays) : -workingMinutesBetween(r.slaDue, now, holidays);
    return { firstReplyDue: r.slaDue.toISOString(), firstReplyAt: null, state: now <= r.slaDue ? 'due' : 'overdue', workingMinutesLeft: left };
  }

  private async view(me: Me, r: Row): Promise<RequestView> {
    const holidays = await calendarFor(this.prisma, r.orgId);
    const comments = await this.prisma.comment.findMany({
      where: { targetType: 'request', targetId: r.id, ...(me.type === 'client' ? { isInternal: false } : {}) },
      orderBy: { createdAt: 'asc' },
    });
    const userIds = [...comments.map((c) => c.authorId), r.createdById, r.approvedById, r.ratedById].filter((x): x is string => !!x);
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, type: true } });
    const user = (id: string | null) => users.find((u) => u.id === id);
    const [invoice, addOn] = await Promise.all([
      r.invoiceId ? this.prisma.invoice.findUnique({ where: { id: r.invoiceId } }) : null,
      r.addOnId ? this.prisma.addOn.findUnique({ where: { id: r.addOnId } }) : null,
    ]);
    const amount = r.quoteAmountPaise;
    const isOwner = me.clientOrg?.role === 'client_owner' || me.permissions.approve_addon_quote?.rule === 'full';
    const reopenUntil = r.status === 'done' && r.resolvedAt ? new Date(r.resolvedAt.getTime() + SERVICE_REOPEN_DAYS * 86_400_000) : null;
    const clientCanAct = me.type === 'client' && (r.createdById === me.id || ['client_owner', 'client_approver'].includes(me.clientOrg?.role ?? ''));
    return {
      id: r.id,
      type: r.type as RequestType,
      status: r.status,
      description: r.description,
      client: r.engagement.clientOrg,
      engagement: { id: r.engagementId, serviceName: r.engagement.service.name },
      createdBy: user(r.createdById)?.name ?? '',
      createdAt: r.createdAt.toISOString(),
      sla: this.sla(r, holidays),
      quote: amount ? { amountPaise: amount, gstPaise: Math.round(amount * 0.18), totalPaise: amount + Math.round(amount * 0.18), timeline: r.timeline, addOnName: addOn?.name ?? null } : null,
      approval: r.approvedAt ? { by: user(r.approvedById)?.name ?? '', at: r.approvedAt.toISOString() } : null,
      invoice: invoice ? { id: invoice.id, number: invoice.number, status: invoice.status, totalPaise: invoice.totalPaise } : null,
      comments: comments.map((c) => ({
        id: c.id,
        body: c.body,
        internal: c.isInternal,
        author: user(c.authorId)?.name ?? '',
        isClient: user(c.authorId)?.type === 'client',
        at: c.createdAt.toISOString(),
      })),
      can: {
        decide: me.type === 'staff' && OPEN.includes(r.status) && (isLeadership(me) || r.engagement.amId === me.id || r.assigneeId === me.id),
        quoteCustom: me.type === 'staff' && me.roles.some((x) => ['founder', 'admin'].includes(x)),
        approveQuote: me.type === 'client' && isOwner && r.status === 'quoted',
        rate: clientCanAct && r.status === 'done',
        reopen: clientCanAct && !!reopenUntil && reopenUntil.getTime() > Date.now(),
      },
      resolvedAt: r.resolvedAt?.toISOString() ?? null,
      rating: r.rating ? { value: r.rating > 0 ? 'up' : 'down', comment: r.ratingComment, at: r.ratedAt?.toISOString() ?? '', by: user(r.ratedById)?.name ?? '' } : null,
      reopenCount: r.reopenCount,
      reopenUntil: reopenUntil?.toISOString() ?? null,
      assignee: r.assigneeId ? { id: r.assigneeId, name: (await this.prisma.user.findUnique({ where: { id: r.assigneeId }, select: { name: true } }))?.name ?? '' } : null,
      neededBy: r.neededBy?.toISOString() ?? null,
      raisedOnBehalf: r.raisedOnBehalf,
    };
  }

  async list(me: Me): Promise<RequestView[]> {
    const rows = await this.prisma.request.findMany({ where: await this.scope(me), include, orderBy: { createdAt: 'desc' }, take: 200 });
    return Promise.all(rows.map((r) => this.view(me, r)));
  }

  async get(me: Me, id: string) {
    return this.view(me, await this.load(me, id));
  }

  async addOns(me: Me) {
    await this.scope(me);
    if (me.type !== 'staff') throw new ForbiddenException();
    const book = await this.prisma.priceBook.findFirst({ where: { orgId: me.orgId, status: 'active' }, orderBy: { effectiveFrom: 'desc' } });
    const rows = await this.prisma.addOn.findMany({ where: { orgId: me.orgId, ...(book ? { priceBookId: book.id } : {}) }, orderBy: { name: 'asc' } });
    return rows.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise, unit: a.unit, isCustomQuote: a.isCustomQuote }));
  }

  // -------------------------------------------------------------------------
  // Client side

  async create(me: Me, input: CreateRequest, ip?: string) {
    if (!me.clientOrg) throw new ForbiddenException('Client accounts only');
    const engagement = await this.prisma.engagement.findFirst({ where: { id: input.engagementId, clientOrgId: me.clientOrg.id, deletedAt: null } });
    if (!engagement) throw new NotFoundException('Service not found');
    const holidays = await calendarFor(this.prisma, me.orgId);
    const sla = await this.settings.get(me.orgId, 'sla');
    const slaMinutes = sla.firstReplyMinutes[input.type] ?? SLA_FIRST_REPLY_MIN[input.type];
    const now = new Date();
    const r = await this.prisma.request.create({
      data: {
        orgId: me.orgId,
        engagementId: engagement.id,
        type: input.type,
        description: input.description,
        createdById: me.id,
        status: input.type === 'new_scope' ? 'scope_check' : 'received',
        slaDue: addWorkingMinutes(now, slaMinutes, holidays),
      },
      include,
    });
    await this.audit.log(me, 'request.created', 'Request', r.id, undefined, { type: input.type }, ip);
    await this.notifications.notify(me.orgId, [engagement.amId], {
      kind: 'request_created',
      title: `${input.type === 'urgent' ? 'URGENT: ' : ''}New request from ${me.clientOrg.name}`,
      body: input.description.slice(0, 140),
      link: `/team/requests/${r.id}`,
      critical: input.type === 'urgent',
    });
    return this.view(me, r);
  }

  async clientComment(me: Me, id: string, body: string, ip?: string) {
    const r = await this.load(me, id);
    await this.prisma.comment.create({ data: { orgId: r.orgId, targetType: 'request', targetId: r.id, body, authorId: me.id } });
    await this.audit.log(me, 'request.commented', 'Request', r.id, undefined, undefined, ip);
    await this.notifications.notify(r.orgId, [r.engagement.amId], { kind: 'request_client_reply', title: `${r.engagement.clientOrg.name} replied on a request`, body: body.slice(0, 140), link: `/team/requests/${r.id}` });
    return this.view(me, await this.load(me, id));
  }

  /** Written client approval of an add-on quote (approve_addon_quote: client owner only). Raises the invoice. */
  async approveQuote(me: Me, id: string, ip?: string) {
    const r = await this.load(me, id);
    if (me.clientOrg?.role !== 'client_owner') throw new ForbiddenException('Only the account owner can approve extra costs');
    if (r.status !== 'quoted' || !r.quoteAmountPaise) throw new BadRequestException('There is no quote waiting for approval');
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const invoice = await this.billing.issue(tx, {
        orgId: r.orgId,
        clientOrgId: r.engagement.clientOrgId,
        engagementId: r.engagementId,
        requestId: r.id,
        kind: 'addon',
        lines: [{ label: `Extra request: ${r.description.slice(0, 80)}`, amountPaise: r.quoteAmountPaise! }],
      });
      await tx.approval.create({ data: { orgId: r.orgId, targetType: 'request', targetId: r.id, userId: me.id, at: now } });
      await tx.request.update({ where: { id: r.id }, data: { status: 'approved', approvedById: me.id, approvedAt: now, invoiceId: invoice.id } });
    });
    await this.audit.log(me, 'request.quote_approved', 'Request', r.id, { status: 'quoted' }, { status: 'approved', amountPaise: r.quoteAmountPaise }, ip);
    await this.notifications.notify(r.orgId, [r.engagement.amId], { kind: 'quote_approved', title: `${r.engagement.clientOrg.name} approved a quote`, link: `/team/requests/${r.id}` });
    const fresh = await this.load(me, id);
    if (fresh.invoiceId) await this.serviceBilling.invoiceIssued(fresh.invoiceId);
    return this.view(me, fresh);
  }

  async declineQuote(me: Me, id: string, reason: string | undefined, ip?: string) {
    const r = await this.load(me, id);
    if (me.clientOrg?.role !== 'client_owner') throw new ForbiddenException('Only the account owner can decide on extra costs');
    if (r.status !== 'quoted') throw new BadRequestException('There is no quote waiting for a decision');
    await this.prisma.$transaction([
      this.prisma.request.update({ where: { id: r.id }, data: { status: 'declined', resolvedAt: new Date() } }),
      ...(reason ? [this.prisma.comment.create({ data: { orgId: r.orgId, targetType: 'request', targetId: r.id, body: `Quote declined: ${reason}`, authorId: me.id } })] : []),
    ]);
    await this.audit.log(me, 'request.quote_declined', 'Request', r.id, undefined, { reason }, ip);
    await this.notifications.notify(r.orgId, [r.engagement.amId], { kind: 'quote_declined', title: `${r.engagement.clientOrg.name} declined a quote`, link: `/team/requests/${r.id}` });
    return this.view(me, await this.load(me, id));
  }

  /** Thumbs up / down (+ comment) once the request is done. Can be changed until it is reopened. */
  async rate(me: Me, id: string, input: ServiceRateRequest, ip?: string) {
    const r = await this.load(me, id);
    if (me.type !== 'client') throw new ForbiddenException('Only the client can rate a request');
    if (r.status !== 'done') throw new BadRequestException('You can rate a request once it is done');
    if (r.createdById !== me.id && !['client_owner', 'client_approver'].includes(me.clientOrg?.role ?? '')) throw new ForbiddenException('Only the person who raised it or an account owner/approver can rate it');
    const value = input.rating === 'up' ? 1 : -1;
    await this.prisma.request.update({ where: { id: r.id }, data: { rating: value, ratingComment: input.comment?.trim() || null, ratedAt: new Date(), ratedById: me.id } });
    await this.audit.log(me, 'request.rated', 'Request', r.id, r.rating ? { rating: r.rating } : undefined, { rating: value, comment: input.comment }, ip);
    await this.notifications.notify(r.orgId, [r.engagement.amId], {
      kind: 'request_rated',
      title: `${r.engagement.clientOrg.name} rated a request ${value > 0 ? 'thumbs up' : 'thumbs down'}`,
      body: input.comment?.slice(0, 140) || r.description.slice(0, 140),
      link: `/team/requests/${r.id}`,
      critical: value < 0,
    });
    return this.view(me, await this.load(me, id));
  }

  /** The client reopens a done request within 7 days: work restarts with a new task and the AM is alerted. */
  async reopen(me: Me, id: string, reason: string, ip?: string) {
    const r = await this.load(me, id);
    if (me.type !== 'client') throw new ForbiddenException('Only the client can reopen a request');
    if (r.createdById !== me.id && !['client_owner', 'client_approver'].includes(me.clientOrg?.role ?? '')) throw new ForbiddenException('Only the person who raised it or an account owner/approver can reopen it');
    if (r.status !== 'done' || !r.resolvedAt) throw new BadRequestException('Only finished requests can be reopened');
    if (Date.now() - r.resolvedAt.getTime() > SERVICE_REOPEN_DAYS * 86_400_000) throw new BadRequestException(`Requests can be reopened up to ${SERVICE_REOPEN_DAYS} days after they are done. Please raise a new request.`);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.request.update({ where: { id: r.id }, data: { status: 'in_progress', resolvedAt: null, reopenedAt: now, reopenCount: { increment: 1 }, rating: null, ratingComment: null, ratedAt: null, ratedById: null } }),
      this.prisma.comment.create({ data: { orgId: r.orgId, targetType: 'request', targetId: r.id, body: `Reopened: ${reason}`, authorId: me.id } }),
    ]);
    await this.createWorkTask(r, 'Reopened');
    await this.audit.log(me, 'request.reopened', 'Request', r.id, { status: 'done' }, { status: 'in_progress', reason }, ip);
    await this.notifications.notify(r.orgId, [r.engagement.amId], {
      kind: 'request_reopened',
      title: `${r.engagement.clientOrg.name} reopened a request`,
      body: reason.slice(0, 140),
      link: `/team/requests/${r.id}`,
      critical: true,
    });
    return this.view(me, await this.load(me, id));
  }

  // -------------------------------------------------------------------------
  // Team side

  private async createWorkTask(r: Row, prefix: string) {
    const holidays = await calendarFor(this.prisma, r.orgId);
    await this.prisma.task.create({
      data: {
        orgId: r.orgId,
        engagementId: r.engagementId,
        title: `${prefix}: ${r.description.slice(0, 70)}`,
        flowStep: `request:${r.id}`,
        kind: 'work',
        role: 'am',
        ownerId: r.engagement.amId,
        deadline: addWorkingDays(new Date(), r.type === 'urgent' ? 1 : 2, holidays),
      },
    });
  }

  async decide(me: Me, id: string, input: DecideRequest, ip?: string) {
    const r = await this.load(me, id);
    if (me.type !== 'staff') throw new ForbiddenException();
    if (!isLeadership(me) && r.engagement.amId !== me.id && r.assigneeId !== me.id) throw new ForbiddenException("Only the client's Account Manager can act on this request");
    if (!OPEN.includes(r.status) && input.action !== 'reply') throw new BadRequestException('This request is closed');
    const now = new Date();
    const data: Prisma.RequestUncheckedUpdateInput = {};
    const isPublicReply = !(input.action === 'reply' && input.internal);
    if (isPublicReply && !r.firstReplyAt) data.firstReplyAt = now;
    let clientNotice: string | null = null;

    switch (input.action) {
      case 'reply':
        if (input.internal) break;
        clientNotice = 'BMU replied to your request';
        break;
      case 'in_scope':
        if (r.type === 'new_scope') throw new BadRequestException('Extra requests are new scope: send a quote instead');
        if (!['received', 'scope_check', 'rescheduled'].includes(r.status)) throw new BadRequestException('Already decided');
        data.status = 'in_progress';
        await this.createWorkTask(r, 'Change request');
        clientNotice = 'Your request is included in your package and in progress';
        break;
      case 'quote': {
        if (['approved', 'paid', 'in_progress'].includes(r.status)) throw new BadRequestException('Already approved');
        let amount: number;
        if (input.customAmountPaise) {
          // quote_addon: AMs quote from the add-on price list only; Founder/Admin may set a custom price.
          if (!me.roles.some((x) => ['founder', 'admin'].includes(x))) throw new ForbiddenException('Account Managers quote from the add-on price list');
          amount = input.customAmountPaise;
        } else {
          if (!input.addOnId) throw new BadRequestException('Pick an add-on from the price list');
          const addOn = await this.prisma.addOn.findFirst({ where: { id: input.addOnId, orgId: r.orgId, priceBook: { status: 'active' } } });
          if (!addOn) throw new BadRequestException('Unknown add-on');
          if (!addOn.pricePaise) throw new BadRequestException('This add-on is custom-quoted: ask the Founder or an Admin to price it');
          amount = addOn.pricePaise * input.quantity;
          data.addOnId = addOn.id;
        }
        data.status = 'quoted';
        data.type = 'new_scope';
        data.scopeDecision = 'new_direction';
        data.quoteAmountPaise = amount;
        data.timeline = input.timeline;
        clientNotice = 'You have a quote to review';
        break;
      }
      case 'accept_urgent':
        if (r.type !== 'urgent') throw new BadRequestException('Only urgent requests are accepted this way');
        data.status = 'in_progress';
        await this.createWorkTask(r, 'Urgent');
        clientNotice = 'Your urgent request was accepted';
        break;
      case 'reschedule':
        data.status = 'rescheduled';
        data.timeline = input.timeline;
        clientNotice = `Your request was rescheduled: ${input.timeline}`;
        break;
      case 'done':
        if (r.type === 'new_scope' && !['paid', 'in_progress'].includes(r.status)) throw new BadRequestException('Extra requests need written approval and payment before work starts');
        if (r.status === 'quoted' || r.status === 'approved') throw new BadRequestException('Waiting for the client');
        data.status = 'done';
        data.resolvedAt = now;
        await this.prisma.task.updateMany({ where: { flowStep: `request:${r.id}`, status: { notIn: ['done', 'cancelled'] } }, data: { status: 'done', completedAt: now } });
        clientNotice = 'Your request is done. Tell us how we did (thumbs up or down)';
        break;
      case 'decline':
        data.status = 'declined';
        data.resolvedAt = now;
        clientNotice = 'Update on your request';
        break;
    }

    const message = 'message' in input ? input.message : undefined;
    await this.prisma.$transaction([
      this.prisma.request.update({ where: { id: r.id }, data }),
      ...(message
        ? [this.prisma.comment.create({ data: { orgId: r.orgId, targetType: 'request', targetId: r.id, body: message, isInternal: input.action === 'reply' && input.internal, authorId: me.id } })]
        : []),
    ]);
    await this.audit.log(me, `request.${input.action}`, 'Request', r.id, { status: r.status }, { status: data.status ?? r.status }, ip);
    if (clientNotice) {
      const who = data.status === 'quoted' ? await this.notifications.clientDeciders(r.engagement.clientOrgId) : await this.requesterAndOwners(r);
      await this.notifications.notify(r.orgId, who, { kind: `request_${input.action}`, title: clientNotice, body: message?.slice(0, 140), link: `/client/requests/${r.id}`, critical: data.status === 'quoted' });
    }
    return this.view(me, await this.load(me, id));
  }

  private async requesterAndOwners(r: Row) {
    return [r.createdById, ...(await this.notifications.clientDeciders(r.engagement.clientOrgId))];
  }
}
