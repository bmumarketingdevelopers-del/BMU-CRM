// v31 leave flow: the employee asks; their Department Head decides first (a rejection is final); approved requests
// then go to HR for the final call. A Department Head's own leave goes straight to HR of the same branch. When no
// HR can decide (e.g. HR's own request with no other HR), a Founder decides. Founders don't request leave.
// Paid leave: 1 casual and 1 sick day build up each month and carry over within the calendar year; the rest is unpaid.
import { PAID_LEAVE_PER_MONTH } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Approved requests of these types mean the person is away (work from home is not). Use in `where`. */
export const AWAY_LEAVE = { type: { not: 'wfh' } } as const;

export type LeaveRouting = {
  /** The Department Head who decides first, or null (no head, or the person is the head) = straight to HR. */
  headOf: (userId: string) => string | null;
  /** Who makes the final call for this person's request. */
  hrFor: (userId: string) => string[];
  isDepartmentHead: (userId: string) => boolean;
};

export async function loadLeaveRouting(prisma: PrismaService, orgId: string): Promise<LeaveRouting> {
  const [users, depts] = await Promise.all([
    prisma.user.findMany({
      where: { orgId, type: 'staff', deletedAt: null },
      select: { id: true, status: true, departmentId: true, branchId: true, roles: { select: { role: { select: { baseRole: true } } } } },
    }),
    prisma.department.findMany({ where: { orgId, deletedAt: null }, select: { id: true, headUserId: true, branchId: true } }),
  ]);
  const byId = new Map(users.map((u) => [u.id, u]));
  const active = (id: string | null | undefined) => !!id && byId.get(id)?.status === 'active';
  const has = (u: (typeof users)[number], role: string) => u.roles.some((r) => r.role.baseRole === role);
  const heads = new Set(depts.map((d) => d.headUserId).filter((x): x is string => !!x));
  const branchOf = (u: (typeof users)[number]) => u.branchId ?? depts.find((d) => d.id === u.departmentId)?.branchId ?? null;
  const hr = users.filter((u) => u.status === 'active' && has(u, 'hr_ops'));
  const founders = users.filter((u) => u.status === 'active' && has(u, 'founder'));

  return {
    headOf: (userId) => {
      const u = byId.get(userId);
      const head = u?.departmentId ? depts.find((d) => d.id === u.departmentId)?.headUserId : null;
      return head && head !== userId && active(head) ? head : null;
    },
    hrFor: (userId) => {
      const u = byId.get(userId);
      let list = hr.filter((h) => h.id !== userId);
      // A Department Head's leave: HR of the same branch only.
      if (u && heads.has(userId)) {
        const branch = branchOf(u);
        list = list.filter((h) => branchOf(h) === branch);
      }
      const ids = list.map((h) => h.id);
      return ids.length ? ids : founders.filter((f) => f.id !== userId).map((f) => f.id);
    },
    isDepartmentHead: (userId) => heads.has(userId),
  };
}

/**
 * Split a request's working days into paid and unpaid. Casual / sick: a day in month m is paid while the paid days
 * already used or asked for this year (otherPaid) plus this request's paid days stay within m (1 a month, carried over).
 */
export function splitPaid(type: string, days: string[], otherPaid: number): { paid: number; unpaid: number } {
  if (type === 'wfh') return { paid: 0, unpaid: 0 };
  if (type !== 'casual' && type !== 'sick') return { paid: 0, unpaid: days.length };
  const perMonth = PAID_LEAVE_PER_MONTH[type];
  let paid = 0;
  for (const d of [...days].sort()) if (otherPaid + paid < Number(d.slice(5, 7)) * perMonth) paid++;
  return { paid, unpaid: days.length - paid };
}

/** Paid days built up by the end of month m (1-12). */
export const paidAccrued = (type: 'casual' | 'sick', month: number) => month * PAID_LEAVE_PER_MONTH[type];
