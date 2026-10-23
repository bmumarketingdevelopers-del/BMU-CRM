// v11 people: who may do which hierarchy action (spec actions.organisation_hierarchy + approval_matrix).
import { ForbiddenException } from '@nestjs/common';
import { type Me, type PeopleCan } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export const staffOnly = (me: Me) => {
  if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
};
export const has = (me: Me, ...roles: string[]) => me.type === 'staff' && me.roles.some((r) => roles.includes(r));
export const peopleCap = (me: Me) => me.permissions.users_roles_hierarchy ?? { scope: 'none' as const, rule: 'none' };
const capable = (me: Me) => peopleCap(me).scope !== 'none';

export const isFounder = (me: Me) => has(me, 'founder');
export const isFA = (me: Me) => has(me, 'founder', 'admin');
export const isHR = (me: Me) => has(me, 'hr_ops') && capable(me);
export const isDH = (me: Me) => has(me, 'department_head') && capable(me);

/**
 * Who may add people (create team accounts): the Founder and HR only. Every way of adding someone checks this:
 * Add person, bulk import, the older invite form and "new hire" onboarding. Branch Managers and Department Heads ask
 * HR or the Founder.
 */
export const canAddPeople = (me: Me) => (isFounder(me) && capable(me)) || isHR(me);

/** The HR Department Head: someone with both the HR / Ops and the Department Head roles. */
export const isHrHead = (me: Me) => isHR(me) && has(me, 'department_head');

/**
 * Who may approve a new person, and who adds without approval: a Founder or the HR Department Head. Other HR members'
 * additions wait for one of them (through Add person only: the other ways of adding someone are for these two).
 */
export const approvesNewPeople = (me: Me) => (isFounder(me) && capable(me)) || isHrHead(me);

export function peopleCan(me: Me): PeopleCan {
  const fa = isFA(me) && capable(me);
  const hr = isHR(me);
  const dh = isDH(me);
  return {
    addPerson: canAddPeople(me),
    addNeedsApproval: canAddPeople(me) && !approvesNewPeople(me),
    addUnit: fa,
    addPod: fa || has(me, 'am_lead'),
    move: fa || dh,
    changeRole: fa,
    offboard: fa || hr,
    reassignWork: fa || dh || has(me, 'am_lead'),
    customRole: fa,
    import: approvesNewPeople(me),
    edit: fa || hr,
  };
}

/** Hierarchy screens: Founder, Branch Manager, HR and Department Heads (who see their own department's people). */
export function assertPeopleReader(me: Me) {
  staffOnly(me);
  if (!(has(me, 'founder', 'admin', 'hr_ops', 'department_head') && capable(me)) && !has(me, 'am_lead')) throw new ForbiddenException("You don't have access to the organisation");
}

/**
 * Can `me` give someone this base role? Founder: anyone. Admin: ranks below Admin; the Branch Manager role needs the Founder.
 * HR (adding only): never Founder or client roles; Branch Manager only by the HR Department Head, with the Founder's approval.
 * Rule: the person granting must be at least one rank above the new role.
 */
export function rolePolicy(me: Me, baseRole: string, mode: 'add' | 'change'): { ok: boolean; needsFounder: boolean; whyNot: string | null } {
  if (baseRole.startsWith('client_')) return { ok: false, needsFounder: false, whyNot: 'Client roles are given from the client account, not here' };
  if (baseRole === 'founder') return isFounder(me) ? { ok: true, needsFounder: false, whyNot: null } : { ok: false, needsFounder: false, whyNot: 'Only the Founder can give the Founder role' };
  if (isFounder(me)) return { ok: true, needsFounder: false, whyNot: null };
  if (has(me, 'admin')) {
    if (baseRole === 'admin') return { ok: true, needsFounder: true, whyNot: null };
    return { ok: true, needsFounder: false, whyNot: null };
  }
  if (mode === 'change') return { ok: false, needsFounder: false, whyNot: 'Only the Founder or a Branch Manager can change roles' };
  if (has(me, 'hr_ops')) {
    // The HR Department Head may add a Branch Manager; the Founder approves it before the account is created.
    if (baseRole === 'admin') {
      return isHrHead(me)
        ? { ok: true, needsFounder: true, whyNot: null }
        : { ok: false, needsFounder: false, whyNot: 'Only the HR Department Head can add a Branch Manager (the Founder approves it)' };
    }
    return { ok: true, needsFounder: false, whyNot: null };
  }
  return { ok: false, needsFounder: false, whyNot: "You can't give roles" };
}

/** Which people `me` may see (users_roles_hierarchy scope), staff only. */
export async function visiblePeopleWhere(prisma: PrismaService, me: Me): Promise<Prisma.UserWhereInput> {
  const base: Prisma.UserWhereInput = { orgId: me.orgId, type: 'staff', deletedAt: null };
  if (isFounder(me) || isHR(me)) return base;
  const self = await prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { branchId: true, departmentId: true } });
  const { scope } = peopleCap(me);
  if (has(me, 'admin')) return scope === 'all' || !self.branchId ? base : { ...base, OR: [{ branchId: self.branchId }, { branchId: null }] };
  if (has(me, 'department_head')) return { ...base, OR: [{ departmentId: self.departmentId ?? '__none__' }, { id: me.id }] };
  if (has(me, 'am_lead')) return base;
  if (scope === 'all') return base;
  return { ...base, OR: [{ id: me.id }, { managerId: me.id }] };
}
