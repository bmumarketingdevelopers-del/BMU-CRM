import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  LEAVE_ALLOWANCE,
  istDate,
  isWorkingDay,
  type AttendanceCell,
  type AttendanceToday,
  type AttendanceView,
  type DecideLeave,
  type LeaveRow,
  type Me,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { assertOrgReader, isLeaveDecider } from './access.js';

const DAY = 86_400_000;
/** Leave longer than this many working days also needs HR after the manager. */
export const LONG_LEAVE_DAYS = 3;
/** A @db.Date column value for yyyy-mm-dd. */
const dbDate = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
const ymdOf = (d: Date) => d.toISOString().slice(0, 10);
const istMinutes = (d: Date) => {
  const ist = new Date(d.getTime() + 330 * 60_000);
  return ist.getUTCHours() * 60 + ist.getUTCMinutes();
};
const hhmmToMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3, 5));

type Calendar = { holidays: { date: string; name: string }[]; days: number[]; start: string; end: string };

/** Today's attendance board, the month grid, late check-ins, leave requests and balances. */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  private async calendar(orgId: string): Promise<Calendar> {
    const [h, wh] = await Promise.all([this.settings.get(orgId, 'holidays'), this.settings.get(orgId, 'workingHours')]);
    return { holidays: h.list, days: wh.days, start: wh.start, end: wh.end };
  }

  /** "working" | "weekend" | "holiday" for an IST calendar date. */
  private dayKind(ymd: string, cal: Calendar): { kind: 'working' | 'weekend' | 'holiday'; label: string | null } {
    const holiday = cal.holidays.find((h) => h.date === ymd);
    if (holiday) return { kind: 'holiday', label: holiday.name };
    const noonIst = new Date(`${ymd}T12:00:00+05:30`);
    const dow = dbDate(ymd).getUTCDay();
    if (!isWorkingDay(noonIst, []) || !cal.days.includes(dow)) return { kind: 'weekend', label: null };
    return { kind: 'working', label: null };
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

    const [y, mo] = m.split('-').map(Number);
    const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    const monthDays = Array.from({ length: daysInMonth }, (_, i) => `${m}-${String(i + 1).padStart(2, '0')}`);
    const first = monthDays[0];
    const last = monthDays[monthDays.length - 1];
    const yearStart = `${y}-01-01`;
    const yearEnd = `${y}-12-31`;

    const users = await this.prisma.user.findMany({
      where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null },
      orderBy: { name: 'asc' },
      select: { id: true, name: true, createdAt: true, department: { select: { name: true } } },
    });
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
    const onLeave = (userId: string, ymd: string) => leaves.some((l) => l.userId === userId && ymdOf(l.from) <= ymd && ymdOf(l.to) >= ymd);
    const isLate = (checkIn: Date | null) => !!checkIn && istMinutes(checkIn) > startMin;

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
      else status = nowMin < startMin ? 'not_yet' : 'absent';
      return {
        user: { id: u.id, name: u.name, department: u.department?.name ?? null },
        status,
        checkIn: r?.checkIn?.toISOString() ?? null,
        checkOut: r?.checkOut?.toISOString() ?? null,
        late: isLate(r?.checkIn ?? null),
      };
    });

    // Month grid
    const days = monthDays.map((date) => ({ date, ...this.dayKind(date, cal) }));
    const late: AttendanceView['late'] = [];
    const grid = users.map((u) => {
      let present = 0;
      let leave = 0;
      let absent = 0;
      const cells = days.map(({ date, kind }): AttendanceCell => {
        const r = att.get(`${u.id}|${date}`);
        if (r?.checkIn) {
          present++;
          if (isLate(r.checkIn)) {
            late.push({ user: { id: u.id, name: u.name }, date, checkIn: r.checkIn.toISOString(), minutesLate: istMinutes(r.checkIn) - startMin });
            return 'late';
          }
          return 'present';
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
      return { user: { id: u.id, name: u.name }, cells, present, leave, absent };
    });
    late.sort((a, b) => b.date.localeCompare(a.date) || b.minutesLate - a.minutesLate);

    // Leave balances for the year of the chosen month
    const balances = users.map((u) => {
      const used = { casual: 0, sick: 0, other: 0 };
      for (const l of leaves.filter((x) => x.userId === u.id)) {
        const n = this.workingDays(l.from, l.to, cal, [yearStart, yearEnd]);
        const key = l.type === 'casual' || l.type === 'sick' ? l.type : 'other';
        used[key] += n;
      }
      return {
        user: { id: u.id, name: u.name },
        casualUsed: used.casual,
        sickUsed: used.sick,
        otherUsed: used.other,
        casualLeft: Math.max(0, LEAVE_ALLOWANCE.casual - used.casual),
        sickLeft: Math.max(0, LEAVE_ALLOWANCE.sick - used.sick),
      };
    });

    return { today, todayKind: todayInfo, month: m, workingHours: { start: cal.start, end: cal.end, days: cal.days }, board, days, grid, late: late.slice(0, 50), balances };
  }

  // ---------------------------------------------------------------------------
  // Leave requests

  private async reportIds(me: Me) {
    const reports = await this.prisma.user.findMany({ where: { orgId: me.orgId, managerId: me.id, deletedAt: null }, select: { id: true } });
    return reports.map((r) => r.id);
  }

  /** v10 chain: the manager decides first; leave over 3 working days then needs HR. HR, Admin and the Founder can decide at any stage. */
  private canDecide(me: Me, requester: { id: string; managerId: string | null }, stage = 'manager') {
    if (me.type !== 'staff' || requester.id === me.id) return false;
    if (isLeaveDecider(me)) return true;
    return stage === 'manager' && requester.managerId === me.id;
  }

  async leave(me: Me): Promise<LeaveRow[]> {
    if (me.type !== 'staff') throw new ForbiddenException('Team only');
    const all = isLeaveDecider(me);
    const reports = all ? [] : await this.reportIds(me);
    if (!all && !reports.length) return [];
    const list = await this.prisma.leaveRequest.findMany({
      where: { orgId: me.orgId, ...(all ? {} : { userId: { in: reports } }) },
      orderBy: { createdAt: 'desc' },
      take: 300,
    });
    return this.rows(me, list);
  }

  private async rows(
    me: Me,
    list: { id: string; userId: string; from: Date; to: Date; type: string; reason: string | null; status: LeaveRow['status']; decidedById: string | null; decidedAt: Date | null; createdAt: Date; stage: string; managerDecidedById: string | null; decisionNote: string | null }[],
  ) {
    const cal = await this.calendar(me.orgId);
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
        canDecide: l.status === 'pending' && !!u && this.canDecide(me, u, l.stage),
        stage: (l.status === 'pending' ? (l.stage === 'hr' ? 'hr' : 'manager') : 'done') as LeaveRow['stage'],
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
    if (!this.canDecide(me, requester, l.stage)) {
      throw new ForbiddenException(l.stage === 'hr' ? 'This leave is waiting for HR. Only HR, Admin or the Founder can decide it now.' : 'Only HR, Admin, the Founder or their manager can decide this leave');
    }
    const cal = await this.calendar(me.orgId);
    const days = this.workingDays(l.from, l.to, cal);
    const range = ymdOf(l.from) === ymdOf(l.to) ? ymdOf(l.from) : `${ymdOf(l.from)} to ${ymdOf(l.to)}`;
    const note = input.note?.trim() || null;

    // Manager approves a long leave: it moves on to HR instead of being final.
    if (input.decision === 'approve' && l.stage !== 'hr' && days > LONG_LEAVE_DAYS && !isLeaveDecider(me)) {
      const updated = await this.prisma.leaveRequest.update({ where: { id }, data: { stage: 'hr', managerDecidedById: me.id, managerDecidedAt: new Date(), decisionNote: note } });
      await this.audit.log(me, 'leave.manager_approved', 'LeaveRequest', id, { stage: l.stage }, { stage: 'hr', note }, ip);
      const hr = await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'hr_ops' } } } }, select: { id: true } });
      await this.notifications.notify(me.orgId, hr.map((h) => h.id), { kind: 'leave_request', title: `${requester.name}'s ${days}-day ${l.type} leave needs HR approval`, body: `${range}. Approved by ${me.name}.`, link: '/admin/attendance#leave' });
      await this.notifications.notify(me.orgId, [l.userId], { kind: 'leave_request', title: `${me.name} approved your leave (${range}). It now goes to HR.`, body: note ?? undefined, link: '/team/profile' });
      return (await this.rows(me, [updated]))[0];
    }

    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, stage: 'done', decidedById: me.id, decidedAt: new Date(), decisionNote: note, ...(l.stage === 'manager' && requester.managerId === me.id ? { managerDecidedById: me.id, managerDecidedAt: new Date() } : {}) },
    });
    await this.audit.log(me, `leave.${status}`, 'LeaveRequest', id, { status: l.status, stage: l.stage }, { status, note }, ip);
    await this.notifications.notify(me.orgId, [l.userId], {
      kind: 'leave_request',
      title: `Your ${l.type} leave (${range}) was ${status}`,
      body: note ? `${me.name}: ${note}` : `Decided by ${me.name}`,
      link: '/team/profile',
    });
    if (status === 'approved') await this.flagCover(me, updated, requester, range);
    return (await this.rows(me, [updated]))[0];
  }

  /** Tasks due while someone is away: tell their manager (or HR) so the work gets reassigned. */
  private async flagCover(me: Me, l: { id: string; userId: string; from: Date; to: Date }, requester: { name: string; managerId: string | null }, range: string) {
    const tasks = await this.prisma.task.count({
      where: {
        orgId: me.orgId,
        ownerId: l.userId,
        status: { in: ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] },
        deadline: { gte: new Date(`${ymdOf(l.from)}T00:00:00+05:30`), lt: new Date(new Date(`${ymdOf(l.to)}T00:00:00+05:30`).getTime() + DAY) },
      },
    });
    if (!tasks) return;
    const to = requester.managerId ? [requester.managerId] : (await this.prisma.user.findMany({ where: { orgId: me.orgId, type: 'staff', status: 'active', roles: { some: { role: { baseRole: 'hr_ops' } } } }, select: { id: true } })).map((u) => u.id);
    await this.notifications.notify(me.orgId, to, {
      kind: 'leave_cover',
      title: `${requester.name} is on leave ${range}: ${tasks} task${tasks > 1 ? 's' : ''} due. Reassign?`,
      link: `/team/leave/${l.id}/cover`,
      critical: true,
    });
  }
}
