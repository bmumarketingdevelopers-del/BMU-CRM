import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  GATES,
  LEAVE_TYPES,
  istDate,
  normaliseIdentifier,
  type CalendarItem,
  type CalendarView,
  type TeamCapacityPerson,
  type TeamCapacityView,
  type Client360,
  type GateTrack,
  type LeaveRequestInput,
  type LeaveRequestView,
  type LeaveType,
  type Me,
  type MyProfile,
  type SopDetail,
  type SopRow,
  type UpdateMe,
} from '@bmu/shared';
import type { Prisma, TaskStatus } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { applyNotificationTemplate } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { AWAY_LEAVE, loadLeaveRouting, paidAccrued, splitPaid } from '../admin-org/leave-flow.js';
import { assertStaff, canSeeBilling, currentWeek, dayOf, dbDate, eachDay, excerpt, hasRole, isUniqueError, isWorkDay, monthRange, workingDaysIn } from './util.js';

const OPEN: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'];
const APPROVED_DELIVERABLE = ['approved', 'scheduled', 'published'] as const;
const INACTIVE_ENGAGEMENT = ['delivered', 'closed', 'paused'];
const OPEN_REQUEST = ['received', 'scope_check', 'in_scope', 'quoted', 'approved', 'paid', 'in_progress', 'rescheduled'] as const;
/** Capacity estimate: each open task due this week ≈ 4 hours, against 48 productive hours a week. */
const HOURS_PER_TASK = 4;
const KNOWN_HOLIDAYS: Record<string, string> = {
  '01-26': 'Republic Day',
  '05-01': 'Labour Day',
  '08-15': 'Independence Day',
  '10-02': 'Gandhi Jayanti',
  '11-01': 'Karnataka Rajyotsava',
  '12-25': 'Christmas',
};
const WEEK_HOURS = 48;

export const trackFor = (currentGate: string, status?: string): GateTrack => {
  if (status === 'delivered' || status === 'closed') return Object.fromEntries(GATES.map((g) => [g.id, 'passed'])) as GateTrack;
  const idx = GATES.findIndex((g) => g.id === currentGate);
  return Object.fromEntries(GATES.map((g, i) => [g.id, i < idx ? 'passed' : i === idx ? 'open' : 'locked'])) as GateTrack;
};

const taskHref = (t: { deliverableId: string | null; engagementId: string | null }) =>
  t.deliverableId ? `/team/deliverables/${t.deliverableId}` : t.engagementId ? `/team/projects/${t.engagementId}` : null;

@Injectable()
export class TeamWorkspaceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
  ) {}

  async holidays(orgId: string) {
    // Older settings stored bare dates; borrow the default names where we know them.
    return (await this.settings.get(orgId, 'holidays')).list.map((h) => ({
      date: h.date,
      name: h.name === 'Holiday' ? (KNOWN_HOLIDAYS[h.date.slice(5)] ?? h.name) : h.name,
    }));
  }

  /** Working weekdays from Command Centre → Holidays & Working Hours (0 = Sunday). */
  private async workDays(orgId: string) {
    return (await this.settings.get(orgId, 'workingHours')).days;
  }

  // -------------------------------------------------------------------------
  // Client 360

  async client360(me: Me, id: string): Promise<Client360> {
    assertStaff(me);
    const seeAll = hasRole(me, 'founder', 'admin', 'am_lead');
    if (!seeAll && !hasRole(me, 'account_manager')) throw new ForbiddenException("You don't have access to Client 360");
    const c = await this.prisma.clientOrg.findFirst({
      where: { id, orgId: me.orgId, deletedAt: null },
      include: {
        am: { select: { id: true, name: true, email: true } },
        users: { include: { user: { select: { id: true, name: true, email: true, status: true } } } },
        engagements: {
          where: { deletedAt: null },
          include: { service: true, cycles: { include: { deliverables: true, plans: { select: { id: true } }, requirements: { select: { id: true } } } } },
          orderBy: { createdAt: 'asc' },
        },
      },
    });
    if (!c) throw new NotFoundException('Client not found');
    // v11 clients: the previous CM keeps read access for 7 days after a reassignment.
    if (!seeAll && c.amUserId !== me.id && !(await this.prisma.assignment.findFirst({ where: { orgId: me.orgId, targetType: 'client_am', targetId: c.id, fromUserId: me.id, readAccessUntil: { gt: new Date() } }, select: { id: true } }))) throw new ForbiddenException('This client belongs to another Client Manager');

    const engagementIds = c.engagements.map((e) => e.id);
    const cycles = c.engagements.flatMap((e) => e.cycles.map((cy) => ({ ...cy, serviceName: e.service.name })));
    const deliverables = cycles.flatMap((cy) => cy.deliverables.map((d) => ({ ...d, serviceName: cy.serviceName })));
    const billing = canSeeBilling(me);
    const now = new Date();

    const [requests, openRequests, invoices, messages, lastClientMessage, files] = await Promise.all([
      this.prisma.request.findMany({ where: { engagementId: { in: engagementIds } }, orderBy: { createdAt: 'desc' }, take: 8 }),
      this.prisma.request.count({ where: { engagementId: { in: engagementIds }, status: { in: [...OPEN_REQUEST] } } }),
      billing ? this.prisma.invoice.findMany({ where: { clientOrgId: c.id }, include: { payments: true }, orderBy: { createdAt: 'desc' } }) : Promise.resolve(null),
      this.prisma.message.findMany({ where: { thread: { clientOrgId: c.id } }, orderBy: { createdAt: 'desc' }, take: 6 }),
      this.prisma.message.findFirst({ where: { thread: { clientOrgId: c.id }, isInternal: false }, orderBy: { createdAt: 'desc' } }),
      this.prisma.file.findMany({ where: { clientOrgId: c.id }, orderBy: { createdAt: 'desc' }, take: 10 }),
    ]);

    const entityIds = [
      c.id,
      ...engagementIds,
      ...cycles.map((cy) => cy.id),
      ...deliverables.map((d) => d.id),
      ...cycles.flatMap((cy) => [...cy.plans.map((p) => p.id), ...cy.requirements.map((r) => r.id)]),
      ...(await this.prisma.request.findMany({ where: { engagementId: { in: engagementIds } }, select: { id: true } })).map((r) => r.id),
      ...(invoices ?? []).map((i) => i.id),
    ];
    const activity = await this.prisma.auditEvent.findMany({ where: { orgId: me.orgId, entityId: { in: entityIds } }, orderBy: { at: 'desc' }, take: 25 });
    const people = await this.prisma.user.findMany({
      where: { id: { in: [...new Set([...activity.map((a) => a.actorId), ...messages.map((m) => m.authorId)].filter((x): x is string => !!x))] } },
      select: { id: true, name: true, type: true },
    });
    const person = (id: string | null) => people.find((p) => p.id === id);

    const outstanding = (invoices ?? [])
      .filter((i) => ['issued', 'partially_paid', 'overdue'].includes(i.status))
      .reduce((s, i) => s + i.totalPaise - i.payments.reduce((p, x) => p + x.amountPaise, 0), 0);

    return {
      client: { id: c.id, name: c.name, industry: c.industry, health: c.health, since: (c.tenureStart ?? c.createdAt).toISOString(), am: c.am },
      stats: {
        activeServices: c.engagements.filter((e) => !INACTIVE_ENGAGEMENT.includes(e.status)).length,
        openRequests,
        draftsWaiting: deliverables.filter((d) => d.status === 'ready_for_client').length,
        outstandingPaise: billing ? outstanding : null,
        lastContactAt: lastClientMessage?.createdAt.toISOString() ?? null,
      },
      services: c.engagements.map((e) => {
        const ds = e.cycles.flatMap((cy) => cy.deliverables);
        return {
          id: e.id,
          serviceName: e.service.name,
          tier: e.tier,
          billingType: e.billingType,
          status: e.status,
          currentGate: e.currentGate,
          track: trackFor(e.currentGate, e.status),
          approved: ds.filter((d) => (APPROVED_DELIVERABLE as readonly string[]).includes(d.status)).length,
          total: ds.length,
        };
      }),
      deliverables: deliverables
        .filter((d) => !(APPROVED_DELIVERABLE as readonly string[]).includes(d.status))
        .sort((a, b) => (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity))
        .slice(0, 12)
        .map((d) => ({ id: d.id, title: d.title, status: d.status, dueAt: d.dueAt?.toISOString() ?? null, serviceName: d.serviceName, overdue: !!d.dueAt && d.dueAt < now })),
      requests: requests.map((r) => ({ id: r.id, type: r.type, description: r.description, status: r.status, createdAt: r.createdAt.toISOString() })),
      invoices: invoices
        ? {
            outstandingPaise: outstanding,
            paidPaise: invoices.reduce((s, i) => s + i.payments.reduce((p, x) => p + x.amountPaise, 0), 0),
            recent: invoices.slice(0, 5).map((i) => ({
              id: i.id,
              number: i.number,
              status: i.status,
              totalPaise: i.totalPaise,
              paidPaise: i.payments.reduce((p, x) => p + x.amountPaise, 0),
              dueDate: i.dueDate.toISOString(),
            })),
          }
        : null,
      messages: messages.map((m) => ({
        id: m.id,
        threadId: m.threadId,
        author: person(m.authorId)?.name ?? 'Someone',
        fromClient: person(m.authorId)?.type === 'client',
        body: m.body,
        internal: m.isInternal,
        at: m.createdAt.toISOString(),
      })),
      files: files.map((f) => ({ id: f.id, name: f.name ?? 'File', kind: f.kind, url: f.kind === 'link' ? f.path : `/api/files/${f.id}`, at: f.createdAt.toISOString() })),
      users: c.users.map((u) => ({ id: u.user.id, name: u.user.name, email: u.user.email, role: u.clientRole, status: u.user.status })),
      activity: activity.map((a) => ({ id: a.id, action: a.action, entity: a.entity, actor: person(a.actorId)?.name ?? null, at: a.at.toISOString() })),
    };
  }

  // -------------------------------------------------------------------------
  // Who "my team" is (calendar and capacity)

  private async peopleInScope(me: Me) {
    const self = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, include: { department: true, team: true } });
    const base: Prisma.UserWhereInput = { orgId: me.orgId, type: 'staff', deletedAt: null, status: { not: 'suspended' } };
    let scope: TeamCapacityView['scope'] = 'team';
    let label = self.team ? `Team ${self.team.name}` : 'Just you';
    let where: Prisma.UserWhereInput;
    if (hasRole(me, 'founder', 'admin')) {
      scope = 'all';
      label = 'Everyone';
      where = base;
    } else if (hasRole(me, 'department_head', 'am_lead') && self.departmentId) {
      scope = 'department';
      label = self.department!.name;
      where = { ...base, departmentId: self.departmentId };
    } else if (self.teamId) {
      where = { ...base, teamId: self.teamId };
    } else {
      where = { ...base, id: me.id };
    }
    const users = await this.prisma.user.findMany({ where, include: { department: { select: { name: true } } }, orderBy: { name: 'asc' } });
    return { scope, label, users, self };
  }

  // -------------------------------------------------------------------------
  // Calendar

  async calendar(me: Me, month: string | undefined, view: 'mine' | 'team'): Promise<CalendarView> {
    assertStaff(me);
    const range = monthRange(month);
    const { scope, users } = view === 'team' ? await this.peopleInScope(me) : { scope: 'team' as const, users: [] };
    const all = view === 'team' && scope === 'all';
    const ids = view === 'mine' ? [me.id] : users.map((u) => u.id);
    const within = { gte: range.start, lt: range.end };
    const now = new Date();

    const ownerFilter: Prisma.TaskWhereInput = all ? {} : { ownerId: { in: ids } };
    const deliverableFilter: Prisma.DeliverableWhereInput = all ? {} : { OR: [{ tasks: { some: { ownerId: { in: ids } } } }, { cycle: { engagement: { amId: { in: ids } } } }] };
    const cycleFilter: Prisma.CycleWhereInput = all ? {} : { OR: [{ engagement: { amId: { in: ids } } }, { deliverables: { some: { tasks: { some: { ownerId: { in: ids } } } } } }] };

    const [tasks, deliverables, cycles, leave, holidays] = await Promise.all([
      this.prisma.task.findMany({
        where: { orgId: me.orgId, deadline: within, status: { not: 'cancelled' }, ...ownerFilter },
        include: { owner: { select: { name: true } }, deliverable: { include: { cycle: { include: { engagement: { include: { clientOrg: { select: { name: true } } } } } } } } },
        orderBy: { deadline: 'asc' },
        take: 400,
      }),
      this.prisma.deliverable.findMany({
        where: { orgId: me.orgId, dueAt: within, ...deliverableFilter },
        include: { cycle: { include: { engagement: { include: { clientOrg: { select: { name: true } }, service: { select: { name: true } } } } } } },
        take: 300,
      }),
      this.prisma.cycle.findMany({
        where: { orgId: me.orgId, firstDraftDue: within, ...cycleFilter },
        include: { engagement: { include: { clientOrg: { select: { name: true } }, service: { select: { name: true } } } } },
      }),
      this.prisma.leaveRequest.findMany({
        where: { orgId: me.orgId, status: 'approved', ...AWAY_LEAVE, from: { lte: dbDate(range.lastDay) }, to: { gte: dbDate(range.firstDay) }, ...(all ? {} : { userId: { in: ids } }) },
      }),
      this.holidays(me.orgId),
    ]);
    const leaveNames = await this.prisma.user.findMany({ where: { id: { in: leave.map((l) => l.userId) } }, select: { id: true, name: true } });
    const holidayDates = holidays.map((h) => h.date);
    const workDays = await this.workDays(me.orgId);

    const items: CalendarItem[] = [];
    for (const t of tasks) {
      const done = t.status === 'done';
      items.push({
        id: `t-${t.id}`,
        date: istDate(t.deadline!),
        kind: 'task',
        title: t.title,
        sub: [t.deliverable?.cycle.engagement.clientOrg.name, view === 'team' ? t.owner?.name ?? 'Unassigned' : null].filter(Boolean).join(' · ') || undefined,
        href: taskHref(t) ?? undefined,
        done,
        overdue: !done && t.deadline! < now,
      });
    }
    for (const d of deliverables) {
      const done = (APPROVED_DELIVERABLE as readonly string[]).includes(d.status);
      items.push({
        id: `d-${d.id}`,
        date: istDate(d.dueAt!),
        kind: 'deliverable',
        title: d.title,
        sub: `${d.cycle.engagement.clientOrg.name} · ${d.cycle.engagement.service.name}`,
        href: `/team/deliverables/${d.id}`,
        done,
        overdue: !done && d.dueAt! < now,
      });
    }
    for (const c of cycles) {
      items.push({
        id: `c-${c.id}`,
        date: istDate(c.firstDraftDue!),
        kind: 'draft_due',
        title: `First drafts due: ${c.engagement.service.name}`,
        sub: c.engagement.clientOrg.name,
        href: `/team/projects/${c.engagementId}`,
      });
    }
    for (const h of holidays) if (h.date >= range.firstDay && h.date <= range.lastDay) items.push({ id: `h-${h.date}`, date: h.date, kind: 'holiday', title: h.name });
    for (const l of leave) {
      const name = leaveNames.find((u) => u.id === l.userId)?.name ?? 'Someone';
      for (const day of eachDay(dayOf(l.from), dayOf(l.to))) {
        if (day < range.firstDay || day > range.lastDay || !isWorkDay(day, holidayDates, workDays)) continue;
        items.push({ id: `l-${l.id}-${day}`, date: day, kind: 'leave', title: l.userId === me.id ? 'You are on leave' : `${name} on leave`, sub: `${l.type} leave` });
      }
    }
    items.sort((a, b) => a.date.localeCompare(b.date));
    return { month: range.month, view, today: istDate(now), items };
  }

  // -------------------------------------------------------------------------
  // Capacity

  async capacity(me: Me): Promise<TeamCapacityView> {
    assertStaff(me);
    const { scope, label, users, self } = await this.peopleInScope(me);
    const week = currentWeek();
    const now = new Date();
    const ids = [...new Set([...users.map((u) => u.id), me.id])];
    const [tasks, leave] = await Promise.all([
      this.prisma.task.findMany({ where: { orgId: me.orgId, ownerId: { in: ids }, status: { in: OPEN } }, select: { ownerId: true, deadline: true, status: true } }),
      this.prisma.leaveRequest.findMany({ where: { userId: { in: ids }, status: 'approved', ...AWAY_LEAVE, from: { lte: dbDate(week.today) }, to: { gte: dbDate(week.today) } }, select: { userId: true } }),
    ]);
    const row = (u: { id: string; name: string; department: { name: string } | null }): TeamCapacityPerson => {
      const mine = tasks.filter((t) => t.ownerId === u.id);
      const dueThisWeek = mine.filter((t) => t.deadline && t.deadline >= now && t.deadline < week.end).length;
      const overdue = mine.filter((t) => t.deadline && t.deadline < now).length;
      return {
        id: u.id,
        name: u.name,
        department: u.department?.name ?? null,
        open: mine.length,
        dueThisWeek,
        overdue,
        blocked: mine.filter((t) => t.status === 'blocked').length,
        loadPct: Math.round(((dueThisWeek + overdue) * HOURS_PER_TASK * 100) / WEEK_HOURS),
        onLeave: leave.some((l) => l.userId === u.id),
      };
    };
    const unassignedWhere: Prisma.TaskWhereInput = { orgId: me.orgId, ownerId: null, status: { in: OPEN } };
    if (scope !== 'all') unassignedWhere.departmentId = self.departmentId ?? '__none__';
    const unassigned = await this.prisma.task.findMany({
      where: unassignedWhere,
      include: { deliverable: { include: { cycle: { include: { engagement: { include: { clientOrg: { select: { name: true } } } } } } } } },
      orderBy: [{ deadline: 'asc' }, { createdAt: 'asc' }],
      take: 25,
    });
    const depts = await this.prisma.department.findMany({ where: { id: { in: unassigned.map((t) => t.departmentId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
    return {
      scope,
      scopeLabel: label,
      week: { from: week.from, to: week.to },
      hoursPerTask: HOURS_PER_TASK,
      weekHours: WEEK_HOURS,
      me: row({ id: self.id, name: self.name, department: self.department }),
      people: users.map(row).sort((a, b) => b.loadPct - a.loadPct || b.open - a.open),
      unassigned: unassigned.map((t) => ({
        id: t.id,
        title: t.title,
        deadline: t.deadline?.toISOString() ?? null,
        client: t.deliverable?.cycle.engagement.clientOrg.name ?? null,
        department: depts.find((d) => d.id === t.departmentId)?.name ?? null,
        href: taskHref(t),
      })),
    };
  }

  // -------------------------------------------------------------------------
  // SOP library (read-only)

  async sops(me: Me): Promise<SopRow[]> {
    assertStaff(me);
    const rows = await this.prisma.sOP.findMany({ where: { orgId: me.orgId, status: 'published' }, include: { department: { select: { id: true, name: true } } }, orderBy: [{ department: { name: 'asc' } }, { title: 'asc' }] });
    return rows.map((s) => ({ id: s.id, title: s.title, version: s.version, department: s.department, excerpt: excerpt(s.body) }));
  }

  async sop(me: Me, id: string): Promise<SopDetail> {
    assertStaff(me);
    const s = await this.prisma.sOP.findFirst({ where: { id, orgId: me.orgId, status: 'published' }, include: { department: { select: { id: true, name: true } } } });
    if (!s) throw new NotFoundException('SOP not found');
    const ack = await this.prisma.sopAcknowledgement.findFirst({ where: { sopId: s.id, userId: me.id }, orderBy: { version: 'desc' } });
    return { id: s.id, title: s.title, version: s.version, department: s.department, excerpt: excerpt(s.body), body: s.body, acknowledgedVersion: ack?.version ?? null, acknowledgedAt: ack?.at.toISOString() ?? null };
  }

  // -------------------------------------------------------------------------
  // Profile, attendance and leave

  async profile(me: Me): Promise<MyProfile> {
    assertStaff(me);
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: me.id },
      include: { department: true, team: true, manager: { select: { name: true, email: true } }, roles: { include: { role: true } } },
    });
    const range = monthRange(undefined);
    const today = istDate(new Date());
    const year = Number(today.slice(0, 4));
    const yearWindow = { from: `${year}-01-01`, to: `${year}-12-31` };
    const [attendance, eod, requests, holidays] = await Promise.all([
      this.prisma.attendance.findMany({ where: { userId: me.id, date: { gte: dbDate(range.firstDay), lte: dbDate(range.lastDay) } }, orderBy: { date: 'asc' } }),
      this.prisma.eODReport.findMany({ where: { userId: me.id }, orderBy: { date: 'desc' }, take: 14 }),
      this.prisma.leaveRequest.findMany({ where: { userId: me.id }, orderBy: { from: 'desc' }, take: 50 }),
      this.holidays(me.orgId),
    ]);
    const holidayDates = holidays.map((h) => h.date);
    const workDays = await this.workDays(me.orgId);
    const days = attendance.map((a) => {
      const hours = a.checkIn && a.checkOut ? Math.max(0, (a.checkOut.getTime() - a.checkIn.getTime()) / 3_600_000) : 0;
      return { date: dayOf(a.date), checkIn: a.checkIn?.toISOString() ?? null, checkOut: a.checkOut?.toISOString() ?? null, hours: Math.round(hours * 10) / 10 };
    });
    const daysIn = (r: (typeof requests)[number]) => workingDaysIn(dayOf(r.from), dayOf(r.to), holidayDates, yearWindow, workDays);
    const inYear = (r: (typeof requests)[number]) => dayOf(r.to) >= yearWindow.from && dayOf(r.from) <= yearWindow.to;
    // v31: paid days of casual / sick (older requests without the split count as paid); unpaid days of any type.
    const paidOf = (r: (typeof requests)[number]) => r.paidDays ?? (r.type === 'casual' || r.type === 'sick' ? daysIn(r) : 0);
    const unpaidOf = (r: (typeof requests)[number]) => r.unpaidDays ?? (r.type === 'unpaid' ? daysIn(r) : 0);
    const used = (type: LeaveType, status: 'approved' | 'pending') => requests.filter((r) => inYear(r) && r.type === type && r.status === status).reduce((s, r) => s + paidOf(r), 0);
    const accrued = paidAccrued('casual', Number(today.slice(5, 7)));
    return {
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        department: user.department?.name ?? null,
        team: user.team?.name ?? null,
        manager: user.manager,
        roles: user.roles.map((r) => r.role.name),
        canRename: me.type !== 'staff' || me.roles.some((r) => ['founder', 'admin', 'hr_ops'].includes(r)),
        specialty: user.specialty,
      },
      attendance: {
        month: range.month,
        days,
        totalHours: Math.round(days.reduce((s, d) => s + d.hours, 0) * 10) / 10,
        daysPresent: days.filter((d) => d.checkIn).length,
        workingDaysSoFar: workingDaysIn(range.firstDay, today < range.lastDay ? today : range.lastDay, holidayDates, undefined, workDays),
      },
      eod: eod.map((e) => ({ date: dayOf(e.date), completed: e.completed, pending: e.pending, blocked: e.blocked, waiting: e.waiting })),
      leave: {
        year,
        balance: (['casual', 'sick'] as const).map((type) => {
          const u = used(type, 'approved');
          const p = used(type, 'pending');
          const allowed = type === 'casual' ? accrued : paidAccrued('sick', Number(today.slice(5, 7)));
          return { type, allowed, used: u, pending: p, left: Math.max(0, allowed - u) };
        }),
        unpaidUsed: requests.filter((r) => inYear(r) && r.status === 'approved').reduce((s, r) => s + unpaidOf(r), 0),
        wfhDays: requests.filter((r) => inYear(r) && r.status === 'approved' && r.type === 'wfh').reduce((s, r) => s + daysIn(r), 0),
        canApply: !me.roles.includes('founder'),
        requests: await Promise.all(requests.map((r) => this.toLeave(r, holidayDates, workDays))),
      },
      holidays: holidays.filter((h) => h.date.startsWith(String(year))),
    };
  }

  /** v31: the employee sees only the final result; the approvers, steps and notes stay confidential. */
  private async toLeave(r: Prisma.LeaveRequestGetPayload<object>, holidays: string[], workDays?: readonly number[]): Promise<LeaveRequestView> {
    const days = workingDaysIn(dayOf(r.from), dayOf(r.to), holidays, undefined, workDays);
    const type = ((LEAVE_TYPES as readonly string[]).includes(r.type) ? r.type : 'casual') as LeaveType;
    return {
      id: r.id,
      from: dayOf(r.from),
      to: dayOf(r.to),
      type,
      reason: r.reason,
      status: r.status,
      days,
      paidDays: r.paidDays ?? (type === 'casual' || type === 'sick' ? days : 0),
      unpaidDays: r.unpaidDays ?? (type === 'unpaid' ? days : 0),
      createdAt: r.createdAt.toISOString(),
      decidedAt: r.status === 'pending' ? null : (r.decidedAt?.toISOString() ?? null),
    };
  }

  async applyLeave(me: Me, input: LeaveRequestInput, ip?: string) {
    assertStaff(me);
    // v31: Founders are the top of the company and don't request leave.
    if (me.roles.includes('founder')) throw new ForbiddenException('Founders do not need to request leave.');
    const holidays = (await this.holidays(me.orgId)).map((h) => h.date);
    const workDays = await this.workDays(me.orgId);
    const days = workingDaysIn(input.from, input.to, holidays, undefined, workDays);
    if (days === 0) throw new BadRequestException('Those dates are all days off or holidays. No leave is needed.');
    if (input.from.slice(0, 4) !== input.to.slice(0, 4)) throw new BadRequestException('Apply for leave in each calendar year separately');
    const overlap = await this.prisma.leaveRequest.findFirst({
      where: { userId: me.id, status: { in: ['pending', 'approved'] }, from: { lte: dbDate(input.to) }, to: { gte: dbDate(input.from) } },
    });
    if (overlap) throw new BadRequestException(`You already have a ${overlap.status} leave request from ${dayOf(overlap.from)} to ${dayOf(overlap.to)}`);
    // v31: 1 paid casual and 1 paid sick day a month, carried over within the year; the rest of the days are unpaid.
    const dayList: string[] = [];
    for (let t = dbDate(input.from).getTime(); t <= dbDate(input.to).getTime(); t += 86_400_000) {
      const d = new Date(t).toISOString().slice(0, 10);
      if (workDays.includes(new Date(t).getUTCDay()) && !holidays.includes(d)) dayList.push(d);
    }
    const year = input.from.slice(0, 4);
    const others = await this.prisma.leaveRequest.findMany({
      where: { userId: me.id, type: input.type, status: { in: ['pending', 'approved'] }, from: { lte: dbDate(`${year}-12-31`) }, to: { gte: dbDate(`${year}-01-01`) } },
    });
    const otherPaid = others.reduce((s, r) => s + (r.paidDays ?? workingDaysIn(dayOf(r.from), dayOf(r.to), holidays, { from: `${year}-01-01`, to: `${year}-12-31` }, workDays)), 0);
    const split = splitPaid(input.type, dayList, otherPaid);
    // v31 approval chain: the Department Head first, then HR. A Department Head's own leave goes to HR of their branch.
    const routing = await loadLeaveRouting(this.prisma, me.orgId);
    const head = routing.headOf(me.id);
    const row = await this.prisma.leaveRequest.create({
      data: { orgId: me.orgId, userId: me.id, from: dbDate(input.from), to: dbDate(input.to), type: input.type, reason: input.reason || null, stage: head ? 'head' : 'hr', paidDays: split.paid, unpaidDays: split.unpaid },
    });
    await this.audit.log(me, 'leave.requested', 'LeaveRequest', row.id, undefined, { ...input, days, stage: row.stage, paidDays: split.paid, unpaidDays: split.unpaid }, ip);
    const what = input.type === 'wfh' ? 'work from home' : `${input.type} leave`;
    const title = `${me.name} asked for ${days} day${days > 1 ? 's' : ''} of ${what}`;
    const splitText = input.type === 'casual' || input.type === 'sick' ? ` (${split.paid} paid, ${split.unpaid} unpaid)` : '';
    const body = `${input.from} to ${input.to}${splitText}${input.reason ? `: ${input.reason}` : ''}${head ? ' · HR makes the final call after you' : ''}`;
    const notice = await applyNotificationTemplate(this.prisma, me.orgId, { kind: 'leave_request', title, body, link: head ? '/team/approvals' : '/admin/attendance#leave' });
    const to = head ? [head] : routing.hrFor(me.id);
    if (notice?.channels.includes('inApp') && to.length) {
      await this.prisma.notification.createMany({ data: to.map((userId) => ({ orgId: me.orgId, userId, kind: notice.kind, title: notice.title, body: notice.body, link: notice.link })) });
    }
    return this.profile(me);
  }

  async cancelLeave(me: Me, id: string, ip?: string) {
    assertStaff(me);
    const row = await this.prisma.leaveRequest.findFirst({ where: { id, userId: me.id } });
    if (!row) throw new NotFoundException('Leave request not found');
    if (row.status !== 'pending') throw new BadRequestException('Only pending requests can be cancelled. Ask your manager to change an approved one.');
    await this.prisma.leaveRequest.update({ where: { id }, data: { status: 'cancelled' } });
    await this.audit.log(me, 'leave.cancelled', 'LeaveRequest', id, { status: 'pending' }, { status: 'cancelled' }, ip);
    return this.profile(me);
  }

  /** Any signed-in person can update their own name and mobile number. */
  async updateMe(me: Me, input: UpdateMe, ip?: string) {
    const before = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { name: true, phone: true } });
    // v11 actions spec: team members edit only their own contact details; name changes go through HR or a Branch Manager.
    const canRename = me.type !== 'staff' || me.roles.some((r) => ['founder', 'admin', 'hr_ops'].includes(r));
    if (!canRename && input.name.trim() !== before.name) throw new ForbiddenException('Ask HR or a Branch Manager to change your name. You can change your mobile number here.');
    const phone = input.phone === undefined ? undefined : input.phone ? normaliseIdentifier(input.phone) : null;
    try {
      await this.prisma.user.update({ where: { id: me.id }, data: { name: input.name, ...(phone !== undefined ? { phone } : {}) } });
    } catch (e) {
      if (isUniqueError(e)) throw new BadRequestException('This mobile number is already used by another account');
      throw e;
    }
    await this.audit.log(me, 'profile.updated', 'User', me.id, before, { name: input.name, phone }, ip);
    return { ok: true as const };
  }
}
