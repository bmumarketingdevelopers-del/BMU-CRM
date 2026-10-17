import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  CRAFT_HOURS_PER_TASK,
  CRAFT_PRIORITIES,
  CRAFT_SPECIALTY_OPTIONS,
  CRAFT_WEEK_HOURS,
  canOpenCraftManager,
  craftFitsStep,
  craftSpecialtyForStep,
  craftSpecialtyLabel,
  deliverableStatusLabels,
  istDate,
  type CraftAdhocTaskInput,
  type CraftAssignInput,
  type CraftBoardTask,
  type CraftBulkAssignInput,
  type CraftClientCard,
  type CraftClientNoteInput,
  type CraftKpi,
  type CraftManagerView,
  type CraftMember,
  type CraftNoteKind,
  type CraftPriority,
  type CraftStrip,
  type CraftTaskUpdateInput,
  type CraftTeamRow,
  type CraftTodayItem,
  type DeliverableStatus,
  type Me,
} from '@bmu/shared';
import type { EngagementStatus, Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { ReassignService } from '../actions/reassign.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { checkWindow, leaveOn, loadWorkCalendar } from '../admin-org/work-calendar.js';
import { assertAssignee, assignScope } from '../actions/tasks/assign-rules.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DAY, pct, plural, shortDay, weekStart } from './craft-util.js';

const OPEN = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
const LEADS_ALL = ['founder', 'admin', 'am_lead'];
/** Base roles that make up the assignable team. */
const TEAM_ROLES = ['producer', 'strategist', 'qc_reviewer', 'intern', 'account_manager', 'am_lead', 'department_head'];
/** Who may own each special task kind (same rules as Production). */
const QC_ROLES = ['qc_reviewer', 'department_head', 'founder'];
const REVIEW_ROLES = ['account_manager', 'am_lead', 'founder', 'admin'];
const DONE_DELIVERABLE = ['approved', 'scheduled', 'published'];
/** Engagements that are still being worked on. */
const LIVE: EngagementStatus[] = ['onboarding', 'blocked', 'planning', 'awaiting_plan_approval', 'in_production', 'in_review', 'awaiting_final_payment', 'active_retainer', 'paused'];

type Scope = { kind: 'own_clients' | 'department' | 'all'; label: string; departmentId: string | null; engagementIds: string[] | null };

const taskSelect = {
  id: true,
  orgId: true,
  title: true,
  kind: true,
  flowStep: true,
  status: true,
  priority: true,
  specialty: true,
  deadline: true,
  ownerId: true,
  engagementId: true,
  deliverableId: true,
  departmentId: true,
  dependsOn: true,
  blockedReason: true,
  completedAt: true,
  owner: { select: { id: true, name: true, specialty: true } },
  deliverable: {
    select: {
      id: true,
      title: true,
      status: true,
      departmentId: true,
      versions: { orderBy: { number: 'desc' as const }, take: 1, select: { uploadedById: true } },
      cycle: { select: { engagement: { select: { id: true, amId: true, clientOrg: { select: { id: true, name: true } }, service: { select: { id: true, name: true } } } } } },
    },
  },
} satisfies Prisma.TaskSelect;
type TaskRow = Prisma.TaskGetPayload<{ select: typeof taskSelect }>;

type EngMap = Map<string, { id: string; amId: string | null; clientOrg: { id: string; name: string }; service: { id: string; name: string } }>;
type MemberRow = { id: string; name: string; specialty: string | null; departmentId: string | null; department: string | null; baseRole: string | null; roles: string[] };

const isOpen = (s: string) => (OPEN as readonly string[]).includes(s);
const asPriority = (p: string): CraftPriority => ((CRAFT_PRIORITIES as readonly string[]).includes(p) ? (p as CraftPriority) : 'normal');
const priorityRank = (p: string) => ({ urgent: 0, high: 1, normal: 2, low: 3 })[asPriority(p)];
const istDay = (d: Date) => istDate(d);
/** Start of an IST day as a Date (for @db.Date comparisons). */
const dateOnly = (day: string) => new Date(`${day}T00:00:00Z`);

/** Ends a date-only input ("2026-10-05") at 6 pm IST so it reads as "due that day"; full timestamps pass through. */
function parseDeadline(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T18:00:00+05:30`) : new Date(v);
}

@Injectable()
export class CraftManagerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly reassignEngine: ReassignService,
    private readonly settings: SettingsService,
  ) {}

  // -------------------------------------------------------------------------
  // Scope

  /**
   * Founder, Admin and CM Lead manage everything; a Department Head manages their department; a Client Manager or
   * Project Manager manages the engagements they are the CM of. Everyone else (producers, clients, creators) is refused.
   */
  async scope(me: Me): Promise<Scope> {
    if (me.type !== 'staff' || !canOpenCraftManager(me)) throw new ForbiddenException('The manager workspace is for client managers, project managers and department heads');
    if (me.roles.some((r) => LEADS_ALL.includes(r))) return { kind: 'all', label: 'All clients and teams', departmentId: null, engagementIds: null };
    if (me.roles.includes('department_head')) {
      const self = await this.prisma.user.findUnique({ where: { id: me.id }, include: { department: { select: { name: true } } } });
      return { kind: 'department', label: self?.department?.name ?? 'Your department', departmentId: self?.departmentId ?? '__none__', engagementIds: null };
    }
    const engs = await this.prisma.engagement.findMany({ where: { orgId: me.orgId, amId: me.id, deletedAt: null }, select: { id: true } });
    return { kind: 'own_clients', label: 'Your clients', departmentId: null, engagementIds: engs.map((e) => e.id) };
  }

  private taskWhere(me: Me, s: Scope): Prisma.TaskWhereInput {
    if (s.kind === 'all') return { orgId: me.orgId };
    if (s.kind === 'department') return { orgId: me.orgId, OR: [{ departmentId: s.departmentId }, { deliverable: { departmentId: s.departmentId } }, { owner: { departmentId: s.departmentId } }] };
    const ids = s.engagementIds ?? [];
    return { orgId: me.orgId, OR: [{ engagementId: { in: ids } }, { deliverable: { cycle: { engagementId: { in: ids } } } }] };
  }

  private clientWhere(me: Me, s: Scope, deptClientIds: string[]): Prisma.ClientOrgWhereInput {
    const base = { orgId: me.orgId, deletedAt: null };
    if (s.kind === 'all') return { ...base, engagements: { some: { deletedAt: null, status: { in: LIVE } } } };
    if (s.kind === 'department') return { ...base, id: { in: deptClientIds } };
    return { ...base, OR: [{ amUserId: me.id }, { engagements: { some: { amId: me.id, deletedAt: null } } }] };
  }

  /** Loads a task and checks it is inside the manager's scope (403 when it exists but belongs to someone else's client). */
  private async scopedTask(me: Me, s: Scope, id: string): Promise<TaskRow> {
    const t = await this.prisma.task.findFirst({ where: { AND: [{ id }, this.taskWhere(me, s)] }, select: taskSelect });
    if (t) return t;
    const exists = await this.prisma.task.findFirst({ where: { id, orgId: me.orgId }, select: { id: true } });
    if (exists) throw new ForbiddenException(s.kind === 'department' ? 'That task is outside your department' : "That task belongs to another manager's client");
    throw new NotFoundException('Task not found');
  }

  // -------------------------------------------------------------------------
  // People

  private async members(me: Me, s: Scope, extraIds: string[]): Promise<MemberRow[]> {
    const where: Prisma.UserWhereInput = { orgId: me.orgId, type: 'staff', deletedAt: null };
    const roleFilter: Prisma.UserWhereInput = { roles: { some: { role: { baseRole: { in: TEAM_ROLES } } } } };
    let filter: Prisma.UserWhereInput;
    if (s.kind === 'department') filter = { departmentId: s.departmentId };
    else if (s.kind === 'all') filter = roleFilter;
    // A CM's team: their reports, anyone working on their clients, every specialist and the QC reviewers.
    else filter = { OR: [{ managerId: me.id }, { id: { in: extraIds } }, { specialty: { not: null } }, { roles: { some: { role: { baseRole: 'qc_reviewer' } } } }] };
    const rows = await this.prisma.user.findMany({
      where: { ...where, ...filter, NOT: { status: 'suspended' } },
      include: { department: { select: { name: true } }, roles: { include: { role: { select: { baseRole: true } } } } },
      orderBy: [{ name: 'asc' }],
    });
    return rows
      .filter((u) => u.id !== me.id || s.kind !== 'own_clients')
      .map((u) => ({ id: u.id, name: u.name, specialty: u.specialty, departmentId: u.departmentId, department: u.department?.name ?? null, baseRole: u.roles[0]?.role.baseRole ?? null, roles: u.roles.map((r) => r.role.baseRole) }));
  }

  private async assignee(me: Me, s: Scope, ownerId: string): Promise<MemberRow> {
    const u = await this.prisma.user.findFirst({
      where: { id: ownerId, orgId: me.orgId, type: 'staff', deletedAt: null },
      include: { department: { select: { name: true } }, roles: { include: { role: { select: { baseRole: true } } } } },
    });
    if (!u || u.status === 'suspended') throw new BadRequestException('Pick an active team member');
    if (s.kind === 'department' && u.departmentId !== s.departmentId) throw new ForbiddenException(`${u.name} is outside your department`);
    return { id: u.id, name: u.name, specialty: u.specialty, departmentId: u.departmentId, department: u.department?.name ?? null, baseRole: u.roles[0]?.role.baseRole ?? null, roles: u.roles.map((r) => r.role.baseRole) };
  }

  /** The rules every assignment follows: open tasks only, QC never to the version's own uploader, client reviews to CMs. */
  private checkAssignable(t: TaskRow, u: MemberRow) {
    if (!isOpen(t.status)) throw new BadRequestException(`"${t.title}" is ${t.status === 'done' ? 'already done' : 'cancelled'} and can't be reassigned`);
    if (t.kind === 'qc') {
      if (!u.roles.some((r) => QC_ROLES.includes(r))) throw new BadRequestException(`${u.name} can't do QC. Pick a QC reviewer or department head.`);
      if (t.deliverable?.versions[0]?.uploadedById === u.id) throw new BadRequestException(`${u.name} uploaded this version, so they can't QC it`);
    }
    if (t.kind === 'client_review' && !u.roles.some((r) => REVIEW_ROLES.includes(r))) throw new BadRequestException('Client reviews go to a client manager');
  }

  private async leaveDays(orgId: string, userIds: string[], from: Date, to: Date) {
    if (!userIds.length) return new Map<string, Set<string>>();
    const rows = await this.prisma.leaveRequest.findMany({
      where: { orgId, userId: { in: userIds }, status: 'approved', type: { not: 'wfh' }, from: { lte: dateOnly(istDay(to)) }, to: { gte: dateOnly(istDay(from)) } },
      select: { userId: true, from: true, to: true },
    });
    const map = new Map<string, Set<string>>();
    for (const r of rows) {
      const set = map.get(r.userId) ?? new Set<string>();
      for (let d = r.from.getTime(); d <= r.to.getTime(); d += DAY) set.add(new Date(d).toISOString().slice(0, 10));
      map.set(r.userId, set);
    }
    return map;
  }

  private memberCards(members: MemberRow[], openTasks: { ownerId: string | null; status: string; deadline: Date | null }[], leave: Map<string, Set<string>>, now: Date): CraftMember[] {
    const today = istDay(now);
    const ws = weekStart(now);
    const we = new Date(ws.getTime() + 7 * DAY);
    const weekDays = Array.from({ length: 6 }, (_, i) => istDay(new Date(ws.getTime() + i * DAY + 12 * 3_600_000)));
    return members.map((m) => {
      const mine = openTasks.filter((t) => t.ownerId === m.id);
      const overdue = mine.filter((t) => t.deadline && t.deadline < now && t.status !== 'blocked').length;
      const dueThisWeek = mine.filter((t) => t.deadline && t.deadline >= now && t.deadline < we).length;
      const off = leave.get(m.id) ?? new Set<string>();
      const leaveDaysThisWeek = weekDays.filter((d) => off.has(d)).length;
      const capacityHours = Math.max(0, CRAFT_WEEK_HOURS - leaveDaysThisWeek * 8);
      const hoursThisWeek = (dueThisWeek + overdue) * CRAFT_HOURS_PER_TASK;
      return {
        id: m.id,
        name: m.name,
        specialty: m.specialty,
        specialtyLabel: craftSpecialtyLabel(m.specialty) || (m.baseRole ? m.baseRole.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : ''),
        department: m.department,
        baseRole: m.baseRole,
        open: mine.length,
        overdue,
        dueThisWeek,
        hoursThisWeek,
        capacityHours,
        loadPct: capacityHours ? Math.round((hoursThisWeek * 100) / capacityHours) : hoursThisWeek ? 999 : 0,
        onLeaveToday: off.has(today),
        leaveDaysThisWeek,
        href: `/team/specialists/${m.id}`,
      };
    });
  }

  /** Right specialty first, then the lowest load, never someone on leave today or someone the rules exclude. */
  private suggest(t: TaskRow, members: MemberRow[], cards: Map<string, CraftMember>): CraftBoardTask['suggestion'] {
    if (!isOpen(t.status)) return null;
    const want = t.specialty ?? craftSpecialtyForStep(t.flowStep);
    const eligible = members.filter((m) => {
      const c = cards.get(m.id);
      if (!c || c.onLeaveToday) return false;
      if (t.kind === 'qc') return m.roles.some((r) => QC_ROLES.includes(r)) && t.deliverable?.versions[0]?.uploadedById !== m.id;
      if (t.kind === 'client_review') return m.roles.some((r) => REVIEW_ROLES.includes(r));
      if (want) return m.specialty === want;
      return !!m.specialty && craftFitsStep(m.specialty, t.flowStep) && m.roles.some((r) => ['producer', 'strategist', 'intern'].includes(r));
    });
    const best = eligible.sort((a, b) => cards.get(a.id)!.loadPct - cards.get(b.id)!.loadPct || cards.get(a.id)!.open - cards.get(b.id)!.open)[0];
    if (!best || best.id === t.ownerId) return null;
    const c = cards.get(best.id)!;
    const fit = t.kind === 'qc' ? 'QC' : t.kind === 'client_review' ? 'Client manager' : craftSpecialtyLabel(best.specialty) || 'Fits the step';
    return { userId: best.id, name: best.name, reason: `${fit} · ${c.loadPct}% loaded this week · ${plural(c.open, 'open task')}` };
  }

  private boardTask(t: TaskRow, now: Date, depTitles: Map<string, { title: string; status: string }>, members: MemberRow[], cards: Map<string, CraftMember>, engs: EngMap): CraftBoardTask {
    const eng = t.deliverable?.cycle.engagement ?? (t.engagementId ? engs.get(t.engagementId) : undefined);
    const latestUploader = t.deliverable?.versions[0]?.uploadedById;
    return {
      id: t.id,
      title: t.title,
      kind: t.kind,
      flowStep: t.flowStep,
      status: t.status,
      priority: asPriority(t.priority),
      deadline: t.deadline?.toISOString() ?? null,
      overdue: !!t.deadline && t.deadline < now && isOpen(t.status),
      owner: t.owner ? { id: t.owner.id, name: t.owner.name, specialtyLabel: craftSpecialtyLabel(t.owner.specialty) } : null,
      specialty: t.specialty ?? craftSpecialtyForStep(t.flowStep),
      client: eng?.clientOrg ?? null,
      service: eng?.service ?? null,
      engagementId: eng?.id ?? t.engagementId,
      deliverable: t.deliverable ? { id: t.deliverable.id, title: t.deliverable.title, status: t.deliverable.status } : null,
      blockedReason: t.blockedReason,
      waitingOn: t.dependsOn.map((id) => depTitles.get(id)).filter((d): d is { title: string; status: string } => !!d && d.status !== 'done').map((d) => d.title),
      cannotAssignTo: t.kind === 'qc' && latestUploader ? [latestUploader] : [],
      suggestion: this.suggest(t, members, cards),
      href: t.deliverable ? `/team/deliverables/${t.deliverable.id}` : '/team/tasks',
    };
  }

  /** Engagements of tasks that are not tied to a deliverable (ad-hoc and planning tasks). */
  private async engMap(rows: TaskRow[]): Promise<EngMap> {
    const ids = [...new Set(rows.filter((t) => !t.deliverable && t.engagementId).map((t) => t.engagementId!))];
    const engs = ids.length
      ? await this.prisma.engagement.findMany({ where: { id: { in: ids } }, select: { id: true, amId: true, clientOrg: { select: { id: true, name: true } }, service: { select: { id: true, name: true } } } })
      : [];
    return new Map(engs.map((e) => [e.id, e]));
  }

  private async depTitles(rows: TaskRow[]) {
    const ids = [...new Set(rows.flatMap((t) => t.dependsOn))];
    const deps = ids.length ? await this.prisma.task.findMany({ where: { id: { in: ids } }, select: { id: true, title: true, status: true } }) : [];
    return new Map(deps.map((d) => [d.id, { title: d.title, status: d.status }]));
  }

  /** v32: who each task may go to: Department Heads their team (or themselves); others the task department's head. */
  private async assignBlocks(me: Me, members: MemberRow[]) {
    const scope = await assignScope(this.prisma, me);
    const heads = scope.kind === 'heads' ? await this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null }, select: { id: true, headUserId: true } }) : [];
    const ok = (m: MemberRow, departmentId: string | null) =>
      scope.kind === 'self' ? m.id === me.id : scope.kind === 'team' ? m.id === me.id || (!!m.departmentId && scope.departmentIds.includes(m.departmentId)) : !!departmentId && heads.some((d) => d.id === departmentId && d.headUserId === m.id);
    return (t: CraftBoardTask, departmentId: string | null): CraftBoardTask => ({ ...t, cannotAssignTo: [...new Set([...t.cannotAssignTo, ...members.filter((m) => !ok(m, departmentId)).map((m) => m.id)])] });
  }

  private async assignableIds(me: Me, members: MemberRow[]) {
    const scope = await assignScope(this.prisma, me);
    if (scope.kind === 'self') return [me.id];
    if (scope.kind === 'team') return members.filter((m) => m.id === me.id || (!!m.departmentId && scope.departmentIds.includes(m.departmentId))).map((m) => m.id);
    const heads = await this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null, headUserId: { not: null } }, select: { headUserId: true } });
    return members.filter((m) => heads.some((d) => d.headUserId === m.id)).map((m) => m.id);
  }

  /** One task as the board shows it, with a fresh suggestion (used after every change). */
  private async oneBoardTask(me: Me, s: Scope, id: string): Promise<CraftBoardTask> {
    const t = await this.scopedTask(me, s, id);
    const now = new Date();
    const members = await this.members(me, s, t.ownerId ? [t.ownerId] : []);
    const open = await this.prisma.task.findMany({ where: { orgId: me.orgId, ownerId: { in: members.map((m) => m.id) }, status: { in: [...OPEN] } }, select: { ownerId: true, status: true, deadline: true } });
    const leave = await this.leaveDays(me.orgId, members.map((m) => m.id), weekStart(now), new Date(weekStart(now).getTime() + 7 * DAY));
    const cards = new Map(this.memberCards(members, open, leave, now).map((c) => [c.id, c]));
    const blocks = await this.assignBlocks(me, members);
    return blocks(this.boardTask(t, now, await this.depTitles([t]), members, cards, await this.engMap([t])), t.departmentId ?? t.deliverable?.departmentId ?? null);
  }

  // -------------------------------------------------------------------------
  // The workspace

  async view(me: Me): Promise<CraftManagerView> {
    const s = await this.scope(me);
    const now = new Date();
    const today = istDay(now);
    const where = this.taskWhere(me, s);

    const rows = await this.prisma.task.findMany({
      where: { AND: [where, { status: { in: [...OPEN] } }] },
      select: taskSelect,
      orderBy: [{ deadline: 'asc' }, { sort: 'asc' }],
      take: 400,
    });
    const recentDone = await this.prisma.task.findMany({
      where: { AND: [where, { status: 'done', completedAt: { gte: new Date(now.getTime() - 60 * DAY) } }] },
      select: { ownerId: true, deadline: true, completedAt: true },
    });

    const members = await this.members(me, s, [...new Set(rows.map((t) => t.ownerId).filter((x): x is string => !!x))]);
    const memberIds = members.map((m) => m.id);
    const memberOpen = memberIds.length
      ? await this.prisma.task.findMany({ where: { orgId: me.orgId, ownerId: { in: memberIds }, status: { in: [...OPEN] } }, select: { ownerId: true, status: true, deadline: true } })
      : [];
    const horizonEnd = new Date(now.getTime() + 15 * DAY);
    const leave = await this.leaveDays(me.orgId, memberIds, weekStart(now), horizonEnd);
    const cardList = this.memberCards(members, memberOpen, leave, now);
    const cards = new Map(cardList.map((c) => [c.id, c]));
    const deps = await this.depTitles(rows);
    const engMap = await this.engMap(rows);
    const blocks = await this.assignBlocks(me, members);
    const board = rows
      .map((t) => blocks(this.boardTask(t, now, deps, members, cards, engMap), t.departmentId ?? t.deliverable?.departmentId ?? null))
      .sort((a, b) => Number(!!a.owner) - Number(!!b.owner) || priorityRank(a.priority) - priorityRank(b.priority) || (a.deadline ?? '9').localeCompare(b.deadline ?? '9'));

    // Clients
    const deptClientIds = [...new Set(board.map((t) => t.client?.id).filter((x): x is string => !!x))];
    const clients = await this.clientCards(me, s, deptClientIds, now);

    // Engagements and deliverables for the ad-hoc task form
    const engWhere: Prisma.EngagementWhereInput =
      s.kind === 'own_clients' ? { orgId: me.orgId, amId: me.id, deletedAt: null } : { orgId: me.orgId, deletedAt: null, clientOrgId: { in: clients.map((c) => c.id) } };
    const engs = await this.prisma.engagement.findMany({
      where: { ...engWhere, status: { in: LIVE } },
      include: { clientOrg: { select: { id: true, name: true } }, service: { select: { name: true } }, cycles: { include: { deliverables: { where: { status: { notIn: [...DONE_DELIVERABLE] as DeliverableStatus[] } }, select: { id: true, title: true } } } } },
      take: 60,
    });

    const filters = {
      clients: [...new Map(board.filter((b) => b.client).map((b) => [b.client!.id, b.client!])).values()].sort((a, b) => a.name.localeCompare(b.name)),
      services: [...new Map(board.filter((b) => b.service).map((b) => [b.service!.id, b.service!])).values()].sort((a, b) => a.name.localeCompare(b.name)),
      specialties: CRAFT_SPECIALTY_OPTIONS.filter((o) => o.id !== 'project_manager').map((o) => ({ id: o.id, label: o.label })),
    };

    const today_ = await this.today(me, s, board, clients, now);
    // On-time and output per person count all their work, not only this manager's clients.
    const memberDone = memberIds.length
      ? await this.prisma.task.findMany({ where: { orgId: me.orgId, ownerId: { in: memberIds }, status: 'done', completedAt: { gte: new Date(now.getTime() - 30 * DAY) } }, select: { ownerId: true, deadline: true, completedAt: true } })
      : [];
    const team = this.teamHeat(members, memberOpen, leave, memberDone, now);
    const qcRates = await this.qcRates(memberIds, now);
    for (const r of team.rows) r.qcFirstPassPct = qcRates.get(r.userId) ?? null;

    // KPIs (this 30 days vs the previous 30)
    const cur = recentDone.filter((t) => t.completedAt && t.completedAt.getTime() >= now.getTime() - 30 * DAY);
    const prev = recentDone.filter((t) => t.completedAt && t.completedAt.getTime() < now.getTime() - 30 * DAY);
    const onTime = (xs: typeof recentDone) => pct(xs.filter((t) => t.deadline && t.completedAt && t.completedAt <= t.deadline).length, xs.filter((t) => t.deadline).length);
    const unassigned = board.filter((b) => !b.owner).length;
    const overdue = board.filter((b) => b.overdue).length;
    const approvals = clients.reduce((n, c) => n + c.approvals.length, 0);
    const replies = today_.filter((t) => t.kind === 'client_reply').length;
    const kpis: CraftKpi[] = [
      { key: 'open', label: 'Open tasks', value: board.length, previous: null, format: 'int', hint: s.label },
      { key: 'unassigned', label: 'Unassigned', value: unassigned, previous: null, format: 'int', lowerIsBetter: true, hint: unassigned ? 'Drag them onto someone' : 'Everything has an owner' },
      { key: 'overdue', label: 'Overdue', value: overdue, previous: null, format: 'int', lowerIsBetter: true },
      { key: 'on_time', label: 'On-time (30 days)', value: onTime(cur) ?? 0, previous: onTime(prev), format: 'pct', hint: `${cur.length} tasks finished` },
      { key: 'approvals', label: 'Waiting on clients', value: approvals, previous: null, format: 'int', lowerIsBetter: true, hint: replies ? `${plural(replies, 'message')} to answer` : 'No unanswered messages' },
    ];

    const insights: string[] = [];
    const over = cardList.filter((c) => c.loadPct > 100 && !c.onLeaveToday);
    const light = cardList.filter((c) => c.loadPct < 50 && !c.onLeaveToday && c.specialty);
    if (over.length) insights.push(`${over.map((c) => c.name.split(' ')[0]).join(', ')} ${over.length === 1 ? 'is' : 'are'} over capacity this week${light.length ? ` while ${light.slice(0, 3).map((c) => c.name.split(' ')[0]).join(', ')} ${light.length === 1 ? 'has' : 'have'} room` : ''}. Move work before it slips.`);
    if (unassigned) insights.push(`${plural(unassigned, 'task')} ${unassigned === 1 ? 'has' : 'have'} no owner. The board suggests the best person for each.`);
    const slow = clients.flatMap((c) => c.approvals.map((a) => ({ ...a, client: c.name }))).filter((a) => a.daysWaiting >= 3);
    if (slow.length) insights.push(`${plural(slow.length, 'approval')} ${slow.length === 1 ? 'has' : 'have'} waited 3+ days on the client (longest: ${slow.sort((a, b) => b.daysWaiting - a.daysWaiting)[0].client}). A nudge usually unblocks it.`);
    const red = clients.filter((c) => c.health === 'red');
    if (red.length) insights.push(`${red.map((c) => c.name).join(', ')} ${red.length === 1 ? 'is' : 'are'} marked red. Log a call this week.`);
    if (!insights.length) insights.push('Workload is balanced and nothing is waiting on you. A good day to plan next week.');

    const self = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, include: { department: { select: { name: true } } } });
    return {
      person: { id: me.id, name: me.name, specialty: self.specialty, specialtyLabel: craftSpecialtyLabel(self.specialty) || 'Manager', department: self.department?.name ?? null, baseRole: me.roles[0] ?? null },
      scope: s.kind,
      scopeLabel: s.label,
      strip: await this.strip(me, now, today),
      kpis,
      insights,
      board,
      members: cardList.sort((a, b) => a.loadPct - b.loadPct),
      // v32: who new work may go to (Department Heads: their team; others: Department Heads).
      assignableIds: await this.assignableIds(me, members),
      filters,
      engagements: engs.map((e) => ({ id: e.id, label: `${e.clientOrg.name} · ${e.service.name}`, clientId: e.clientOrg.id })),
      deliverables: engs.flatMap((e) => e.cycles.flatMap((c) => c.deliverables.map((d) => ({ id: d.id, title: d.title, engagementId: e.id })))),
      clients,
      today: today_,
      team,
    };
  }

  private async strip(me: Me, now: Date, today: string): Promise<CraftStrip> {
    const date = dateOnly(today);
    const [att, eod, mine] = await Promise.all([
      this.prisma.attendance.findUnique({ where: { userId_date: { userId: me.id, date } } }),
      this.prisma.eODReport.findUnique({ where: { userId_date: { userId: me.id, date } } }),
      this.prisma.task.findMany({ where: { orgId: me.orgId, ownerId: me.id, status: { in: [...OPEN] } }, select: { status: true, deadline: true } }),
    ]);
    return {
      checkIn: att?.checkIn?.toISOString() ?? null,
      checkOut: att?.checkOut?.toISOString() ?? null,
      ...checkWindow(att, today, await loadWorkCalendar(this.settings, me.orgId), await leaveOn(this.prisma, me.id, today)),
      overdue: mine.filter((t) => t.status !== 'blocked' && t.deadline && t.deadline < now).length,
      dueToday: mine.filter((t) => t.status !== 'blocked' && t.deadline && t.deadline >= now && istDay(t.deadline) === today).length,
      blocked: mine.filter((t) => t.status === 'blocked').length,
      open: mine.length,
      eodSubmitted: !!eod,
    };
  }

  private async clientCards(me: Me, s: Scope, deptClientIds: string[], now: Date): Promise<CraftClientCard[]> {
    const engFilter: Prisma.EngagementWhereInput = s.kind === 'own_clients' ? { amId: me.id, deletedAt: null } : { deletedAt: null };
    const orgs = await this.prisma.clientOrg.findMany({
      where: this.clientWhere(me, s, deptClientIds),
      include: {
        am: { select: { name: true } },
        engagements: {
          where: { ...engFilter, status: { in: LIVE } },
          include: {
            service: { select: { name: true } },
            cycles: {
              orderBy: { period: 'desc' },
              take: 2,
              include: {
                deliverables: {
                  select: { id: true, title: true, status: true, dueAt: true, versions: { orderBy: { number: 'desc' }, take: 1, select: { sentToClientAt: true, createdAt: true } } },
                },
              },
            },
            requests: { where: { status: { notIn: ['done', 'declined'] } }, orderBy: { createdAt: 'desc' }, take: 10 },
          },
        },
        invoices: { where: { status: { in: ['issued', 'partially_paid', 'overdue'] }, dueDate: { lt: now } }, orderBy: { dueDate: 'asc' } },
        threads: { select: { id: true, type: true } },
      },
      orderBy: { name: 'asc' },
      take: 24,
    });
    const ids = orgs.map((o) => o.id);
    const threadIds = orgs.flatMap((o) => o.threads.map((t) => t.id));
    const [lastMsgs, notes, nudges] = await Promise.all([
      threadIds.length
        ? this.prisma.message.findMany({ where: { threadId: { in: threadIds }, isInternal: false }, orderBy: { createdAt: 'desc' }, take: 300, select: { threadId: true, authorId: true, createdAt: true, body: true } })
        : [],
      ids.length ? this.prisma.craftClientNote.findMany({ where: { orgId: me.orgId, clientOrgId: { in: ids } }, orderBy: { createdAt: 'desc' }, take: 200 }) : [],
      this.prisma.auditEvent.findMany({ where: { orgId: me.orgId, action: 'craft.client_nudged', at: { gte: new Date(now.getTime() - 30 * DAY) } }, select: { entityId: true, at: true }, orderBy: { at: 'desc' } }),
    ]);
    const authorIds = [...new Set([...lastMsgs.map((m) => m.authorId), ...notes.map((n) => n.authorId)])];
    const authors = new Map(
      (authorIds.length ? await this.prisma.user.findMany({ where: { id: { in: authorIds } }, select: { id: true, name: true, type: true } }) : []).map((u) => [u.id, u]),
    );
    const lastNudge = new Map<string, Date>();
    for (const n of nudges) if (!lastNudge.has(n.entityId)) lastNudge.set(n.entityId, n.at);

    return orgs.map((o) => {
      const tIds = new Set(o.threads.map((t) => t.id));
      const msg = lastMsgs.find((m) => tIds.has(m.threadId));
      const author = msg ? authors.get(msg.authorId) : undefined;
      const allDels = o.engagements.flatMap((e) => e.cycles.flatMap((c) => c.deliverables));
      const approvals = allDels
        .filter((d) => d.status === 'ready_for_client')
        .map((d) => {
          const sent = d.versions[0]?.sentToClientAt ?? d.versions[0]?.createdAt ?? now;
          const nudged = lastNudge.get(d.id) ?? null;
          return {
            deliverableId: d.id,
            title: d.title,
            sentAt: sent.toISOString(),
            daysWaiting: Math.max(0, Math.floor((now.getTime() - sent.getTime()) / DAY)),
            canNudge: !nudged || now.getTime() - nudged.getTime() >= DAY,
            lastNudgeAt: nudged?.toISOString() ?? null,
            href: `/team/deliverables/${d.id}`,
          };
        })
        .sort((a, b) => b.daysWaiting - a.daysWaiting);
      const nextDue = allDels
        .filter((d) => d.dueAt && !DONE_DELIVERABLE.includes(d.status) && d.status !== 'ready_for_client')
        .sort((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime())
        .slice(0, 4)
        .map((d) => ({ deliverableId: d.id, title: d.title, due: d.dueAt!.toISOString(), status: d.status, statusLabel: deliverableStatusLabels[d.status as DeliverableStatus] ?? d.status, href: `/team/deliverables/${d.id}` }));
      return {
        id: o.id,
        name: o.name,
        health: o.health,
        am: o.am?.name ?? null,
        threadId: o.threads.find((t) => t.type === 'client_am')?.id ?? o.threads[0]?.id ?? null,
        services: o.engagements.map((e) => {
          const dels = e.cycles[0]?.deliverables ?? [];
          const next = dels.filter((d) => !DONE_DELIVERABLE.includes(d.status)).sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity))[0];
          return {
            engagementId: e.id,
            service: e.service.name,
            gate: e.currentGate,
            status: e.status,
            milestone: next ? `${next.title}${next.dueAt ? ` · due ${shortDay(next.dueAt)}` : ''}` : dels.length ? 'All delivered this cycle' : null,
            progress: { done: dels.filter((d) => DONE_DELIVERABLE.includes(d.status)).length, total: dels.length },
            href: `/team/projects/${e.id}`,
          };
        }),
        approvals,
        requests: o.engagements
          .flatMap((e) => e.requests)
          .map((r) => {
            const replied = !!r.firstReplyAt;
            return {
              id: r.id,
              type: r.type,
              description: r.description,
              status: r.status,
              slaDue: r.slaDue?.toISOString() ?? null,
              replied,
              overdue: !replied && !!r.slaDue && r.slaDue < now,
              hoursLeft: !replied && r.slaDue ? Math.round((r.slaDue.getTime() - now.getTime()) / 3_600_000) : null,
              href: `/team/requests/${r.id}`,
            };
          })
          .sort((a, b) => Number(a.replied) - Number(b.replied) || (a.hoursLeft ?? 1e9) - (b.hoursLeft ?? 1e9)),
        overdueInvoices: o.invoices.map((i) => ({ id: i.id, number: i.number, totalPaise: i.totalPaise, dueDate: i.dueDate.toISOString(), daysOverdue: Math.floor((now.getTime() - i.dueDate.getTime()) / DAY), href: `/team/clients/${o.id}` })),
        nextDue,
        lastContact: msg ? { at: msg.createdAt.toISOString(), by: author?.type === 'client' ? 'client' : 'team', author: author?.name ?? 'Someone' } : null,
        notes: notes
          .filter((n) => n.clientOrgId === o.id)
          .slice(0, 5)
          .map((n) => ({ id: n.id, kind: n.kind as CraftNoteKind, body: n.body, author: authors.get(n.authorId)?.name ?? 'Someone', at: n.createdAt.toISOString(), remindAt: n.remindAt?.toISOString() ?? null })),
        href: `/team/clients/${o.id}`,
      };
    });
  }

  /** Team blockers, client messages waiting for a reply, approvals to chase and today's reminders, most urgent first. */
  private async today(me: Me, s: Scope, board: CraftBoardTask[], clients: CraftClientCard[], now: Date): Promise<CraftTodayItem[]> {
    const items: (CraftTodayItem & { rank: number })[] = [];
    for (const b of board) {
      if (b.status === 'blocked')
        items.push({ id: `b-${b.id}`, kind: 'blocked', rank: 1, title: b.title, detail: `Blocked${b.owner ? ` · ${b.owner.name}` : ''}${b.blockedReason ? `: ${b.blockedReason}` : ''}`, href: b.href, at: b.deadline, client: b.client?.name ?? null, taskId: b.id });
      else if (b.overdue)
        items.push({ id: `o-${b.id}`, kind: 'overdue', rank: 2, title: b.title, detail: `Overdue since ${shortDay(new Date(b.deadline!))}${b.owner ? ` · ${b.owner.name}` : ' · no owner'}`, href: b.href, at: b.deadline, client: b.client?.name ?? null, taskId: b.id });
      else if (!b.owner && b.deadline && new Date(b.deadline).getTime() - now.getTime() < 3 * DAY)
        items.push({ id: `u-${b.id}`, kind: 'unassigned', rank: 3, title: b.title, detail: `No owner, due ${shortDay(new Date(b.deadline))}${b.suggestion ? ` · suggest ${b.suggestion.name}` : ''}`, href: b.href, at: b.deadline, client: b.client?.name ?? null, taskId: b.id });
    }
    const seen = new Set<string>();
    for (const b of board) {
      if (b.deliverable?.status === 'qc_failed' && !seen.has(b.deliverable.id)) {
        seen.add(b.deliverable.id);
        items.push({ id: `q-${b.deliverable.id}`, kind: 'qc_failed', rank: 2, title: b.deliverable.title, detail: `Failed QC${b.owner ? ` · back with ${b.owner.name}` : ''}`, href: b.href, at: null, client: b.client?.name ?? null, deliverableId: b.deliverable.id });
      }
    }
    // Client messages where the client spoke last
    const threadIds = clients.map((c) => c.threadId).filter((x): x is string => !!x);
    if (threadIds.length) {
      const msgs = await this.prisma.message.findMany({ where: { threadId: { in: threadIds }, isInternal: false }, orderBy: { createdAt: 'desc' }, take: 300, select: { threadId: true, authorId: true, createdAt: true, body: true } });
      const authors = new Map((await this.prisma.user.findMany({ where: { id: { in: [...new Set(msgs.map((m) => m.authorId))] } }, select: { id: true, name: true, type: true } })).map((u) => [u.id, u]));
      for (const c of clients) {
        const last = msgs.find((m) => m.threadId === c.threadId);
        const a = last ? authors.get(last.authorId) : undefined;
        if (last && a?.type === 'client') {
          const hrs = Math.round((now.getTime() - last.createdAt.getTime()) / 3_600_000);
          items.push({ id: `m-${c.id}`, kind: 'client_reply', rank: hrs >= 24 ? 1 : 2, title: `${a.name} is waiting for a reply`, detail: `"${last.body.slice(0, 90)}${last.body.length > 90 ? '…' : ''}" · ${hrs < 1 ? 'just now' : `${hrs}h ago`}`, href: `/team/messages/${c.threadId}`, at: last.createdAt.toISOString(), client: c.name });
        }
      }
    }
    for (const c of clients) {
      for (const r of c.requests.filter((r) => !r.replied))
        items.push({ id: `r-${r.id}`, kind: 'client_reply', rank: r.overdue ? 1 : 3, title: `${r.type.replace(/_/g, ' ')} request: ${r.description.slice(0, 70)}`, detail: r.overdue ? 'First reply is overdue' : r.hoursLeft !== null ? `Reply due in ${r.hoursLeft}h` : 'Waiting for a first reply', href: r.href, at: r.slaDue, client: c.name });
      for (const a of c.approvals.filter((a) => a.daysWaiting >= 2))
        items.push({ id: `a-${a.deliverableId}`, kind: 'approval', rank: a.daysWaiting >= 4 ? 2 : 3, title: a.title, detail: `Waiting on the client for ${plural(a.daysWaiting, 'day')}${a.canNudge ? '' : ' · nudged recently'}`, href: a.href, at: a.sentAt, client: c.name, deliverableId: a.deliverableId, canNudge: a.canNudge });
      for (const i of c.overdueInvoices) items.push({ id: `i-${i.id}`, kind: 'invoice', rank: 3, title: `Invoice ${i.number} overdue`, detail: `₹${Math.round(i.totalPaise / 100).toLocaleString('en-IN')} · ${plural(i.daysOverdue, 'day')} late`, href: i.href, at: i.dueDate, client: c.name });
    }
    const reminders = await this.prisma.craftClientNote.findMany({
      where: { orgId: me.orgId, authorId: me.id, remindAt: { gte: new Date(now.getTime() - 12 * 3_600_000), lt: new Date(now.getTime() + 36 * 3_600_000) } },
      orderBy: { remindAt: 'asc' },
    });
    const names = new Map(clients.map((c) => [c.id, c.name]));
    for (const r of reminders)
      items.push({ id: `n-${r.id}`, kind: 'reminder', rank: 1, title: r.kind === 'meeting' ? `Meeting: ${r.body.slice(0, 80)}` : r.body.slice(0, 90), detail: `Reminder ${r.remindAt!.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', hour: 'numeric', minute: '2-digit' })}`, href: `/team/clients/${r.clientOrgId}`, at: r.remindAt!.toISOString(), client: names.get(r.clientOrgId) ?? null });
    void s;
    return items
      .sort((a, b) => a.rank - b.rank || (a.at ?? '9').localeCompare(b.at ?? '9'))
      .slice(0, 30)
      .map(({ rank: _rank, ...rest }) => rest);
  }

  private teamHeat(members: MemberRow[], open: { ownerId: string | null; status: string; deadline: Date | null }[], leave: Map<string, Set<string>>, done: { ownerId: string | null; deadline: Date | null; completedAt: Date | null }[], now: Date) {
    const dates = Array.from({ length: 14 }, (_, i) => istDay(new Date(now.getTime() + i * DAY)));
    const fmt = new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', timeZone: 'Asia/Kolkata' });
    const labels = dates.map((d) => fmt.format(new Date(`${d}T12:00:00+05:30`)));
    const rows: CraftTeamRow[] = members.map((m) => {
      const off = leave.get(m.id) ?? new Set<string>();
      const heat = dates.map((d, i) => {
        if (off.has(d)) return null;
        const n = open.filter((t) => t.ownerId === m.id && t.deadline && (i === 0 ? istDay(t.deadline) <= d : istDay(t.deadline) === d)).length;
        return n * CRAFT_HOURS_PER_TASK;
      });
      const mine = done.filter((t) => t.ownerId === m.id && t.completedAt && t.completedAt.getTime() >= now.getTime() - 30 * DAY);
      return {
        userId: m.id,
        name: m.name,
        specialtyLabel: craftSpecialtyLabel(m.specialty) || (m.baseRole ?? '').replace(/_/g, ' '),
        heat,
        onTimePct: pct(mine.filter((t) => t.deadline && t.completedAt! <= t.deadline).length, mine.filter((t) => t.deadline).length),
        qcFirstPassPct: null,
        done30: mine.length,
        href: `/team/specialists/${m.id}`,
      };
    });
    return { days: labels, dates, rows };
  }

  /** Share of each maker's versions (last 60 days) that passed their first QC check. */
  private async qcRates(userIds: string[], now: Date) {
    if (!userIds.length) return new Map<string, number | null>();
    const versions = await this.prisma.version.findMany({
      where: { uploadedById: { in: userIds }, createdAt: { gte: new Date(now.getTime() - 60 * DAY) }, qcResults: { some: {} } },
      select: { uploadedById: true, qcResults: { orderBy: { createdAt: 'asc' }, take: 1, select: { result: true } } },
    });
    const map = new Map<string, number | null>();
    for (const id of userIds) {
      const mine = versions.filter((v) => v.uploadedById === id);
      map.set(id, pct(mine.filter((v) => v.qcResults[0]?.result === 'pass').length, mine.length));
    }
    return map;
  }

  // -------------------------------------------------------------------------
  // Actions

  async assign(me: Me, taskId: string, input: CraftAssignInput, ip?: string): Promise<CraftBoardTask> {
    const s = await this.scope(me);
    const t = await this.scopedTask(me, s, taskId);
    const u = await this.assignee(me, s, input.ownerId);
    this.checkAssignable(t, u);
    await assertAssignee(this.prisma, me, await assignScope(this.prisma, me), u.id, t.departmentId ?? t.deliverable?.departmentId ?? null);
    const deadline = parseDeadline(input.deadline);
    const data: Prisma.TaskUncheckedUpdateInput = { ownerId: u.id };
    if (deadline !== undefined) data.deadline = deadline;
    if (input.priority) data.priority = input.priority;
    await this.prisma.task.update({ where: { id: t.id }, data });
    await this.audit.log(me, t.ownerId ? 'task.reassigned' : 'task.assigned', 'Task', t.id, { ownerId: t.ownerId, deadline: t.deadline, priority: t.priority }, { ownerId: u.id, deadline: deadline ?? t.deadline, priority: input.priority ?? t.priority }, ip);
    await this.reassignEngine.record(me, 'task', [{ id: t.id, fromUserId: t.ownerId, toUserId: u.id }], t.ownerId ? 'priority_change' : 'new_task', input.note ?? 'Manager workspace');
    await this.notifyAssigned(me, [{ ...t, deadline: deadline === undefined ? t.deadline : deadline }], u, input.note);
    return this.oneBoardTask(me, s, t.id);
  }

  async bulkAssign(me: Me, input: CraftBulkAssignInput, ip?: string) {
    const s = await this.scope(me);
    const u = await this.assignee(me, s, input.ownerId);
    const ids = [...new Set(input.taskIds)];
    const tasks: TaskRow[] = [];
    for (const id of ids) {
      const t = await this.scopedTask(me, s, id);
      this.checkAssignable(t, u);
      await assertAssignee(this.prisma, me, await assignScope(this.prisma, me), u.id, t.departmentId ?? t.deliverable?.departmentId ?? null);
      tasks.push(t);
    }
    await this.prisma.task.updateMany({ where: { id: { in: tasks.map((t) => t.id) } }, data: { ownerId: u.id } });
    for (const t of tasks) await this.audit.log(me, t.ownerId ? 'task.reassigned' : 'task.assigned', 'Task', t.id, { ownerId: t.ownerId }, { ownerId: u.id, bulk: true }, ip);
    await this.reassignEngine.record(me, 'task', tasks.map((t) => ({ id: t.id, fromUserId: t.ownerId, toUserId: u.id })), 'priority_change', 'Manager workspace (bulk)');
    await this.notifyAssigned(me, tasks, u);
    return { ok: true as const, assigned: tasks.length };
  }

  private async notifyAssigned(me: Me, tasks: Pick<TaskRow, 'id' | 'title' | 'ownerId' | 'deadline' | 'deliverable'>[], u: MemberRow, note?: string) {
    if (u.id !== me.id) {
      const one = tasks.length === 1 ? tasks[0] : null;
      await this.notifications.notify(me.orgId, [u.id], {
        kind: 'task_assigned',
        title: one ? `${me.name} assigned you: ${one.title}` : `${me.name} assigned you ${tasks.length} tasks`,
        body: [one?.deliverable ? one.deliverable.cycle.engagement.clientOrg.name : null, one?.deadline ? `Due ${shortDay(one.deadline)}` : null, note].filter(Boolean).join(' · ') || undefined,
        link: one?.deliverable ? `/team/deliverables/${one.deliverable.id}` : '/team/tasks',
      });
    }
    const previous = [...new Set(tasks.map((t) => t.ownerId).filter((x): x is string => !!x && x !== u.id && x !== me.id))];
    for (const p of previous) {
      const moved = tasks.filter((t) => t.ownerId === p);
      await this.notifications.notify(me.orgId, [p], {
        kind: 'task_assigned',
        title: moved.length === 1 ? `${moved[0].title} moved to ${u.name}` : `${moved.length} of your tasks moved to ${u.name}`,
        body: `Reassigned by ${me.name}.`,
        link: '/team/tasks',
      });
    }
  }

  async updateTask(me: Me, taskId: string, input: CraftTaskUpdateInput, ip?: string): Promise<CraftBoardTask> {
    const s = await this.scope(me);
    const t = await this.scopedTask(me, s, taskId);
    if (!isOpen(t.status)) throw new BadRequestException('Only open tasks can be changed');
    const deadline = parseDeadline(input.deadline);
    const data: Prisma.TaskUncheckedUpdateInput = {};
    if (deadline !== undefined) data.deadline = deadline;
    if (input.priority) data.priority = input.priority;
    await this.prisma.task.update({ where: { id: t.id }, data });
    await this.audit.log(me, 'task.updated', 'Task', t.id, { deadline: t.deadline, priority: t.priority }, { deadline: deadline ?? t.deadline, priority: input.priority ?? t.priority }, ip);
    if (t.ownerId && t.ownerId !== me.id) {
      const what = [deadline !== undefined ? (deadline ? `due ${shortDay(deadline)}` : 'no deadline') : null, input.priority ? `${input.priority} priority` : null].filter(Boolean).join(', ');
      await this.notifications.notify(me.orgId, [t.ownerId], { kind: 'task_updated', title: `${t.title}: now ${what}`, body: `Changed by ${me.name}.`, link: t.deliverable ? `/team/deliverables/${t.deliverable.id}` : '/team/tasks', critical: input.priority === 'urgent' });
    }
    return this.oneBoardTask(me, s, t.id);
  }

  async createTask(me: Me, input: CraftAdhocTaskInput & { priority: CraftPriority }, ip?: string): Promise<CraftBoardTask> {
    const s = await this.scope(me);
    let engagementId = input.engagementId ?? null;
    let departmentId: string | null = null;
    if (input.deliverableId) {
      const d = await this.prisma.deliverable.findFirst({ where: { id: input.deliverableId, orgId: me.orgId }, include: { cycle: { select: { engagementId: true } } } });
      if (!d) throw new NotFoundException('Deliverable not found');
      if (engagementId && engagementId !== d.cycle.engagementId) throw new BadRequestException('That deliverable belongs to a different engagement');
      engagementId = d.cycle.engagementId;
      departmentId = d.departmentId;
    }
    if (engagementId) {
      const e = await this.prisma.engagement.findFirst({ where: { id: engagementId, orgId: me.orgId, deletedAt: null } });
      if (!e) throw new NotFoundException('Engagement not found');
      if (s.kind === 'own_clients' && e.amId !== me.id) throw new ForbiddenException("You can only add tasks to your own clients' work");
    } else if (s.kind === 'own_clients') {
      throw new BadRequestException('Pick which client engagement this task is for');
    }
    if (s.kind === 'department') departmentId = s.departmentId;
    else if (!departmentId && input.specialty) {
      const def = CRAFT_SPECIALTY_OPTIONS.find((o) => o.id === input.specialty);
      if (def) departmentId = (await this.prisma.department.findFirst({ where: { orgId: me.orgId, name: def.department, deletedAt: null }, select: { id: true } }))?.id ?? null;
    }
    let owner: MemberRow | null = null;
    if (input.ownerId) owner = await this.assignee(me, s, input.ownerId);
    if (owner) await assertAssignee(this.prisma, me, await assignScope(this.prisma, me), owner.id, departmentId);
    const deadline = parseDeadline(input.deadline) ?? null;
    const created = await this.prisma.task.create({
      data: {
        orgId: me.orgId,
        title: input.title,
        engagementId,
        deliverableId: input.deliverableId ?? null,
        ownerId: owner?.id ?? null,
        departmentId,
        deadline,
        priority: input.priority,
        specialty: input.specialty ?? null,
        kind: 'work',
        status: 'todo',
        sort: 900,
      },
      select: taskSelect,
    });
    await this.audit.log(me, 'task.created', 'Task', created.id, undefined, { title: input.title, ownerId: owner?.id ?? null, engagementId, deliverableId: input.deliverableId ?? null, specialty: input.specialty ?? null, deadline, priority: input.priority, adhoc: true }, ip);
    if (owner) await this.notifyAssigned(me, [{ ...created, ownerId: null }], owner);
    return this.oneBoardTask(me, s, created.id);
  }

  async addClientNote(me: Me, clientOrgId: string, input: CraftClientNoteInput, ip?: string) {
    const s = await this.scope(me);
    const client = await this.prisma.clientOrg.findFirst({ where: { id: clientOrgId, orgId: me.orgId, deletedAt: null }, include: { engagements: { select: { amId: true, id: true } } } });
    if (!client) throw new NotFoundException('Client not found');
    if (s.kind === 'own_clients' && client.amUserId !== me.id && !client.engagements.some((e) => e.amId === me.id)) throw new ForbiddenException("That is another manager's client");
    if (s.kind === 'department') {
      const touches = await this.prisma.task.count({ where: { AND: [this.taskWhere(me, s), { deliverable: { cycle: { engagement: { clientOrgId } } } }] } });
      if (!touches) throw new ForbiddenException('Your department does no work for that client');
    }
    const remindAt = parseDeadline(input.remindAt) ?? null;
    const n = await this.prisma.craftClientNote.create({ data: { orgId: me.orgId, clientOrgId, authorId: me.id, kind: input.kind, body: input.body, remindAt } });
    await this.audit.log(me, `client.${input.kind === 'call' ? 'call_logged' : input.kind === 'meeting' ? 'meeting_scheduled' : 'note_added'}`, 'ClientOrg', clientOrgId, undefined, { noteId: n.id, remindAt }, ip);
    return { id: n.id, kind: n.kind as CraftNoteKind, body: n.body, author: me.name, at: n.createdAt.toISOString(), remindAt: n.remindAt?.toISOString() ?? null };
  }

  // -------------------------------------------------------------------------
  // Used by the specialist dashboards: a CM may open the dashboard of anyone working on their clients.

  async worksForMe(me: Me, userId: string): Promise<boolean> {
    if (!me.roles.includes('account_manager') && me.specialty !== 'project_manager') return false;
    const engs = await this.prisma.engagement.findMany({ where: { orgId: me.orgId, amId: me.id }, select: { id: true } });
    const ids = engs.map((e) => e.id);
    if (!ids.length) return false;
    const n = await this.prisma.task.count({ where: { orgId: me.orgId, ownerId: userId, OR: [{ engagementId: { in: ids } }, { deliverable: { cycle: { engagementId: { in: ids } } } }] } });
    return n > 0;
  }
}
