// v11 clients: reassignment engine targets `client_am` (a client's account manager) and `request` (who handles a
// client request). The engine does candidates, impact, reasons, handover notes, Assignment rows (7-day read access for
// the previous owner), audit, notifications and undo; these targets load, check and apply.
import { ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import { hasRole } from '../actions/people.js';
import { ActionsRegistry, type ReassignItem } from '../actions/registry.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AM_BASE_ROLES, assertStaff, isClientLead, seesAllClients } from './clients-access.js';

const OPEN_REQUEST = ['received', 'scope_check', 'in_scope', 'quoted', 'approved', 'paid', 'in_progress', 'rescheduled'];
/** People who may handle a client request. */
const REQUEST_ROLES = ['account_manager', 'am_lead', 'department_head', 'strategist'];

@Injectable()
export class ClientsTargets implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ActionsRegistry,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.registry.registerReassignTarget({
      type: 'client_am',
      label: 'Client account manager',
      auditEntity: 'ClientOrg',
      load: async (me, ids) => {
        assertStaff(me);
        const rows = await this.prisma.clientOrg.findMany({ where: { id: { in: ids }, orgId: me.orgId, deletedAt: null } });
        if (rows.length !== new Set(ids).size) throw new NotFoundException('Client not found');
        if (!seesAllClients(me) && rows.some((r) => r.amUserId !== me.id)) throw new ForbiddenException("You don't have access to one of these clients");
        // The AM seat is client-facing and always "in progress": the old AM writes a handover note.
        return rows.map((c): ReassignItem => ({ id: c.id, title: c.name, ownerId: c.amUserId, deadline: null, status: c.archivedAt ? 'archived' : 'active', inProgress: true, clientOrgId: c.id, amId: null, hours: 0, href: `/team/clients/${c.id}` }));
      },
      assertCanReassign: async (me) => {
        if (!isClientLead(me)) throw new ForbiddenException("Only an AM Lead, Admin or the Founder can change a client's account manager");
      },
      eligibility: async () => ({ where: { roles: { some: { role: { baseRole: { in: AM_BASE_ROLES } } } } } }),
      snapshot: async (items) => {
        const rows: { model: string; id: string; data: Record<string, unknown> }[] = items.map((i) => ({ model: 'clientOrg', id: i.id, data: { amUserId: i.ownerId } }));
        const engs = await this.prisma.engagement.findMany({ where: { clientOrgId: { in: items.map((i) => i.id) }, deletedAt: null, status: { not: 'closed' } }, select: { id: true, amId: true } });
        return [...rows, ...engs.map((e) => ({ model: 'engagement', id: e.id, data: { amId: e.amId } }))];
      },
      apply: async (me, items, { to, input }) => {
        for (const c of items) {
          await this.prisma.$transaction([
            this.prisma.clientOrg.update({ where: { id: c.id }, data: { amUserId: to.id } }),
            // Open engagements move with the client; closed ones keep their history.
            this.prisma.engagement.updateMany({ where: { clientOrgId: c.id, deletedAt: null, status: { not: 'closed' } }, data: { amId: to.id } }),
          ]);
          await this.introduce(me, c.id, c.ownerId, to, input.handoverNote ?? null);
        }
      },
      openWorkOf: async (orgId, userId) => {
        const rows = await this.prisma.clientOrg.findMany({ where: { orgId, amUserId: userId, deletedAt: null, archivedAt: null }, select: { id: true, name: true } });
        return rows.map((c) => ({ id: c.id, title: c.name, deadline: null, status: 'active', client: c.name }));
      },
      href: (i) => `/team/clients/${i.id}`,
    });
    this.registry.registerUndoModel('clientOrg');
    this.registry.registerUndoModel('engagement');

    this.registry.registerReassignTarget({
      type: 'request',
      label: 'Request',
      auditEntity: 'Request',
      load: async (me, ids) => {
        assertStaff(me);
        const rows = await this.prisma.request.findMany({ where: { id: { in: ids }, orgId: me.orgId }, include: { engagement: { select: { amId: true, clientOrgId: true, clientOrg: { select: { name: true } } } } } });
        if (rows.length !== new Set(ids).size) throw new NotFoundException('Request not found');
        const lead = isClientLead(me) || hasRole(me, 'finance');
        if (!lead && rows.some((r) => r.engagement.amId !== me.id && r.assigneeId !== me.id)) throw new ForbiddenException("One of these requests belongs to another Account Manager's client");
        return rows.map((r): ReassignItem => ({
          id: r.id,
          title: `${r.engagement.clientOrg.name}: ${r.description.slice(0, 60)}`,
          ownerId: r.assigneeId ?? r.engagement.amId,
          deadline: r.neededBy ?? r.slaDue,
          status: r.status,
          inProgress: ['in_progress', 'paid', 'approved'].includes(r.status),
          clientDueAt: r.neededBy,
          clientOrgId: r.engagement.clientOrgId,
          amId: r.engagement.amId,
          hours: 2,
          href: `/team/requests/${r.id}`,
        }));
      },
      assertCanReassign: async (me, items) => {
        if (isClientLead(me)) return;
        if (!hasRole(me, 'account_manager')) throw new ForbiddenException('Only the Account Manager or AM Lead can reassign requests');
        if (items.some((i) => i.amId !== me.id)) throw new ForbiddenException("You can only reassign requests for your own clients");
        if (items.some((i) => !OPEN_REQUEST.includes(i.status ?? ''))) throw new ForbiddenException('Closed requests stay with whoever finished them');
      },
      eligibility: async () => ({ where: { roles: { some: { role: { baseRole: { in: REQUEST_ROLES } } } } } }),
      snapshot: async (items) => {
        const rows = await this.prisma.request.findMany({ where: { id: { in: items.map((i) => i.id) } }, select: { id: true, assigneeId: true } });
        return rows.map((r) => ({ model: 'request', id: r.id, data: { assigneeId: r.assigneeId } }));
      },
      apply: async (_me, items, { to }) => {
        await this.prisma.request.updateMany({ where: { id: { in: items.map((i) => i.id) } }, data: { assigneeId: to.id } });
      },
      openWorkOf: async (orgId, userId) => {
        const rows = await this.prisma.request.findMany({ where: { orgId, assigneeId: userId, status: { in: OPEN_REQUEST as never[] } }, include: { engagement: { select: { clientOrg: { select: { name: true } } } } }, take: 200 });
        return rows.map((r) => ({ id: r.id, title: r.description.slice(0, 80), deadline: r.neededBy ?? r.slaDue, status: r.status, client: r.engagement.clientOrg.name }));
      },
      href: (i) => `/team/requests/${i.id}`,
    });
    this.registry.registerUndoModel('request');
  }

  /** The client meets the new AM in their thread; the handover note is kept as an internal note. */
  private async introduce(me: Me, clientOrgId: string, fromId: string | null, to: { id: string; name: string }, handover: string | null) {
    const [c, am, from] = await Promise.all([
      this.prisma.clientOrg.findUnique({ where: { id: clientOrgId }, select: { name: true, orgId: true } }),
      this.prisma.user.findUnique({ where: { id: to.id }, select: { name: true, email: true, phone: true } }),
      fromId ? this.prisma.user.findUnique({ where: { id: fromId }, select: { name: true } }) : null,
    ]);
    if (!c || !am) return;
    const thread = (await this.prisma.thread.findFirst({ where: { clientOrgId, type: 'client_am' } })) ?? (await this.prisma.thread.create({ data: { orgId: c.orgId, clientOrgId, type: 'client_am' } }));
    const reach = [am.email, am.phone].filter(Boolean).join(' · ');
    const intro = `Hello! I'm ${am.name}, your new account manager at BMU${from ? `, taking over from ${from.name}` : ''}. I have the full history of your account, so nothing changes for you. Message me here any time${reach ? ` (${reach})` : ''}.`;
    await this.prisma.message.create({ data: { orgId: c.orgId, threadId: thread.id, authorId: to.id, body: intro } });
    if (handover) await this.prisma.message.create({ data: { orgId: c.orgId, threadId: thread.id, authorId: me.id, body: `Handover note for ${am.name}: ${handover}`, isInternal: true } });
    const deciders = await this.prisma.clientUser.findMany({ where: { clientOrgId, user: { deletedAt: null, status: { not: 'suspended' } } }, select: { userId: true } });
    await this.notifications.notify(c.orgId, deciders.map((d) => d.userId), { kind: 'am_changed', title: `Meet ${am.name}, your new account manager`, body: intro.slice(0, 160), link: '/client/messages' });
  }
}
