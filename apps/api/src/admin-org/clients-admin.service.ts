import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  OFFBOARDING_CHECKS,
  type AdminEngagementRow,
  type AmWorkloadView,
  type DiscountApprovalRow,
  type EngagementLifecycle,
  type Me,
  type OffboardingCheckKey,
  type OffboardingRow,
} from '@bmu/shared';
import type { EngagementStatus, Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ReassignService } from '../actions/reassign.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AM_ROLES, assertCatalogue, assertClientAdmin } from './access.js';

/** Not counted as active work. */
const INACTIVE: EngagementStatus[] = ['paused', 'offboarding', 'closed', 'delivered'];
const UNPAID = ['issued', 'partially_paid', 'overdue'] as const;
const LIFECYCLE_ACTION = 'engagement.lifecycle';
const CHECK_ACTION = 'engagement.offboarding_check';

const engagementInclude = {
  clientOrg: { select: { id: true, name: true } },
  service: { select: { name: true } },
  am: { select: { id: true, name: true } },
} satisfies Prisma.EngagementInclude;
type EngagementWith = Prisma.EngagementGetPayload<{ include: typeof engagementInclude }>;

const toRow = (e: EngagementWith): AdminEngagementRow => ({
  id: e.id,
  client: { id: e.clientOrg.id, name: e.clientOrg.name },
  serviceName: e.service.name,
  tier: e.tier,
  billingType: e.billingType,
  status: e.status,
  currentGate: e.currentGate,
  am: e.am ? { id: e.am.id, name: e.am.name } : null,
  startDate: e.startDate?.toISOString() ?? null,
  createdAt: e.createdAt.toISOString(),
});

/** Engagements overview, CM assignment, pause/offboard/close and the offboarding checklist. */
@Injectable()
export class ClientsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly reassign: ReassignService,
  ) {}

  async engagements(me: Me): Promise<AdminEngagementRow[]> {
    assertClientAdmin(me);
    const list = await this.prisma.engagement.findMany({
      where: { orgId: me.orgId, deletedAt: null },
      include: engagementInclude,
      orderBy: { createdAt: 'desc' },
    });
    return list.map(toRow);
  }

  // ---------------------------------------------------------------------------
  // CM assignment

  async workload(me: Me): Promise<AmWorkloadView> {
    assertClientAdmin(me);
    const [ams, clients] = await Promise.all([
      this.prisma.user.findMany({
        where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: { in: AM_ROLES } } } } },
        select: { id: true, name: true, roles: { select: { role: { select: { baseRole: true } } } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.clientOrg.findMany({
        where: { orgId: me.orgId, deletedAt: null },
        select: { id: true, name: true, health: true, am: { select: { id: true, name: true } }, engagements: { where: { deletedAt: null }, select: { status: true, amId: true } } },
        orderBy: { name: 'asc' },
      }),
    ]);
    const active = (s: EngagementStatus) => !INACTIVE.includes(s);
    return {
      canEdit: true,
      ams: ams.map((a) => ({
        id: a.id,
        name: a.name,
        role: a.roles.some((r) => r.role.baseRole === 'am_lead') ? 'am_lead' : 'account_manager',
        clients: clients.filter((c) => c.am?.id === a.id).length,
        activeEngagements: clients.flatMap((c) => c.engagements).filter((e) => e.amId === a.id && active(e.status)).length,
      })),
      clients: clients.map((c) => ({ id: c.id, name: c.name, health: c.health, am: c.am, activeEngagements: c.engagements.filter((e) => active(e.status)).length })),
    };
  }

  async reassignAm(me: Me, clientOrgId: string, amUserId: string, ip?: string) {
    assertClientAdmin(me);
    const client = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId, deletedAt: null } });
    if (!client) throw new NotFoundException('Client not found');
    const am = await this.prisma.user.findFirst({
      where: { id: amUserId, orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: { in: AM_ROLES } } } } },
    });
    if (!am) throw new BadRequestException('Choose an active client manager');
    if (client.amUserId === am.id) throw new ConflictException(`${am.name} already manages this client`);
    const moved = await this.prisma.$transaction(async (tx) => {
      await tx.clientOrg.update({ where: { id: client.id }, data: { amUserId: am.id } });
      // Open engagements move with the client; closed ones keep their history.
      const r = await tx.engagement.updateMany({ where: { clientOrgId: client.id, deletedAt: null, status: { not: 'closed' } }, data: { amId: am.id } });
      return r.count;
    });
    await this.audit.log(me, 'client.am_reassigned', 'ClientOrg', client.id, { amUserId: client.amUserId }, { amUserId: am.id, engagementsMoved: moved }, ip);
    await this.reassign.record(me, 'client_am', [{ id: client.id, fromUserId: client.amUserId, toUserId: am.id }], 'other', 'Changed in Command Centre → CM workload');
    await this.prisma.notification.create({
      data: {
        orgId: me.orgId,
        userId: am.id,
        kind: 'client_assigned',
        title: `You are now the client manager for ${client.name}`,
        body: `${me.name} assigned this client to you${moved ? ` with ${moved} open engagement${moved === 1 ? '' : 's'}` : ''}.`,
        link: '/team/clients',
      },
    });
    return this.workload(me);
  }

  // ---------------------------------------------------------------------------
  // Pause, offboarding and close

  async offboarding(me: Me): Promise<OffboardingRow[]> {
    assertClientAdmin(me);
    const list = await this.prisma.engagement.findMany({
      where: { orgId: me.orgId, deletedAt: null, status: { not: 'pending_payment' } },
      include: engagementInclude,
      orderBy: { createdAt: 'desc' },
    });
    return this.offboardingRows(me, list);
  }

  private async offboardingRows(me: Me, list: EngagementWith[]): Promise<OffboardingRow[]> {
    if (!list.length) return [];
    const ids = list.map((e) => e.id);
    const clientIds = [...new Set(list.map((e) => e.clientOrgId))];
    const [invoices, deliverables, events] = await Promise.all([
      this.prisma.invoice.findMany({
        where: { orgId: me.orgId, status: { in: [...UNPAID] }, OR: [{ engagementId: { in: ids } }, { clientOrgId: { in: clientIds }, engagementId: null }] },
        select: { id: true, number: true, status: true, totalPaise: true, engagementId: true, clientOrgId: true },
      }),
      this.prisma.deliverable.findMany({
        where: { orgId: me.orgId, cycle: { engagementId: { in: ids } }, approvedVersionId: { not: null } },
        select: { approvedVersionId: true, cycle: { select: { engagementId: true } } },
      }),
      this.prisma.auditEvent.findMany({
        where: { orgId: me.orgId, entity: 'Engagement', entityId: { in: ids }, action: { startsWith: 'engagement.' } },
        orderBy: { at: 'asc' },
      }),
    ]);
    const versions = await this.prisma.version.findMany({
      where: { id: { in: deliverables.map((d) => d.approvedVersionId!) } },
      select: { id: true, file: { select: { released: true } } },
    });
    const released = new Map(versions.map((v) => [v.id, v.file.released]));
    const actorIds = [...new Set(events.map((e) => e.actorId).filter(Boolean) as string[])];
    const actors = new Map((await this.prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));

    return list.map((e): OffboardingRow => {
      const unpaid = invoices.filter((i) => i.engagementId === e.id || (!i.engagementId && i.clientOrgId === e.clientOrgId));
      const finals = deliverables.filter((d) => d.cycle.engagementId === e.id).map((d) => released.get(d.approvedVersionId!) ?? false);
      const mine = events.filter((ev) => ev.entityId === e.id);
      const checklist = Object.fromEntries(OFFBOARDING_CHECKS.map((c) => [c.key, { done: false, by: null, at: null }])) as OffboardingRow['checklist'];
      for (const ev of mine.filter((x) => x.action === CHECK_ACTION)) {
        const a = ev.after as { key?: OffboardingCheckKey; done?: boolean } | null;
        if (a?.key && a.key in checklist) checklist[a.key] = { done: !!a.done, by: ev.actorId ? (actors.get(ev.actorId) ?? null) : null, at: ev.at.toISOString() };
      }
      const last = [...mine].reverse().find((x) => x.action.startsWith(`${LIFECYCLE_ACTION}.`));
      const s = e.status;
      const closeBlockedReason = unpaid.length
        ? `${unpaid.length} unpaid invoice${unpaid.length === 1 ? '' : 's'} (${unpaid.map((i) => i.number).join(', ')}). Collect or credit-note ${unpaid.length === 1 ? 'it' : 'them'} first.`
        : null;
      return {
        ...toRow(e),
        filesReleased: finals.length ? finals.every(Boolean) : null,
        unpaidInvoices: unpaid.map(({ id, number, status, totalPaise }) => ({ id, number, status, totalPaise })),
        checklist,
        lastChange: last
          ? { action: last.action.slice(LIFECYCLE_ACTION.length + 1), reason: (last.after as { reason?: string } | null)?.reason ?? null, by: last.actorId ? (actors.get(last.actorId) ?? null) : null, at: last.at.toISOString() }
          : null,
        can: {
          pause: !['paused', 'offboarding', 'closed'].includes(s),
          offboard: !['offboarding', 'closed'].includes(s),
          close: s !== 'closed' && !closeBlockedReason,
          reactivate: ['paused', 'offboarding', 'closed'].includes(s),
        },
        closeBlockedReason: s === 'closed' ? null : closeBlockedReason,
      };
    });
  }

  private async engagement(me: Me, id: string) {
    const e = await this.prisma.engagement.findFirst({ where: { id, orgId: me.orgId, deletedAt: null }, include: engagementInclude });
    if (!e) throw new NotFoundException('Engagement not found');
    return e;
  }

  private async one(me: Me, id: string) {
    return (await this.offboardingRows(me, [await this.engagement(me, id)]))[0];
  }

  async lifecycle(me: Me, id: string, input: EngagementLifecycle, ip?: string): Promise<OffboardingRow> {
    assertClientAdmin(me);
    const row = await this.one(me, id);
    const allowed = { pause: row.can.pause, offboard: row.can.offboard, close: row.can.close, reactivate: row.can.reactivate }[input.action];
    if (!allowed) {
      if (input.action === 'close' && row.closeBlockedReason) throw new ConflictException(`Can't close yet: ${row.closeBlockedReason}`);
      throw new ConflictException(`This engagement is ${row.status.replace(/_/g, ' ')}, so it can't be ${input.action === 'offboard' ? 'moved to offboarding' : `${input.action}d`}`);
    }
    let next: EngagementStatus;
    const data: Prisma.EngagementUpdateInput = {};
    if (input.action === 'pause') next = 'paused';
    else if (input.action === 'offboard') next = 'offboarding';
    else if (input.action === 'close') {
      next = 'closed';
      data.endDate = new Date();
    } else {
      next = await this.statusBeforeStop(me, id, row.billingType);
      data.endDate = null;
    }
    data.status = next;
    await this.prisma.engagement.update({ where: { id }, data });
    await this.audit.log(me, `${LIFECYCLE_ACTION}.${input.action}`, 'Engagement', id, { status: row.status }, { status: next, reason: input.reason ?? null }, ip);
    if (row.am && row.am.id !== me.id) {
      const verb = { pause: 'paused', offboard: 'moved to offboarding', close: 'closed', reactivate: 'reactivated' }[input.action];
      await this.prisma.notification.create({
        data: {
          orgId: me.orgId,
          userId: row.am.id,
          kind: 'engagement_status',
          title: `${row.client.name} · ${row.serviceName} was ${verb}`,
          body: input.reason ? `${me.name}: ${input.reason}` : `By ${me.name}`,
          link: `/team/projects/${id}`,
        },
      });
    }
    return this.one(me, id);
  }

  /** The status an engagement had before it was first paused/offboarded/closed in its latest stop. */
  private async statusBeforeStop(me: Me, id: string, billingType: string): Promise<EngagementStatus> {
    const events = await this.prisma.auditEvent.findMany({
      where: { orgId: me.orgId, entity: 'Engagement', entityId: id, action: { startsWith: `${LIFECYCLE_ACTION}.` } },
      orderBy: { at: 'desc' },
      take: 20,
    });
    const stopped: string[] = ['paused', 'offboarding', 'closed'];
    for (const ev of events) {
      const before = (ev.before as { status?: string } | null)?.status;
      if (before && !stopped.includes(before)) return before as EngagementStatus;
    }
    return billingType === 'monthly' ? 'active_retainer' : 'in_production';
  }

  async tick(me: Me, id: string, key: OffboardingCheckKey, done: boolean, ip?: string): Promise<OffboardingRow> {
    assertClientAdmin(me);
    const e = await this.engagement(me, id);
    if (!['offboarding', 'paused', 'closed'].includes(e.status)) throw new ConflictException('Start offboarding before ticking the checklist');
    // The audit trail is the record: the latest tick per item wins.
    await this.audit.log(me, CHECK_ACTION, 'Engagement', id, null, { key, done }, ip);
    return this.one(me, id);
  }

  // ---------------------------------------------------------------------------
  // Catalogue: proposals whose discount went beyond the seller's limit

  async discountApprovals(me: Me): Promise<DiscountApprovalRow[]> {
    assertCatalogue(me);
    const list = await this.prisma.proposal.findMany({
      where: { orgId: me.orgId, deletedAt: null, OR: [{ discountNeedsApproval: true }, { discountApprovedById: { not: null } }] },
      include: { lead: { select: { contact: true } } },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
    const ids = [...new Set(list.flatMap((p) => [p.createdById, p.discountApprovedById]).filter(Boolean) as string[])];
    const names = new Map((await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    return list.map((p) => {
      const c = (p.lead.contact ?? {}) as { company?: string; name?: string };
      return {
        id: p.id,
        lead: c.company || c.name || 'Lead',
        extraDiscountPct: p.extraDiscountPct,
        discountPaise: p.discountPaise,
        totalPaise: p.totalPaise,
        status: p.status,
        createdBy: p.createdById ? (names.get(p.createdById) ?? null) : null,
        approvedBy: p.discountApprovedById ? (names.get(p.discountApprovedById) ?? null) : null,
        createdAt: p.createdAt.toISOString(),
      };
    });
  }
}
