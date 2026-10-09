import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { bookingSchema, bookingUpdateSchema, weeklyHoursSchema, type BookingResult, type BookingRow, type BookingSuggestions, type Me, type WorkloadCell, type WorkloadView } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { hasRole } from '../creative/scope.js';
import type { Prisma, ResourceBooking } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';
import { SettingsService } from '../settings/settings.service.js';
import { addDays, dbDate, isMonday, isoOf, mondayOf, todayIst } from './dates.js';

const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'];
/** Open tasks without an estimate count as two hours. */
const DEFAULT_TASK_MIN = 120;
const BOOKERS = ['founder', 'admin', 'am_lead', 'department_head', 'producer', 'account_manager'];
const round1 = (n: number) => Math.round(n * 10) / 10;

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
      this.prisma.leaveRequest.findMany({ where: { orgId, userId: { in: userIds }, status: 'approved', from: { lte: dbDate(last) }, to: { gte: dbDate(first) } }, select: { userId: true, from: true, to: true } }),
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

  private weeksFrom(from: string | undefined, count: number) {
    const start = mondayOf(from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : todayIst());
    return Array.from({ length: count }, (_, i) => addDays(start, i * 7));
  }

  async workload(me: Me, q: { from?: string; weeks?: string; team?: string }): Promise<WorkloadView> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const weeks = this.weeksFrom(q.from, Math.min(12, Math.max(1, Number(q.weeks) || 6)));
    const all = this.canBook(me) || hasRole(me, 'hr_ops');
    const users = await this.prisma.user.findMany({
      where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, ...(all ? {} : { id: me.id }), ...(q.team ? { departmentId: q.team } : {}) },
      select: { id: true, name: true, specialty: true, weeklyHours: true, roles: { select: { role: { select: { baseRole: true } } } } },
      orderBy: { name: 'asc' },
      take: 300,
    });
    const loads = await this.loads(me.orgId, users.map((u) => u.id), weeks);
    const bookings = await this.bookingRows({ orgId: me.orgId, weekStart: { gte: dbDate(weeks[0]), lte: dbDate(weeks[weeks.length - 1]) }, ...(all ? {} : { userId: me.id }) });
    const { holidays } = await this.calendar(me.orgId);
    const end = addDays(weeks[weeks.length - 1], 6);
    return {
      weeks,
      people: users.map((u) => ({
        userId: u.id,
        name: u.name,
        specialty: u.specialty,
        role: u.roles[0]?.role.baseRole ?? 'staff',
        weeklyHours: u.weeklyHours,
        cells: (loads.get(u.id) ?? []).map(({ leaveDates: _l, ...c }) => c),
      })),
      bookings: bookings.filter((b) => b.status === 'booked'),
      requests: bookings.filter((b) => b.status === 'requested'),
      canBook: this.canBook(me),
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
    if (!this.canBook(me)) throw new ForbiddenException('Only producers, Account Managers and leadership book people');
    const input = parse(bookingSchema, body);
    if (!isMonday(input.weekStart)) throw new BadRequestException('Bookings start on a Monday');
    if (input.weekStart < mondayOf(todayIst())) throw new BadRequestException('That week is already over');
    const eng = await this.prisma.engagement.findFirst({ where: { id: input.engagementId, orgId: me.orgId, deletedAt: null }, select: { id: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } });
    if (!eng) throw new NotFoundException('Project not found');
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
    }
    return { created: await this.toRows(created), skipped };
  }

  async update(me: Me, id: string, body: unknown, ip?: string) {
    if (!this.canBook(me)) throw new ForbiddenException('Only producers, Account Managers and leadership book people');
    const input = parse(bookingUpdateSchema, body);
    const b = await this.prisma.resourceBooking.findFirst({ where: { id, orgId: me.orgId } });
    if (!b) throw new NotFoundException('Booking not found');
    const userId = input.userId ?? b.userId;
    const hours = input.hours ?? b.hours;
    if (userId) {
      const why = await this.refusal(me.orgId, userId, isoOf(b.weekStart), hours, b.userId === userId ? id : undefined);
      if (why) throw new BadRequestException(why);
    }
    const after = await this.prisma.resourceBooking.update({ where: { id }, data: { userId, hours, note: input.note === undefined ? undefined : input.note?.trim() || null, status: userId ? 'booked' : 'requested', specialty: userId ? null : b.specialty } });
    await this.audit.log(me, 'booking.updated', 'ResourceBooking', id, { userId: b.userId, hours: b.hours }, { userId, hours }, ip);
    return (await this.toRows([after]))[0];
  }

  async remove(me: Me, id: string, ip?: string) {
    if (!this.canBook(me)) throw new ForbiddenException('Only producers, Account Managers and leadership book people');
    const b = await this.prisma.resourceBooking.findFirst({ where: { id, orgId: me.orgId } });
    if (!b) throw new NotFoundException('Booking not found');
    await this.prisma.resourceBooking.delete({ where: { id } });
    await this.audit.log(me, 'booking.deleted', 'ResourceBooking', id, { userId: b.userId, hours: b.hours, weekStart: isoOf(b.weekStart) }, undefined, ip);
    return { ok: true as const };
  }

  async projectBookings(me: Me, engagementId: string) {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    return this.bookingRows({ orgId: me.orgId, engagementId, weekStart: { gte: dbDate(addDays(mondayOf(todayIst()), -28)) } });
  }

  /** Best people for a week: matching skill, most free hours, and work finished on time in the last 90 days. */
  async suggest(me: Me, q: { weekStart: string; specialty?: string; hours?: string }): Promise<BookingSuggestions> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    return this.suggestCore(me.orgId, q.weekStart, q.specialty || null, Number(q.hours) || 0);
  }

  async suggestCore(orgId: string, weekRaw: string, specialty: string | null, hours: number): Promise<BookingSuggestions> {
    const weekStart = mondayOf(/^\d{4}-\d{2}-\d{2}$/.test(weekRaw) ? weekRaw : todayIst());
    const users = await this.prisma.user.findMany({
      where: { orgId, type: 'staff', status: 'active', deletedAt: null, ...(specialty ? { specialty } : { specialty: { not: null } }) },
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
    if (!hasRole(me, 'founder', 'admin', 'hr_ops', 'department_head')) throw new ForbiddenException('Founder, Admin, HR and department heads set working hours');
    const { weeklyHours } = parse(weeklyHoursSchema, body);
    const u = await this.prisma.user.findFirst({ where: { id: userId, orgId: me.orgId, type: 'staff' }, select: { weeklyHours: true } });
    if (!u) throw new NotFoundException('Person not found');
    await this.prisma.user.update({ where: { id: userId }, data: { weeklyHours } });
    await this.audit.log(me, 'user.weekly_hours', 'User', userId, { weeklyHours: u.weeklyHours }, { weeklyHours }, ip);
    return { ok: true as const };
  }
}
