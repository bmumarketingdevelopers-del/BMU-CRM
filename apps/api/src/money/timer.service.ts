import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { timerStartSchema, type Me, type TimerStopResult, type TimerView } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { dbDate, mondayOf, todayIst } from './dates.js';

const MAX_MIN = 12 * 60;

/** v18 stopwatch: one running timer per person; stopping it writes a time entry (and adds to the task's logged time). */
@Injectable()
export class TimerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  private staff(me: Me) {
    if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
  }

  async get(me: Me): Promise<TimerView> {
    this.staff(me);
    const t = await this.prisma.activeTimer.findUnique({ where: { userId: me.id } });
    if (!t) return { running: null };
    const [task, eng] = await Promise.all([
      t.taskId ? this.prisma.task.findUnique({ where: { id: t.taskId }, select: { title: true } }) : null,
      t.engagementId ? this.prisma.engagement.findUnique({ where: { id: t.engagementId }, select: { clientOrg: { select: { name: true } }, service: { select: { name: true } } } }) : null,
    ]);
    return {
      running: { taskId: t.taskId, taskTitle: task?.title ?? null, engagementId: t.engagementId, project: eng ? `${eng.clientOrg.name} · ${eng.service.name}` : null, note: t.note, startedAt: t.startedAt.toISOString() },
    };
  }

  async start(me: Me, body: unknown, ip?: string) {
    this.staff(me);
    const input = parse(timerStartSchema, body);
    let engagementId = input.engagementId ?? null;
    if (input.taskId) {
      const task = await this.prisma.task.findFirst({ where: { id: input.taskId, orgId: me.orgId }, select: { engagementId: true, status: true, deliverable: { select: { cycle: { select: { engagementId: true } } } } } });
      if (!task) throw new NotFoundException('Task not found');
      if (task.status === 'done') throw new BadRequestException('That task is already done');
      engagementId = task.engagementId ?? task.deliverable?.cycle?.engagementId ?? engagementId;
    } else if (engagementId && !(await this.prisma.engagement.findFirst({ where: { id: engagementId, orgId: me.orgId }, select: { id: true } }))) {
      throw new NotFoundException('Project not found');
    }
    // Starting a new timer stops the running one first, so no time is lost.
    if (await this.prisma.activeTimer.findUnique({ where: { userId: me.id } })) await this.stop(me, ip);
    await this.prisma.activeTimer.create({ data: { userId: me.id, orgId: me.orgId, taskId: input.taskId ?? null, engagementId, note: input.note?.trim() || null } });
    return this.get(me);
  }

  async stop(me: Me, ip?: string): Promise<TimerStopResult> {
    this.staff(me);
    const t = await this.prisma.activeTimer.findUnique({ where: { userId: me.id } });
    if (!t) throw new BadRequestException('No timer is running');
    const raw = Math.round((Date.now() - t.startedAt.getTime()) / 60_000);
    const minutes = Math.min(MAX_MIN, Math.max(1, raw));
    const date = todayIst();
    const sheet = await this.prisma.timesheet.findUnique({ where: { userId_weekStart: { userId: me.id, weekStart: dbDate(mondayOf(date)) } } });
    if (sheet && ['submitted', 'approved'].includes(sheet.status)) throw new ConflictException(`This week's timesheet is ${sheet.status}. Ask your manager to return it, then stop the timer.`);
    const entry = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.activeTimer.deleteMany({ where: { userId: me.id, startedAt: t.startedAt } });
      if (!claimed.count) return null;
      const e = await tx.timeEntry.create({
        data: { orgId: me.orgId, userId: me.id, date: dbDate(date), minutes, category: t.taskId || t.engagementId ? 'task' : 'internal', source: 'timer', taskId: t.taskId, engagementId: t.engagementId, note: t.note },
      });
      if (t.taskId) await tx.task.update({ where: { id: t.taskId }, data: { timeLoggedMin: { increment: minutes } } });
      return e;
    });
    if (!entry) throw new BadRequestException('The timer was already stopped');
    await this.audit.log(me, 'time.logged', 'TimeEntry', entry.id, null, { minutes, source: 'timer', taskId: t.taskId }, ip);
    const capped = raw > MAX_MIN ? ` The timer ran for over 12 hours, so 12 hours were logged. Fix it in your timesheet if needed.` : '';
    return { minutes, entryId: entry.id, note: `Logged ${Math.floor(minutes / 60)}h ${minutes % 60}m.${capped}` };
  }

  async discard(me: Me) {
    this.staff(me);
    await this.prisma.activeTimer.deleteMany({ where: { userId: me.id } });
    return { running: null } satisfies TimerView;
  }
}
