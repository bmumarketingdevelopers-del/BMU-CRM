import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { bookingSchema, bookingUpdateSchema, craftSpecialtyLabel, weeklyHoursSchema, type BookingResult, type BookingRow, type BookingSuggestions, type Me, type WorkloadCell, type WorkloadView } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { hasRole } from '../creative/scope.js';
import type { Prisma, ResourceBooking } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { SettingsService } from '../settings/settings.service.js';
import { addDays, dbDate, isMonday, isoOf, mondayOf, todayIst } from './dates.js';
import { WORKLOAD_MODE } from './workload-mode.js';

const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'];
/** Open tasks without an estimate count as two hours. */
const DEFAULT_TASK_MIN = 120;
// v23: Producers are the hands-on team (designers, editors, developers...): they pass their own tasks instead (TaskPassService).
const BOOKERS = ['founder', 'admin', 'am_lead', 'department_head', 'account_manager'];
const HOURS_SETTERS = ['founder', 'admin', 'hr_ops', 'department_head'];
export const NOT_A_BOOKER = 'Only Client Managers, Department Heads and leadership book people';
/**
 * Who sees everyone's weekly hours on Workload (and, if a booker, books anyone): Founders, Branch Managers, HR, the CM
 * Lead and Client Managers. A Department Head sees (and books, and sets the hours of) only their own department's people.
 * v23: anyone else (producers, interns, QC...) sees their own department's rows, to pick who to pass a task to.
 */
const SEE_ALL = ['founder', 'admin', 'hr_ops', 'am_lead', 'account_manager'];
const round1 = (n: number) => Math.round(n * 10) / 10;

// v40: WORKLOAD_MODE lives in ./workload-mode.ts (also used by Capacity and the person picker).
export { WORKLOAD_MODE } from './workload-mode.js';

export type WeekLoad = WorkloadCell & { leaveDates: string[] };

/**
 * v18 capacity: weekly hours per person, minus holidays and approved leave, against booked project hours and open task
 * estimates, for the next weeks. Booking refuses people on approved leave or with no hours left that week.
 */
@Injectable()
export class CapacityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  canBook(me: Me) {
    return me.type === 'staff' && hasRole(me, ...BOOKERS);
  }

  /** 'all', or the people whose weekly hours this person may see: their department(s) for a Department Head, else themselves. */
  async visiblePeople(me: Me): Promise<'all' | string[]> {
    if (hasRole(me, ...SEE_ALL)) return 'all';
    if (!hasRole(me, 'department_head')) return [me.id];
    const headed = (await this.prisma.department.findMany({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true } })).map((d) => d.id);
    // A Department Head not yet set as head of a department sees their own department.
    const deptIds = headed.length ? headed : [(await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } }))?.departmentId].filter((x): x is string => !!x);
    const people = deptIds.length ? await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', departmentId: { in: deptIds } }, select: { id: true } }) : [];
    return [...new Set([me.id, ...people.map((p) => p.id)])];
  }

  /** v23: the person and the active team members of their department (themselves only without a department). */
  async departmentPeople(me: Me): Promise<string[]> {
    const dept = (await this.prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } }))?.departmentId;
    if (!dept) return [me.id];
    const people = await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, departmentId: dept }, select: { id: true } });
    return [...new Set([me.id, ...people.map((p) => p.id)])];
  }

  private async assertVisible(me: Me, userIds: (string | null | undefined)[]) {
    const scope = await this.visiblePeople(me);
    if (scope === 'all') return;
    if (userIds.some((u) => u && !scope.includes(u))) throw new ForbiddenException('You can only do this for people in your own department');
  }

  private async calendar(orgId: string) {
    const [cal, hol] = await Promise.all([calendarFor(this.prisma, orgId), this.settings.get(orgId, 'holidays')]);
    const holidays = new Map<string, string>(cal.holidays.map((d) => [d, 'Holiday']));
    for (const h of hol.list) holidays.set(h.date, h.name);
    return { days: [...cal.days], holidays };
  }

  /** Per person and week: available, booked and task hours. */
  async loads(orgId: string, userIds: string[], weeks: string[]) {
    const { days, holidays } = await this.calendar(orgId);
    const first = weeks[0];
    const last = addDays(weeks[weeks.length - 1], 6);
    const [users, leaves, bookings, tasks] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, weeklyHours: true } }),
      this.prisma.leaveRequest.findMany({ where: { orgId, userId: { in: userIds }, status: 'approved', type: { not: 'wfh' }, from: { lte: dbDate(last) }, to: { gte: dbDate(first) } }, select: { userId: true, from: true, to: true } }),
      this.prisma.resourceBooking.findMany({ where: { orgId, userId: { in: userIds }, status: 'booked', weekStart: { gte: dbDate(first), lte: dbDate(weeks[weeks.length - 1]) } }, select: { userId: true, weekStart: true, hours: true } }),
      this.prisma.task.findMany({ where: { orgId, ownerId: { in: userIds }, status: { in: OPEN_TASK as never }, archivedAt: null, isDraft: false, deadline: { not: null, lt: new Date(dbDate(addDays(last, 1)).getTime() - 330 * 60_000) } }, select: { ownerId: true, deadline: true, estimateMin: true } }),
    ]);
    const hoursBy = new Map(users.map((u) => [u.id, u.weeklyHours]));
    const out = new Map<string, WeekLoad[]>();
    const thisWeek = mondayOf(todayIst());
    for (const uid of userIds) {
      const weekly = hoursBy.get(uid) ?? 45;
      const perDay = days.length ? weekly / days.length : 0;
      const cells: WeekLoad[] = weeks.map((w) => {
        const dates = Array.from({ length: 7 }, (_, i) => addDays(w, i)).filter((d) => days.includes(dbDate(d).getUTCDay()));
        const holidayDays = dates.filter((d) => holidays.has(d));
        const open = dates.filter((d) => !holidays.has(d));
        const leaveDates = open.filter((d) => leaves.some((l) => l.userId === uid && isoOf(l.from) <= d && isoOf(l.to) >= d));
        const available = round1(perDay * (open.length - leaveDates.length));
        const booked = bookings.filter((b) => b.userId === uid && isoOf(b.weekStart) === w).reduce((s, b) => s + b.hours, 0);
        const taskMin = tasks
          .filter((t) => t.ownerId === uid)
          .filter((t) => {
            const wk = mondayOf(isoOf(new Date(t.deadline!.getTime() + 330 * 60_000)));
            // Overdue work lands on this week.
            return wk === w || (w === thisWeek && wk < thisWeek);
          })
          .reduce((s, t) => s + (t.estimateMin ?? DEFAULT_TASK_MIN), 0);
        const taskHours = round1(taskMin / 60);
        return { weekStart: w, availableHours: available, bookedHours: booked, taskHours, leaveDays: leaveDates.length, holidayDays: holidayDays.length, loadPct: available > 0 ? Math.round(((booked + taskHours) / available) * 100) : null, leaveDates };
      });
      out.set(uid, cells);
    }
    return out;
  }

  /**
   * v40 assigned-tasks Workload: per person and week, the hours of their open tasks (as the Department Head gave them),
   * spread evenly over the working days from today (or the day the task was added) to its deadline. Overdue work lands
   * today. Tasks without hours are counted, not guessed.
   */
  async taskLoads(orgId: string, userIds: string[], weeks: string[]) {
    const { days, holidays } = await this.calendar(orgId);
    const first = weeks[0];
    const last = addDays(weeks[weeks.length - 1], 6);
    const today = todayIst();
    const [users, leaves, tasks] = await Promise.all([
      this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, weeklyHours: true } }),
      this.prisma.leaveRequest.findMany({ where: { orgId, userId: { in: userIds }, status: 'approved', type: { not: 'wfh' }, from: { lte: dbDate(last) }, to: { gte: dbDate(first) } }, select: { userId: true, from: true, to: true } }),
      this.prisma.task.findMany({
        where: { orgId, ownerId: { in: userIds }, status: { in: OPEN_TASK as never }, archivedAt: null, isDraft: false },
        select: { id: true, title: true, ownerId: true, deadline: true, estimateMin: true, status: true, createdAt: true, engagementId: true },
        orderBy: [{ deadline: 'asc' }],
        take: 5000,
      }),
    ]);
    const engs = await this.prisma.engagement.findMany({ where: { id: { in: [...new Set(tasks.map((t) => t.engagementId).filter((x): x is string => !!x))] } }, select: { id: true, clientOrg: { select: { name: true } } } });
    const ist = (d: Date) => isoOf(new Date(d.getTime() + 330 * 60_000));
    const working = (d: string) => days.includes(dbDate(d).getUTCDay()) && !holidays.has(d);
    // Hours per person per date.
    const perDate = new Map<string, Map<string, number>>();
    const noHours = new Map<string, Map<string, number>>();
    const bump = (m: Map<string, Map<string, number>>, uid: string, date: string, n: number) => {
      const row = m.get(uid) ?? new Map<string, number>();
      row.set(date, (row.get(date) ?? 0) + n);
      m.set(uid, row);
    };
    for (const t of tasks) {
      const uid = t.ownerId!;
      const due = t.deadline ? ist(t.deadline) : today;
      if (!t.estimateMin) {
        bump(noHours, uid, due < today ? today : due, 1);
        continue;
      }
      const start = [today, ist(t.createdAt)].sort().at(-1)!;
      const end = due < start ? start : due;
      const dates: string[] = [];
      for (let d = start, i = 0; d <= end && i < 400; d = addDays(d, 1), i++) if (working(d)) dates.push(d);
      if (!dates.length) dates.push(end);
      for (const d of dates) bump(perDate, uid, d, t.estimateMin / 60 / dates.length);
    }
    const hoursBy = new Map(users.map((u) => [u.id, u.weeklyHours]));
    const out = new Map<string, { cells: WeekLoad[]; tasks: NonNullable<WorkloadView['people'][number]['tasks']> }>();
    for (const uid of userIds) {
      const weekly = hoursBy.get(uid) ?? 45;
      const perDay = days.length ? weekly / days.length : 0;
      const cells: WeekLoad[] = weeks.map((w) => {
        const dates = Array.from({ length: 7 }, (_, i) => addDays(w, i)).filter((d) => days.includes(dbDate(d).getUTCDay()));
        const holidayDays = dates.filter((d) => holidays.has(d));
        const open = dates.filter((d) => !holidays.has(d));
        const leaveDates = open.filter((d) => leaves.some((l) => l.userId === uid && isoOf(l.from) <= d && isoOf(l.to) >= d));
        const available = round1(perDay * (open.length - leaveDates.length));
        const week = Array.from({ length: 7 }, (_, i) => addDays(w, i));
        const taskHours = round1(week.reduce((s, d) => s + (perDate.get(uid)?.get(d) ?? 0), 0));
        const noHoursTasks = week.reduce((s, d) => s + (noHours.get(uid)?.get(d) ?? 0), 0);
        return { weekStart: w, availableHours: available, bookedHours: 0, taskHours, leaveDays: leaveDates.length, holidayDays: holidayDays.length, loadPct: available > 0 ? Math.round((taskHours / available) * 100) : null, noHoursTasks, leaveDates };
      });
      const mine = tasks
        .filter((t) => t.ownerId === uid)
        .slice(0, 40)
        .map((t) => ({ id: t.id, title: t.title, client: engs.find((e) => e.id === t.engagementId)?.clientOrg.name ?? null, hours: t.estimateMin ? round1(t.estimateMin / 60) : null, deadline: t.deadline ? ist(t.deadline) : null, status: t.status }));
      out.set(uid, { cells, tasks: mine });
    }
    return out;
  }

  private weeksFrom(from: string | undefined, count: number) {
    const start = mondayOf(from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : todayIst());
    return Array.from({ length: count }, (_, i) => addDays(start, i * 7));
  }

  async workload(me: Me, q: { from?: string; weeks?: string; team?: string }): Promise<WorkloadView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const weeks = this.weeksFrom(q.from, Math.min(12, Math.max(1, Number(q.weeks) || 6)));
    const scope = await this.visiblePeople(me);
    const all = scope === 'all';
    // A Department Head sees their department's people, their bookings and the open skill requests (to fill them).
    const head = !all && hasRole(me, 'department_head');
    // v23: anyone else sees their department's rows (only their own bookings), to see who has time for a passed task.
    const rows = all || head ? scope : await this.departmentPeople(me);
    const users = await this.prisma.user.findMany({
      where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, ...(rows === 'all' ? {} : { id: { in: rows } }), ...(q.team ? { departmentId: q.team } : {}) },
      select: { id: true, name: true, specialty: true, weeklyHours: true, roles: { select: { role: { select: { baseRole: true } } } } },
      orderBy: { name: 'asc' },
      take: 300,
    });
    // v40: in the assigned-tasks Workload only the hours Department Heads gave assigned tasks fill each week (the
    // screen hides bookings; booking and skill requests still work underneath). 'primary' = booked + task estimates.
    const tasksMode = WORKLOAD_MODE === 'assigned_tasks';
    const byTask = tasksMode ? await this.taskLoads(me.orgId, users.map((u) => u.id), weeks) : null;
    const loads = byTask ? new Map([...byTask].map(([k, v]) => [k, v.cells])) : await this.loads(me.orgId, users.map((u) => u.id), weeks);
    const bookings = await this.bookingRows({
      orgId: me.orgId,
      weekStart: { gte: dbDate(weeks[0]), lte: dbDate(weeks[weeks.length - 1]) },
      ...(all ? {} : head ? { OR: [{ userId: { in: scope as string[] } }, { userId: null }] } : { userId: me.id }),
    });
    const { holidays } = await this.calendar(me.orgId);
    const end = addDays(weeks[weeks.length - 1], 6);
    return {
      mode: WORKLOAD_MODE,
      weeks,
      people: users.map((u) => ({
        userId: u.id,
        name: u.name,
        specialty: u.specialty,
        role: u.roles[0]?.role.baseRole ?? 'staff',
        weeklyHours: u.weeklyHours,
        cells: (loads.get(u.id) ?? []).map(({ leaveDates: _l, ...c }) => c),
        ...(byTask ? { tasks: byTask.get(u.id)?.tasks ?? [] } : {}),
      })),
      bookings: bookings.filter((b) => b.status === 'booked'),
      requests: bookings.filter((b) => b.status === 'requested'),
      canBook: this.canBook(me),
      canSetHours: hasRole(me, ...HOURS_SETTERS),
      holidays: [...holidays.entries()].filter(([d]) => d >= weeks[0] && d <= end).map(([date, name]) => ({ date, name })).sort((a, b) => a.date.localeCompare(b.date)),
    };
  }

  private async bookingRows(where: Prisma.ResourceBookingWhereInput): Promise<BookingRow[]> {
    const list = await this.prisma.resourceBooking.findMany({ where, orderBy: [{ weekStart: 'asc' }, { createdAt: 'asc' }], take: 1000 });
    return this.toRows(list);
  }

  private async toRows(list: ResourceBooking[]): Promise<BookingRow[]> {
    const [engs, users] = await Promise.all([
      this.prisma.engagement.findMany({ where: { id: { in: [...new Set(list.map((b) => b.engagementId))] } }, select: { id: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } }),
      this.prisma.user.findMany({ where: { id: { in: list.map((b) => b.userId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }),
    ]);
    const en = new Map(engs.map((e) => [e.id, e]));
    const un = new Map(users.map((u) => [u.id, u.name]));
    return list.map((b) => ({
      id: b.id,
      engagementId: b.engagementId,
      project: en.get(b.engagementId)?.service.name ?? 'Project',
      client: en.get(b.engagementId)?.clientOrg.name ?? '',
      userId: b.userId,
      person: b.userId ? (un.get(b.userId) ?? null) : null,
      specialty: b.specialty,
      weekStart: isoOf(b.weekStart),
      hours: b.hours,
      note: b.note,
      status: b.status as BookingRow['status'],
    }));
  }

  /**
   * Why a person cannot take `hours` more in a week, or null when they can. Used by the booking form and by the
   * Producer agent's book_person action (so the agent refuses people on approved leave the same way).
   */
  async refusal(orgId: string, userId: string, weekStart: string, hours: number, ignoreBookingId?: string): Promise<string | null> {
    const user = await this.prisma.user.findFirst({ where: { id: userId, orgId }, select: { name: true, status: true, deletedAt: true, type: true } });
    if (!user || user.deletedAt || user.status !== 'active' || user.type !== 'staff') return 'That person is not an active team member';
    const [cell] = (await this.loads(orgId, [userId], [weekStart])).get(userId)!;
    const mine = ignoreBookingId ? await this.prisma.resourceBooking.findUnique({ where: { id: ignoreBookingId }, select: { hours: true, status: true } }) : null;
    const booked = cell.bookedHours - (mine?.status === 'booked' ? mine.hours : 0);
    const free = round1(cell.availableHours - booked);
    const leave = cell.leaveDates.length ? ` (approved leave ${cell.leaveDates[0]}${cell.leaveDates.length > 1 ? ` to ${cell.leaveDates[cell.leaveDates.length - 1]}` : ''})` : '';
    if (cell.availableHours <= 0 && cell.leaveDays > 0) return `${user.name} is on approved leave that week${leave}`;
    if (cell.availableHours <= 0) return `${user.name} has no working hours that week (holidays)`;
    if (hours > free) return `${user.name} has only ${Math.max(0, free)} of ${cell.availableHours} hours free that week${leave}`;
    return null;
  }

  async book(me: Me, body: unknown, ip?: string, opts: { via?: string } = {}): Promise<BookingResult> {
    if (!this.canBook(me)) throw new ForbiddenException(NOT_A_BOOKER);
    const input = parse(bookingSchema, body);
    if (!isMonday(input.weekStart)) throw new BadRequestException('Bookings start on a Monday');
    if (input.weekStart < mondayOf(todayIst())) throw new BadRequestException('That week is already over');
    const eng = await this.prisma.engagement.findFirst({ where: { id: input.engagementId, orgId: me.orgId, deletedAt: null }, select: { id: true, amId: true, clientOrg: { select: { name: true, amUserId: true } }, service: { select: { name: true } } } });
    if (!eng) throw new NotFoundException('Project not found');
    await this.assertVisible(me, [input.userId]);
    const created: ResourceBooking[] = [];
    const skipped: BookingResult['skipped'] = [];
    for (let i = 0; i < input.weeks; i++) {
      const w = addDays(input.weekStart, i * 7);
      if (input.userId) {
        const why = await this.refusal(me.orgId, input.userId, w, input.hours);
        if (why) {
          skipped.push({ weekStart: w, reason: why });
          continue;
        }
      }
      created.push(
        await this.prisma.resourceBooking.create({
          data: { orgId: me.orgId, engagementId: eng.id, userId: input.userId ?? null, specialty: input.userId ? null : (input.specialty ?? null), weekStart: dbDate(w), hours: input.hours, note: input.note?.trim() || null, status: input.userId ? 'booked' : 'requested', createdById: me.id },
        }),
      );
    }
    if (!created.length && input.weeks === 1 && skipped.length) throw new BadRequestException(skipped[0].reason);
    if (created.length) {
      await this.audit.log(me, input.userId ? 'booking.created' : 'booking.requested', 'Engagement', eng.id, undefined, { userId: input.userId, specialty: input.specialty, weeks: created.map((b) => isoOf(b.weekStart)), hours: input.hours, via: opts.via }, ip);
      if (input.userId && input.userId !== me.id) {
        await this.notifications.notify(me.orgId, [input.userId], {
          kind: 'booking',
          title: `Booked ${input.hours}h a week on ${eng.clientOrg.name} · ${eng.service.name}`,
          body: `${created.length} week${created.length === 1 ? '' : 's'} from ${isoOf(created[0].weekStart)}, by ${me.name}.`,
          link: '/team/workload',
          noEmail: true,
        });
      }
      if (!input.userId && input.specialty) await this.tellRequestPosted(me, eng, input.specialty, created);
    }
    return { created: await this.toRows(created), skipped };
  }

  async update(me: Me, id: string, body: unknown, ip?: string) {
    if (!this.canBook(me)) throw new ForbiddenException(NOT_A_BOOKER);
    const input = parse(bookingUpdateSchema, body);
    const b = await this.prisma.resourceBooking.findFirst({ where: { id, orgId: me.orgId } });
    if (!b) throw new NotFoundException('Booking not found');
    const userId = input.userId ?? b.userId;
    const hours = input.hours ?? b.hours;
    await this.assertVisible(me, [b.userId, userId]);
    if (userId) {
      const why = await this.refusal(me.orgId, userId, isoOf(b.weekStart), hours, b.userId === userId ? id : undefined);
      if (why) throw new BadRequestException(why);
    }
    const after = await this.prisma.resourceBooking.update({ where: { id }, data: { userId, hours, note: input.note === undefined ? undefined : input.note?.trim() || null, status: userId ? 'booked' : 'requested', specialty: userId ? null : b.specialty } });
    await this.audit.log(me, 'booking.updated', 'ResourceBooking', id, { userId: b.userId, hours: b.hours }, { userId, hours }, ip);
    if (b.status === 'requested' && userId) await this.tellRequestFilled(me, b, userId, hours);
    return (await this.toRows([after]))[0];
  }

  async remove(me: Me, id: string, ip?: string) {
    if (!this.canBook(me)) throw new ForbiddenException(NOT_A_BOOKER);
    const b = await this.prisma.resourceBooking.findFirst({ where: { id, orgId: me.orgId } });
    if (!b) throw new NotFoundException('Booking not found');
    await this.assertVisible(me, [b.userId]);
    await this.prisma.resourceBooking.delete({ where: { id } });
    await this.audit.log(me, 'booking.deleted', 'ResourceBooking', id, { userId: b.userId, hours: b.hours, weekStart: isoOf(b.weekStart) }, undefined, ip);
    return { ok: true as const };
  }

  /**
   * A skill request was posted (e.g. the SDE head needs a UI/UX designer): the project's Client Manager, the CM Lead(s)
   * and the Department Head(s) of the departments with that skill are told, so someone fills it.
   */
  private async tellRequestPosted(me: Me, eng: { id: string; amId: string | null; clientOrg: { name: string; amUserId: string | null }; service: { name: string } }, specialty: string, created: ResourceBooking[]) {
    const [leads, skilled] = await Promise.all([
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'am_lead' } } } }, select: { id: true } }),
      this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, specialty, departmentId: { not: null } }, select: { departmentId: true } }),
    ]);
    const heads = skilled.length
      ? await this.prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null, id: { in: [...new Set(skilled.map((u) => u.departmentId!))] }, headUserId: { not: null } }, select: { headUserId: true } })
      : [];
    const to = [...new Set([eng.amId ?? eng.clientOrg.amUserId, ...leads.map((l) => l.id), ...heads.map((h) => h.headUserId)].filter((x): x is string => !!x && x !== me.id))];
    if (!to.length) return;
    const weeks = created.length;
    await this.notifications.notify(me.orgId, to, {
      kind: 'booking',
      title: `${me.name} needs a ${craftSpecialtyLabel(specialty)}: ${eng.clientOrg.name} · ${eng.service.name}`,
      body: `${created[0].hours}h a week for ${weeks} week${weeks === 1 ? '' : 's'} from ${isoOf(created[0].weekStart)}. Fill it under Skill requests on Workload.`,
      link: '/team/workload',
    });
  }

  /** A skill request was filled: the person who asked and the person booked are told. */
  private async tellRequestFilled(me: Me, b: ResourceBooking, userId: string, hours: number) {
    const [eng, person] = await Promise.all([
      this.prisma.engagement.findUnique({ where: { id: b.engagementId }, select: { clientOrg: { select: { name: true } }, service: { select: { name: true } } } }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { name: true } }),
    ]);
    const project = eng ? `${eng.clientOrg.name} · ${eng.service.name}` : 'the project';
    const week = isoOf(b.weekStart);
    if (b.createdById && b.createdById !== me.id) {
      await this.notifications.notify(me.orgId, [b.createdById], {
        kind: 'booking',
        title: `${person?.name ?? 'Someone'} is booked for your ${craftSpecialtyLabel(b.specialty)} request`,
        body: `${project}: ${hours}h in the week of ${week}, by ${me.name}.`,
        link: '/team/workload',
      });
    }
    if (userId !== me.id) {
      await this.notifications.notify(me.orgId, [userId], {
        kind: 'booking',
        title: `Booked ${hours}h on ${project}`,
        body: `Week of ${week}, by ${me.name}.`,
        link: '/team/workload',
        noEmail: true,
      });
    }
  }

  async projectBookings(me: Me, engagementId: string) {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    return this.bookingRows({ orgId: me.orgId, engagementId, weekStart: { gte: dbDate(addDays(mondayOf(todayIst()), -28)) } });
  }

  /** Best people for a week: matching skill, most free hours, and work finished on time in the last 90 days. */
  async suggest(me: Me, q: { weekStart: string; specialty?: string; hours?: string }): Promise<BookingSuggestions> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    // A Department Head is only offered people from their department.
    const scope = await this.visiblePeople(me);
    return this.suggestCore(me.orgId, q.weekStart, q.specialty || null, Number(q.hours) || 0, scope === 'all' ? undefined : scope);
  }

  async suggestCore(orgId: string, weekRaw: string, specialty: string | null, hours: number, onlyUserIds?: string[]): Promise<BookingSuggestions> {
    const weekStart = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(weekRaw) ? weekRaw : todayIst());
    const users = await this.prisma.user.findMany({
      where: { orgId, type: 'staff', status: 'active', deletedAt: null, ...(specialty ? { specialty } : { specialty: { not: null } }), ...(onlyUserIds ? { id: { in: onlyUserIds } } : {}) },
      select: { id: true, name: true, specialty: true },
      take: 200,
    });
    if (!users.length) return { weekStart, specialty, candidates: [] };
    const loads = await this.loads(orgId, users.map((u) => u.id), [weekStart]);
    const since = new Date(Date.now() - 90 * 86_400_000);
    const done = await this.prisma.task.findMany({ where: { orgId, ownerId: { in: users.map((u) => u.id) }, status: 'done', completedAt: { gte: since }, deadline: { not: null } }, select: { ownerId: true, completedAt: true, deadline: true } });
    const candidates = users
      .map((u) => {
        const c = loads.get(u.id)![0];
        const free = round1(c.availableHours - c.bookedHours - c.taskHours);
        const mine = done.filter((t) => t.ownerId === u.id);
        const quality = mine.length >= 3 ? Math.round((mine.filter((t) => t.completedAt! <= t.deadline!).length / mine.length) * 100) : null;
        const score = Math.round(Math.max(0, free) * 2 + (quality ?? 70) / 2 - (c.leaveDays ? 20 : 0));
        const bits = [`${Math.max(0, free)}h free`];
        if (quality !== null) bits.push(`${quality}% on time`);
        if (c.leaveDays) bits.push(`${c.leaveDays} day${c.leaveDays === 1 ? '' : 's'} on leave`);
        return { userId: u.id, name: u.name, specialty: u.specialty, freeHours: free, qualityPct: quality, score, reason: bits.join(', '), _ok: c.availableHours > 0 && free >= hours };
      })
      .filter((c) => c._ok)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map(({ _ok, ...c }) => c);
    return { weekStart, specialty, candidates };
  }

  async setWeeklyHours(me: Me, userId: string, body: unknown, ip?: string) {
    if (!hasRole(me, ...HOURS_SETTERS)) throw new ForbiddenException('Founder, Branch Manager, HR and department heads set working hours');
    // A Department Head sets the hours of their own department's people only.
    if (!hasRole(me, 'founder', 'admin', 'hr_ops')) await this.assertVisible(me, [userId]);
    const { weeklyHours } = parse(weeklyHoursSchema, body);
    const u = await this.prisma.user.findFirst({ where: { id: userId, orgId: me.orgId, type: 'staff' }, select: { weeklyHours: true } });
    if (!u) throw new NotFoundException('Person not found');
    await this.prisma.user.update({ where: { id: userId }, data: { weeklyHours } });
    await this.audit.log(me, 'user.weekly_hours', 'User', userId, { weeklyHours: u.weeklyHours }, { weeklyHours }, ip);
    return { ok: true as const };
  }
}
