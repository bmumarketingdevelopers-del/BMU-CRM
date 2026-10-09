// v11 people: offboarding as a blocking checklist. It can't finish while the person owns ANY open record (tasks,
// clients and engagements as AM, leads, client requests on their engagements, approvals waiting on them, creator
// briefs). HR finishes it with a final Admin confirmation; login is disabled at the end of the last day, and the
// person moves to "Former" on the tree. Builds on the v10 checklist (team-flows PeopleService).
import { BadRequestException, ForbiddenException, Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { istDate, type Me, type PeopleOffboard, type PeopleOffboardingStatus, type PeopleOpenRecords } from '@bmu/shared';
import { ApprovalsService } from '../actions/approvals.service.js';
import { ReassignService } from '../actions/reassign.service.js';
import { ActionsRegistry } from '../actions/registry.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PeopleService } from '../team-flows/people.service.js';
import { isFA, peopleCan, staffOnly } from './people-access.js';

const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const OPEN_LEAD = ['new', 'contacted', 'discovery', 'proposal_sent'] as const;
const CLOSED_ENGAGEMENT = ['delivered', 'closed'];
const OPEN_REQUEST = ['received', 'scope_check', 'in_scope', 'quoted', 'approved', 'paid', 'in_progress', 'rescheduled'] as const;
const OPEN_BRIEF = ['offered', 'accepted', 'submitted', 'revision', 'approved'] as const;

@Injectable()
export class OffboardingService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly approvals: ApprovalsService,
    private readonly registry: ActionsRegistry,
    private readonly reassign: ReassignService,
    private readonly team: PeopleService,
  ) {}

  onModuleInit() {
    this.registry.registerApprovalHandler({
      action: 'person.offboard',
      label: 'Confirm offboarding',
      href: (r) => `/admin/users/${r.targetId}`,
      apply: async ({ approver, req }) => {
        if (!isFA(approver)) throw new ForbiddenException('Only an Admin can confirm offboarding');
        return this.finish(approver, (req.payload as { processId: string }).processId);
      },
    });
    // The v10 checklist's "Complete" button follows the same blocking rules.
    this.team.offboardGuard = async (me, row) => {
      await this.assertNothingOpen(row.orgId, row.userId);
      if (!isFA(me)) throw new BadRequestException('An Admin gives the final confirmation. Use "Confirm offboarding" on the person to send it to an Admin.');
    };
  }

  /** Everything the person still owns that blocks offboarding. */
  async openRecords(orgId: string, userId: string): Promise<PeopleOpenRecords> {
    const [tasks, clients, engagements, leads, requests, approvals, briefs] = await Promise.all([
      this.prisma.task.findMany({ where: { orgId, ownerId: userId, status: { in: [...OPEN_TASK] }, archivedAt: null, isDraft: false }, select: { id: true, title: true, deadline: true }, orderBy: { deadline: 'asc' }, take: 300 }),
      this.prisma.clientOrg.findMany({ where: { orgId, amUserId: userId, deletedAt: null, archivedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.engagement.findMany({ where: { orgId, amId: userId, deletedAt: null, archivedAt: null, status: { notIn: CLOSED_ENGAGEMENT as never[] } }, select: { id: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } }),
      this.prisma.lead.findMany({ where: { orgId, ownerId: userId, deletedAt: null, archivedAt: null, stage: { in: [...OPEN_LEAD] } }, select: { id: true, contact: true } }),
      this.prisma.request.findMany({ where: { orgId, status: { in: [...OPEN_REQUEST] }, OR: [{ assigneeId: userId }, { assigneeId: null, engagement: { amId: userId, deletedAt: null } }] }, select: { id: true, description: true, engagementId: true }, take: 100 }),
      this.prisma.approvalRequest.findMany({ where: { orgId, approverId: userId, status: 'pending' }, select: { id: true, summary: true } }),
      this.prisma.creatorBrief.findMany({ where: { orgId, createdById: userId, status: { in: [...OPEN_BRIEF] } }, select: { id: true, title: true } }),
    ]);
    const out = {
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, deadline: t.deadline?.toISOString() ?? null, href: `/team/tasks/${t.id}` })),
      clients: clients.map((c) => ({ id: c.id, title: c.name, href: `/team/clients/${c.id}` })),
      engagements: engagements.map((e) => ({ id: e.id, title: `${e.clientOrg.name} · ${e.service.name}`, href: `/team/projects/${e.id}` })),
      leads: leads.map((l) => {
        const c = (l.contact ?? {}) as { name?: string; company?: string };
        return { id: l.id, title: c.company || c.name || 'Lead', href: `/team/leads/${l.id}` };
      }),
      requests: requests.map((r) => ({ id: r.id, title: r.description.slice(0, 80), href: `/team/requests/${r.id}` })),
      approvals: approvals.map((a) => ({ id: a.id, title: a.summary, href: '/admin/approvals' })),
      briefs: briefs.map((b) => ({ id: b.id, title: b.title, href: '/team/creators' })),
    };
    return { ...out, total: Object.values(out).reduce((s, l) => s + l.length, 0) };
  }

  private describe(o: PeopleOpenRecords) {
    const parts: [number, string][] = [
      [o.tasks.length, 'open task'],
      [o.clients.length, 'client (as AM)'],
      [o.engagements.length, 'engagement (as AM)'],
      [o.leads.length, 'open lead'],
      [o.requests.length, 'client request'],
      [o.approvals.length, 'approval waiting on them'],
      [o.briefs.length, 'creator brief'],
    ];
    return parts.filter(([n]) => n).map(([n, l]) => `${n} ${l}${n > 1 ? (l.includes('(') ? '' : 's') : ''}`);
  }

  async assertNothingOpen(orgId: string, userId: string) {
    const open = await this.openRecords(orgId, userId);
    if (open.total) {
      const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } });
      throw new BadRequestException(`${u?.name ?? 'This person'} still owns ${this.describe(open).join(', ')}. Reassign everything before finishing offboarding.`);
    }
  }

  private async user(me: Me, id: string) {
    const u = await this.prisma.user.findFirst({ where: { id, orgId: me.orgId, type: 'staff', deletedAt: null } });
    if (!u) throw new NotFoundException('Person not found');
    return u;
  }

  async status(me: Me, userId: string): Promise<PeopleOffboardingStatus> {
    staffOnly(me);
    if (!peopleCan(me).offboard && !peopleCan(me).reassignWork) throw new ForbiddenException('Only HR, an Admin or the Founder can see offboarding');
    const u = await this.user(me, userId);
    await this.team.suspendDueLeavers(me.orgId);
    const row = await this.prisma.peopleProcess.findFirst({ where: { userId, kind: 'offboarding', status: { in: ['open', 'done'] } }, orderBy: { createdAt: 'desc' } });
    const open = await this.openRecords(me.orgId, userId);
    const items = row ? ((await this.team.get(me, row.id).catch(() => null))?.items ?? []) : [];
    const pendingItems = items.filter((i) => !i.done && i.key !== 'access_suspended' && !i.key.startsWith('reassign_')).map((i) => i.label);
    const blockers = [...(open.total ? [`Still owns ${this.describe(open).join(', ')}`] : []), ...(pendingItems.length ? [`${pendingItems.length} checklist item${pendingItems.length > 1 ? 's' : ''} open`] : [])];
    const pendingApproval = row ? await this.prisma.approvalRequest.findFirst({ where: { orgId: me.orgId, action: 'person.offboard', targetId: userId, status: 'pending' } }) : null;
    if (pendingApproval) blockers.push('Waiting for an Admin to confirm');
    return {
      person: { id: u.id, name: u.name },
      processId: row?.id ?? null,
      lastDay: row?.lastDay ? row.lastDay.toISOString().slice(0, 10) : null,
      status: row?.status ?? null,
      openRecords: open,
      pendingItems,
      canConfirm: !!row && row.status === 'open' && peopleCan(me).offboard && !blockers.length,
      confirmNeedsAdmin: !isFA(me),
      blockers,
    };
  }

  async start(me: Me, userId: string, input: PeopleOffboard, ip?: string): Promise<PeopleOffboardingStatus> {
    staffOnly(me);
    if (!peopleCan(me).offboard) throw new ForbiddenException('Only HR, an Admin or the Founder can offboard people');
    const u = await this.user(me, userId);
    if (u.leftAt) throw new BadRequestException(`${u.name} has already left`);
    const p = await this.team.startOffboarding(me, { userId, lastDay: input.lastDay, note: [input.reason, input.note].filter(Boolean).join(' · ') }, ip);
    await this.audit.log(me, 'user.offboarding_started', 'User', userId, null, { processId: p.id, lastDay: input.lastDay, reason: input.reason }, ip);
    // Affected AMs: clients whose work this person is doing.
    const ams = await this.prisma.task.findMany({ where: { orgId: me.orgId, ownerId: userId, status: { in: [...OPEN_TASK] }, engagementId: { not: null } }, select: { engagementId: true }, distinct: ['engagementId'] });
    const engs = ams.length ? await this.prisma.engagement.findMany({ where: { id: { in: ams.map((a) => a.engagementId!) } }, select: { amId: true } }) : [];
    const amIds = [...new Set(engs.map((e) => e.amId).filter((x): x is string => !!x && x !== userId && x !== me.id))];
    if (amIds.length) await this.notifications.notify(me.orgId, amIds, { kind: 'offboarding', title: `${u.name} leaves on ${input.lastDay}: some of your clients' work needs a new owner`, link: `/admin/users/${userId}` });
    const hr = await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'hr_ops' } } } }, select: { id: true } });
    await this.notifications.notify(me.orgId, hr.map((h) => h.id).filter((x) => x !== me.id), { kind: 'offboarding', title: `Offboarding started: ${u.name} (last day ${input.lastDay})`, link: `/admin/users/${userId}` });
    return this.status(me, userId);
  }

  /** Hands over what the engine doesn't move: approvals waiting on them, and their creator briefs. */
  async handover(me: Me, userId: string, input: { kind: 'approvals' | 'briefs'; toUserId: string }, ip?: string): Promise<PeopleOffboardingStatus> {
    staffOnly(me);
    if (!peopleCan(me).offboard) throw new ForbiddenException('Only HR, an Admin or the Founder can hand over work');
    const u = await this.user(me, userId);
    const to = await this.user(me, input.toUserId);
    if (to.id === u.id) throw new BadRequestException('Pick someone other than the person leaving');
    if (to.status !== 'active' || to.leftAt) throw new BadRequestException(`${to.name} is not an active team member`);
    let ids: string[] = [];
    if (input.kind === 'approvals') {
      ids = (await this.prisma.approvalRequest.findMany({ where: { orgId: me.orgId, approverId: userId, status: 'pending' }, select: { id: true, requestedById: true } })).filter((a) => a.requestedById !== to.id).map((a) => a.id);
      if (ids.length) await this.prisma.approvalRequest.updateMany({ where: { id: { in: ids } }, data: { approverId: to.id } });
    } else {
      ids = (await this.prisma.creatorBrief.findMany({ where: { orgId: me.orgId, createdById: userId, status: { in: [...OPEN_BRIEF] } }, select: { id: true } })).map((b) => b.id);
      if (ids.length) await this.prisma.creatorBrief.updateMany({ where: { id: { in: ids } }, data: { createdById: to.id } });
    }
    if (!ids.length) throw new BadRequestException(input.kind === 'approvals' ? 'No approvals to hand over (one asked for by the new person must go to someone else)' : 'No open creator briefs to hand over');
    await this.reassign.record(me, input.kind === 'approvals' ? 'approval' : 'creator_brief', ids.map((id) => ({ id, fromUserId: userId, toUserId: to.id })), 'offboarding', `Handover from ${u.name}`);
    await this.audit.log(me, 'offboarding.work_reassigned', 'User', userId, null, { kind: input.kind, count: ids.length, toUserId: to.id, toName: to.name }, ip);
    await this.notifications.notify(me.orgId, [to.id], { kind: input.kind === 'approvals' ? 'approval_needed' : 'task_assigned', title: input.kind === 'approvals' ? `${ids.length} approval${ids.length > 1 ? 's' : ''} handed over to you from ${u.name}` : `${ids.length} creator brief${ids.length > 1 ? 's' : ''} handed over to you from ${u.name}`, link: input.kind === 'approvals' ? '/team/approvals' : '/team/creators' });
    return this.status(me, userId);
  }

  /** Finish offboarding: blocked while anything is open; HR's request goes to an Admin for the final confirmation. */
  async confirm(me: Me, userId: string, ip?: string) {
    staffOnly(me);
    if (!peopleCan(me).offboard) throw new ForbiddenException('Only HR, an Admin or the Founder can finish offboarding');
    const u = await this.user(me, userId);
    const row = await this.prisma.peopleProcess.findFirst({ where: { userId, kind: 'offboarding', status: 'open' }, orderBy: { createdAt: 'desc' } });
    if (!row) throw new BadRequestException(`Start offboarding ${u.name} first`);
    await this.assertNothingOpen(me.orgId, userId);
    const s = await this.status(me, userId);
    if (s.pendingItems.length) throw new BadRequestException(`${s.pendingItems.length} checklist item${s.pendingItems.length > 1 ? 's are' : ' is'} still open: ${s.pendingItems.slice(0, 3).join('; ')}`);
    if (!isFA(me)) {
      const req = await this.approvals.create(
        me,
        {
          action: 'person.offboard',
          targetType: 'user',
          targetId: userId,
          summary: `Finish offboarding ${u.name} (last day ${row.lastDay?.toISOString().slice(0, 10)})`,
          payload: { processId: row.id },
          reason: row.note ?? 'Offboarding checklist complete',
          approverId: null,
          approverRoles: ['admin'],
          diff: [{ field: 'Status', before: 'Leaving', after: 'Former (login disabled after the last day)' }],
        },
        ip,
      );
      return { ok: true as const, id: userId, outcome: 'approval' as const, message: 'Sent to an Admin for the final confirmation', approval: { id: req.id, summary: req.summary }, undo: null };
    }
    await this.finish(me, row.id, ip);
    return { ok: true as const, id: userId, outcome: 'applied' as const, message: `Offboarding of ${u.name} confirmed`, approval: null, undo: null };
  }

  async finish(me: Me, processId: string, ip?: string) {
    const row = await this.prisma.peopleProcess.findFirst({ where: { id: processId, orgId: me.orgId } });
    if (!row) throw new NotFoundException('Checklist not found');
    if (row.status !== 'open') throw new BadRequestException(`This checklist is ${row.status}`);
    await this.assertNothingOpen(me.orgId, row.userId);
    await this.prisma.peopleProcess.update({ where: { id: row.id }, data: { status: 'done', completedAt: new Date() } });
    await this.audit.log(me, 'offboarding.completed', 'User', row.userId, null, { processId: row.id, confirmedBy: me.name }, ip);
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: row.userId }, select: { name: true, managerId: true } });
    const lastDay = row.lastDay ? row.lastDay.toISOString().slice(0, 10) : istDate(new Date());
    await this.notifications.notify(me.orgId, [u.managerId].filter((x): x is string => !!x && x !== me.id), { kind: 'offboarding', title: `${u.name}'s offboarding is confirmed. Login stops after ${lastDay}.`, link: `/admin/users/${row.userId}` });
    await this.team.suspendDueLeavers(me.orgId);
    return { processId: row.id };
  }
}
