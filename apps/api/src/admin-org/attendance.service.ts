import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ATTENDANCE_CORRECTION_DAYS,
  craftSpecialtyLabel,
  istDate,
  type AttendanceCell,
  type AttendanceCorrectionInput,
  type AttendanceCorrectionRow,
  type AttendanceRecordDay,
  type AttendanceRecordDepartment,
  type AttendanceRecordPerson,
  type AttendanceRecords,
  type AttendanceRecordTotals,
  type AttendanceToday,
  type AttendanceTodayDept,
  type AttendanceTodaySummary,
  type AttendanceView,
  type DecideLeave,
  type LeaveRow,
  type Me,
  leaveDecisionMessage,
  isAwayLeave,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { assertOrgReader, isLeaveDecider } from './access.js';
import { AWAY_LEAVE, loadLeaveRouting, paidAccrued, type LeaveRouting } from './leave-flow.js';
import { addDays, dayKind, dayLabel, dbDate, hhmmToMin, istMinutes, lateMinutes, loadWorkCalendar, previousWorkingDay, ymdOf, type WorkCalendar } from './work-calendar.js';

const DAY = 86_400_000;
/** v30: the attendance records sheet: the Founder and HR (all), Department Heads (their team, view only). */
const RECORD_KEEPERS = ['founder', 'hr_ops'];
const hasRole = (me: Me, roles: string[]) => me.type === 'staff' && me.roles.some((r) => roles.includes(r));
/** India time on a day, e.g. ("2026-10-21", "09:40") -> Date. */
const istAt = (ymd: string, hhmm: string) => new Date(`${ymd}T${hhmm}:00+05:30`);
type Calendar = WorkCalendar;

/** Today's attendance board, the month grid, late check-ins, leave requests and balances. */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  private calendar(orgId: string): Promise<Calendar> {
    return loadWorkCalendar(this.settings, orgId);
  }

  /** "working" | "weekend" | "holiday" for an IST calendar date (working days from Holidays & Working Hours). */
  private dayKind(ymd: string, cal: Calendar) {
    return dayKind(ymd, cal);
  }

  /**
   * v30: whose attendance the viewer sees. Founder, Branch Manager and HR: everyone. A Department Head: the
   * department(s) they head (or their own department when they head none).
   */
  private async scope(me: Me): Promise<{ all: boolean; departmentIds: string[]; departmentNames: string[] }> {
    if (hasRole(me, ['founder', 'admin', 'hr_ops'])) return { all: true, departmentIds: [], departmentNames: [] };
    let depts = await this.prisma.department.findMany({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true, name: true } });
    if (!depts.length) {
      const self = await this.prisma.user.findUnique({ where: { id: me.id }, select: { department: { select: { id: true, name: true, deletedAt: true } } } });
      if (self?.department && !self.department.deletedAt) depts = [{ id: self.department.id, name: self.department.name }];
    }
    return { all: false, departmentIds: depts.map((d) => d.id), departmentNames: depts.map((d) => d.name) };
  }

  /** Active team members in the viewer's scope. */
  private scopedUsers(me: Me, scope: { all: boolean; departmentIds: string[] }) {
    return this.prisma.user.findMany({
      where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, ...(scope.all ? {} : { departmentId: { in: scope.departmentIds } }) },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, createdAt: true, departmentId: true, department: { select: { name: true } } },
    });
  }

  private async canDecideAnyCorrection(me: Me) {
    if (me.type !== 'staff') return false;
    if (isLeaveDecider(me)) return true;
    return (await this.prisma.user.count({ where: { orgId: me.orgId, managerId: me.id, deletedAt: null } })) > 0;
  }

  /** Working days between two dates (inclusive), optionally clipped to a range. */
  private workingDays(from: Date, to: Date, cal: Calendar, clip?: [string, string]) {
    let n = 0;
    for (let t = from.getTime(); t <= to.getTime(); t += DAY) {
      const ymd = ymdOf(new Date(t));
      if (clip && (ymd < clip[0] || ymd > clip[1])) continue;
      if (this.dayKind(ymd, cal).kind === 'working') n++;
    }
    return n;
  }

  async view(me: Me, month?: string): Promise<AttendanceView> {
    assertOrgReader(me);
    const today = istDate(new Date());
    const m = month ?? today.slice(0, 7);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(m)) throw new BadRequestException('Month must look like 2026-10');
    const cal = await this.calendar(me.orgId);
    const startMin = hhmmToMin(cal.start);
    const scope = await this.scope(me);

    const [y, mo] = m.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const monthDays = Array.from({ length: daysInMonth }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`);
    const first = monthDays[0];
    const last = monthDays[monthDays.length - 1];
    const yearStart = `${y}-01-01`;
    const yearEnd = `${y}-12-31`;

    const users = await this.scopedUsers(me, scope);
    const ids = users.map((u) => u.id);
    const lo = first < today ? first : today;
    const hi = last > today ? last : today;
    const [rows, leaves] = await Promise.all([
      this.prisma.attendance.findMany({ where: { orgId: me.orgId, userId: { in: ids }, date: { gte: dbDate(lo), lte: dbDate(hi) } } }),
      this.prisma.leaveRequest.findMany({
        where: { orgId: me.orgId, userId: { in: ids }, status: 'approved', to: { gte: dbDate(yearStart < lo ? yearStart : lo) }, from: { lte: dbDate(yearEnd > hi ? yearEnd : hi) } },
      }),
    ]);
    // Absence only counts from when someone's attendance started being tracked.
    const firsts = await this.prisma.attendance.groupBy({ by: ['userId'], where: { orgId: me.orgId, userId: { in: ids } }, _min: { date: true } });
    const since = new Map(
      users.map((u) => {
        const first = firsts.find((f) => f.userId === u.id)?._min.date;
        const created = istDate(u.createdAt);
        return [u.id, first && ymdOf(first) < created ? ymdOf(first) : created];
      }),
    );
    const att = new Map(rows.map((r) => [`${r.userId}|${ymdOf(r.date)}`, r]));
    const covers = (l: (typeof leaves)[number], userId: string, ymd: string) => l.userId === userId && ymdOf(l.from) <= ymd && ymdOf(l.to) >= ymd;
    const onLeave = (userId: string, ymd: string) => leaves.some((l) => isAwayLeave(l.type) && covers(l, userId, ymd));
    const onWfh = (userId: string, ymd: string) => leaves.some((l) => l.type === 'wfh' && covers(l, userId, ymd));
    // v30: late only after the start time plus the grace (15 minutes by default).
    const isLate = (checkIn: Date | null) => lateMinutes(checkIn, cal) > 0;

    // Today
    const todayInfo = this.dayKind(today, cal);
    const todayKind = todayInfo.kind;
    const nowMin = istMinutes(new Date());
    const board = users.map((u) => {
      const r = att.get(`${u.id}|${today}`);
      let status: AttendanceToday;
      if (r?.checkOut) status = 'checked_out';
      else if (r?.checkIn) status = 'checked_in';
      else if (todayKind === 'holiday') status = 'holiday';
      else if (todayKind === 'weekend') status = 'day_off';
      else if (onLeave(u.id, today)) status = 'on_leave';
      else status = nowMin <= startMin + cal.graceMinutes ? 'not_yet' : 'absent';
      return {
        user: { id: u.id, name: u.name, department: u.department?.name ?? null },
        status,
        checkIn: r?.checkIn?.toISOString() ?? null,
        checkOut: r?.checkOut?.toISOString() ?? null,
        late: isLate(r?.checkIn ?? null),
        wfh: onWfh(u.id, today),
      };
    });

    // Month grid
    const days = monthDays.map((date) => ({ date, ...this.dayKind(date, cal) }));
    const late: AttendanceView['late'] = [];
    const grid = users.map((u) => {
      let present = 0;
      let leave = 0;
      let absent = 0;
      let missedOut = 0;
      const cells = days.map(({ date, kind }): AttendanceCell => {
        const r = att.get(`${u.id}|${date}`);
        if (r?.checkIn) {
          present++;
          const lateBy = isLate(r.checkIn);
          if (lateBy) late.push({ user: { id: u.id, name: u.name }, date, checkIn: r.checkIn.toISOString(), minutesLate: istMinutes(r.checkIn) - startMin });
          // v30: a past day with a check-in and no check-out.
          if (!r.checkOut && date < today) {
            missedOut++;
            return 'missed_out';
          }
          return lateBy ? 'late' : 'present';
        }
        if (kind === 'holiday') return 'holiday';
        if (kind === 'weekend') return 'weekend';
        if (onLeave(u.id, date)) {
          leave++;
          return 'leave';
        }
        if (date >= today) return 'future';
        if (date < (since.get(u.id) ?? first)) return 'none';
        absent++;
        return 'absent';
      });
      return { user: { id: u.id, name: u.name }, cells, present, leave, absent, missedOut };
    });
    late.sort((a, b) => b.date.localeCompare(a.date) || b.minutesLate - a.minutesLate);

    // Leave balances for the year of the chosen month
    // v31: 1 paid casual + 1 paid sick day a month, carried over within the year; unpaid days counted separately.
    const monthsSoFar = String(y) < today.slice(0, 4) ? 12 : String(y) > today.slice(0, 4) ? 0 : Number(today.slice(5, 7));
    const balances = users.map((u) => {
      const used = { casual: 0, sick: 0, other: 0, wfh: 0 };
      for (const l of leaves.filter((x) => x.userId === u.id && ymdOf(x.to) >= yearStart && ymdOf(x.from) <= yearEnd)) {
        const n = this.workingDays(l.from, l.to, cal, [yearStart, yearEnd]);
        if (l.type === 'wfh') used.wfh += n;
        else if (l.type === 'casual' || l.type === 'sick') {
          used[l.type] += l.paidDays ?? n;
          used.other += l.unpaidDays ?? 0;
        } else used.other += l.unpaidDays ?? n;
      }
      const casualAccrued = paidAccrued('casual', monthsSoFar);
      const sickAccrued = paidAccrued('sick', monthsSoFar);
      return {
        user: { id: u.id, name: u.name },
        casualUsed: used.casual,
        sickUsed: used.sick,
        otherUsed: used.other,
        casualLeft: Math.max(0, casualAccrued - used.casual),
        sickLeft: Math.max(0, sickAccrued - used.sick),
        casualAccrued,
        sickAccrued,
        wfhDays: used.wfh,
      };
    });

    return {
      today,
      todayKind: todayInfo,
      month: m,
      workingHours: { start: cal.start, end: cal.end, days: cal.days, graceMinutes: cal.graceMinutes },
      board,
      days,
      grid,
      late: late.slice(0, 50),
      balances,
      scope: { all: scope.all, departments: scope.departmentNames },
      canRecords: scope.all ? hasRole(me, RECORD_KEEPERS) : scope.departmentIds.length > 0,
      canDownload: hasRole(me, RECORD_KEEPERS),
      canCorrections: await this.canDecideAnyCorrection(me),
    };
  }

  // ---------------------------------------------------------------------------
  // v30: today by department (Founder's and HR's dashboards; Department Heads see their own)

  async today(me: Me): Promise<AttendanceTodaySummary> {
    assertOrgReader(me);
    const cal = await this.calendar(me.orgId);
    const scope = await this.scope(me);
    const today = istDate(new Date());
    const kind = this.dayKind(today, cal);
    const prev = previousWorkingDay(today, cal);
    const users = await this.scopedUsers(me, scope);
    const ids = users.map((u) => u.id);
    const [rows, leaves, prevRows] = await Promise.all([
      this.prisma.attendance.findMany({ where: { orgId: me.orgId, userId: { in: ids }, date: dbDate(today) } }),
      this.prisma.leaveRequest.findMany({ where: { orgId: me.orgId, userId: { in: ids }, status: 'approved', ...AWAY_LEAVE, from: { lte: dbDate(today) }, to: { gte: dbDate(today) } }, select: { userId: true } }),
      prev ? this.prisma.attendance.findMany({ where: { orgId: me.orgId, userId: { in: ids }, date: dbDate(prev), checkIn: { not: null }, checkOut: null }, select: { userId: true } }) : Promise.resolve([]),
    ]);
    const att = new Map(rows.map((r) => [r.userId, r]));
    const away = new Set(leaves.map((l) => l.userId));
    const waitWindow = istMinutes(new Date()) <= hhmmToMin(cal.start) + cal.graceMinutes;
    const groups = new Map<string, AttendanceTodayDept>();
    const blank = (id: string | null, name: string): AttendanceTodayDept => ({ id, name, total: 0, in: 0, late: 0, onLeave: 0, notIn: 0, notYet: 0, checkedOut: 0 });
    for (const u of users) {
      const key = u.departmentId ?? '';
      const g = groups.get(key) ?? blank(u.departmentId, u.department?.name ?? 'No department');
      g.total++;
      const r = att.get(u.id);
      if (r?.checkIn) {
        g.in++;
        if (r.checkOut) g.checkedOut++;
        if (lateMinutes(r.checkIn, cal)) g.late++;
      } else if (kind.kind === 'working') {
        if (away.has(u.id)) g.onLeave++;
        else if (waitWindow) g.notYet++;
        else g.notIn++;
      }
      groups.set(key, g);
    }
    const departments = [...groups.values()].sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || a.name.localeCompare(b.name));
    const totals = { total: 0, in: 0, late: 0, onLeave: 0, notIn: 0, notYet: 0, checkedOut: 0 };
    for (const d of departments) for (const k of Object.keys(totals) as (keyof typeof totals)[]) totals[k] += d[k];
    return {
      today,
      todayKind: kind,
      workingHours: { start: cal.start, end: cal.end, graceMinutes: cal.graceMinutes },
      departments,
      totals,
      missedCheckOutYesterday: prevRows.length,
      scope: { all: scope.all, departments: scope.departmentNames },
    };
  }

  // ---------------------------------------------------------------------------
  // v30: the attendance records sheet, by department with each person's designation

  async records(me: Me, q: { from?: string; to?: string; departmentId?: string }): Promise<AttendanceRecords> {
    assertOrgReader(me);
    const scope = await this.scope(me);
    if (scope.all ? !hasRole(me, RECORD_KEEPERS) : !scope.departmentIds.length) throw new ForbiddenException('The attendance records are kept by the Founder and HR. Department Heads see their own team.');
    const today = istDate(new Date());
    const isYmd = (v?: string) => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(dbDate(v).getTime());
    const from = isYmd(q.from) ? q.from! : `${today.slice(0, 7)}-01`;
    const to = isYmd(q.to) ? q.to! : today;
    if (from > to) throw new BadRequestException('The start date must be on or before the end date');
    if ((dbDate(to).getTime() - dbDate(from).getTime()) / DAY > 366) throw new BadRequestException('Choose up to one year at a time');
    const cal = await this.calendar(me.orgId);

    // Departments the viewer may see and pick.
    const allDepts = await this.prisma.department.findMany({
      where: { orgId: me.orgId, deletedAt: null, ...(scope.all ? {} : { id: { in: scope.departmentIds } }) },
      select: { id: true, name: true, branch: { select: { name: true } } },
      orderBy: { name: 'asc' },
    });
    if (q.departmentId === 'none' ? !scope.all : q.departmentId && !allDepts.some((d) => d.id === q.departmentId)) throw new ForbiddenException('You cannot see that department');
    const deptFilter = q.departmentId === 'none' ? { departmentId: null } : q.departmentId ? { departmentId: q.departmentId } : scope.all ? {} : { departmentId: { in: scope.departmentIds } };

    // Everyone active, plus anyone who has attendance in the range (e.g. left since).
    const users = await this.prisma.user.findMany({
      where: {
        orgId: me.orgId,
        type: 'staff',
        deletedAt: null,
        ...deptFilter,
        OR: [{ status: 'active' }, { attendance: { some: { date: { gte: dbDate(from), lte: dbDate(to) } } } }],
      },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true, createdAt: true, specialty: true, departmentId: true, roles: { select: { role: { select: { name: true } } } } },
    });
    const ids = users.map((u) => u.id);
    const [rows, leaves, firsts] = await Promise.all([
      this.prisma.attendance.findMany({ where: { orgId: me.orgId, userId: { in: ids }, date: { gte: dbDate(from), lte: dbDate(to) } } }),
      this.prisma.leaveRequest.findMany({ where: { orgId: me.orgId, userId: { in: ids }, status: 'approved', from: { lte: dbDate(to) }, to: { gte: dbDate(from) } }, select: { userId: true, from: true, to: true, type: true } }),
      this.prisma.attendance.groupBy({ by: ['userId'], where: { orgId: me.orgId, userId: { in: ids } }, _min: { date: true } }),
    ]);
    const att = new Map(rows.map((r) => [`${r.userId}|${ymdOf(r.date)}`, r]));
    const since = new Map(
      users.map((u) => {
        const first = firsts.find((f) => f.userId === u.id)?._min.date;
        const created = istDate(u.createdAt);
        return [u.id, first && ymdOf(first) < created ? ymdOf(first) : created];
      }),
    );
    const dates: string[] = [];
    for (let d = from; d <= to; d = addDays(d, 1)) dates.push(d);
    const kinds = new Map(dates.map((d) => [d, this.dayKind(d, cal)]));
    const pastStart = istMinutes(new Date()) > hhmmToMin(cal.start) + cal.graceMinutes;
    const zero = (): AttendanceRecordTotals => ({ workingDays: 0, present: 0, late: 0, missedOut: 0, leave: 0, absent: 0, hours: 0 });
    const add = (t: AttendanceRecordTotals, x: AttendanceRecordTotals) => {
      for (const k of Object.keys(t) as (keyof AttendanceRecordTotals)[]) t[k] += x[k];
    };

    const person = (u: (typeof users)[number]): AttendanceRecordPerson => {
      const totals = zero();
      const days = dates.map((date): AttendanceRecordDay => {
        const k = kinds.get(date)!;
        const r = att.get(`${u.id}|${date}`);
        const covering = leaves.filter((l) => l.userId === u.id && ymdOf(l.from) <= date && ymdOf(l.to) >= date);
        const leave = covering.find((l) => isAwayLeave(l.type));
        const wfh = covering.some((l) => l.type === 'wfh');
        const hours = r?.checkIn && r.checkOut ? Math.round(((r.checkOut.getTime() - r.checkIn.getTime()) / 3_600_000) * 100) / 100 : 0;
        const base = { date, kind: k.kind, label: k.label, checkIn: r?.checkIn?.toISOString() ?? null, checkOut: r?.checkOut?.toISOString() ?? null, hours, lateMinutes: 0, corrected: !!r?.corrected, leaveType: null as string | null, wfh };
        const tracked = date >= (since.get(u.id) ?? from);
        if (k.kind === 'working' && tracked && date <= today) totals.workingDays++;
        totals.hours += hours;
        if (r?.checkIn) {
          if (k.kind !== 'working') return { ...base, status: 'worked_off_day' };
          totals.present++;
          const lateBy = lateMinutes(r.checkIn, cal);
          const missed = !r.checkOut && date < today;
          if (lateBy) totals.late++;
          if (missed) totals.missedOut++;
          return { ...base, lateMinutes: lateBy, status: lateBy && missed ? 'late_missed_out' : lateBy ? 'late' : missed ? 'missed_out' : 'present' };
        }
        if (k.kind === 'holiday') return { ...base, status: 'holiday' };
        if (k.kind === 'weekend') return { ...base, status: 'weekend' };
        if (leave) {
          totals.leave++;
          return { ...base, status: 'leave', leaveType: leave.type };
        }
        if (date > today || (date === today && !pastStart)) return { ...base, status: 'future' };
        if (!tracked) return { ...base, status: 'not_tracked' };
        totals.absent++;
        return { ...base, status: 'absent' };
      });
      totals.hours = Math.round(totals.hours * 100) / 100;
      const roles = [...new Set(u.roles.map((r) => r.role.name))];
      const spec = craftSpecialtyLabel(u.specialty);
      const designation = [roles.join(' / '), spec].filter(Boolean).join(' – ') || 'Team member';
      return { user: { id: u.id, name: u.name, email: u.email ?? '' }, designation, days, totals };
    };

    const byDept = new Map<string, AttendanceRecordDepartment>();
    for (const u of users) {
      const d = u.departmentId ? allDepts.find((x) => x.id === u.departmentId) : undefined;
      const key = d?.id ?? '';
      const g = byDept.get(key) ?? { id: d?.id ?? null, name: d?.name ?? 'No department', branch: d?.branch.name ?? null, people: [], totals: zero() };
      const p = person(u);
      g.people.push(p);
      add(g.totals, p.totals);
      byDept.set(key, g);
    }
    for (const g of byDept.values()) g.totals.hours = Math.round(g.totals.hours * 100) / 100;
    const departments = [...byDept.values()].sort((a, b) => (a.id ? 0 : 1) - (b.id ? 0 : 1) || a.name.localeCompare(b.name));
    return {
      from,
      to,
      generatedAt: new Date().toISOString(),
      workingHours: { start: cal.start, end: cal.end, days: cal.days, graceMinutes: cal.graceMinutes },
      departments,
      departmentOptions: allDepts.map((d) => ({ id: d.id, name: allDepts.filter((x) => x.name === d.name).length > 1 ? `${d.name} (${d.branch.name})` : d.name })),
      canDownload: hasRole(me, RECORD_KEEPERS),
    };
  }

  // ---------------------------------------------------------------------------
  // v30: attendance corrections: the employee asks, their manager or HR (Founder, Branch Manager) decides

  private async correctionRows(
    me: Me,
    list: { id: string; userId: string; date: Date; checkIn: Date; checkOut: Date; recordedCheckIn: Date | null; recordedCheckOut: Date | null; reason: string; status: string; decidedById: string | null; decidedAt: Date | null; decisionNote: string | null; createdAt: Date }[],
  ): Promise<AttendanceCorrectionRow[]> {
    const ids = [...new Set(list.flatMap((c) => [c.userId, c.decidedById].filter(Boolean) as string[]))];
    const users = ids.length ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, managerId: true } }) : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    return list.map((c) => {
      const u = byId.get(c.userId);
      const d = c.decidedById ? byId.get(c.decidedById) : undefined;
      return {
        id: c.id,
        user: { id: c.userId, name: u?.name ?? 'Former member' },
        date: ymdOf(c.date),
        recorded: { checkIn: c.recordedCheckIn?.toISOString() ?? null, checkOut: c.recordedCheckOut?.toISOString() ?? null },
        requested: { checkIn: c.checkIn.toISOString(), checkOut: c.checkOut.toISOString() },
        reason: c.reason,
        status: c.status as AttendanceCorrectionRow['status'],
        decidedBy: d ? { id: d.id, name: d.name } : null,
        decidedAt: c.decidedAt?.toISOString() ?? null,
        decisionNote: c.decisionNote,
        createdAt: c.createdAt.toISOString(),
        canDecide: c.status === 'pending' && !!u && this.canDecide(me, u),
      };
    });
  }

  async myCorrections(me: Me): Promise<AttendanceCorrectionRow[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const list = await this.prisma.attendanceCorrection.findMany({ where: { orgId: me.orgId, userId: me.id }, orderBy: { createdAt: 'desc' }, take: 50 });
    return this.correctionRows(me, list);
  }

  async requestCorrection(me: Me, input: AttendanceCorrectionInput, ip?: string): Promise<AttendanceCorrectionRow[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const today = istDate(new Date());
    if (input.date > today) throw new BadRequestException('You can only correct today or an earlier day');
    if (input.date < addDays(today, -ATTENDANCE_CORRECTION_DAYS)) throw new BadRequestException(`Corrections can go back ${ATTENDANCE_CORRECTION_DAYS} days`);
    const cal = await this.calendar(me.orgId);
    const k = this.dayKind(input.date, cal);
    if (k.kind !== 'working') throw new BadRequestException(k.kind === 'holiday' ? `${dayLabel(input.date)} is a holiday (${k.label}). No attendance is needed.` : `${dayLabel(input.date)} is a weekly off. No attendance is needed.`);
    const checkIn = istAt(input.date, input.checkIn);
    const checkOut = istAt(input.date, input.checkOut);
    if (checkOut.getTime() > Date.now()) throw new BadRequestException('The check-out time is still ahead. Ask after you finish, or check out from My Day.');
    const open = await this.prisma.attendanceCorrection.findFirst({ where: { userId: me.id, date: dbDate(input.date), status: 'pending' } });
    if (open) throw new BadRequestException(`You already asked to correct ${dayLabel(input.date)}. Wait for the decision or cancel it first.`);
    const rec = await this.prisma.attendance.findUnique({ where: { userId_date: { userId: me.id, date: dbDate(input.date) } } });
    const row = await this.prisma.attendanceCorrection.create({
      data: { orgId: me.orgId, userId: me.id, date: dbDate(input.date), checkIn, checkOut, recordedCheckIn: rec?.checkIn ?? null, recordedCheckOut: rec?.checkOut ?? null, reason: input.reason },
    });
    await this.audit.log(me, 'attendance.correction_requested', 'AttendanceCorrection', row.id, rec ? { checkIn: rec.checkIn, checkOut: rec.checkOut } : undefined, { ...input }, ip);
    // The manager decides; people without an active manager go to HR.
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { managerId: true, manager: { select: { status: true, deletedAt: true } } } });
    const hasManager = !!user.managerId && user.manager?.status !== 'suspended' && !user.manager?.deletedAt;
    const to = hasManager
      ? [user.managerId!]
      : (await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, id: { not: me.id }, roles: { some: { role: { baseRole: 'hr_ops' } } } }, select: { id: true } })).map((u) => u.id);
    await this.notifications.notify(me.orgId, to, {
      kind: 'attendance_correction',
      title: `${me.name} asked to correct attendance for ${dayLabel(input.date)}`,
      body: `In ${input.checkIn}, out ${input.checkOut}: ${input.reason}`,
      link: hasManager ? '/team/approvals' : '/admin/attendance#corrections',
    });
    return this.myCorrections(me);
  }

  async cancelCorrection(me: Me, id: string, ip?: string): Promise<AttendanceCorrectionRow[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const row = await this.prisma.attendanceCorrection.findFirst({ where: { id, userId: me.id } });
    if (!row) throw new NotFoundException('Correction request not found');
    if (row.status !== 'pending') throw new BadRequestException('Only a request waiting for a decision can be cancelled');
    await this.prisma.attendanceCorrection.update({ where: { id }, data: { status: 'cancelled' } });
    await this.audit.log(me, 'attendance.correction_cancelled', 'AttendanceCorrection', id, { status: 'pending' }, { status: 'cancelled' }, ip);
    return this.myCorrections(me);
  }

  /** Requests the viewer can decide (and recent decided ones): HR, Branch Manager and the Founder see all; managers their reports. */
  async corrections(me: Me): Promise<AttendanceCorrectionRow[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const all = isLeaveDecider(me);
    const reports = all ? [] : await this.reportIds(me);
    if (!all && !reports.length) return [];
    const list = await this.prisma.attendanceCorrection.findMany({
      where: { orgId: me.orgId, ...(all ? {} : { userId: { in: reports } }) },
      orderBy: { createdAt: 'desc' },
      take: 200,
    });
    const rows = await this.correctionRows(me, list);
    return rows.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
  }

  async decideCorrection(me: Me, id: string, input: DecideLeave, ip?: string): Promise<AttendanceCorrectionRow> {
    const c = await this.prisma.attendanceCorrection.findFirst({ where: { id, orgId: me.orgId } });
    if (!c) throw new NotFoundException('Correction request not found');
    if (c.status !== 'pending') throw new ConflictException(`This request was already ${c.status}`);
    const requester = await this.prisma.user.findUniqueOrThrow({ where: { id: c.userId }, select: { id: true, name: true, managerId: true } });
    if (!this.canDecide(me, requester)) throw new ForbiddenException('Only their manager, HR, Branch Manager or the Founder can decide this');
    const note = input.note?.trim() || null;
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const updated = await this.prisma.$transaction(async (tx) => {
      if (status === 'approved') {
        await tx.attendance.upsert({
          where: { userId_date: { userId: c.userId, date: c.date } },
          update: { checkIn: c.checkIn, checkOut: c.checkOut, corrected: true },
          create: { userId: c.userId, date: c.date, orgId: c.orgId, checkIn: c.checkIn, checkOut: c.checkOut, corrected: true },
        });
      }
      return tx.attendanceCorrection.update({ where: { id }, data: { status, decidedById: me.id, decidedAt: new Date(), decisionNote: note } });
    });
    await this.audit.log(me, `attendance.correction_${status}`, 'AttendanceCorrection', id, { checkIn: c.recordedCheckIn, checkOut: c.recordedCheckOut }, { status, checkIn: c.checkIn, checkOut: c.checkOut, note }, ip);
    await this.notifications.notify(me.orgId, [c.userId], {
      kind: 'attendance_correction',
      title: `Your attendance correction for ${dayLabel(ymdOf(c.date))} was ${status}`,
      body: note ? `${me.name}: ${note}` : `Decided by ${me.name}`,
      link: '/team/profile',
    });
    return (await this.correctionRows(me, [updated]))[0];
  }

  // ---------------------------------------------------------------------------
  // Leave requests

  private async reportIds(me: Me) {
    const reports = await this.prisma.user.findMany({ where: { orgId: me.orgId, managerId: me.id, deletedAt: null }, select: { id: true } });
    return reports.map((r) => r.id);
  }

  /** Attendance corrections: the person's manager, or HR, Branch Manager and the Founder. */
  private canDecide(me: Me, requester: { id: string; managerId: string | null }) {
    if (me.type !== 'staff' || requester.id === me.id) return false;
    if (isLeaveDecider(me)) return true;
    return requester.managerId === me.id;
  }

  /** v31: the step a pending request is at: the Department Head ("head"; older rows say "manager"), then HR. */
  private leaveStage(l: { userId: string; stage: string }, routing: LeaveRouting): 'head' | 'hr' {
    return l.stage === 'hr' || !routing.headOf(l.userId) ? 'hr' : 'head';
  }

  /** v31: the Department Head decides first; then HR (HR of the same branch for a Department Head's own leave). */
  private canDecideLeave(me: Me, l: { userId: string; stage: string; status: string }, routing: LeaveRouting) {
    if (me.type !== 'staff' || l.status !== 'pending' || l.userId === me.id) return false;
    return this.leaveStage(l, routing) === 'head' ? routing.headOf(l.userId) === me.id : routing.hrFor(l.userId).includes(me.id);
  }

  /** Founder, Branch Manager and HR see every request; a Department Head sees their department's. */
  async leave(me: Me): Promise<LeaveRow[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const routing = await loadLeaveRouting(this.prisma, me.orgId);
    const all = isLeaveDecider(me);
    const list = await this.prisma.leaveRequest.findMany({ where: { orgId: me.orgId }, orderBy: { createdAt: 'desc' }, take: 500 });
    const mine = all ? list : list.filter((l) => routing.headOf(l.userId) === me.id || this.canDecideLeave(me, l, routing));
    return this.rows(me, mine.slice(0, 300), routing);
  }

  private async rows(
    me: Me,
    list: { id: string; userId: string; from: Date; to: Date; type: string; reason: string | null; status: LeaveRow['status']; decidedById: string | null; decidedAt: Date | null; createdAt: Date; stage: string; managerDecidedById: string | null; decisionNote: string | null; paidDays: number | null; unpaidDays: number | null }[],
    routingIn?: LeaveRouting,
  ) {
    const cal = await this.calendar(me.orgId);
    const routing = routingIn ?? (await loadLeaveRouting(this.prisma, me.orgId));
    const userIds = [...new Set(list.flatMap((l) => [l.userId, l.decidedById, l.managerDecidedById].filter(Boolean) as string[]))];
    const live = list.filter((l) => l.status === 'pending' || (l.status === 'approved' && ymdOf(l.to) >= istDate(new Date())));
    const openTasks = live.length
      ? await this.prisma.task.findMany({
          where: { orgId: me.orgId, ownerId: { in: [...new Set(live.map((l) => l.userId))] }, status: { in: ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] }, deadline: { not: null } },
          select: { ownerId: true, deadline: true },
        })
      : [];
    const users = await this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true, managerId: true } });
    const byId = new Map(users.map((u) => [u.id, u]));
    const rows = list.map((l): LeaveRow => {
      const u = byId.get(l.userId);
      const d = l.decidedById ? byId.get(l.decidedById) : undefined;
      return {
        id: l.id,
        user: { id: l.userId, name: u?.name ?? 'Former member' },
        from: ymdOf(l.from),
        to: ymdOf(l.to),
        type: l.type,
        reason: l.reason,
        status: l.status,
        workingDays: this.workingDays(l.from, l.to, cal),
        decidedBy: d ? { id: d.id, name: d.name } : null,
        decidedAt: l.decidedAt?.toISOString() ?? null,
        createdAt: l.createdAt.toISOString(),
        canDecide: !!u && this.canDecideLeave(me, l, routing),
        stage: l.status === 'pending' ? this.leaveStage(l, routing) : 'done',
        paidDays: l.paidDays ?? (l.type === 'casual' || l.type === 'sick' ? this.workingDays(l.from, l.to, cal) : 0),
        unpaidDays: l.unpaidDays ?? (l.type === 'unpaid' ? this.workingDays(l.from, l.to, cal) : 0),
        managerDecidedBy: l.managerDecidedById && byId.get(l.managerDecidedById) ? { id: l.managerDecidedById, name: byId.get(l.managerDecidedById)!.name } : null,
        decisionNote: l.decisionNote,
        tasksDuringLeave: openTasks.filter((t) => t.ownerId === l.userId && istDate(t.deadline!) >= ymdOf(l.from) && istDate(t.deadline!) <= ymdOf(l.to)).length,
      };
    });
    return rows.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending'));
  }

  async decide(me: Me, id: string, input: DecideLeave, ip?: string): Promise<LeaveRow> {
    const l = await this.prisma.leaveRequest.findFirst({ where: { id, orgId: me.orgId } });
    if (!l) throw new NotFoundException('Leave request not found');
    const requester = await this.prisma.user.findUniqueOrThrow({ where: { id: l.userId }, select: { id: true, name: true, managerId: true } });
    if (l.status !== 'pending') throw new ConflictException(`This leave was already ${l.status}`);
    const routing = await loadLeaveRouting(this.prisma, me.orgId);
    const stage = this.leaveStage(l, routing);
    if (!this.canDecideLeave(me, l, routing)) {
      throw new ForbiddenException(stage === 'hr' ? 'This request is waiting for HR to make the final decision.' : 'This request is waiting for the Department Head first.');
    }
    const cal = await this.calendar(me.orgId);
    const days = this.workingDays(l.from, l.to, cal);
    const range = ymdOf(l.from) === ymdOf(l.to) ? dayLabel(ymdOf(l.from)) : `${dayLabel(ymdOf(l.from))} to ${dayLabel(ymdOf(l.to))}`;
    const note = input.note?.trim() || null;
    const what = l.type === 'wfh' ? 'work from home' : `${l.type} leave`;

    // v31: the Department Head approves: it goes on to HR for the final call. The employee is not told about this step.
    if (stage === 'head' && input.decision === 'approve') {
      const updated = await this.prisma.leaveRequest.update({ where: { id }, data: { stage: 'hr', managerDecidedById: me.id, managerDecidedAt: new Date(), decisionNote: note } });
      await this.audit.log(me, 'leave.head_approved', 'LeaveRequest', id, { stage: l.stage }, { stage: 'hr', note }, ip);
      await this.notifications.notify(me.orgId, routing.hrFor(l.userId), {
        kind: 'leave_request',
        title: `${requester.name}'s ${days}-day ${what} needs your final decision`,
        body: `${range}. Approved by the Department Head (${me.name}).${note ? ` Note: ${note}` : ''}`,
        link: '/admin/attendance#leave',
      });
      return (await this.rows(me, [updated], routing))[0];
    }

    // Final: HR decides, or the Department Head rejects (a rejection ends it).
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, stage: 'done', decidedById: me.id, decidedAt: new Date(), decisionNote: note, ...(stage === 'head' ? { managerDecidedById: me.id, managerDecidedAt: new Date() } : {}) },
    });
    await this.audit.log(me, `leave.${status}`, 'LeaveRequest', id, { status: l.status, stage: l.stage }, { status, stage, note }, ip);
    // The employee sees only the result, worded for the kind of request; never who decided or the steps in between.
    const msg = leaveDecisionMessage(l.type, status, range, l.paidDays !== null && l.unpaidDays !== null ? { paid: l.paidDays, unpaid: l.unpaidDays } : undefined);
    await this.notifications.notify(me.orgId, [l.userId], { kind: 'leave_request', title: msg.title, body: msg.body, link: '/team/profile' });
    if (status === 'approved' && isAwayLeave(l.type)) await this.flagCover(me, updated, requester, range, routing);
    return (await this.rows(me, [updated], routing))[0];
  }

  /** Tasks due while someone is away: tell their manager (or HR) so the work gets reassigned. */
  private async flagCover(me: Me, l: { id: string; userId: string; from: Date; to: Date }, requester: { name: string; managerId: string | null }, range: string, routing: LeaveRouting) {
    const tasks = await this.prisma.task.count({
      where: {
        orgId: me.orgId,
        ownerId: l.userId,
        status: { in: ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] },
        deadline: { gte: new Date(`${ymdOf(l.from)}T00:00:00+05:30`), lt: new Date(new Date(`${ymdOf(l.to)}T00:00:00+05:30`).getTime() + DAY) },
      },
    });
    if (!tasks) return;
    // v31: the Department Head reassigns the work (HR when there is none).
    const head = routing.headOf(l.userId);
    const to = head ? [head] : routing.hrFor(l.userId);
    await this.notifications.notify(me.orgId, to, {
      kind: 'leave_cover',
      title: `${requester.name} is on leave ${range}: ${tasks} task${tasks > 1 ? 's' : ''} due. Reassign?`,
      link: `/team/leave/${l.id}/cover`,
      critical: true,
    });
  }
}
