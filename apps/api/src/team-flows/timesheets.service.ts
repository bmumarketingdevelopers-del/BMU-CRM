import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  TEAM_TIME_CATEGORIES,
  istDate,
  type Me,
  type TeamDecideTimesheet,
  type TeamTimeCategory,
  type TeamTimeEntryInput,
  type TeamTimesheet,
  type TeamTimesheetRow,
  type TeamTimesheetStatus,
} from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { addDays, dayStr, dbDay, hasRole, isHrApprover, isStaff, mondayOf } from './access.js';

const LOCKED: TeamTimesheetStatus[] = ['submitted', 'approved'];

/** Weekly timesheets built from task time logs plus manual entries; submitted to the manager for approval. */
@Injectable()
export class TimesheetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly notifications: NotificationsService,
  ) {}

  private weekOf(raw?: string) {
    if (raw && !/^\d{4}-\d{2}-\d{2}$/.test(raw)) throw new BadRequestException('Use a date like 2026-10-05');
    return mondayOf(raw ?? istDate(new Date()));
  }

  /** Whether `me` approves this person's timesheets: their manager, their department head, or HR/Branch Manager/Founder. */
  private async approverOf(me: Me, user: { id: string; managerId: string | null; departmentId: string | null }) {
    if (!isStaff(me) || me.id === user.id) return false;
    if (isHrApprover(me) || user.managerId === me.id) return true;
    if (hasRole(me, 'department_head') && user.departmentId) {
      return !!(await this.prisma.department.findFirst({ where: { id: user.departmentId, headUserId: me.id } }));
    }
    return false;
  }

  private async person(me: Me, userId: string) {
    const u = await this.prisma.user.findFirst({ where: { id: userId, orgId: me.orgId, type: 'staff' }, select: { id: true, name: true, managerId: true, departmentId: true } });
    if (!u) throw new NotFoundException('Person not found');
    return u;
  }

  async week(me: Me, weekRaw?: string, userId?: string): Promise<TeamTimesheet> {
    if (!isStaff(me)) throw new ForbiddenException('Team accounts only');
    const weekStart = this.weekOf(weekRaw);
    const user = await this.person(me, userId ?? me.id);
    const canDecideFor = await this.approverOf(me, user);
    if (user.id !== me.id && !canDecideFor) throw new ForbiddenException("You can only see your own timesheet or your team's");
    const weekEnd = addDays(weekStart, 6);
    const [sheet, entries, holidays, hours] = await Promise.all([
      this.prisma.timesheet.findUnique({ where: { userId_weekStart: { userId: user.id, weekStart: dbDay(weekStart) } } }),
      this.prisma.timeEntry.findMany({ where: { userId: user.id, date: { gte: dbDay(weekStart), lte: dbDay(weekEnd) } }, orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
      this.settings.get(me.orgId, 'holidays'),
      this.settings.get(me.orgId, 'workingHours'),
    ]);
    const taskIds = [...new Set(entries.map((e) => e.taskId).filter((x): x is string => !!x))];
    const engIds = [...new Set(entries.map((e) => e.engagementId).filter((x): x is string => !!x))];
    const [tasks, engagements, decider] = await Promise.all([
      this.prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true, title: true } }),
      this.prisma.engagement.findMany({ where: { id: { in: engIds } }, select: { id: true, clientOrg: { select: { name: true } } } }),
      sheet?.decidedById ? this.prisma.user.findUnique({ where: { id: sheet.decidedById }, select: { name: true } }) : null,
    ]);
    const status = (sheet?.status ?? 'draft') as TeamTimesheetStatus;
    const holidayDates = holidays.list.map((h) => h.date);
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = addDays(weekStart, i);
      const mine = entries.filter((e) => dayStr(e.date) === date);
      return {
        date,
        workingDay: hours.days.includes(dbDay(date).getUTCDay()) && !holidayDates.includes(date),
        taskMinutes: mine.filter((e) => e.category === 'task').reduce((s, e) => s + e.minutes, 0),
        otherMinutes: mine.filter((e) => e.category !== 'task').reduce((s, e) => s + e.minutes, 0),
      };
    });
    const total = entries.reduce((s, e) => s + e.minutes, 0);
    const own = user.id === me.id;
    const editable = own && !LOCKED.includes(status);
    const recentIds = editable
      ? (
          await this.prisma.task.findMany({
            where: { ownerId: me.id, engagementId: { not: null }, updatedAt: { gte: new Date(Date.now() - 60 * 86_400_000) } },
            select: { engagementId: true },
            distinct: ['engagementId'],
            take: 30,
          })
        ).map((t) => t.engagementId as string)
      : [];
    const recent = recentIds.length
      ? await this.prisma.engagement.findMany({ where: { id: { in: recentIds } }, select: { id: true, clientOrg: { select: { name: true } }, service: { select: { name: true } } } })
      : [];
    return {
      id: sheet?.id ?? null,
      user: { id: user.id, name: user.name },
      weekStart,
      weekEnd,
      status,
      totalMinutes: total,
      days,
      byCategory: TEAM_TIME_CATEGORIES.map((category) => ({ category, minutes: entries.filter((e) => e.category === category).reduce((s, e) => s + e.minutes, 0) })).filter((c) => c.minutes > 0),
      entries: entries.map((e) => ({
        id: e.id,
        date: dayStr(e.date),
        minutes: e.minutes,
        category: ((TEAM_TIME_CATEGORIES as readonly string[]).includes(e.category) ? e.category : 'internal') as TeamTimeCategory,
        source: e.source === 'task_log' ? 'task_log' : 'manual',
        task: e.taskId ? { id: e.taskId, title: tasks.find((t) => t.id === e.taskId)?.title ?? 'Task' } : null,
        client: engagements.find((x) => x.id === e.engagementId)?.clientOrg.name ?? null,
        note: e.note,
      })),
      submittedAt: sheet?.submittedAt?.toISOString() ?? null,
      decidedBy: decider?.name ?? null,
      decidedAt: sheet?.decidedAt?.toISOString() ?? null,
      comment: sheet?.comment ?? null,
      canEdit: editable,
      ...(editable ? { clientOptions: recent.map((x) => ({ engagementId: x.id, label: `${x.clientOrg.name} · ${x.service.name}` })).sort((a, b) => a.label.localeCompare(b.label)) } : {}),
      canSubmit: own && !LOCKED.includes(status) && total > 0 && weekStart <= istDate(new Date()),
      canDecide: status === 'submitted' && canDecideFor,
    };
  }

  private async assertEditable(me: Me, date: string) {
    const weekStart = mondayOf(date);
    const sheet = await this.prisma.timesheet.findUnique({ where: { userId_weekStart: { userId: me.id, weekStart: dbDay(weekStart) } } });
    if (sheet && LOCKED.includes(sheet.status as TeamTimesheetStatus)) throw new ConflictException(`That week's timesheet is ${sheet.status}. Ask your manager to return it before changing it.`);
    return weekStart;
  }

  async addEntry(me: Me, input: TeamTimeEntryInput, ip?: string) {
    if (!isStaff(me)) throw new ForbiddenException('Team accounts only');
    if (input.date > istDate(new Date())) throw new BadRequestException('You can only log time for today or earlier');
    const weekStart = await this.assertEditable(me, input.date);
    const dayTotal = await this.prisma.timeEntry.aggregate({ where: { userId: me.id, date: dbDay(input.date) }, _sum: { minutes: true } });
    if ((dayTotal._sum.minutes ?? 0) + input.minutes > 16 * 60) throw new BadRequestException('That would be more than 16 hours on one day');
    if (input.engagementId && !(await this.prisma.engagement.findFirst({ where: { id: input.engagementId, clientOrg: { orgId: me.orgId } }, select: { id: true } }))) {
      throw new BadRequestException('That client service was not found');
    }
    const e = await this.prisma.timeEntry.create({
      data: { orgId: me.orgId, userId: me.id, date: dbDay(input.date), minutes: input.minutes, category: input.category, source: 'manual', note: input.note || null, engagementId: input.engagementId ?? null },
    });
    await this.audit.log(me, 'time.logged', 'TimeEntry', e.id, null, input, ip);
    return this.week(me, weekStart);
  }

  async removeEntry(me: Me, id: string, ip?: string) {
    const e = await this.prisma.timeEntry.findFirst({ where: { id, userId: me.id } });
    if (!e) throw new NotFoundException('Time entry not found');
    if (e.source === 'task_log' || (e.source === 'timer' && e.taskId)) throw new BadRequestException('Time logged on a task stays on the task. Add a correction entry instead.');
    const weekStart = await this.assertEditable(me, dayStr(e.date));
    await this.prisma.timeEntry.delete({ where: { id } });
    await this.audit.log(me, 'time.removed', 'TimeEntry', id, { date: dayStr(e.date), minutes: e.minutes, category: e.category }, null, ip);
    return this.week(me, weekStart);
  }

  async submit(me: Me, weekRaw: string, ip?: string) {
    const view = await this.week(me, weekRaw);
    if (!view.canSubmit) {
      if (LOCKED.includes(view.status)) throw new ConflictException(`This timesheet is already ${view.status}`);
      if (!view.totalMinutes) throw new BadRequestException('Log some time before submitting the week');
      throw new BadRequestException('You can submit this week once it has started');
    }
    const now = new Date();
    const sheet = await this.prisma.timesheet.upsert({
      where: { userId_weekStart: { userId: me.id, weekStart: dbDay(view.weekStart) } },
      update: { status: 'submitted', totalMinutes: view.totalMinutes, submittedAt: now, decidedById: null, decidedAt: null },
      create: { orgId: me.orgId, userId: me.id, weekStart: dbDay(view.weekStart), status: 'submitted', totalMinutes: view.totalMinutes, submittedAt: now },
    });
    await this.audit.log(me, 'timesheet.submitted', 'Timesheet', sheet.id, { status: view.status }, { status: 'submitted', weekStart: view.weekStart, totalMinutes: view.totalMinutes }, ip);
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { managerId: true } });
    const approvers = user.managerId ? [user.managerId] : (await this.hrPeople(me.orgId)).filter((id) => id !== me.id);
    const hours = Math.round((view.totalMinutes / 60) * 10) / 10;
    await this.notifications.notify(me.orgId, approvers, { kind: 'timesheet_submitted', title: `${me.name} submitted a timesheet (${hours}h, week of ${view.weekStart})`, link: `/team/timesheets/review/${sheet.id}` });
    return this.week(me, view.weekStart);
  }

  private async hrPeople(orgId: string) {
    const rows = await this.prisma.user.findMany({ where: { orgId, type: 'staff', status: 'active', deletedAt: null, roles: { some: { role: { baseRole: 'hr_ops' } } } }, select: { id: true } });
    return rows.map((r) => r.id);
  }

  async approvals(me: Me, status?: string): Promise<TeamTimesheetRow[]> {
    if (!isStaff(me)) throw new ForbiddenException('Team accounts only');
    const all = isHrApprover(me);
    const headed = hasRole(me, 'department_head') ? await this.prisma.department.findMany({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true } }) : [];
    const people = all
      ? null
      : await this.prisma.user.findMany({
          where: { orgId: me.orgId, id: { not: me.id }, OR: [{ managerId: me.id }, ...(headed.length ? [{ departmentId: { in: headed.map((d) => d.id) } }] : [])] },
          select: { id: true },
        });
    if (people && !people.length) return [];
    const statusWhere = status === 'all' ? { not: 'draft' } : status && ['submitted', 'approved', 'returned'].includes(status) ? status : 'submitted';
    const rows = await this.prisma.timesheet.findMany({
      where: { orgId: me.orgId, status: statusWhere, ...(people ? { userId: { in: people.map((p) => p.id) } } : { userId: { not: me.id } }) },
      orderBy: [{ weekStart: 'desc' }, { submittedAt: 'desc' }],
      take: 200,
    });
    const users = await this.prisma.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.userId, r.decidedById].filter(Boolean) as string[]))] } }, select: { id: true, name: true } });
    const name = (id: string | null) => users.find((u) => u.id === id)?.name ?? null;
    return rows.map((r) => ({
      id: r.id,
      user: { id: r.userId, name: name(r.userId) ?? 'Former member' },
      weekStart: dayStr(r.weekStart),
      status: r.status as TeamTimesheetStatus,
      totalMinutes: r.totalMinutes,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      decidedBy: name(r.decidedById),
      comment: r.comment,
      canDecide: r.status === 'submitted',
    }));
  }

  async byId(me: Me, id: string) {
    const sheet = await this.prisma.timesheet.findFirst({ where: { id, orgId: me.orgId } });
    if (!sheet) throw new NotFoundException('Timesheet not found');
    return this.week(me, dayStr(sheet.weekStart), sheet.userId);
  }

  async decide(me: Me, id: string, input: TeamDecideTimesheet, ip?: string) {
    const sheet = await this.prisma.timesheet.findFirst({ where: { id, orgId: me.orgId } });
    if (!sheet) throw new NotFoundException('Timesheet not found');
    const user = await this.person(me, sheet.userId);
    if (!(await this.approverOf(me, user))) throw new ForbiddenException("Only this person's manager, department head or HR can decide this timesheet");
    if (sheet.status !== 'submitted') throw new ConflictException(`This timesheet is ${sheet.status}`);
    const status = input.decision === 'approve' ? 'approved' : 'returned';
    await this.prisma.timesheet.update({ where: { id }, data: { status, decidedById: me.id, decidedAt: new Date(), comment: input.comment || null } });
    await this.audit.log(me, `timesheet.${status}`, 'Timesheet', id, { status: sheet.status }, { status, comment: input.comment ?? null, weekStart: dayStr(sheet.weekStart) }, ip);
    await this.notifications.notify(me.orgId, [sheet.userId], {
      kind: 'timesheet_decided',
      title: status === 'approved' ? `Your timesheet for the week of ${dayStr(sheet.weekStart)} was approved` : `Your timesheet for the week of ${dayStr(sheet.weekStart)} was returned`,
      body: input.comment ? `${me.name}: ${input.comment}` : undefined,
      link: `/team/timesheet?week=${dayStr(sheet.weekStart)}`,
    });
    return this.week(me, dayStr(sheet.weekStart), sheet.userId);
  }
}
