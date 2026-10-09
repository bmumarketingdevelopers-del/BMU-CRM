// v11 core: who is above whom (approvers), department heads, capacity and leave.
import { Injectable } from '@nestjs/common';
import { CRAFT_HOURS_PER_TASK, craftSpecialtyLabel, istDate, type Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { calendarFor } from '../production/generate.js';

export const OPEN_TASK = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;
export const DAY_MS = 86_400_000;
/** Productive hours in a working day (the Capacity page uses 8h × 6 days = 48h a week). */
export const HOURS_PER_DAY = 8;
/** Load window: today plus the next 6 days. */
export const LOAD_WINDOW_DAYS = 7;

export const hasRole = (me: { roles: string[] }, ...roles: string[]) => me.roles.some((r) => roles.includes(r));
export const isLeader = (me: { roles: string[] }) => hasRole(me, 'founder', 'admin', 'am_lead');
export const dbDay = (ymd: string) => new Date(`${ymd}T00:00:00Z`);
export const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** "2026-10-05" → 6 pm IST that day; full timestamps pass through. */
export function parseDue(v: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(`${v}T18:00:00+05:30`) : new Date(v);
}

export type PersonLoad = {
  id: string;
  name: string;
  role: string | null;
  roles: string[];
  departmentId: string | null;
  department: string | null;
  specialty: string | null;
  skills: string[];
  managerId: string | null;
  hoursOpen: number;
  capacityHours: number;
  loadPct: number;
  openTasks: number;
  /** Approved leave days (yyyy-mm-dd) from today for 60 days. */
  leaveDays: Set<string>;
  onLeaveToday: boolean;
};

const ROLE_ORDER = ['founder', 'admin', 'am_lead', 'department_head', 'sales_manager', 'account_manager', 'strategist', 'qc_reviewer', 'producer', 'intern', 'finance', 'hr_ops', 'sales_executive'];

@Injectable()
export class PeopleDirectory {
  constructor(private readonly prisma: PrismaService) {}

  async departmentOf(userId: string): Promise<string | null> {
    return (await this.prisma.user.findUnique({ where: { id: userId }, select: { departmentId: true } }))?.departmentId ?? null;
  }

  /** The head of a department: Department.headUserId, else a department_head in it. */
  async departmentHead(orgId: string, departmentId: string | null | undefined): Promise<string | null> {
    if (!departmentId) return null;
    const d = await this.prisma.department.findFirst({ where: { id: departmentId, orgId }, select: { headUserId: true } });
    if (d?.headUserId) {
      const ok = await this.prisma.user.findFirst({ where: { id: d.headUserId, deletedAt: null, status: { not: 'suspended' } }, select: { id: true } });
      if (ok) return ok.id;
    }
    const u = await this.prisma.user.findFirst({
      where: { orgId, departmentId, deletedAt: null, status: { not: 'suspended' }, roles: { some: { role: { baseRole: 'department_head' } } } },
      select: { id: true },
    });
    return u?.id ?? null;
  }

  /** Is `me` the head of this department (or founder/admin, who can act as any head)? */
  async isHeadOf(me: Me, departmentId: string | null | undefined): Promise<boolean> {
    if (hasRole(me, 'founder', 'admin')) return true;
    if (!hasRole(me, 'department_head') || !departmentId) return false;
    const head = await this.departmentHead(me.orgId, departmentId);
    if (head === me.id) return true;
    return (await this.departmentOf(me.id)) === departmentId;
  }

  /** First active admin, then founder (the last stop for approvals). */
  async admin(orgId: string): Promise<string | null> {
    for (const role of ['admin', 'founder']) {
      const u = await this.prisma.user.findFirst({ where: { orgId, type: 'staff', deletedAt: null, status: 'active', roles: { some: { role: { baseRole: role } } } }, select: { id: true }, orderBy: { createdAt: 'asc' } });
      if (u) return u.id;
    }
    return null;
  }

  /** Next rank up: the person's manager, else their department head, else an admin. Never the person themselves. */
  async nextUp(orgId: string, userId: string): Promise<string | null> {
    const u = await this.prisma.user.findUnique({ where: { id: userId }, select: { managerId: true, departmentId: true } });
    if (u?.managerId && u.managerId !== userId) {
      const m = await this.prisma.user.findFirst({ where: { id: u.managerId, deletedAt: null, status: { not: 'suspended' } }, select: { id: true } });
      if (m) return m.id;
    }
    const head = await this.departmentHead(orgId, u?.departmentId);
    if (head && head !== userId) return head;
    const admin = await this.admin(orgId);
    return admin && admin !== userId ? admin : null;
  }

  async names(ids: (string | null | undefined)[]): Promise<Map<string, string>> {
    const list = [...new Set(ids.filter((x): x is string => !!x))];
    if (!list.length) return new Map();
    const rows = await this.prisma.user.findMany({ where: { id: { in: list } }, select: { id: true, name: true } });
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /**
   * Load per person: open task hours due within the next 7 days (overdue included; estimate or 4h a task) against
   * 8h per working day in that window minus approved leave days.
   */
  async loads(orgId: string, where: Prisma.UserWhereInput, now = new Date(), userTypes: ('staff' | 'creator')[] = ['staff']): Promise<PersonLoad[]> {
    const users = await this.prisma.user.findMany({
      where: { AND: [{ orgId, type: { in: userTypes }, deletedAt: null, status: 'active' }, where] },
      include: { department: { select: { name: true } }, roles: { include: { role: { select: { baseRole: true } } } } },
      orderBy: { name: 'asc' },
      take: 400,
    });
    if (!users.length) return [];
    const ids = users.map((u) => u.id);
    const cal = await calendarFor(this.prisma, orgId);
    const today = istDate(now);
    const windowEnd = new Date(new Date(`${today}T00:00:00+05:30`).getTime() + LOAD_WINDOW_DAYS * DAY_MS);
    const [tasks, leaves] = await Promise.all([
      this.prisma.task.findMany({
        where: { orgId, ownerId: { in: ids }, status: { in: [...OPEN_TASK] }, archivedAt: null, isDraft: false },
        select: { ownerId: true, deadline: true, estimateMin: true },
      }),
      this.prisma.leaveRequest.findMany({
        where: { orgId, userId: { in: ids }, status: 'approved', to: { gte: dbDay(today) }, from: { lte: dbDay(ymd(new Date(now.getTime() + 60 * DAY_MS))) } },
        select: { userId: true, from: true, to: true },
      }),
    ]);
    const windowDays: string[] = [];
    for (let i = 0; i < LOAD_WINDOW_DAYS; i++) {
      const d = new Date(new Date(`${today}T12:00:00+05:30`).getTime() + i * DAY_MS);
      const day = istDate(d);
      const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
      if (cal.days.includes(dow) && !cal.holidays.includes(day)) windowDays.push(day);
    }
    return users
      .map((u) => {
        const leaveDays = new Set<string>();
        for (const l of leaves.filter((x) => x.userId === u.id)) for (let t = l.from.getTime(); t <= l.to.getTime(); t += DAY_MS) leaveDays.add(ymd(new Date(t)));
        const mine = tasks.filter((t) => t.ownerId === u.id);
        const due = mine.filter((t) => t.deadline && t.deadline < windowEnd);
        const hoursOpen = Math.round(due.reduce((s, t) => s + (t.estimateMin ? t.estimateMin / 60 : CRAFT_HOURS_PER_TASK), 0) * 10) / 10;
        const capacityHours = windowDays.filter((d) => !leaveDays.has(d)).length * HOURS_PER_DAY;
        const roles = u.roles.map((r) => r.role.baseRole).sort((a, b) => ROLE_ORDER.indexOf(a) - ROLE_ORDER.indexOf(b));
        const spec = u.specialty ? craftSpecialtyLabel(u.specialty) : null;
        return {
          id: u.id,
          name: u.name,
          role: roles[0] ?? null,
          roles,
          departmentId: u.departmentId,
          department: u.department?.name ?? null,
          specialty: u.specialty,
          skills: [spec, u.department?.name].filter((x): x is string => !!x),
          managerId: u.managerId,
          hoursOpen,
          capacityHours,
          loadPct: capacityHours ? Math.round((hoursOpen / capacityHours) * 100) : hoursOpen ? 999 : 0,
          openTasks: mine.length,
          leaveDays,
          onLeaveToday: leaveDays.has(today),
        };
      });
  }

  /** Load % after adding `hours`. */
  static after(p: PersonLoad, hours: number) {
    if (!p.capacityHours) return 999;
    return Math.round(((p.hoursOpen + hours) / p.capacityHours) * 100);
  }

  /** IST day of a deadline. */
  static day(d: Date | null | undefined) {
    return d ? istDate(d) : null;
  }
}
