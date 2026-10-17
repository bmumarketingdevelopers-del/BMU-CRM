// v32: who may be given a task.
// - Department Heads: their own team members (their department) or themselves.
// - Everyone else who assigns work (Founder, Branch Manager, CM Lead, Client Managers, Strategists): only the Department
//   Head of the department(s) they choose; picking several departments sends each head their own copy.
// - Team members (producers, interns, QC...): only themselves.
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import type { Prisma } from '../../generated/prisma/client.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { hasRole, isLeader } from '../people.js';

export const ASSIGNER_ROLES = ['founder', 'admin', 'am_lead', 'department_head', 'account_manager', 'strategist'];

export type AssignScope = { kind: 'self' } | { kind: 'team'; departmentIds: string[] } | { kind: 'heads' };

export async function assignScope(prisma: PrismaService, me: Me): Promise<AssignScope> {
  if (!hasRole(me, ...ASSIGNER_ROLES)) return { kind: 'self' };
  if (hasRole(me, 'department_head') && !isLeader(me)) {
    const headed = await prisma.department.findMany({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true } });
    let ids = headed.map((d) => d.id);
    if (!ids.length) {
      const self = await prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } });
      ids = self?.departmentId ? [self.departmentId] : [];
    }
    return { kind: 'team', departmentIds: ids };
  }
  return { kind: 'heads' };
}

/** The Department Head of a department, or a clear error when it has none. */
export async function departmentHead(prisma: PrismaService, orgId: string, departmentId: string) {
  const d = await prisma.department.findFirst({ where: { id: departmentId, orgId, deletedAt: null }, select: { name: true, headUserId: true } });
  if (!d) throw new BadRequestException('Pick a department');
  const head = d.headUserId ? await prisma.user.findFirst({ where: { id: d.headUserId, status: 'active', deletedAt: null }, select: { id: true, name: true } }) : null;
  if (!head) throw new BadRequestException(`${d.name} has no Department Head yet. Ask HR or the Founder to set one in Departments & Teams.`);
  return { ...head, department: d.name };
}

/** Throws unless `ownerId` may be given a task of `departmentId` by `me`. */
export async function assertAssignee(prisma: PrismaService, me: Me, scope: AssignScope, ownerId: string, departmentId: string | null) {
  if (scope.kind === 'self') {
    if (ownerId !== me.id) throw new ForbiddenException('Team members add tasks only for themselves. Ask your Department Head to assign work to someone else.');
    return;
  }
  if (scope.kind === 'team') {
    if (ownerId === me.id) return;
    const u = await prisma.user.findFirst({ where: { id: ownerId, orgId: me.orgId, deletedAt: null }, select: { departmentId: true } });
    if (!u?.departmentId || !scope.departmentIds.includes(u.departmentId)) throw new ForbiddenException('Department Heads assign tasks only to their own team members (or keep them).');
    return;
  }
  if (!departmentId) throw new BadRequestException('Pick the department; the task goes to its Department Head');
  const head = await departmentHead(prisma, me.orgId, departmentId);
  if (ownerId !== head.id) throw new ForbiddenException(`Tasks go to the Department Head of the chosen department (${head.department}: ${head.name}).`);
}

/** Narrows the assignee picker to the people `me` may assign (heads of the chosen department, or their team). */
export async function assigneeWhere(prisma: PrismaService, me: Me, scope: AssignScope, departmentId?: string | null): Promise<Prisma.UserWhereInput> {
  if (scope.kind === 'self') return { id: me.id };
  if (scope.kind === 'team') return { OR: [{ id: me.id }, { departmentId: { in: scope.departmentIds } }] };
  const depts = await prisma.department.findMany({ where: { orgId: me.orgId, deletedAt: null, headUserId: { not: null }, ...(departmentId ? { id: departmentId } : {}) }, select: { headUserId: true } });
  return { id: { in: depts.map((d) => d.headUserId!) } };
}
