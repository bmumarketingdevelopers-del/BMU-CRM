import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  istDate,
  normaliseIdentifier,
  type Me,
  type TeamOpenWork,
  type TeamPeopleOptions,
  type TeamPeopleProcess,
  type TeamProcessGroup,
  type TeamProcessItem,
  type TeamReassign,
  type TeamStartOffboarding,
  type TeamStartOnboarding,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { approvesNewPeople, canAddPeople } from '../people-actions/people-access.js';
import { canManagePeople, canReadPeople, dbDay, dayStr, hasRole, isStaff } from './access.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const OPEN_LEAD = ['new', 'contacted', 'discovery', 'proposal_sent'] as const;
type Row = Prisma.PeopleProcessGetPayload<object>;

const item = (key: string, label: string, group: TeamProcessGroup, extra: Partial<TeamProcessItem> = {}): TeamProcessItem => ({
  key,
  label,
  group,
  done: false,
  doneAt: null,
  doneBy: null,
  ...extra,
});

const ONBOARDING_BASE: TeamProcessItem[] = [
  item('offer_letter', 'Signed offer letter received', 'documents'),
  item('id_proof', 'ID and address proof (Aadhaar / PAN) collected', 'documents'),
  item('bank_details', 'Bank details for salary collected', 'documents'),
  item('laptop_issued', 'Laptop issued', 'equipment'),
  item('laptop_setup', 'Laptop set up (email, chat, shared drive)', 'equipment'),
  item('hub_login', 'Signed in to BMU Hub for the first time', 'accounts', { auto: true }),
  item('workspace_account', 'Email and Google Workspace account created', 'accounts'),
  item('tool_licences', 'Tool licences assigned (Figma, Adobe, Canva…)', 'accounts'),
  item('buddy_assigned', 'Buddy assigned', 'buddy', { auto: true }),
  item('buddy_checkin', 'First-week check-in with buddy', 'buddy'),
];

const OFFBOARDING_BASE: TeamProcessItem[] = [
  item('reassign_tasks', 'Open tasks reassigned', 'handover', { auto: true }),
  item('reassign_clients', 'Clients moved to another client manager', 'handover', { auto: true }),
  item('reassign_leads', 'Open leads reassigned', 'handover', { auto: true }),
  // v11 people: approvals waiting on them and their creator briefs must move too; vault access and file ownership.
  item('reassign_approvals', 'Approvals waiting on them handed over', 'handover', { auto: true }),
  item('reassign_briefs', 'Creator briefs handed over', 'handover', { auto: true }),
  item('handover_notes', 'Handover notes shared with the team', 'handover'),
  item('laptop_returned', 'Laptop and equipment returned', 'equipment'),
  item('vault_revoked', 'Password vault and shared drive access revoked', 'access'),
  item('files_transferred', 'File ownership transferred', 'access'),
  item('exit_interview', 'Exit interview done', 'documents'),
  item('final_settlement', 'Full and final settlement started', 'documents'),
  item('access_suspended', 'BMU Hub access suspended on the last day', 'access', { auto: true }),
];

/** Employee onboarding and offboarding checklists (HR), with SOP acknowledgements and bulk work handover. */
@Injectable()
export class PeopleService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('People');
  private job?: JobHandle;
  /** v11 people: set by the people actions module; blocks completing an offboarding while work is open. */
  offboardGuard?: (me: Me, row: Row) => Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit() {
    this.job = startJob({ name: 'people.leavers', hint: 'Suspends leavers whose last day has arrived', everyMs: 10 * 60_000, core: true, run: () => this.suspendDueLeavers() });
    // Suspends leavers whose last day has arrived (checked every 10 minutes).
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  // -------------------------------------------------------------------------
  // Views

  async options(me: Me): Promise<TeamPeopleOptions> {
    if (!canReadPeople(me)) throw new ForbiddenException("You don't have access to onboarding");
    const [staff, sops, roles, departments] = await Promise.all([
      this.prisma.user.findMany({
        where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' } },
        select: { id: true, name: true, department: { select: { name: true } }, roles: { select: { role: { select: { baseRole: true } } } } },
        orderBy: { name: 'asc' },
      }),
      this.prisma.sOP.findMany({ where: { orgId: me.orgId, status: 'published' }, include: { department: { select: { name: true } } }, orderBy: { title: 'asc' } }),
      this.prisma.role.findMany({ where: { orgId: me.orgId, NOT: { baseRole: { startsWith: 'client_' } } }, orderBy: { name: 'asc' } }),
      this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, orderBy: { name: 'asc' }, select: { id: true, name: true } }),
    ]);
    return {
      staff: staff.map((u) => ({ id: u.id, name: u.name, department: u.department?.name ?? null, roles: u.roles.map((r) => r.role.baseRole) })),
      sops: sops.map((s) => ({ id: s.id, title: s.title, department: s.department.name, version: s.version })),
      roles: roles.filter((r) => r.baseRole !== 'founder' || me.roles.includes('founder')).map((r) => ({ id: r.id, name: r.name })),
      departments,
    };
  }

  async list(me: Me, kind?: string): Promise<TeamPeopleProcess[]> {
    if (!canReadPeople(me)) throw new ForbiddenException("You don't have access to onboarding");
    await this.suspendDueLeavers(me.orgId);
    const rows = await this.prisma.peopleProcess.findMany({
      where: { orgId: me.orgId, ...(kind === 'onboarding' || kind === 'offboarding' ? { kind } : {}) },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 200,
    });
    const synced = await Promise.all(rows.map((r) => this.sync(r)));
    return this.views(me, synced, false);
  }

  async get(me: Me, id: string): Promise<TeamPeopleProcess> {
    const row = await this.prisma.peopleProcess.findFirst({ where: { id, orgId: me.orgId } });
    if (!row) throw new NotFoundException('Checklist not found');
    if (!canReadPeople(me) && row.userId !== me.id && row.buddyId !== me.id) throw new ForbiddenException("You don't have access to this checklist");
    await this.suspendDueLeavers(me.orgId);
    const synced = await this.sync((await this.prisma.peopleProcess.findUnique({ where: { id } }))!);
    return (await this.views(me, [synced], true))[0];
  }

  /** The signed-in person's own onboarding (new hires see their progress and SOPs to read). */
  async mine(me: Me): Promise<TeamPeopleProcess[]> {
    if (!isStaff(me)) throw new ForbiddenException('Team accounts only');
    const rows = await this.prisma.peopleProcess.findMany({ where: { orgId: me.orgId, userId: me.id, kind: 'onboarding', status: { not: 'cancelled' } }, orderBy: { createdAt: 'desc' } });
    const synced = await Promise.all(rows.map((r) => this.sync(r)));
    return this.views(me, synced, false);
  }

  private items(r: Row): TeamProcessItem[] {
    return Array.isArray(r.items) ? (r.items as unknown as TeamProcessItem[]) : [];
  }

  private async openWork(orgId: string, userId: string): Promise<TeamOpenWork> {
    const [tasks, clients, leads] = await Promise.all([
      this.prisma.task.findMany({
        where: { orgId, ownerId: userId, status: { in: [...OPEN_TASK] } },
        select: { id: true, title: true, deadline: true, deliverable: { select: { cycle: { select: { engagement: { select: { clientOrg: { select: { name: true } } } } } } } } },
        orderBy: [{ deadline: 'asc' }],
        take: 300,
      }),
      this.prisma.clientOrg.findMany({ where: { orgId, amUserId: userId, deletedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.lead.findMany({ where: { orgId, ownerId: userId, deletedAt: null, stage: { in: [...OPEN_LEAD] } }, select: { id: true, contact: true, stage: true }, orderBy: { createdAt: 'desc' } }),
    ]);
    return {
      tasks: tasks.map((t) => ({ id: t.id, title: t.title, deadline: t.deadline?.toISOString() ?? null, client: t.deliverable?.cycle.engagement.clientOrg.name ?? null })),
      clients,
      leads: leads.map((l) => {
        const c = (l.contact ?? {}) as { name?: string; company?: string };
        return { id: l.id, name: c.company || c.name || 'Lead', stage: l.stage };
      }),
    };
  }

  /** Ticks the items the system can check by itself (login, buddy, SOPs read, work handed over, access). */
  private async sync(r: Row): Promise<Row> {
    const items = this.items(r);
    const user = await this.prisma.user.findUnique({ where: { id: r.userId }, select: { status: true } });
    const auto = (key: string, done: boolean) => {
      const it = items.find((i) => i.key === key);
      if (!it || it.done === done) return false;
      if (!done && !it.auto) return false;
      Object.assign(it, { done, doneAt: done ? new Date().toISOString() : null, doneBy: done ? 'BMU Hub' : null });
      return true;
    };
    let changed = false;
    if (r.kind === 'onboarding') {
      changed = auto('hub_login', user?.status === 'active') || changed;
      changed = auto('buddy_assigned', !!r.buddyId) || changed;
      const sopItems = items.filter((i) => i.sopId);
      if (sopItems.length) {
        const acks = await this.prisma.sopAcknowledgement.findMany({ where: { userId: r.userId, sopId: { in: sopItems.map((i) => i.sopId!) } } });
        for (const it of sopItems) {
          const ack = acks.filter((a) => a.sopId === it.sopId).sort((a, b) => b.version - a.version)[0];
          const done = !!ack && ack.version >= (it.sopVersion ?? 1);
          if (it.done !== done && (done || it.doneBy === 'BMU Hub' || it.doneBy === null)) {
            Object.assign(it, { done, doneAt: done ? ack!.at.toISOString() : null, doneBy: done ? 'Acknowledged in BMU Hub' : null });
            changed = true;
          }
        }
      }
    } else {
      const work = await this.openWork(r.orgId, r.userId);
      changed = auto('reassign_tasks', work.tasks.length === 0) || changed;
      changed = auto('reassign_clients', work.clients.length === 0) || changed;
      changed = auto('reassign_leads', work.leads.length === 0) || changed;
      changed = auto('access_suspended', user?.status === 'suspended') || changed;
      const [approvals, briefs] = await Promise.all([
        this.prisma.approvalRequest.count({ where: { orgId: r.orgId, approverId: r.userId, status: 'pending' } }),
        this.prisma.creatorBrief.count({ where: { orgId: r.orgId, createdById: r.userId, status: { in: ['offered', 'accepted', 'submitted', 'revision', 'approved'] } } }),
      ]);
      changed = auto('reassign_approvals', approvals === 0) || changed;
      changed = auto('reassign_briefs', briefs === 0) || changed;
    }
    if (!changed) return r;
    return this.prisma.peopleProcess.update({ where: { id: r.id }, data: { items: items as unknown as Prisma.InputJsonValue } });
  }

  private async views(me: Me, rows: Row[], withWork: boolean): Promise<TeamPeopleProcess[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.userId, r.startedById, r.buddyId].filter(Boolean) as string[]))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, email: true, status: true, department: { select: { name: true } }, roles: { select: { role: { select: { name: true } } } } },
    });
    const byId = new Map(users.map((u) => [u.id, u]));
    return Promise.all(
      rows.map(async (r) => {
        const items = this.items(r);
        const u = byId.get(r.userId);
        const doneCount = items.filter((i) => i.done).length;
        const buddy = r.buddyId ? byId.get(r.buddyId) : undefined;
        return {
          id: r.id,
          kind: r.kind as TeamPeopleProcess['kind'],
          status: r.status as TeamPeopleProcess['status'],
          user: { id: r.userId, name: u?.name ?? 'Former member', email: u?.email ?? null, department: u?.department?.name ?? null, role: u?.roles[0]?.role.name ?? null, status: u?.status ?? 'suspended' },
          startedBy: byId.get(r.startedById)?.name ?? null,
          buddy: buddy ? { id: buddy.id, name: buddy.name } : null,
          startDate: r.startDate ? dayStr(r.startDate) : null,
          lastDay: r.lastDay ? dayStr(r.lastDay) : null,
          items,
          doneCount,
          progressPct: items.length ? Math.round((doneCount * 100) / items.length) : 0,
          note: r.note,
          createdAt: r.createdAt.toISOString(),
          completedAt: r.completedAt?.toISOString() ?? null,
          suspendedAt: r.suspendedAt?.toISOString() ?? null,
          ...(withWork && r.kind === 'offboarding' ? { openWork: await this.openWork(r.orgId, r.userId) } : {}),
          canEdit: canManagePeople(me) && r.status === 'open',
        };
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Changes

  private async staff(me: Me, id: string, label = 'That person') {
    const u = await this.prisma.user.findFirst({ where: { id, orgId: me.orgId, type: 'staff', deletedAt: null } });
    if (!u) throw new BadRequestException(`${label} is not on the team`);
    return u;
  }

  async startOnboarding(me: Me, input: TeamStartOnboarding, ip?: string): Promise<TeamPeopleProcess> {
    if (!canManagePeople(me)) throw new ForbiddenException('Only HR, Branch Manager or the Founder can start onboarding');
    let userId = input.userId;
    if (input.newHire) {
      if (!canAddPeople(me)) throw new ForbiddenException('Only the Founder or HR can add people');
      if (!approvesNewPeople(me)) throw new ForbiddenException('Your new people need approval: use Add person, and a Founder or the HR Department Head approves');
      const nh = input.newHire;
      const role = await this.prisma.role.findFirst({ where: { id: nh.roleId, orgId: me.orgId } });
      if (!role || role.baseRole.startsWith('client_')) throw new BadRequestException('Choose a team role');
      if (role.baseRole === 'founder' && !me.roles.includes('founder')) throw new ForbiddenException('Only the Founder can grant the Founder role');
      if (role.baseRole === 'admin' && !hasRole(me, 'founder', 'admin')) throw new ForbiddenException('HR cannot add someone as Branch Manager');
      const email = nh.email ? normaliseIdentifier(nh.email) : null;
      const phone = nh.phone ? normaliseIdentifier(nh.phone) : null;
      const clash = await this.prisma.user.findFirst({ where: { orgId: me.orgId, OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] } });
      if (clash) throw new ConflictException('Someone already uses that email or mobile number');
      if (nh.managerId) await this.staff(me, nh.managerId, 'The manager');
      const dept = nh.departmentId ? await this.prisma.department.findFirst({ where: { id: nh.departmentId, orgId: me.orgId, deletedAt: null } }) : null;
      if (nh.departmentId && !dept) throw new BadRequestException('Department not found');
      const created = await this.prisma.user.create({
        data: {
          orgId: me.orgId,
          type: 'staff',
          name: nh.name,
          email,
          phone,
          status: 'invited',
          managerId: nh.managerId ?? null,
          departmentId: dept?.id ?? null,
          branchId: dept?.branchId ?? null,
          roles: { create: { roleId: role.id } },
        },
      });
      userId = created.id;
      await this.audit.log(me, 'user.invited', 'User', created.id, undefined, { name: nh.name, email, phone, roleId: role.id, via: 'onboarding' }, ip);
    }
    const user = await this.staff(me, userId!);
    if (await this.prisma.peopleProcess.findFirst({ where: { userId: user.id, kind: 'onboarding', status: 'open' } })) throw new ConflictException(`${user.name} already has an open onboarding checklist`);
    if (input.buddyId) {
      if (input.buddyId === user.id) throw new BadRequestException('A new hire cannot be their own buddy');
      await this.staff(me, input.buddyId, 'The buddy');
    }
    const sops = input.sopIds?.length ? await this.prisma.sOP.findMany({ where: { id: { in: input.sopIds }, orgId: me.orgId, status: 'published' } }) : [];
    if (sops.length !== (input.sopIds?.length ?? 0)) throw new BadRequestException('Pick published SOPs only');
    const items: TeamProcessItem[] = [
      ...ONBOARDING_BASE.map((i) => ({ ...i })),
      ...sops.map((s) => item(`sop_${s.id}`, `Read: ${s.title}`, 'induction', { sopId: s.id, sopVersion: s.version, auto: true })),
    ];
    const row = await this.prisma.peopleProcess.create({
      data: {
        orgId: me.orgId,
        userId: user.id,
        kind: 'onboarding',
        startedById: me.id,
        buddyId: input.buddyId ?? null,
        startDate: input.startDate ? dbDay(input.startDate) : dbDay(istDate(new Date())),
        items: items as unknown as Prisma.InputJsonValue,
        note: input.note ?? null,
      },
    });
    await this.audit.log(me, 'onboarding.started', 'User', user.id, null, { processId: row.id, buddyId: input.buddyId ?? null, sops: sops.map((s) => s.title) }, ip);
    await this.notifications.notify(me.orgId, [user.id], { kind: 'onboarding', title: 'Welcome to BMU! Your onboarding checklist is ready', body: sops.length ? `${sops.length} SOP${sops.length > 1 ? 's' : ''} to read` : undefined, link: '/team/onboarding' });
    if (input.buddyId) await this.notifications.notify(me.orgId, [input.buddyId], { kind: 'onboarding', title: `You are ${user.name}'s onboarding buddy`, link: `/team/onboarding/${row.id}` });
    return this.get(me, row.id);
  }

  async startOffboarding(me: Me, input: TeamStartOffboarding, ip?: string): Promise<TeamPeopleProcess> {
    if (!canManagePeople(me)) throw new ForbiddenException('Only HR, Branch Manager or the Founder can start offboarding');
    const user = await this.staff(me, input.userId);
    if (user.id === me.id) throw new BadRequestException('You cannot offboard yourself');
    const founder = await this.prisma.userRole.findFirst({ where: { userId: user.id, role: { baseRole: 'founder' } } });
    if (founder && !me.roles.includes('founder')) throw new ForbiddenException('Only the Founder can offboard a Founder');
    if (await this.prisma.peopleProcess.findFirst({ where: { userId: user.id, kind: 'offboarding', status: 'open' } })) throw new ConflictException(`${user.name} already has an open offboarding checklist`);
    const row = await this.prisma.peopleProcess.create({
      data: {
        orgId: me.orgId,
        userId: user.id,
        kind: 'offboarding',
        startedById: me.id,
        lastDay: dbDay(input.lastDay),
        items: OFFBOARDING_BASE.map((i) => ({ ...i })) as unknown as Prisma.InputJsonValue,
        note: input.note ?? null,
      },
    });
    await this.audit.log(me, 'offboarding.started', 'User', user.id, null, { processId: row.id, lastDay: input.lastDay }, ip);
    if (user.managerId) await this.notifications.notify(me.orgId, [user.managerId], { kind: 'offboarding', title: `${user.name} leaves on ${input.lastDay}. Their work needs new owners.`, link: `/admin/people/${row.id}` });
    await this.suspendDueLeavers(me.orgId);
    return this.get(me, row.id);
  }

  private async editable(me: Me, id: string) {
    if (!canManagePeople(me)) throw new ForbiddenException('Only HR, Branch Manager or the Founder can change this checklist');
    const row = await this.prisma.peopleProcess.findFirst({ where: { id, orgId: me.orgId } });
    if (!row) throw new NotFoundException('Checklist not found');
    if (row.status !== 'open') throw new ConflictException(`This checklist is ${row.status}`);
    return row;
  }

  async tick(me: Me, id: string, key: string, done: boolean, ip?: string) {
    const row = await this.editable(me, id);
    const items = this.items(row);
    const it = items.find((i) => i.key === key);
    if (!it) throw new NotFoundException('Checklist item not found');
    if (it.sopId) throw new BadRequestException('The new hire ticks this by reading the SOP and pressing "I have read this"');
    if (it.auto && ['reassign_tasks', 'reassign_clients', 'reassign_leads', 'reassign_approvals', 'reassign_briefs', 'access_suspended', 'hub_login'].includes(it.key)) {
      throw new BadRequestException('BMU Hub ticks this by itself once it is true');
    }
    Object.assign(it, { done, doneAt: done ? new Date().toISOString() : null, doneBy: done ? me.name : null });
    await this.prisma.peopleProcess.update({ where: { id }, data: { items: items as unknown as Prisma.InputJsonValue } });
    await this.audit.log(me, `${row.kind}.item_${done ? 'done' : 'undone'}`, 'User', row.userId, null, { processId: id, key, label: it.label }, ip);
    return this.get(me, id);
  }

  async addItem(me: Me, id: string, label: string, group: TeamProcessGroup, ip?: string) {
    const row = await this.editable(me, id);
    const items = this.items(row);
    const key = `custom_${Date.now().toString(36)}`;
    items.push(item(key, label, group));
    await this.prisma.peopleProcess.update({ where: { id }, data: { items: items as unknown as Prisma.InputJsonValue } });
    await this.audit.log(me, `${row.kind}.item_added`, 'User', row.userId, null, { processId: id, key, label }, ip);
    return this.get(me, id);
  }

  /** Bulk handover of the leaver's open tasks, clients (CM) or leads to one person. */
  async reassign(me: Me, id: string, input: TeamReassign, ip?: string) {
    const row = await this.editable(me, id);
    if (row.kind !== 'offboarding') throw new BadRequestException('Work is handed over from an offboarding checklist');
    const to = await this.staff(me, input.toUserId, 'The new owner');
    if (to.status !== 'active') throw new BadRequestException(`${to.name} is not an active team member`);
    if (to.id === row.userId) throw new BadRequestException('Pick someone other than the person leaving');
    let moved = 0;
    if (input.kind === 'tasks') {
      moved = (await this.prisma.task.updateMany({ where: { id: { in: input.ids }, orgId: me.orgId, ownerId: row.userId }, data: { ownerId: to.id } })).count;
      if (moved) await this.notifications.notify(me.orgId, [to.id], { kind: 'task_assigned', title: `${moved} task${moved > 1 ? 's' : ''} handed over to you`, link: '/team/tasks' });
    } else if (input.kind === 'clients') {
      const isAm = await this.prisma.userRole.findFirst({ where: { userId: to.id, role: { baseRole: { in: ['account_manager', 'am_lead', 'admin', 'founder'] } } } });
      if (!isAm) throw new BadRequestException(`${to.name} is not a client manager`);
      const clients = await this.prisma.clientOrg.findMany({ where: { id: { in: input.ids }, orgId: me.orgId, amUserId: row.userId }, select: { id: true } });
      await this.prisma.$transaction([
        this.prisma.clientOrg.updateMany({ where: { id: { in: clients.map((c) => c.id) } }, data: { amUserId: to.id } }),
        this.prisma.engagement.updateMany({ where: { clientOrgId: { in: clients.map((c) => c.id) }, amId: row.userId, deletedAt: null }, data: { amId: to.id } }),
      ]);
      moved = clients.length;
      for (const c of clients) await this.audit.log(me, 'client.am_reassigned', 'ClientOrg', c.id, { amUserId: row.userId }, { amUserId: to.id, via: 'offboarding' }, ip);
      if (moved) await this.notifications.notify(me.orgId, [to.id], { kind: 'client_assigned', title: `You now manage ${moved} more client${moved > 1 ? 's' : ''}`, link: '/team/clients' });
    } else {
      moved = (await this.prisma.lead.updateMany({ where: { id: { in: input.ids }, orgId: me.orgId, ownerId: row.userId }, data: { ownerId: to.id } })).count;
      if (moved) await this.notifications.notify(me.orgId, [to.id], { kind: 'lead_assigned', title: `${moved} lead${moved > 1 ? 's' : ''} handed over to you`, link: '/team/leads' });
    }
    if (!moved) throw new BadRequestException('Nothing to move: those items no longer belong to this person');
    await this.audit.log(me, 'offboarding.work_reassigned', 'User', row.userId, null, { processId: id, kind: input.kind, count: moved, toUserId: to.id, toName: to.name }, ip);
    return this.get(me, id);
  }

  async complete(me: Me, id: string, ip?: string) {
    const row = await this.editable(me, id);
    if (row.kind === 'offboarding' && this.offboardGuard) await this.offboardGuard(me, row);
    const synced = await this.sync(row);
    const pending = this.items(synced).filter((i) => !i.done && i.key !== 'access_suspended');
    if (pending.length) throw new BadRequestException(`${pending.length} item${pending.length > 1 ? 's are' : ' is'} still open: ${pending.slice(0, 3).map((i) => i.label).join('; ')}`);
    await this.prisma.peopleProcess.update({ where: { id }, data: { status: 'done', completedAt: new Date() } });
    await this.audit.log(me, `${row.kind}.completed`, 'User', row.userId, null, { processId: id }, ip);
    if (row.kind === 'onboarding') await this.notifications.notify(me.orgId, [row.userId], { kind: 'onboarding', title: 'Your onboarding is complete. Welcome aboard!', link: '/team' });
    await this.suspendDueLeavers(me.orgId);
    return this.get(me, id);
  }

  async cancel(me: Me, id: string, ip?: string) {
    const row = await this.editable(me, id);
    await this.prisma.peopleProcess.update({ where: { id }, data: { status: 'cancelled' } });
    await this.audit.log(me, `${row.kind}.cancelled`, 'User', row.userId, null, { processId: id }, ip);
    return this.get(me, id);
  }

  /** "I have read this": records the acknowledgement of the current SOP version. */
  async acknowledgeSop(me: Me, sopId: string, ip?: string) {
    if (!isStaff(me)) throw new ForbiddenException('Team accounts only');
    const sop = await this.prisma.sOP.findFirst({ where: { id: sopId, orgId: me.orgId, status: 'published' } });
    if (!sop) throw new NotFoundException('SOP not found');
    await this.prisma.sopAcknowledgement.upsert({
      where: { sopId_userId_version: { sopId, userId: me.id, version: sop.version } },
      update: {},
      create: { orgId: me.orgId, sopId, userId: me.id, version: sop.version },
    });
    await this.audit.log(me, 'sop.acknowledged', 'SOP', sopId, null, { version: sop.version, title: sop.title }, ip);
    const open = await this.prisma.peopleProcess.findMany({ where: { userId: me.id, kind: 'onboarding', status: 'open' } });
    for (const r of open) await this.sync(r);
    return { ok: true as const, version: sop.version };
  }

  /** Suspends people at the end of their offboarding last day (v11: login works through the last day). Safe to call often. */
  async suspendDueLeavers(orgId?: string) {
    const today = dbDay(istDate(new Date()));
    const due = await this.prisma.peopleProcess.findMany({
      where: { kind: 'offboarding', status: { in: ['open', 'done'] }, lastDay: { lt: today }, suspendedAt: null, ...(orgId ? { orgId } : {}) },
    });
    for (const p of due) {
      await this.prisma.user.updateMany({ where: { id: p.userId, status: { not: 'suspended' } }, data: { status: 'suspended' } });
      await this.prisma.user.updateMany({ where: { id: p.userId, leftAt: null }, data: { leftAt: new Date() } });
      await this.prisma.peopleProcess.update({ where: { id: p.id }, data: { suspendedAt: new Date() } });
      await this.audit.logSystem(p.orgId, 'user.suspended', 'User', p.userId, { reason: 'Offboarding: last day reached', processId: p.id });
      await this.sync((await this.prisma.peopleProcess.findUnique({ where: { id: p.id } }))!);
    }
    return due.length;
  }
}
