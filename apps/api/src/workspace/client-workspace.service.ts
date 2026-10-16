import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { CLIENT_TEAM_ROLES, type ClientReport, type ClientTeamRole, type ClientTeamView, type InviteClientUser, type Me, type UpdateClientUser } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { trackFor } from './team.service.js';
import { canSeeBilling, isUniqueError, monthRange } from './util.js';
import { clientVisibleInvoiceWhere, readInvoiceBranding } from '../service/invoice-branding.service.js';

const APPROVED = ['approved', 'scheduled', 'published'];
const monthLabel = new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });

/** Client app: monthly report and the client's own team users. Always scoped to the signed-in client's account. */
@Injectable()
export class ClientWorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  private clientOrgId(me: Me) {
    if (me.type !== 'client' || !me.clientOrg) throw new ForbiddenException('Client accounts only');
    return me.clientOrg.id;
  }

  // -------------------------------------------------------------------------
  // Monthly report

  async report(me: Me, month: string | undefined): Promise<ClientReport> {
    const clientOrgId = this.clientOrgId(me);
    const range = monthRange(month);
    const within = { gte: range.start, lt: range.end };
    const org = await this.prisma.clientOrg.findUniqueOrThrow({
      where: { id: clientOrgId },
      include: { engagements: { where: { deletedAt: null }, include: { service: true, cycles: { include: { deliverables: true } } }, orderBy: { createdAt: 'asc' } } },
    });
    const deliverables = org.engagements.flatMap((e) => e.cycles.flatMap((c) => c.deliverables.map((d) => ({ ...d, serviceName: e.service.name }))));
    const deliverableIds = deliverables.map((d) => d.id);
    const engagementIds = org.engagements.map((e) => e.id);

    const [approvals, changeRounds, opened, resolved, firstReplies] = await Promise.all([
      this.prisma.approval.findMany({ where: { targetType: 'deliverable', targetId: { in: deliverableIds }, at: within }, orderBy: { at: 'desc' } }),
      this.prisma.auditEvent.count({ where: { action: 'deliverable.changes_requested', entityId: { in: deliverableIds }, at: within } }),
      this.prisma.request.findMany({ where: { engagementId: { in: engagementIds }, createdAt: within }, orderBy: { createdAt: 'desc' } }),
      this.prisma.request.count({ where: { engagementId: { in: engagementIds }, resolvedAt: within } }),
      this.prisma.request.findMany({ where: { engagementId: { in: engagementIds }, firstReplyAt: within }, select: { firstReplyAt: true, slaDue: true } }),
    ]);
    const versions = await this.prisma.version.findMany({ where: { id: { in: approvals.map((a) => a.versionId).filter((x): x is string => !!x) } } });
    const waits = approvals
      .map((a) => {
        const v = versions.find((x) => x.id === a.versionId);
        return v?.sentToClientAt ? (a.at.getTime() - v.sentToClientAt.getTime()) / 3_600_000 : null;
      })
      .filter((x): x is number => x !== null && x >= 0);
    const onTime = firstReplies.filter((r) => !r.slaDue || r.firstReplyAt! <= r.slaDue).length;

    let spend: ClientReport['spend'] = null;
    if (canSeeBilling(me)) {
      const [invoices, payments] = await Promise.all([
        this.prisma.invoice.findMany({ where: { clientOrgId, createdAt: within, status: { notIn: ['draft', 'void'] }, ...clientVisibleInvoiceWhere(await readInvoiceBranding(this.prisma, me.orgId)) }, orderBy: { createdAt: 'desc' } }),
        this.prisma.payment.findMany({ where: { invoice: { clientOrgId }, at: within } }),
      ]);
      spend = {
        invoicedPaise: invoices.reduce((s, i) => s + i.totalPaise, 0),
        paidPaise: payments.reduce((s, p) => s + p.amountPaise, 0),
        invoices: invoices.map((i) => ({ id: i.id, number: i.number, totalPaise: i.totalPaise, status: i.status, createdAt: i.createdAt.toISOString() })),
      };
    }

    const byType = new Map<string, number>();
    for (const r of opened) byType.set(r.type, (byType.get(r.type) ?? 0) + 1);

    return {
      period: range.month,
      periodLabel: monthLabel.format(range.start),
      client: { name: org.name },
      stats: {
        deliverablesApproved: approvals.length,
        draftsReviewed: approvals.length + changeRounds,
        avgApprovalHours: waits.length ? Math.round((waits.reduce((s, x) => s + x, 0) / waits.length) * 10) / 10 : null,
        requestsResolved: resolved,
        onTimeFirstReplyPct: firstReplies.length ? Math.round((onTime / firstReplies.length) * 100) : null,
      },
      approved: approvals.map((a) => {
        const d = deliverables.find((x) => x.id === a.targetId)!;
        return { id: a.id, title: d?.title ?? 'Deliverable', serviceName: d?.serviceName ?? '', version: versions.find((v) => v.id === a.versionId)?.number ?? null, approvedAt: a.at.toISOString() };
      }),
      requests: {
        opened: opened.length,
        resolved,
        byType: [...byType.entries()].map(([type, count]) => ({ type, count })),
        items: opened.slice(0, 10).map((r) => ({ id: r.id, type: r.type, description: r.description, status: r.status, createdAt: r.createdAt.toISOString() })),
      },
      spend,
      services: org.engagements.map((e) => {
        const ds = e.cycles.flatMap((c) => c.deliverables);
        return {
          id: e.id,
          serviceName: e.service.name,
          tier: e.tier,
          status: e.status,
          track: trackFor(e.currentGate, e.status),
          approved: ds.filter((d) => APPROVED.includes(d.status)).length,
          total: ds.length,
        };
      }),
    };
  }

  // -------------------------------------------------------------------------
  // Team users

  async team(me: Me): Promise<ClientTeamView> {
    const clientOrgId = this.clientOrgId(me);
    const rows = await this.prisma.clientUser.findMany({ where: { clientOrgId, user: { deletedAt: null } }, include: { user: true }, orderBy: { user: { createdAt: 'asc' } } });
    return {
      canManage: me.clientOrg!.role === 'client_owner',
      members: rows.map((r) => ({
        id: r.userId,
        name: r.user.name,
        email: r.user.email,
        phone: r.user.phone,
        role: ((CLIENT_TEAM_ROLES as readonly string[]).includes(r.clientRole) ? r.clientRole : 'client_viewer') as ClientTeamRole,
        status: r.user.status,
        isMe: r.userId === me.id,
      })),
    };
  }

  private assertOwner(me: Me) {
    const clientOrgId = this.clientOrgId(me);
    if (me.clientOrg!.role !== 'client_owner') throw new ForbiddenException('Only the account owner can manage team users');
    return clientOrgId;
  }

  private roleId(orgId: string, base: ClientTeamRole) {
    return this.prisma.role.findFirstOrThrow({ where: { orgId, baseRole: base, isCustom: false }, select: { id: true } }).then((r) => r.id);
  }

  async invite(me: Me, input: InviteClientUser, ip?: string) {
    const clientOrgId = this.assertOwner(me);
    if (await this.prisma.user.findFirst({ where: { orgId: me.orgId, email: input.email } })) {
      throw new BadRequestException('Someone with this email already has an account. Use a different email.');
    }
    const roleId = await this.roleId(me.orgId, input.role);
    try {
      const user = await this.prisma.$transaction(async (tx) => {
        const u = await tx.user.create({ data: { orgId: me.orgId, type: 'client', name: input.name, email: input.email, status: 'active' } });
        await tx.clientUser.create({ data: { userId: u.id, orgId: me.orgId, clientOrgId, clientRole: input.role, brandScope: [] } });
        await tx.userRole.create({ data: { userId: u.id, roleId } });
        return u;
      });
      await this.audit.log(me, 'client_user.invited', 'User', user.id, undefined, { clientOrgId, ...input }, ip);
      // v11 clients: welcome message in the client thread and the CM is told.
      const org = await this.prisma.clientOrg.findUnique({ where: { id: clientOrgId }, select: { name: true, amUserId: true } });
      const thread = await this.prisma.thread.findFirst({ where: { clientOrgId, type: 'client_am' } });
      if (thread && org?.amUserId) await this.prisma.message.create({ data: { orgId: me.orgId, threadId: thread.id, authorId: org.amUserId, body: `Welcome to BMU, ${input.name.split(' ')[0]}! ${me.name} added you to the account. Sign in with ${input.email} to follow the work and message us here.` } });
      await this.notifications.notify(me.orgId, [user.id], { kind: 'welcome', title: 'Welcome to BMU! Your account is ready', body: `${me.name} added you to ${org?.name ?? 'the account'}.`, link: '/client' });
      await this.notifications.notify(me.orgId, [org?.amUserId], { kind: 'client_updated', title: `${org?.name ?? 'A client'} added ${input.name} (${input.role.replace('client_', '')})`, link: `/team/clients/${clientOrgId}?tab=users` });
    } catch (e) {
      if (isUniqueError(e)) throw new BadRequestException('Someone with this email already has an account. Use a different email.');
      throw e;
    }
    return this.team(me);
  }

  async update(me: Me, userId: string, input: UpdateClientUser, ip?: string) {
    const clientOrgId = this.assertOwner(me);
    const target = await this.prisma.clientUser.findFirst({ where: { userId, clientOrgId }, include: { user: true } });
    if (!target) throw new NotFoundException('Team user not found');
    const losesOwner = target.clientRole === 'client_owner' && target.user.status !== 'suspended' && ((input.role && input.role !== 'client_owner') || input.active === false);
    if (losesOwner) {
      const owners = await this.prisma.clientUser.count({ where: { clientOrgId, clientRole: 'client_owner', user: { status: { not: 'suspended' }, deletedAt: null } } });
      if (owners <= 1) throw new BadRequestException('Your account needs at least one active owner. Make someone else an owner first.');
    }
    const before = { role: target.clientRole, status: target.user.status };
    await this.prisma.$transaction(async (tx) => {
      if (input.role && input.role !== target.clientRole) {
        await tx.clientUser.update({ where: { userId }, data: { clientRole: input.role } });
        await tx.userRole.deleteMany({ where: { userId, role: { baseRole: { in: [...CLIENT_TEAM_ROLES] } } } });
        await tx.userRole.create({ data: { userId, roleId: await this.roleId(me.orgId, input.role) } });
      }
      if (input.active !== undefined) await tx.user.update({ where: { id: userId }, data: { status: input.active ? 'active' : 'suspended' } });
    });
    await this.audit.log(me, input.active === false ? 'client_user.deactivated' : 'client_user.updated', 'User', userId, before, input, ip);
    return this.team(me);
  }
}
