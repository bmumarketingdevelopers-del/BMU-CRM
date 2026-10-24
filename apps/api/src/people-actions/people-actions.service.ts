// v11 people & hierarchy actions: add / edit / move / change role, scheduled changes (effective dates), branches,
// departments and teams, custom roles, bulk actions, the hierarchy tree and the people list. Approvals per the
// approval_matrix go through ApprovalsService (handlers registered in onModuleInit).
import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  CAPABILITIES,
  istDate,
  normaliseIdentifier,
  PEOPLE_CAPABILITY_LABELS,
  peopleAddPersonSchema,
  peopleChangeRoleSchema,
  peopleCustomRoleSchema,
  peopleEmploymentLabels,
  peopleMergePermissions,
  peopleMoveSchema,
  peopleManagerChoices,
  peopleOnboardingLabels,
  peoplePermissionDiff,
  peopleRoleRank,
  peopleScopeLabels,
  type AccessScope,
  type Me,
  type PeopleAddPerson,
  type PeopleBulk,
  type PeopleChangeRole,
  type PeopleCreateUnit,
  type PeopleCustomRole,
  type PeopleDuplicate,
  type PeopleEditPerson,
  type PeopleEmploymentType,
  type PeopleMove,
  type PeopleMovePreview,
  type PeopleMutationResult,
  type PeopleOptions,
  type PeoplePersonDetail,
  type PeoplePersonRow,
  type PeopleRolePreview,
  type PeopleTree,
  type TeamProcessItem,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { ApprovalsService } from '../actions/approvals.service.js';
import { PeopleDirectory } from '../actions/people.js';
import { ActionsRegistry, type UndoRow } from '../actions/registry.js';
import { UndoService } from '../actions/undo.service.js';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { appUrl, EmailService } from '../service/email.service.js';
import { PeopleService } from '../team-flows/people.service.js';
import { OffboardingService } from './offboarding.service.js';
import { approvesNewPeople, assertPeopleReader, isFA, isFounder, isHR, peopleCan, rolePolicy, staffOnly, visiblePeopleWhere } from './people-access.js';
import { startJob, type JobHandle } from '../runtime/jobs.js';

const userInclude = {
  roles: { include: { role: true } },
  department: { select: { id: true, name: true } },
  team: { select: { id: true, name: true } },
  manager: { select: { id: true, name: true } },
  branch: { select: { id: true, name: true } },
} as const;
type UserFull = Prisma.UserGetPayload<{ include: typeof userInclude }>;
type MovePayload = { departmentId: string; teamId: string | null; managerId: string | null; branchId: string };

const dbDay = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const dayStr = (d: Date) => d.toISOString().slice(0, 10);
const today = () => istDate(new Date());
const fmtDay = (ymd: string) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const ref = (u: { id: string; name: string } | null | undefined) => (u ? { id: u.id, name: u.name } : null);
const item = (key: string, label: string, group: TeamProcessItem['group'], extra: Partial<TeamProcessItem> = {}): TeamProcessItem => ({ key, label, group, done: false, doneAt: null, doneBy: null, ...extra });

@Injectable()
export class PeopleActionsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('PeopleActions');
  private job?: JobHandle;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly approvals: ApprovalsService,
    private readonly registry: ActionsRegistry,
    private readonly people: PeopleDirectory,
    private readonly undo: UndoService,
    private readonly team: PeopleService,
    private readonly offboarding: OffboardingService,
  ) {}

  onModuleInit() {
    this.registry.registerUndoModel('user');
    this.registry.registerApprovalHandler({
      action: 'person.add',
      label: 'Add a person to the team',
      href: () => '/admin/users',
      approvers: (me) => approvesNewPeople(me),
      apply: async ({ approver, requester, req }) => {
        if (!approvesNewPeople(approver)) throw new ForbiddenException('Only a Founder or the HR Department Head can approve a new person');
        const input = peopleAddPersonSchema.parse((req.payload as { input: unknown }).input);
        const branchManager = await this.prisma.role.count({ where: { id: { in: input.roleIds }, orgId: approver.orgId, baseRole: 'admin' } });
        if (branchManager && !isFounder(approver)) throw new ForbiddenException('Only the Founder can approve a new Branch Manager');
        return { userId: await this.createPerson(approver, input, undefined, requester) };
      },
    });
    this.registry.registerApprovalHandler({
      action: 'person.move',
      label: 'Move a person to another department',
      href: (r) => `/admin/users/${r.targetId}`,
      apply: async ({ approver, requester, req }) => {
        if (!isFA(approver)) throw new ForbiddenException('Only a Branch Manager can approve a move between departments');
        const input = peopleMoveSchema.parse((req.payload as { input: unknown }).input);
        return this.move(approver, req.targetId, input, undefined, { approved: true, requestedBy: requester, approvalId: req.id });
      },
    });
    this.registry.registerApprovalHandler({
      action: 'person.role',
      label: 'Change a role (Branch Manager level)',
      href: (r) => `/admin/users/${r.targetId}`,
      apply: async ({ approver, requester, req }) => {
        if (!isFounder(approver)) throw new ForbiddenException('Only the Founder can approve this role change');
        const input = peopleChangeRoleSchema.parse((req.payload as { input: unknown }).input);
        return this.changeRole(approver, req.targetId, input, undefined, { approved: true, requestedBy: requester, approvalId: req.id });
      },
    });
    this.registry.registerApprovalHandler({
      action: 'role.custom',
      label: 'Create a custom role',
      href: () => '/admin/roles',
      apply: async ({ approver, req }) => {
        if (!isFounder(approver)) throw new ForbiddenException('Only the Founder can approve a new role');
        const input = peopleCustomRoleSchema.parse((req.payload as { input: unknown }).input);
        return this.customRole(approver, input, undefined, true);
      },
    });
    this.job = startJob({ name: 'people.scheduled_changes', hint: 'Applies scheduled moves and role changes on their date', everyMs: 10 * 60_000, core: true, run: () => this.applyDue() });
  }

  onModuleDestroy() {
    this.job?.stop();
  }

  // ---------------------------------------------------------------------------
  // Reads

  private async person(me: Me, id: string, opts: { visible?: boolean } = {}) {
    const where: Prisma.UserWhereInput = opts.visible ? { AND: [await visiblePeopleWhere(this.prisma, me), { id }] } : { id, orgId: me.orgId, type: 'staff', deletedAt: null };
    const u = await this.prisma.user.findFirst({ where, include: userInclude });
    if (!u) throw new NotFoundException('Person not found');
    return u;
  }

  private async rows(me: Me, users: UserFull[]): Promise<PeoplePersonRow[]> {
    const ids = users.map((u) => u.id);
    const [loads, scheduled, approvals] = await Promise.all([
      ids.length ? this.people.loads(me.orgId, { id: { in: ids } }) : Promise.resolve([]),
      this.prisma.peopleScheduledChange.groupBy({ by: ['userId'], where: { orgId: me.orgId, userId: { in: ids }, status: 'scheduled' }, _count: { _all: true } }),
      this.prisma.approvalRequest.groupBy({ by: ['targetId'], where: { orgId: me.orgId, targetType: 'user', targetId: { in: ids }, status: 'pending' }, _count: { _all: true } }),
    ]);
    const t = today();
    return users.map((u) => {
      const l = loads.find((x) => x.id === u.id);
      const next = l ? [...l.leaveDays].filter((d) => d >= t).sort()[0] ?? null : null;
      return {
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone,
        photoUrl: u.photoUrl,
        status: u.status,
        roles: u.roles.map((r) => ({ id: r.role.id, name: r.role.name, baseRole: r.role.baseRole })).sort((a, b) => peopleRoleRank(a.baseRole) - peopleRoleRank(b.baseRole)),
        department: ref(u.department),
        team: ref(u.team),
        manager: ref(u.manager),
        branch: ref(u.branch),
        joiningDate: u.joiningDate ? dayStr(u.joiningDate) : null,
        employmentType: (u.employmentType as PeopleEmploymentType | null) ?? null,
        specialty: u.specialty,
        loadPct: l ? l.loadPct : null,
        openTasks: l?.openTasks ?? 0,
        onLeaveToday: l?.onLeaveToday ?? false,
        nextLeave: next,
        leftAt: u.leftAt?.toISOString() ?? null,
        pending: { scheduled: scheduled.find((s) => s.userId === u.id)?._count._all ?? 0, approvals: approvals.find((a) => a.targetId === u.id)?._count._all ?? 0 },
      };
    });
  }

  async options(me: Me): Promise<PeopleOptions> {
    staffOnly(me);
    const can = peopleCan(me);
    if (!Object.values(can).some(Boolean)) throw new ForbiddenException("You don't have access to people actions");
    const [roles, branches, departments, staff, sops, flows, qc, clients, pods, self] = await Promise.all([
      this.prisma.role.findMany({ where: { orgId: me.orgId, NOT: { baseRole: { startsWith: 'client_' } } }, include: { permissions: true }, orderBy: [{ isCustom: 'asc' }, { name: 'asc' }] }),
      this.prisma.branch.findMany({ where: { orgId: me.orgId, deletedAt: null }, orderBy: { createdAt: 'asc' } }),
      this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, include: { teams: { where: { deletedAt: null }, orderBy: { name: 'asc' } } }, orderBy: { name: 'asc' } }),
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' }, leftAt: null }, select: { id: true, name: true, departmentId: true, teamId: true, roles: { select: { role: { select: { baseRole: true } } } } }, orderBy: { name: 'asc' } }),
      this.prisma.sOP.findMany({ where: { orgId: me.orgId, status: 'published' }, select: { id: true, title: true, departmentId: true }, orderBy: { title: 'asc' } }),
      this.prisma.flowTemplate.findMany({ where: { orgId: me.orgId, active: true }, include: { department: { select: { name: true } } }, orderBy: [{ name: 'asc' }, { version: 'desc' }] }),
      this.prisma.checklistTemplate.findMany({ where: { orgId: me.orgId, kind: 'qc' }, orderBy: [{ name: 'asc' }, { version: 'desc' }] }),
      this.prisma.clientOrg.findMany({ where: { orgId: me.orgId, deletedAt: null, archivedAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.clientPod.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, clientIds: true } }),
      this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } }),
    ]);
    const deptName = new Map(departments.map((d) => [d.id, d.name]));
    const latestFlows = flows.filter((t, i) => flows.findIndex((x) => x.departmentId === t.departmentId && x.name === t.name) === i);
    const latestQc = qc.filter((t, i) => qc.findIndex((x) => x.departmentId === t.departmentId && x.name === t.name) === i);
    return {
      roles: roles.map((r) => {
        const p = rolePolicy(me, r.baseRole, can.changeRole ? 'change' : 'add');
        return { id: r.id, name: r.name, baseRole: r.baseRole, isCustom: r.isCustom, rank: peopleRoleRank(r.baseRole), assignable: p.ok, needsApproval: p.needsFounder, whyNot: p.whyNot, permissions: CAPABILITIES.map((c) => ({ capability: c, scope: (r.permissions.find((x) => x.capability === c)?.scope ?? 'none') as AccessScope })) };
      }),
      branches: branches.map((b) => ({ id: b.id, name: b.name, city: b.city, workStart: b.workStart, workEnd: b.workEnd, workDays: b.workDays })),
      departments: departments.map((d) => ({ id: d.id, name: d.name, branchId: d.branchId, headId: d.headUserId, teams: d.teams.map((t) => ({ id: t.id, name: t.name, leadId: t.leadUserId })) })),
      staff: staff.map((s) => ({ id: s.id, name: s.name, departmentId: s.departmentId, teamId: s.teamId, roles: s.roles.map((r) => r.role.baseRole) })),
      sops,
      flowTemplates: latestFlows.map((f) => ({ id: f.id, name: f.name, department: f.department.name })),
      qcChecklists: latestQc.map((q) => ({ id: q.id, name: q.name, department: q.departmentId ? (deptName.get(q.departmentId) ?? null) : null })),
      clients: clients.map((c) => ({ ...c, podId: pods.find((p) => p.clientIds.includes(c.id))?.id ?? null })),
      can,
      me: { id: me.id, departmentId: self?.departmentId ?? null },
    };
  }

  async tree(me: Me): Promise<PeopleTree> {
    assertPeopleReader(me);
    await this.applyDue(me.orgId);
    const visible = await visiblePeopleWhere(this.prisma, me);
    const [org, branches, users, former, pods, self] = await Promise.all([
      this.prisma.organisation.findUniqueOrThrow({ where: { id: me.orgId }, select: { name: true } }),
      this.prisma.branch.findMany({
        where: { orgId: me.orgId, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        include: { departments: { where: { deletedAt: null }, orderBy: { name: 'asc' }, include: { teams: { where: { deletedAt: null }, orderBy: { name: 'asc' } } } } },
      }),
      this.prisma.user.findMany({ where: { AND: [visible, { leftAt: null }] }, include: userInclude, orderBy: { name: 'asc' } }),
      this.prisma.user.findMany({ where: { AND: [visible, { leftAt: { not: null } }] }, include: userInclude, orderBy: { leftAt: 'desc' }, take: 100 }),
      this.podsView(me),
      this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } }),
    ]);
    const rows = await this.rows(me, users);
    const names = new Map(rows.map((r) => [r.id, r.name]));
    const nameRef = async (id: string | null) => {
      if (!id) return null;
      if (names.has(id)) return { id, name: names.get(id)! };
      const u = await this.prisma.user.findUnique({ where: { id }, select: { id: true, name: true } });
      return ref(u);
    };
    const deptIds = new Set(branches.flatMap((b) => b.departments.map((d) => d.id)));
    return {
      org,
      branches: await Promise.all(
        branches.map(async (b) => ({
          id: b.id,
          name: b.name,
          city: b.city,
          workStart: b.workStart,
          workEnd: b.workEnd,
          departments: await Promise.all(
            b.departments.map(async (d) => ({
              id: d.id,
              name: d.name,
              head: await nameRef(d.headUserId),
              teams: await Promise.all(d.teams.map(async (t) => ({ id: t.id, name: t.name, lead: await nameRef(t.leadUserId), memberIds: rows.filter((r) => r.team?.id === t.id).map((r) => r.id) }))),
              memberIds: rows.filter((r) => r.department?.id === d.id && (!r.team || !d.teams.some((t) => t.id === r.team!.id))).map((r) => r.id),
            })),
          ),
        })),
      ),
      people: rows,
      unplacedIds: rows.filter((r) => !r.department || !deptIds.has(r.department.id)).map((r) => r.id),
      pods,
      former: await this.rows(me, former),
      can: peopleCan(me),
      me: { id: me.id, departmentId: self?.departmentId ?? null },
    };
  }

  async list(me: Me, f: { q?: string; departmentId?: string; roleId?: string; status?: string; branchId?: string; employmentType?: string; former?: string }) {
    assertPeopleReader(me);
    await this.applyDue(me.orgId);
    const and: Prisma.UserWhereInput[] = [await visiblePeopleWhere(this.prisma, me)];
    and.push(f.former === '1' ? { leftAt: { not: null } } : { leftAt: null });
    if (f.q?.trim()) {
      const q = f.q.trim();
      and.push({ OR: [{ name: { contains: q, mode: 'insensitive' } }, { email: { contains: q, mode: 'insensitive' } }, { phone: { contains: q.replace(/\D/g, '').slice(-10) || q } }] });
    }
    if (f.departmentId) and.push({ departmentId: f.departmentId === 'none' ? null : f.departmentId });
    if (f.branchId) and.push({ branchId: f.branchId });
    if (f.roleId) and.push({ roles: { some: { roleId: f.roleId } } });
    if (f.status && ['invited', 'active', 'suspended'].includes(f.status)) and.push({ status: f.status as 'invited' });
    if (f.employmentType) and.push({ employmentType: f.employmentType });
    const users = await this.prisma.user.findMany({ where: { AND: and }, include: userInclude, orderBy: { name: 'asc' }, take: 500 });
    return this.rows(me, users);
  }

  async detail(me: Me, id: string): Promise<PeoplePersonDetail> {
    staffOnly(me);
    const self = id === me.id;
    if (!self) assertPeopleReader(me);
    await this.applyDue(me.orgId);
    const u = await this.person(me, id, { visible: !self });
    const [row] = await this.rows(me, [u]);
    const [reports, scheduled, approvals, onboarding, offboarding, openRecords] = await Promise.all([
      this.prisma.user.findMany({ where: { managerId: id, deletedAt: null, leftAt: null }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
      this.prisma.peopleScheduledChange.findMany({ where: { userId: id, status: 'scheduled' }, orderBy: { effectiveDate: 'asc' } }),
      this.prisma.approvalRequest.findMany({ where: { orgId: me.orgId, targetType: 'user', targetId: id, status: 'pending' }, orderBy: { createdAt: 'desc' } }),
      this.prisma.peopleProcess.findFirst({ where: { userId: id, kind: 'onboarding', status: { not: 'cancelled' } }, orderBy: { createdAt: 'desc' }, select: { id: true } }),
      this.prisma.peopleProcess.findFirst({ where: { userId: id, kind: 'offboarding', status: { not: 'cancelled' } }, orderBy: { createdAt: 'desc' }, select: { id: true } }),
      this.offboarding.openRecords(me.orgId, id),
    ]);
    const byNames = await this.people.names(scheduled.map((s) => s.byId));
    const perms = peopleMergePermissions(await this.rolePerms(u.roles.map((r) => r.roleId)));
    return {
      ...row,
      reports,
      scheduled: await Promise.all(scheduled.map(async (s) => ({ id: s.id, kind: s.kind as 'move' | 'role', effectiveDate: dayStr(s.effectiveDate), summary: await this.describeChange(s.kind, s.payload as Record<string, unknown>), reason: s.reason, by: byNames.get(s.byId) ?? '' }))),
      approvals: approvals.map((a) => ({ id: a.id, summary: a.summary, status: a.status, actionLabel: this.registry.approvalHandlers.get(a.action)?.label ?? a.action })),
      onboardingId: onboarding?.id ?? null,
      offboardingId: offboarding?.id ?? null,
      openRecords,
      permissions: Object.entries(perms)
        .filter(([, s]) => s !== 'none')
        .map(([capability, scope]) => ({ capability, label: PEOPLE_CAPABILITY_LABELS[capability] ?? capability, scope })),
      can: { ...peopleCan(me), self },
    };
  }

  private async rolePerms(roleIds: string[]) {
    const roles = await this.prisma.role.findMany({ where: { id: { in: roleIds } }, include: { permissions: true } });
    return roles.map((r) => ({ permissions: r.permissions.map((p) => ({ capability: p.capability, scope: p.scope as AccessScope })) }));
  }

  private async describeChange(kind: string, p: Record<string, unknown>) {
    if (kind === 'role') {
      const roles = await this.prisma.role.findMany({ where: { id: { in: (p.roleIds as string[]) ?? [] } }, select: { id: true, name: true } });
      return `Role becomes ${((p.roleIds as string[]) ?? []).map((id) => roles.find((r) => r.id === id)?.name ?? 'a role').join(' + ')}`;
    }
    const [d, t, m] = await Promise.all([
      p.departmentId ? this.prisma.department.findUnique({ where: { id: p.departmentId as string }, select: { name: true } }) : null,
      p.teamId ? this.prisma.team.findUnique({ where: { id: p.teamId as string }, select: { name: true } }) : null,
      p.managerId ? this.prisma.user.findUnique({ where: { id: p.managerId as string }, select: { name: true } }) : null,
    ]);
    return `Moves to ${[d?.name, t?.name].filter(Boolean).join(' · ') || 'no department'}${m ? `, reporting to ${m.name}` : ''}`;
  }

  async duplicates(me: Me, input: { email?: string; phone?: string; name?: string }): Promise<PeopleDuplicate[]> {
    staffOnly(me);
    if (!peopleCan(me).addPerson) throw new ForbiddenException("You can't add people");
    const email = input.email?.includes('@') ? normaliseIdentifier(input.email) : null;
    const phone = input.phone && input.phone.replace(/\D/g, '').length >= 10 ? normaliseIdentifier(input.phone) : null;
    const name = input.name?.trim();
    const or: Prisma.UserWhereInput[] = [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : []), ...(name && name.length >= 4 ? [{ name: { equals: name, mode: 'insensitive' as const } }] : [])];
    if (!or.length) return [];
    const rows = await this.prisma.user.findMany({ where: { orgId: me.orgId, deletedAt: null, OR: or }, select: { id: true, name: true, email: true, phone: true, status: true }, take: 5 });
    return rows.map((r) => ({ id: r.id, name: r.name, status: r.status, match: email && r.email === email ? 'email' : phone && r.phone === phone ? 'phone' : 'name' }));
  }

  // ---------------------------------------------------------------------------
  // Add person

  private async validateAdd(me: Me, input: ReturnType<typeof peopleAddPersonSchema.parse>) {
    const can = peopleCan(me);
    if (!can.addPerson) throw new ForbiddenException('Only the Founder or HR can add people');
    const dept = await this.prisma.department.findFirst({ where: { id: input.departmentId, orgId: me.orgId, deletedAt: null }, include: { teams: { where: { deletedAt: null } }, branch: true } });
    if (!dept) throw new BadRequestException('Pick a department');
    if (dept.branchId !== input.branchId) throw new BadRequestException(`${dept.name} belongs to the ${dept.branch.name} branch. Pick that branch or another department.`);
    if (dept.teams.length && !input.teamId) throw new BadRequestException(`Pick a team or pod in ${dept.name}`);
    if (input.teamId && !dept.teams.some((t) => t.id === input.teamId)) throw new BadRequestException(`That team is not part of ${dept.name}`);
    const manager = await this.prisma.user.findFirst({
      where: { id: input.managerId, orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' }, leftAt: null },
      include: { roles: { select: { role: { select: { baseRole: true } } } } },
    });
    if (!manager) throw new BadRequestException('Pick who they report to (an active team member)');
    const roles = await this.prisma.role.findMany({ where: { id: { in: input.roleIds }, orgId: me.orgId } });
    if (roles.length !== new Set(input.roleIds).size) throw new BadRequestException('Unknown role');
    for (const r of roles) {
      const p = rolePolicy(me, r.baseRole, 'add');
      if (!p.ok) throw new ForbiddenException(p.whyNot ?? "You can't give that role");
    }
    // Reports to someone above them: a manager in their department (Department Head, Sales Manager, AM Lead), their
    // team's lead, or leadership (same rule as the "Reports to" list in Add person).
    const ctx = { candidateRoles: roles.map((r) => r.baseRole), departmentId: dept.id, departmentHeadId: dept.headUserId, teamLeadId: input.teamId ? (dept.teams.find((t) => t.id === input.teamId)?.leadUserId ?? null) : null };
    // The people who could be their manager: their department, its team lead and leadership.
    const pool = await this.prisma.user.findMany({
      where: {
        orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' }, leftAt: null,
        OR: [{ departmentId: dept.id }, { roles: { some: { role: { baseRole: { in: ['founder', 'admin'] } } } } }, ...(ctx.teamLeadId ? [{ id: ctx.teamLeadId }] : [])],
      },
      select: { id: true, name: true, departmentId: true, roles: { select: { role: { select: { baseRole: true } } } } },
    });
    const staffPool = pool.map((u) => ({ id: u.id, name: u.name, departmentId: u.departmentId, roles: u.roles.map((r) => r.role.baseRole) }));
    const choices = peopleManagerChoices(ctx, staffPool);
    if (!choices.some((c) => c.id === manager.id)) {
      const best = choices.find((c) => c.recommended) ?? choices[0];
      throw new BadRequestException(`${manager.name} can't be their manager: pick someone above their role${best ? `, such as ${best.name} (${best.why})` : ''}`);
    }
    if (input.onboarding.buddyId) {
      const buddy = await this.prisma.user.findFirst({ where: { id: input.onboarding.buddyId, orgId: me.orgId, type: 'staff', deletedAt: null, status: 'active' } });
      if (!buddy) throw new BadRequestException('Pick an active buddy');
    }
    const email = normaliseIdentifier(input.email);
    const phone = normaliseIdentifier(input.phone);
    const clash = await this.prisma.user.findFirst({ where: { orgId: me.orgId, OR: [{ email }, { phone }] }, select: { name: true, email: true, deletedAt: true } });
    if (clash) throw new ConflictException(`Possible duplicate: ${clash.name}${clash.deletedAt ? ' (removed earlier)' : ''} already uses that ${clash.email === email ? 'email' : 'mobile number'}. Open their profile instead.`);
    const pending = await this.prisma.approvalRequest.findFirst({ where: { orgId: me.orgId, action: 'person.add', targetId: email, status: 'pending' } });
    if (pending) throw new ConflictException(`Adding ${input.name} is already waiting for approval`);
    return { dept, manager, roles, email, phone };
  }

  async add(me: Me, raw: PeopleAddPerson, ip?: string): Promise<PeopleMutationResult> {
    staffOnly(me);
    const input = peopleAddPersonSchema.parse(raw);
    const v = await this.validateAdd(me, input);
    // A Branch Manager added by the HR Department Head is created only once the Founder approves it.
    if (!isFounder(me) && v.roles.some((r) => rolePolicy(me, r.baseRole, 'add').needsFounder)) {
      const roleNames = v.roles.map((r) => r.name).join(' + ');
      const req = await this.approvals.create(
        me,
        {
          action: 'person.add',
          targetType: 'person_invite',
          targetId: v.email,
          summary: `Add ${input.name} to ${v.dept.name} as ${roleNames}`,
          payload: { input },
          reason: input.note ?? 'A new Branch Manager is approved by the Founder',
          approverId: null,
          approverRoles: ['founder'],
          diff: [
            { field: 'Name', before: null, after: input.name },
            { field: 'Role', before: null, after: roleNames },
            { field: 'Department', before: null, after: v.dept.name },
            { field: 'Reports to', before: null, after: v.manager.name },
            { field: 'Joining', before: null, after: fmtDay(input.joiningDate) },
          ],
        },
        ip,
      );
      return { ok: true, id: null, outcome: 'approval', message: 'Sent to the Founder for approval (new Branch Manager)', approval: { id: req.id, summary: req.summary }, undo: null };
    }
    if (!approvesNewPeople(me)) {
      // Other HR members: nothing is created or sent until a Founder or the HR Department Head approves.
      const hrHead = await this.prisma.user.findFirst({
        where: { orgId: me.orgId, type: 'staff', deletedAt: null, status: 'active', AND: [{ roles: { some: { role: { baseRole: 'hr_ops' } } } }, { roles: { some: { role: { baseRole: 'department_head' } } } }] },
        select: { id: true },
      });
      const req = await this.approvals.create(
        me,
        {
          action: 'person.add',
          targetType: 'person_invite',
          targetId: v.email,
          summary: `Add ${input.name} to ${v.dept.name} as ${v.roles.map((r) => r.name).join(' + ')}`,
          payload: { input },
          reason: input.note ?? 'New people added by HR are approved by a Founder or the HR Department Head',
          approverId: hrHead?.id ?? null,
          approverRoles: ['founder'],
          diff: [
            { field: 'Name', before: null, after: input.name },
            { field: 'Role', before: null, after: v.roles.map((r) => r.name).join(' + ') },
            { field: 'Department', before: null, after: v.dept.name },
            { field: 'Reports to', before: null, after: v.manager.name },
            { field: 'Joining', before: null, after: fmtDay(input.joiningDate) },
          ],
        },
        ip,
      );
      return { ok: true, id: null, outcome: 'approval', message: 'Sent to a Founder or the HR Department Head for approval', approval: { id: req.id, summary: req.summary }, undo: null };
    }
    const id = await this.createPerson(me, input, ip);
    return { ok: true, id, outcome: 'applied', message: `${input.name} added and invited`, approval: null, undo: null };
  }

  /** Creates the person (status invited), the onboarding checklist and tasks, and sends the invite. */
  async createPerson(me: Me, input: ReturnType<typeof peopleAddPersonSchema.parse>, ip?: string, requestedBy?: Me | null): Promise<string> {
    const v = await this.validateAdd(me, input);
    const user = await this.prisma.user.create({
      data: {
        orgId: me.orgId,
        type: 'staff',
        name: input.name,
        email: v.email,
        phone: v.phone,
        status: 'invited',
        departmentId: v.dept.id,
        teamId: input.teamId ?? null,
        managerId: v.manager.id,
        branchId: v.dept.branchId,
        joiningDate: dbDay(input.joiningDate),
        employmentType: input.employmentType,
        specialty: input.specialty ?? null,
        roles: { create: [...new Set(input.roleIds)].map((roleId) => ({ roleId })) },
      },
    });
    await this.audit.log(
      me,
      'user.invited',
      'User',
      user.id,
      undefined,
      { name: input.name, email: v.email, phone: v.phone, roles: v.roles.map((r) => r.name), department: v.dept.name, manager: v.manager.name, joiningDate: input.joiningDate, employmentType: peopleEmploymentLabels[input.employmentType], requestedBy: requestedBy?.name ?? null },
      ip,
    );
    const hr = await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'hr_ops' } } } }, select: { id: true, departmentId: true } });
    // The HR task goes to the HR person who added them (the requester, when an approver created the account).
    const hrOwner = hr.find((h) => h.id === requestedBy?.id) ?? hr.find((h) => h.id === me.id) ?? hr[0] ?? null;
    // The new joiner's Department Head is told and gets a task too, whoever they report to.
    const headId = await this.people.departmentHead(me.orgId, v.dept.id);
    if (input.onboarding.enabled) await this.startOnboarding(me, user.id, input, v, hrOwner, headId, requestedBy?.id ?? null);
    if (input.sendInvite) await this.sendInvite(me, user.id);
    const team = [...new Set([v.manager.id, headId].filter((x): x is string => !!x && x !== me.id))];
    await this.notifications.notify(me.orgId, team, { kind: 'onboarding', title: `${input.name} joins your team on ${fmtDay(input.joiningDate)}`, body: `${v.roles.map((r) => r.name).join(' + ')} · ${v.dept.name} · reports to ${v.manager.name}`, link: `/admin/users/${user.id}` });
    await this.notifications.notify(me.orgId, hr.map((h) => h.id).filter((x) => x !== me.id), { kind: 'onboarding', title: `New joiner: ${input.name} (${fmtDay(input.joiningDate)})`, body: input.onboarding.enabled ? 'Onboarding checklist created' : undefined, link: `/admin/users/${user.id}` });
    return user.id;
  }

  private async startOnboarding(me: Me, userId: string, input: ReturnType<typeof peopleAddPersonSchema.parse>, v: { dept: { id: string; name: string }; manager: { id: string; name: string } }, hr: { id: string; departmentId: string | null } | null, headId: string | null = null, startedById: string | null = null) {
    const pick = new Set(input.onboarding.items);
    const sopIds = input.onboarding.sopIds?.length ? input.onboarding.sopIds : pick.has('sop_reading') ? (await this.prisma.sOP.findMany({ where: { orgId: me.orgId, departmentId: v.dept.id, status: 'published' }, select: { id: true }, take: 10 })).map((s) => s.id) : [];
    const sops = pick.has('sop_reading') && sopIds.length ? await this.prisma.sOP.findMany({ where: { id: { in: sopIds }, orgId: me.orgId, status: 'published' } }) : [];
    const items: TeamProcessItem[] = [
      item('offer_letter', 'Signed offer letter received', 'documents'),
      item('id_proof', 'ID and address proof (Aadhaar / PAN) collected', 'documents'),
      item('bank_details', 'Bank details for salary collected', 'documents'),
      ...(pick.has('laptop') ? [item('laptop_issued', 'Laptop issued', 'equipment'), item('laptop_setup', 'Laptop set up (email, chat, shared drive)', 'equipment')] : []),
      ...(pick.has('accounts') ? [item('hub_login', 'Signed in to BMU Hub for the first time', 'accounts', { auto: true }), item('workspace_account', 'Email and Google Workspace account created', 'accounts'), item('tool_licences', 'Tool licences assigned (Figma, Adobe, Canva…)', 'accounts')] : []),
      ...sops.map((s) => item(`sop_${s.id}`, `Read: ${s.title}`, 'induction', { sopId: s.id, sopVersion: s.version, auto: true })),
      ...(pick.has('shadowing') ? [item('buddy_assigned', 'Buddy assigned', 'buddy', { auto: true }), item('buddy_checkin', 'First-week check-in with buddy', 'buddy'), item('shadowing', 'Shadowed a teammate for the first week', 'buddy')] : []),
    ];
    const row = await this.prisma.peopleProcess.create({
      // Started by the HR person who added them, even when an approver created the account.
      data: { orgId: me.orgId, userId, kind: 'onboarding', startedById: startedById ?? me.id, buddyId: input.onboarding.buddyId ?? null, startDate: dbDay(input.joiningDate), items: items as unknown as Prisma.InputJsonValue, note: input.note ?? null },
    });
    await this.audit.log(me, 'onboarding.started', 'User', userId, null, { processId: row.id, items: [...pick].map((k) => peopleOnboardingLabels[k]), sops: sops.map((s) => s.title) });
    // Onboarding tasks for HR, the manager and the Department Head (when that is someone else), due on the joining day.
    const deadline = new Date(`${input.joiningDate}T18:00:00+05:30`);
    const tasks = [
      hr ? { ownerId: hr.id, departmentId: hr.departmentId, title: `Onboard ${input.name}: documents, laptop and accounts`, description: `Joining ${fmtDay(input.joiningDate)} in ${v.dept.name}. Work through the onboarding checklist.` } : null,
      { ownerId: v.manager.id, departmentId: v.dept.id, title: `Welcome ${input.name}: first-week plan and buddy`, description: `${input.name} joins your team on ${fmtDay(input.joiningDate)}. Plan their first week${pick.has('shadowing') ? ' and who they shadow' : ''}.` },
      headId && headId !== v.manager.id
        ? { ownerId: headId, departmentId: v.dept.id, title: `New joiner in ${v.dept.name}: ${input.name}, first work and access`, description: `${input.name} joins ${v.dept.name} on ${fmtDay(input.joiningDate)}, reporting to ${v.manager.name}. Plan their first assignments and check their tool access. The onboarding checklist is under Onboarding & Offboarding.` }
        : null,
    ].filter((t): t is NonNullable<typeof t> => !!t);
    for (const t of tasks) {
      const created = await this.prisma.task.create({
        data: { orgId: me.orgId, title: t.title, description: t.description, ownerId: t.ownerId, departmentId: t.departmentId, deadline, isInternal: true, createdById: me.id, priority: 'high' },
      });
      await this.audit.log(me, 'task.created', 'Task', created.id, null, { title: t.title, ownerId: t.ownerId, via: 'onboarding' });
      if (t.ownerId !== me.id) await this.notifications.notify(me.orgId, [t.ownerId], { kind: 'task_assigned', title: t.title, body: `Due ${fmtDay(input.joiningDate)}`, link: `/team/tasks/${created.id}` });
    }
    if (input.onboarding.buddyId) await this.notifications.notify(me.orgId, [input.onboarding.buddyId], { kind: 'onboarding', title: `You are ${input.name}'s onboarding buddy`, link: `/team/onboarding/${row.id}` });
  }

  /** Invite by email (outbox / SMTP) and SMS (logged until an SMS gateway is connected). */
  async sendInvite(me: Me, userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { id: true, name: true, email: true, phone: true } });
    const signIn = appUrl('/sign-in');
    if (u.email)
      await this.email.send({
        orgId: me.orgId,
        to: u.email,
        toName: u.name,
        toUserId: u.id,
        kind: 'staff_invite',
        subject: `${me.name} invited you to BMU Hub`,
        heading: 'Welcome to the team',
        paragraphs: [`Hi ${u.name.split(' ')[0]}, ${me.name} added you to BMU Hub, where the team plans and delivers client work.`, `Sign in with this email${u.phone ? ' or your mobile number' : ''}. We send you a one-time code each time, so there is no password to remember.`],
        button: { label: 'Sign in to BMU Hub', url: signIn },
        entity: 'User',
        entityId: u.id,
      });
    if (u.phone) {
      this.log.log(`SMS invite to ${u.phone}: "${me.name} added you to BMU Hub. Sign in at ${signIn} with this number."`);
      await this.audit.log(me, 'user.invite_sms', 'User', u.id, null, { phone: u.phone, delivery: 'logged (no SMS gateway connected)' });
    }
    await this.audit.log(me, 'user.invite_sent', 'User', u.id, null, { email: u.email, phone: u.phone });
  }

  async resendInvite(me: Me, id: string): Promise<PeopleMutationResult> {
    if (!peopleCan(me).edit) throw new ForbiddenException('Only the Founder, a Branch Manager or HR can resend invites');
    const u = await this.person(me, id, { visible: true });
    if (u.status !== 'invited') throw new BadRequestException(`${u.name} has already signed in`);
    await this.sendInvite(me, id);
    return { ok: true, id, outcome: 'applied', message: `Invite sent again to ${u.name}`, approval: null, undo: null };
  }

  // ---------------------------------------------------------------------------
  // Edit person (self: contact + photo only)

  async edit(me: Me, id: string, input: PeopleEditPerson, ip?: string): Promise<PeopleMutationResult> {
    staffOnly(me);
    const self = id === me.id;
    const can = peopleCan(me);
    if (!self && !can.edit) throw new ForbiddenException('Only the Founder, a Branch Manager or HR can edit people. Role, department and manager changes use Change role and Move.');
    const u = await this.person(me, id, { visible: !self });
    if (!can.edit && self) {
      const extra = Object.keys(input).filter((k) => !['email', 'phone', 'photoUrl'].includes(k) && input[k as keyof PeopleEditPerson] !== undefined);
      if (extra.length) throw new ForbiddenException('You can change your contact details and photo only. Ask HR for anything else.');
    }
    if (u.roles.some((r) => r.role.baseRole === 'founder') && !isFounder(me)) throw new ForbiddenException("Only the Founder can change the Founder's account");
    const email = input.email ? normaliseIdentifier(input.email) : input.email;
    const phone = input.phone ? normaliseIdentifier(input.phone) : input.phone;
    if (email === null && (phone === null || (phone === undefined && !u.phone))) throw new BadRequestException('Keep an email or a mobile number so they can sign in');
    if (phone === null && !email && !u.email) throw new BadRequestException('Keep an email or a mobile number so they can sign in');
    const clash = email || phone ? await this.prisma.user.findFirst({ where: { orgId: me.orgId, id: { not: id }, OR: [...(email ? [{ email }] : []), ...(phone ? [{ phone }] : [])] }, select: { name: true } }) : null;
    if (clash) throw new ConflictException(`${clash.name} already uses that email or mobile number`);
    const data: Prisma.UserUpdateInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(email !== undefined ? { email } : {}),
      ...(phone !== undefined ? { phone } : {}),
      ...(input.photoUrl !== undefined ? { photoUrl: input.photoUrl } : {}),
      ...(input.specialty !== undefined ? { specialty: input.specialty } : {}),
      ...(input.joiningDate !== undefined ? { joiningDate: input.joiningDate ? dbDay(input.joiningDate) : null } : {}),
      ...(input.employmentType !== undefined ? { employmentType: input.employmentType } : {}),
    };
    if (!Object.keys(data).length) throw new BadRequestException('Nothing to change');
    const before = { name: u.name, email: u.email, phone: u.phone, photoUrl: u.photoUrl, specialty: u.specialty, joiningDate: u.joiningDate, employmentType: u.employmentType };
    const snapshot: Record<string, unknown> = {};
    for (const k of Object.keys(data)) snapshot[k] = before[k as keyof typeof before] ?? null;
    await this.prisma.user.update({ where: { id }, data });
    await this.audit.log(me, 'user.updated', 'User', id, snapshot, { ...input, email, phone }, ip);
    const undo = await this.undo.create(me, `${u.name}'s details changed`, [{ model: 'user', id, data: snapshot }]);
    return { ok: true, id, outcome: 'applied', message: self ? 'Your details are saved' : `${u.name}'s details saved`, approval: null, undo };
  }

  // ---------------------------------------------------------------------------
  // Move person (manager / team / department / branch)

  private async planMove(me: Me, id: string, input: ReturnType<typeof peopleMoveSchema.parse>, opts: { approved?: boolean } = {}) {
    staffOnly(me);
    const can = peopleCan(me);
    if (!can.move) throw new ForbiddenException('Only the Founder, a Branch Manager or the Department Head can move people');
    const u = await this.person(me, id);
    if (u.leftAt || u.status === 'suspended') throw new BadRequestException(`${u.name} is not an active team member`);
    if (u.roles.some((r) => r.role.baseRole === 'founder') && !isFounder(me)) throw new ForbiddenException('Only the Founder can move the Founder');
    if (id === me.id && !isFA(me)) throw new ForbiddenException('Ask a Branch Manager to move you');
    const dept = await this.prisma.department.findFirst({ where: { id: input.departmentId, orgId: me.orgId, deletedAt: null }, include: { teams: { where: { deletedAt: null } }, branch: true } });
    if (!dept) throw new BadRequestException('Pick a department');
    const team = input.teamId ? dept.teams.find((t) => t.id === input.teamId) : null;
    if (input.teamId && !team) throw new BadRequestException(`That team is not part of ${dept.name}`);
    if (input.branchId && input.branchId !== dept.branchId) throw new BadRequestException(`${dept.name} belongs to the ${dept.branch.name} branch`);
    const managerId = input.managerId === undefined ? u.managerId : input.managerId;
    let manager: { id: string; name: string } | null = null;
    if (managerId) {
      if (managerId === id) throw new BadRequestException("Someone can't report to themselves");
      manager = await this.prisma.user.findFirst({ where: { id: managerId, orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' }, leftAt: null }, select: { id: true, name: true } });
      if (!manager) throw new BadRequestException('Pick an active manager');
      if (await this.wouldLoop(id, managerId)) throw new BadRequestException(`That would create a reporting loop: ${manager.name} already reports to ${u.name}`);
    }
    const t = today();
    if (input.effectiveDate < t) throw new BadRequestException("The effective date can't be in the past");
    const cross = u.departmentId !== dept.id;
    let blocked: string | null = null;
    let needsApproval: PeopleMovePreview['needsApproval'] = null;
    if (!isFA(me)) {
      // Department heads move people within their own department; anything across departments goes to a Branch Manager.
      const ownsFrom = u.departmentId ? await this.people.isHeadOf(me, u.departmentId) : false;
      if (!ownsFrom) blocked = `${u.name} is not in your department. Ask a Branch Manager to move them.`;
      else if (cross && !opts.approved) needsApproval = { approver: 'a Branch Manager', why: `Moving ${u.name} from ${u.department?.name ?? 'no department'} to ${dept.name} crosses departments` };
    }
    const nothing = u.departmentId === dept.id && (u.teamId ?? null) === (team?.id ?? null) && (u.managerId ?? null) === (manager?.id ?? null);
    if (nothing && !blocked) blocked = 'Nothing changes: pick a new team, department or manager';

    // Access preview: what they gain or lose sight of, and who sees them.
    const perms = peopleMergePermissions(await this.rolePerms(u.roles.map((r) => r.roleId)));
    const gains: string[] = [];
    const loses: string[] = [];
    const scopeCaps = (scope: AccessScope) => Object.entries(perms).filter(([, s]) => s === scope).map(([c]) => PEOPLE_CAPABILITY_LABELS[c] ?? c);
    const deptCaps = scopeCaps('department');
    const teamCaps = scopeCaps('team');
    const branchCaps = scopeCaps('branch');
    if (cross) {
      if (deptCaps.length) {
        gains.push(`Sees ${dept.name}'s ${deptCaps.join(', ').toLowerCase()}`);
        if (u.department) loses.push(`No longer sees ${u.department.name}'s ${deptCaps.join(', ').toLowerCase()}`);
      }
      const newHead = await this.people.departmentHead(me.orgId, dept.id);
      const oldHead = await this.people.departmentHead(me.orgId, u.departmentId);
      const names = await this.people.names([newHead, oldHead]);
      if (newHead && newHead !== id) gains.push(`${names.get(newHead)} (head of ${dept.name}) sees their work and capacity`);
      if (oldHead && oldHead !== newHead && oldHead !== id) loses.push(`${names.get(oldHead)} (head of ${u.department?.name}) stops seeing their work`);
    }
    if ((u.teamId ?? null) !== (team?.id ?? null) && teamCaps.length) {
      if (team) gains.push(`Sees ${team.name}'s ${teamCaps.join(', ').toLowerCase()}`);
      if (u.team) loses.push(`No longer sees ${u.team.name}'s ${teamCaps.join(', ').toLowerCase()}`);
    }
    if (u.branchId !== dept.branchId && branchCaps.length) {
      gains.push(`Sees the ${dept.branch.name} branch's ${branchCaps.join(', ').toLowerCase()}`);
      if (u.branch) loses.push(`No longer sees the ${u.branch.name} branch's ${branchCaps.join(', ').toLowerCase()}`);
    }
    if ((u.managerId ?? null) !== (manager?.id ?? null)) {
      if (manager) gains.push(`${manager.name} becomes their manager: sees their work, approves their leave and timesheets`);
      if (u.manager) loses.push(`${u.manager.name} stops being their manager (no longer sees their work or approves their leave)`);
    }
    if (!gains.length && !loses.length && !blocked) gains.push('No change to what they can see');
    const open = await this.offboarding.openRecords(me.orgId, id);
    return {
      u,
      dept,
      team,
      manager,
      cross,
      payload: { departmentId: dept.id, teamId: team?.id ?? null, managerId: manager?.id ?? null, branchId: dept.branchId } as MovePayload,
      preview: {
        person: { id: u.id, name: u.name },
        from: { department: u.department?.name ?? null, team: u.team?.name ?? null, manager: u.manager?.name ?? null, branch: u.branch?.name ?? null },
        to: { department: dept.name, team: team?.name ?? null, manager: manager?.name ?? null, branch: dept.branch.name },
        gains,
        loses,
        openWork: { tasks: open.tasks.length, clients: open.clients.length, leads: open.leads.length, total: open.total },
        crossDepartment: cross,
        scheduled: input.effectiveDate > t,
        needsApproval,
        blocked,
      } satisfies PeopleMovePreview,
    };
  }

  private async wouldLoop(userId: string, managerId: string) {
    let cursor: string | null = managerId;
    for (let i = 0; cursor && i < 50; i++) {
      if (cursor === userId) return true;
      const next: { managerId: string | null } | null = await this.prisma.user.findUnique({ where: { id: cursor }, select: { managerId: true } });
      cursor = next?.managerId ?? null;
    }
    return false;
  }

  async movePreview(me: Me, id: string, raw: PeopleMove): Promise<PeopleMovePreview> {
    return (await this.planMove(me, id, peopleMoveSchema.parse(raw))).preview;
  }

  async move(me: Me, id: string, raw: PeopleMove, ip?: string, opts: { approved?: boolean; requestedBy?: Me | null; approvalId?: string; skipUndo?: boolean } = {}): Promise<PeopleMutationResult & { undoRows?: UndoRow[] }> {
    const input = peopleMoveSchema.parse(raw);
    const plan = await this.planMove(me, id, input, opts);
    const { preview, u } = plan;
    if (preview.blocked) throw new (preview.blocked.includes('not in your department') ? ForbiddenException : BadRequestException)(preview.blocked);
    if (preview.needsApproval) {
      const req = await this.approvals.create(
        me,
        {
          action: 'person.move',
          targetType: 'user',
          targetId: id,
          summary: `Move ${u.name} to ${[preview.to.department, preview.to.team].filter(Boolean).join(' · ')}`,
          payload: { input },
          reason: input.reason,
          approverId: null,
          approverRoles: ['admin'],
          diff: [
            { field: 'Department', before: preview.from.department, after: preview.to.department },
            { field: 'Team', before: preview.from.team, after: preview.to.team },
            { field: 'Manager', before: preview.from.manager, after: preview.to.manager },
            { field: 'From', before: null, after: fmtDay(input.effectiveDate) },
          ],
        },
        ip,
      );
      return { ok: true, id, outcome: 'approval', message: 'Sent to a Branch Manager for approval (the move crosses departments)', approval: { id: req.id, summary: req.summary }, undo: null };
    }
    if (preview.scheduled) {
      const s = await this.prisma.peopleScheduledChange.create({ data: { orgId: me.orgId, userId: id, kind: 'move', payload: plan.payload, effectiveDate: dbDay(input.effectiveDate), reason: input.reason, byId: opts.requestedBy?.id ?? me.id, approvalRequestId: opts.approvalId ?? null } });
      await this.audit.log(me, 'user.move_scheduled', 'User', id, preview.from, { ...preview.to, effectiveDate: input.effectiveDate, reason: input.reason, scheduledChangeId: s.id }, ip);
      await this.notifications.notify(me.orgId, [id, plan.manager?.id, u.managerId].filter((x): x is string => !!x && x !== me.id), { kind: 'org_change', title: `${u.name} moves to ${preview.to.department}${preview.to.team ? ` · ${preview.to.team}` : ''} on ${fmtDay(input.effectiveDate)}`, body: input.reason, link: `/admin/users/${id}` });
      return { ok: true, id, outcome: 'scheduled', message: `${u.name} moves on ${fmtDay(input.effectiveDate)}`, approval: null, undo: null };
    }
    const rows = await this.applyMove(me, id, plan.payload, input.reason, ip, opts.approvalId);
    const undo = opts.skipUndo || opts.approved ? null : await this.undo.create(me, `${u.name} moved`, rows);
    return { ok: true, id, outcome: 'applied', message: `${u.name} moved to ${preview.to.department}${preview.to.team ? ` · ${preview.to.team}` : ''}`, approval: null, undo, undoRows: rows };
  }

  /** Applies a move now (also used for scheduled moves). Returns undo rows. */
  private async applyMove(actor: Me | null, id: string, p: MovePayload, reason: string, ip?: string, approvalId?: string | null, orgId?: string): Promise<UndoRow[]> {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id }, include: userInclude });
    const before = { departmentId: u.departmentId, teamId: u.teamId, managerId: u.managerId, branchId: u.branchId };
    const rows: UndoRow[] = [{ model: 'user', id, data: before }];
    await this.prisma.user.update({ where: { id }, data: { departmentId: p.departmentId, teamId: p.teamId, managerId: p.managerId, branchId: p.branchId } });
    // A lead who leaves their team stops being its lead; a head who leaves the department stops being its head.
    if (u.teamId && u.teamId !== p.teamId) await this.prisma.team.updateMany({ where: { id: u.teamId, leadUserId: id }, data: { leadUserId: null } });
    if (u.departmentId && u.departmentId !== p.departmentId) await this.prisma.department.updateMany({ where: { id: u.departmentId, headUserId: id }, data: { headUserId: null } });
    const after = await this.prisma.user.findUniqueOrThrow({ where: { id }, include: userInclude });
    const view = (x: UserFull) => ({ department: x.department?.name ?? null, team: x.team?.name ?? null, manager: x.manager?.name ?? null, branch: x.branch?.name ?? null });
    const org = actor?.orgId ?? orgId ?? u.orgId;
    if (actor) await this.audit.log(actor, 'user.moved', 'User', id, { ...before, ...view(u) }, { ...p, ...view(after), reason, approvalId: approvalId ?? null }, ip);
    else await this.audit.logSystem(org, 'user.moved', 'User', id, { ...p, ...view(after), reason, scheduled: true });
    const who = [id, after.managerId, u.managerId].filter((x): x is string => !!x && x !== actor?.id);
    await this.notifications.notify(org, [...new Set(who)], { kind: 'org_change', title: `${u.name} moved to ${view(after).department ?? 'no department'}${after.team ? ` · ${after.team.name}` : ''}`, body: `${after.manager ? `Reports to ${after.manager.name}. ` : ''}${reason}`, link: `/admin/users/${id}` });
    return rows;
  }

  // ---------------------------------------------------------------------------
  // Change role (permission diff, rank rule, Founder for Admin)

  private async planRole(me: Me, id: string, input: PeopleChangeRole, opts: { approved?: boolean } = {}) {
    staffOnly(me);
    if (!peopleCan(me).changeRole) throw new ForbiddenException(isHR(me) ? 'HR can edit people data, not roles' : 'Only the Founder or a Branch Manager can change roles');
    const u = await this.person(me, id);
    if (id === me.id) throw new ForbiddenException("You can't change your own role. Ask the Founder.");
    if (u.leftAt) throw new BadRequestException(`${u.name} has left`);
    const roles = await this.prisma.role.findMany({ where: { id: { in: input.roleIds }, orgId: me.orgId }, include: { permissions: true } });
    const ids = [...new Set(input.roleIds)];
    if (roles.length !== ids.length) throw new BadRequestException('Unknown role');
    const current = u.roles.map((r) => r.role);
    let blocked: string | null = null;
    let needsFounder = false;
    if (current.some((r) => r.baseRole === 'founder') && !isFounder(me)) blocked = "Only the Founder can change the Founder's roles";
    for (const r of roles) {
      const p = rolePolicy(me, r.baseRole, 'change');
      if (!p.ok) blocked ??= p.whyNot;
      needsFounder ||= p.needsFounder;
    }
    if (current.some((r) => r.baseRole === 'admin') && !isFounder(me)) needsFounder = true;
    const t = today();
    if (input.effectiveDate < t) blocked ??= "The effective date can't be in the past";
    const same = ids.length === current.length && ids.every((rid, i) => current[i]?.id === rid || current.some((c) => c.id === rid)) && current.every((c) => ids.includes(c.id));
    if (same) blocked ??= 'These are already their roles';
    const before = peopleMergePermissions(await this.rolePerms(current.map((r) => r.id)));
    const ordered = ids.map((rid) => roles.find((r) => r.id === rid)!);
    const after = peopleMergePermissions(ordered.map((r) => ({ permissions: r.permissions.map((p) => ({ capability: p.capability, scope: p.scope as AccessScope })) })));
    return {
      u,
      ordered,
      preview: {
        person: { id: u.id, name: u.name },
        before: current.map((r) => r.name),
        after: ordered.map((r) => r.name),
        diff: peoplePermissionDiff(before, after).filter((l) => l.change !== 'same'),
        scheduled: input.effectiveDate > t,
        needsApproval: needsFounder && !opts.approved && !blocked ? { approver: 'the Founder', why: 'Branch Manager-level role changes need the Founder' } : null,
        blocked,
      } satisfies PeopleRolePreview,
    };
  }

  async rolePreview(me: Me, id: string, input: PeopleChangeRole) {
    return (await this.planRole(me, id, peopleChangeRoleSchema.parse(input))).preview;
  }

  async changeRole(me: Me, id: string, raw: PeopleChangeRole, ip?: string, opts: { approved?: boolean; requestedBy?: Me | null; approvalId?: string } = {}): Promise<PeopleMutationResult> {
    const input = peopleChangeRoleSchema.parse(raw);
    const { u, ordered, preview } = await this.planRole(me, id, input, opts);
    if (preview.blocked) throw new (preview.blocked.startsWith('Only') ? ForbiddenException : BadRequestException)(preview.blocked);
    if (preview.needsApproval) {
      const req = await this.approvals.create(
        me,
        {
          action: 'person.role',
          targetType: 'user',
          targetId: id,
          summary: `Change ${u.name}'s role to ${preview.after.join(' + ')}`,
          payload: { input },
          reason: input.reason,
          approverId: null,
          approverRoles: ['founder'],
          diff: [{ field: 'Role', before: preview.before.join(' + '), after: preview.after.join(' + ') }, ...preview.diff.slice(0, 6).map((d) => ({ field: d.label, before: peopleScopeLabels[d.before], after: peopleScopeLabels[d.after] }))],
        },
        ip,
      );
      return { ok: true, id, outcome: 'approval', message: 'Sent to the Founder for approval', approval: { id: req.id, summary: req.summary }, undo: null };
    }
    if (preview.scheduled) {
      const s = await this.prisma.peopleScheduledChange.create({ data: { orgId: me.orgId, userId: id, kind: 'role', payload: { roleIds: ordered.map((r) => r.id) }, effectiveDate: dbDay(input.effectiveDate), reason: input.reason, byId: opts.requestedBy?.id ?? me.id, approvalRequestId: opts.approvalId ?? null } });
      await this.audit.log(me, 'user.role_change_scheduled', 'User', id, { roles: preview.before }, { roles: preview.after, effectiveDate: input.effectiveDate, reason: input.reason, scheduledChangeId: s.id }, ip);
      await this.notifications.notify(me.orgId, [id], { kind: 'org_change', title: `Your role becomes ${preview.after.join(' + ')} on ${fmtDay(input.effectiveDate)}`, body: input.reason, link: '/team/profile' });
      return { ok: true, id, outcome: 'scheduled', message: `${u.name}'s role changes on ${fmtDay(input.effectiveDate)}`, approval: null, undo: null };
    }
    await this.applyRole(me, id, ordered.map((r) => r.id), input.reason, ip, opts.approvalId);
    return { ok: true, id, outcome: 'applied', message: `${u.name} is now ${preview.after.join(' + ')}`, approval: null, undo: null };
  }

  private async applyRole(actor: Me | null, id: string, roleIds: string[], reason: string, ip?: string, approvalId?: string | null) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id }, include: { roles: { include: { role: true } } } });
    const roles = await this.prisma.role.findMany({ where: { id: { in: roleIds } } });
    await this.prisma.$transaction([this.prisma.userRole.deleteMany({ where: { userId: id } }), this.prisma.userRole.createMany({ data: roleIds.map((roleId) => ({ userId: id, roleId })) })]);
    const before = u.roles.map((r) => r.role.name);
    const after = roleIds.map((rid) => roles.find((r) => r.id === rid)?.name ?? rid);
    if (actor) await this.audit.log(actor, 'user.role_changed', 'User', id, { roles: before }, { roles: after, reason, approvalId: approvalId ?? null }, ip);
    else await this.audit.logSystem(u.orgId, 'user.role_changed', 'User', id, { roles: after, reason, scheduled: true });
    await this.notifications.notify(u.orgId, [id, u.managerId].filter((x): x is string => !!x && x !== actor?.id), { kind: 'org_change', title: `${u.name}'s role is now ${after.join(' + ')}`, body: `Permissions updated. ${reason}`, link: `/admin/users/${id}` });
  }

  // ---------------------------------------------------------------------------
  // Scheduled changes

  async cancelScheduled(me: Me, changeId: string, ip?: string): Promise<PeopleMutationResult> {
    const s = await this.prisma.peopleScheduledChange.findFirst({ where: { id: changeId, orgId: me.orgId } });
    if (!s) throw new NotFoundException('Scheduled change not found');
    if (s.status !== 'scheduled') throw new BadRequestException(`This change is already ${s.status}`);
    if (!isFA(me) && s.byId !== me.id) throw new ForbiddenException('Only a Branch Manager or the person who scheduled it can cancel it');
    await this.prisma.peopleScheduledChange.update({ where: { id: changeId }, data: { status: 'cancelled' } });
    await this.audit.log(me, 'user.scheduled_change_cancelled', 'User', s.userId, { kind: s.kind, effectiveDate: dayStr(s.effectiveDate) }, null, ip);
    return { ok: true, id: s.userId, outcome: 'applied', message: 'Scheduled change cancelled', approval: null, undo: null };
  }

  /** Applies moves and role changes whose effective date has arrived (IST). Safe to call often. */
  async applyDue(orgId?: string) {
    const due = await this.prisma.peopleScheduledChange.findMany({ where: { status: 'scheduled', effectiveDate: { lte: dbDay(today()) }, ...(orgId ? { orgId } : {}) }, take: 100 });
    let applied = 0;
    for (const s of due) {
      const claimed = await this.prisma.peopleScheduledChange.updateMany({ where: { id: s.id, status: 'scheduled' }, data: { status: 'applied', appliedAt: new Date() } });
      if (!claimed.count) continue;
      try {
        if (s.kind === 'move') await this.applyMove(null, s.userId, s.payload as MovePayload, s.reason, undefined, s.approvalRequestId, s.orgId);
        else await this.applyRole(null, s.userId, (s.payload as { roleIds: string[] }).roleIds, s.reason, undefined, s.approvalRequestId);
        applied++;
      } catch (e) {
        this.log.error(`Scheduled change ${s.id} failed: ${(e as Error).message}`);
        await this.prisma.peopleScheduledChange.update({ where: { id: s.id }, data: { status: 'scheduled', appliedAt: null } });
      }
    }
    return applied;
  }

  async runJobs(me: Me) {
    if (!isFA(me)) throw new ForbiddenException('Founders and admins only');
    const applied = await this.applyDue(me.orgId);
    const suspended = await this.team.suspendDueLeavers(me.orgId);
    return { applied, suspended };
  }

  // ---------------------------------------------------------------------------
  // Branch / department / team

  async createUnit(me: Me, input: PeopleCreateUnit, ip?: string): Promise<PeopleMutationResult> {
    staffOnly(me);
    if (!peopleCan(me).addUnit) throw new ForbiddenException('Only the Founder or a Branch Manager can create branches, departments and teams');
    const staff = async (uid: string, label: string) => {
      const u = await this.prisma.user.findFirst({ where: { id: uid, orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' }, leftAt: null }, select: { id: true, name: true } });
      if (!u) throw new BadRequestException(`Pick an active ${label}`);
      return u;
    };
    if (input.kind === 'branch') {
      if (await this.prisma.branch.findFirst({ where: { orgId: me.orgId, name: input.name, deletedAt: null } })) throw new ConflictException('A branch with that name already exists');
      if (input.workingHours.start >= input.workingHours.end) throw new BadRequestException('Working hours must end after they start');
      const b = await this.prisma.branch.create({ data: { orgId: me.orgId, name: input.name, city: input.city, workStart: input.workingHours.start, workEnd: input.workingHours.end, workDays: [...new Set(input.workingHours.days)].sort() } });
      await this.audit.log(me, 'branch.created', 'Branch', b.id, null, input, ip);
      return { ok: true, id: b.id, outcome: 'applied', message: `Branch ${b.name} created`, approval: null, undo: null };
    }
    if (input.kind === 'department') {
      const branch = await this.prisma.branch.findFirst({ where: { id: input.branchId, orgId: me.orgId, deletedAt: null } });
      if (!branch) throw new BadRequestException('Pick the branch');
      const head = await staff(input.headUserId, 'department head');
      const existing = await this.prisma.department.findUnique({ where: { branchId_name: { branchId: branch.id, name: input.name } } });
      if (existing && !existing.deletedAt) throw new ConflictException('This branch already has a department with that name');
      const d = existing
        ? await this.prisma.department.update({ where: { id: existing.id }, data: { deletedAt: null, headUserId: head.id } })
        : await this.prisma.department.create({ data: { orgId: me.orgId, branchId: branch.id, name: input.name, headUserId: head.id } });
      // Default flow templates and QC checklists: copies of the chosen ones, owned by the new department.
      const flows = input.copyFlowTemplateIds?.length ? await this.prisma.flowTemplate.findMany({ where: { id: { in: input.copyFlowTemplateIds }, orgId: me.orgId } }) : [];
      for (const f of flows) {
        if (await this.prisma.flowTemplate.findFirst({ where: { departmentId: d.id, name: f.name } })) continue;
        await this.prisma.flowTemplate.create({ data: { orgId: me.orgId, departmentId: d.id, name: f.name, key: f.key, deliverableTypes: f.deliverableTypes, steps: f.steps as Prisma.InputJsonValue, version: 1, active: true } });
      }
      const qcs = input.copyQcChecklistIds?.length ? await this.prisma.checklistTemplate.findMany({ where: { id: { in: input.copyQcChecklistIds }, orgId: me.orgId, kind: 'qc' } }) : [];
      for (const q of qcs) await this.prisma.checklistTemplate.create({ data: { orgId: me.orgId, departmentId: d.id, serviceId: q.serviceId, kind: 'qc', key: q.key, name: q.name, items: q.items as Prisma.InputJsonValue, version: 1 } });
      await this.audit.log(me, 'department.created', 'Department', d.id, null, { name: input.name, branch: branch.name, head: head.name, flowTemplates: flows.map((f) => f.name), qcChecklists: qcs.map((q) => q.name) }, ip);
      if (head.id !== me.id) await this.notifications.notify(me.orgId, [head.id], { kind: 'org_change', title: `You are now head of ${d.name}`, link: '/admin/hierarchy' });
      return { ok: true, id: d.id, outcome: 'applied', message: `${d.name} created${flows.length || qcs.length ? ` with ${flows.length} flow template${flows.length === 1 ? '' : 's'} and ${qcs.length} QC checklist${qcs.length === 1 ? '' : 's'}` : ''}`, approval: null, undo: null };
    }
    const d = await this.prisma.department.findFirst({ where: { id: input.departmentId, orgId: me.orgId, deletedAt: null } });
    if (!d) throw new BadRequestException('Pick the department');
    if (await this.prisma.team.findFirst({ where: { departmentId: d.id, name: input.name, deletedAt: null } })) throw new ConflictException('This department already has a team with that name');
    const lead = await staff(input.leadUserId, 'team lead');
    const t = await this.prisma.team.create({ data: { orgId: me.orgId, departmentId: d.id, name: input.name, leadUserId: lead.id } });
    const leadUser = await this.prisma.user.findUniqueOrThrow({ where: { id: lead.id } });
    if (leadUser.departmentId === d.id || !leadUser.departmentId) await this.prisma.user.update({ where: { id: lead.id }, data: { teamId: t.id, departmentId: d.id, branchId: d.branchId } });
    await this.audit.log(me, 'team.created', 'Team', t.id, null, { name: input.name, department: d.name, lead: lead.name }, ip);
    if (lead.id !== me.id) await this.notifications.notify(me.orgId, [lead.id], { kind: 'org_change', title: `You now lead ${t.name} (${d.name})`, link: '/admin/hierarchy' });
    return { ok: true, id: t.id, outcome: 'applied', message: `Team ${t.name} created in ${d.name}`, approval: null, undo: null };
  }

  // ---------------------------------------------------------------------------
  // Client pods

  async podsView(me: Me) {
    const pods = await this.prisma.clientPod.findMany({ where: { orgId: me.orgId, deletedAt: null }, orderBy: { name: 'asc' } });
    const userIds = pods.flatMap((p) => [p.amUserId, p.strategistUserId, ...p.producerIds]);
    const [names, clients] = await Promise.all([this.people.names(userIds), this.prisma.clientOrg.findMany({ where: { id: { in: pods.flatMap((p) => p.clientIds) } }, select: { id: true, name: true } })]);
    const r = (id: string | null) => (id ? { id, name: names.get(id) ?? 'Former member' } : null);
    return pods.map((p) => ({ id: p.id, name: p.name, am: r(p.amUserId), strategist: r(p.strategistUserId), producers: p.producerIds.map((id) => r(id)!), clients: p.clientIds.map((id) => ({ id, name: clients.find((c) => c.id === id)?.name ?? 'Client' })) }));
  }

  async pods(me: Me) {
    staffOnly(me);
    return this.podsView(me);
  }

  private async validatePod(me: Me, input: { name: string; amUserId: string; strategistUserId: string; producerIds: string[]; clientIds: string[] }, podId?: string) {
    if (!peopleCan(me).addPod) throw new ForbiddenException('Only the Founder, a Branch Manager or the CM Lead can manage client pods');
    const ids = [...new Set([input.amUserId, input.strategistUserId, ...input.producerIds])];
    const users = await this.prisma.user.findMany({ where: { id: { in: ids }, orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' }, leftAt: null }, include: { roles: { include: { role: { select: { baseRole: true } } } } } });
    const u = (id: string) => users.find((x) => x.id === id);
    const roles = (id: string) => u(id)?.roles.map((r) => r.role.baseRole) ?? [];
    if (!u(input.amUserId) || !roles(input.amUserId).some((r) => ['account_manager', 'am_lead'].includes(r))) throw new BadRequestException('The CM must be an active client manager');
    if (!u(input.strategistUserId) || !roles(input.strategistUserId).some((r) => ['strategist', 'department_head'].includes(r))) throw new BadRequestException('The strategist must be an active strategist');
    for (const p of input.producerIds) if (!u(p)) throw new BadRequestException('Every producer must be an active team member');
    const clients = await this.prisma.clientOrg.findMany({ where: { id: { in: input.clientIds }, orgId: me.orgId, deletedAt: null }, select: { id: true, name: true } });
    if (clients.length !== new Set(input.clientIds).size) throw new BadRequestException('Unknown client');
    const others = await this.prisma.clientPod.findMany({ where: { orgId: me.orgId, deletedAt: null, ...(podId ? { id: { not: podId } } : {}), clientIds: { hasSome: input.clientIds } } });
    if (others.length) {
      const taken = clients.filter((c) => others.some((o) => o.clientIds.includes(c.id)));
      throw new ConflictException(`${taken.map((c) => c.name).join(', ')} ${taken.length > 1 ? 'are' : 'is'} already in ${others[0].name}. Remove ${taken.length > 1 ? 'them' : 'it'} there first.`);
    }
    if (await this.prisma.clientPod.findFirst({ where: { orgId: me.orgId, deletedAt: null, name: { equals: input.name, mode: 'insensitive' }, ...(podId ? { id: { not: podId } } : {}) } })) throw new ConflictException('A pod with that name already exists');
    return { clients };
  }

  async createPod(me: Me, input: { name: string; amUserId: string; strategistUserId: string; producerIds: string[]; clientIds: string[] }, ip?: string): Promise<PeopleMutationResult> {
    staffOnly(me);
    const { clients } = await this.validatePod(me, input);
    const pod = await this.prisma.clientPod.create({ data: { orgId: me.orgId, name: input.name, amUserId: input.amUserId, strategistUserId: input.strategistUserId, producerIds: [...new Set(input.producerIds)], clientIds: [...new Set(input.clientIds)] } });
    await this.audit.log(me, 'pod.created', 'ClientPod', pod.id, null, { ...input, clients: clients.map((c) => c.name) }, ip);
    await this.notifications.notify(me.orgId, [...new Set([input.amUserId, input.strategistUserId, ...input.producerIds])].filter((x) => x !== me.id), { kind: 'org_change', title: `You are in the ${pod.name} client pod`, body: `Clients: ${clients.map((c) => c.name).join(', ')}. New tasks for them come to the pod by default.`, link: '/team/tasks' });
    return { ok: true, id: pod.id, outcome: 'applied', message: `Pod ${pod.name} created with ${clients.length} client${clients.length === 1 ? '' : 's'}`, approval: null, undo: null };
  }

  async updatePod(me: Me, id: string, input: Partial<{ name: string; amUserId: string; strategistUserId: string; producerIds: string[]; clientIds: string[] }>, ip?: string): Promise<PeopleMutationResult> {
    staffOnly(me);
    const pod = await this.prisma.clientPod.findFirst({ where: { id, orgId: me.orgId, deletedAt: null } });
    if (!pod) throw new NotFoundException('Pod not found');
    const next = { name: input.name ?? pod.name, amUserId: input.amUserId ?? pod.amUserId, strategistUserId: input.strategistUserId ?? pod.strategistUserId ?? '', producerIds: input.producerIds ?? pod.producerIds, clientIds: input.clientIds ?? pod.clientIds };
    await this.validatePod(me, next, id);
    await this.prisma.clientPod.update({ where: { id }, data: next });
    await this.audit.log(me, 'pod.updated', 'ClientPod', id, pod, next, ip);
    return { ok: true, id, outcome: 'applied', message: `Pod ${next.name} saved`, approval: null, undo: null };
  }

  async removePod(me: Me, id: string, ip?: string): Promise<PeopleMutationResult> {
    staffOnly(me);
    if (!peopleCan(me).addPod) throw new ForbiddenException('Only the Founder, a Branch Manager or the CM Lead can manage client pods');
    const pod = await this.prisma.clientPod.findFirst({ where: { id, orgId: me.orgId, deletedAt: null } });
    if (!pod) throw new NotFoundException('Pod not found');
    await this.prisma.clientPod.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.audit.log(me, 'pod.removed', 'ClientPod', id, { name: pod.name }, null, ip);
    return { ok: true, id, outcome: 'applied', message: `Pod ${pod.name} removed`, approval: null, undo: null };
  }

  // ---------------------------------------------------------------------------
  // Custom role (clone + scopes; a Branch Manager's new role needs the Founder)

  async customRole(me: Me, raw: PeopleCustomRole, ip?: string, approved = false): Promise<PeopleMutationResult> {
    staffOnly(me);
    const input = peopleCustomRoleSchema.parse(raw);
    if (!peopleCan(me).customRole) throw new ForbiddenException('Only the Founder or a Branch Manager can create roles');
    const base = await this.prisma.role.findFirst({ where: { id: input.cloneFromRoleId, orgId: me.orgId }, include: { permissions: true } });
    if (!base) throw new BadRequestException('Pick the role to start from');
    if (base.baseRole === 'founder' || base.baseRole.startsWith('client_')) throw new BadRequestException('Start from a team role other than Founder');
    if (await this.prisma.role.findFirst({ where: { orgId: me.orgId, name: { equals: input.name, mode: 'insensitive' } } })) throw new ConflictException('A role with that name exists');
    for (const cap of Object.keys(input.scopes)) if (!(CAPABILITIES as string[]).includes(cap)) throw new BadRequestException(`Unknown permission "${cap}"`);
    const perms = CAPABILITIES.map((c) => {
      const scope = (input.scopes[c] ?? base.permissions.find((p) => p.capability === c)?.scope ?? 'none') as AccessScope;
      const orig = base.permissions.find((p) => p.capability === c);
      return { capability: c, scope, rule: orig && orig.scope === scope ? orig.rule : scope === 'none' ? 'none' : scope === 'own' ? 'own' : scope === 'all' ? 'full' : scope };
    });
    if (!isFounder(me) && !approved) {
      const req = await this.approvals.create(
        me,
        {
          action: 'role.custom',
          targetType: 'role',
          targetId: `new:${input.name.toLowerCase()}`,
          summary: `New role "${input.name}" based on ${base.name}`,
          payload: { input },
          reason: 'New custom role created by a Branch Manager',
          approverId: null,
          approverRoles: ['founder'],
          diff: perms
            .filter((p) => (base.permissions.find((b) => b.capability === p.capability)?.scope ?? 'none') !== p.scope)
            .map((p) => ({ field: PEOPLE_CAPABILITY_LABELS[p.capability] ?? p.capability, before: peopleScopeLabels[(base.permissions.find((b) => b.capability === p.capability)?.scope ?? 'none') as AccessScope], after: peopleScopeLabels[p.scope] })),
        },
        ip,
      );
      return { ok: true, id: null, outcome: 'approval', message: 'Sent to the Founder for approval', approval: { id: req.id, summary: req.summary }, undo: null };
    }
    const created = await this.prisma.role.create({ data: { orgId: me.orgId, name: input.name, baseRole: base.baseRole, isCustom: true, permissions: { create: perms.map((p) => ({ capability: p.capability, scope: p.scope, rule: p.rule })) } } });
    await this.audit.log(me, 'role.created', 'Role', created.id, { from: base.name }, { name: input.name, scopes: input.scopes }, ip);
    return { ok: true, id: created.id, outcome: 'applied', message: `Role "${input.name}" created`, approval: null, undo: null };
  }

  // ---------------------------------------------------------------------------
  // Bulk: move or add a role for many people (one undo for the moves)

  async bulk(me: Me, input: PeopleBulk, ip?: string) {
    staffOnly(me);
    const failed: { id: string; name: string; error: string }[] = [];
    const undoRows: UndoRow[] = [];
    let applied = 0;
    let approvals = 0;
    let scheduled = 0;
    const users = await this.prisma.user.findMany({ where: { id: { in: input.userIds }, orgId: me.orgId }, include: { roles: true } });
    for (const id of input.userIds) {
      const u = users.find((x) => x.id === id);
      try {
        if (!u) throw new NotFoundException('Person not found');
        const r =
          input.action === 'move'
            ? await this.move(me, id, input.move, ip, { skipUndo: true })
            : await this.changeRole(me, id, { roleIds: [...u.roles.map((x) => x.roleId).filter((x) => x !== input.roleId), input.roleId], effectiveDate: input.effectiveDate, reason: input.reason }, ip);
        if (r.outcome === 'approval') approvals++;
        else if (r.outcome === 'scheduled') scheduled++;
        else applied++;
        if ('undoRows' in r && Array.isArray(r.undoRows)) undoRows.push(...(r.undoRows as UndoRow[]));
      } catch (e) {
        failed.push({ id, name: u?.name ?? id, error: (e as Error).message });
      }
    }
    const label = `${applied} ${applied === 1 ? 'person' : 'people'} ${input.action === 'move' ? 'moved' : 'given the role'}`;
    const undo = undoRows.length ? await this.undo.create(me, label, undoRows) : null;
    await this.audit.log(me, `user.bulk_${input.action}`, 'User', input.userIds[0], null, { count: input.userIds.length, applied, approvals, scheduled, failed: failed.length }, ip);
    const parts = [applied ? label : null, scheduled ? `${scheduled} scheduled` : null, approvals ? `${approvals} sent for approval` : null, failed.length ? `${failed.length} could not be changed` : null].filter(Boolean);
    return { ok: true as const, id: null, outcome: 'applied' as const, message: parts.join(' · ') || 'Nothing changed', approval: null, undo, applied, failed };
  }
}
