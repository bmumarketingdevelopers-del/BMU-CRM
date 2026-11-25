import type { Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const ALL_CLIENTS = ['founder', 'admin', 'am_lead'];

export type HeadScope = { engagementIds: string[]; clientIds: string[]; hasClient: (id: string | null | undefined) => boolean; hasEngagement: (id: string | null | undefined) => boolean };

/** A Department Head without a role that sees every client (Founder, Branch Manager, CM Lead). */
export const isLimitedHead = (me: Me) => me.type === 'staff' && me.roles.includes('department_head') && !me.roles.some((r) => ALL_CLIENTS.includes(r));

const scopes = new WeakMap<Me, Promise<HeadScope>>();

/**
 * v53: the projects and clients a Department Head may see: where their department works, or that they are assigned to.
 * null for everyone else (their own rules apply). Worked out once per request (`me` is loaded fresh for each one).
 */
export function headScope(prisma: PrismaService, me: Me): Promise<HeadScope> | null {
  if (!isLimitedHead(me)) return null;
  let s = scopes.get(me);
  if (!s) scopes.set(me, (s = loadHeadScope(prisma, me)));
  return s;
}

/** The departments a person heads, else their own department. */
export async function departmentsOf(prisma: PrismaService, me: Me): Promise<string[]> {
  const headed = await prisma.department.findMany({ where: { orgId: me.orgId, headUserId: me.id, deletedAt: null }, select: { id: true } });
  if (headed.length) return headed.map((d) => d.id);
  const self = await prisma.user.findUnique({ where: { id: me.id }, select: { departmentId: true } });
  return self?.departmentId ? [self.departmentId] : [];
}

async function loadHeadScope(prisma: PrismaService, me: Me): Promise<HeadScope> {
  const orgId = me.orgId;
  const depts = await departmentsOf(prisma, me);
  const inDept = { in: depts };
  // Work of the department: its tasks, tasks of its people, and the head's own (cancelled and archived ones don't count).
  const ours: Prisma.TaskWhereInput = { status: { not: 'cancelled' }, archivedAt: null, OR: [{ ownerId: me.id }, { departmentId: inDept }, { owner: { departmentId: inDept } }] };
  const [tasks, estimates, milestones] = await Promise.all([
    prisma.task.findMany({ where: { orgId, engagementId: { not: null }, ...ours }, select: { engagementId: true }, distinct: ['engagementId'] }),
    // Asked for a finish date, or shared a finished part.
    prisma.projectEstimate.findMany({ where: { orgId, OR: [{ headId: me.id }, { departmentId: inDept }] }, select: { engagementId: true } }),
    prisma.projectMilestone.findMany({ where: { orgId, departmentId: inDept }, select: { engagementId: true } }),
  ]);
  const ids = [...new Set([...tasks.map((t) => t.engagementId!), ...estimates.map((e) => e.engagementId), ...milestones.map((m) => m.engagementId)])];
  const [engagements, clients] = await Promise.all([
    prisma.engagement.findMany({
      where: {
        orgId,
        deletedAt: null,
        OR: [
          { id: { in: ids } },
          { cycles: { some: { deliverables: { some: { archivedAt: null, OR: [{ departmentId: inDept }, { handoffHeadId: me.id }, { tasks: { some: ours } }] } } } } },
          { requests: { some: { assigneeId: me.id } } },
          // Their own clients (a head who is also a Client Manager), and clients given to their department.
          { amId: me.id },
          { clientOrg: { amUserId: me.id } },
          { clientOrg: { departmentId: inDept } },
        ],
      },
      select: { id: true, clientOrgId: true },
    }),
    prisma.clientOrg.findMany({ where: { orgId, deletedAt: null, OR: [{ amUserId: me.id }, { departmentId: inDept }] }, select: { id: true } }),
  ]);
  const engagementIds = engagements.map((e) => e.id);
  const clientIds = [...new Set([...engagements.map((e) => e.clientOrgId), ...clients.map((c) => c.id)])];
  const e = new Set(engagementIds);
  const c = new Set(clientIds);
  return { engagementIds, clientIds, hasClient: (id) => !!id && c.has(id), hasEngagement: (id) => !!id && e.has(id) };
}

/**
 * Engagements a staff member can see: leadership all; a Department Head those their department works on or they are
 * assigned to; a Client Manager their own clients;
 * strategists and producers the clients of their pod (same team as the client's CM).
 */
export async function visibleEngagementWhere(prisma: PrismaService, me: Me): Promise<Prisma.EngagementWhereInput> {
  const base: Prisma.EngagementWhereInput = { orgId: me.orgId, deletedAt: null };
  if (me.type !== 'staff') return { AND: [base, { id: '__none__' }] };
  if (me.roles.some((r) => ALL_CLIENTS.includes(r))) return base;
  const head = await headScope(prisma, me);
  // AND, so a caller that adds its own `id` cannot replace the rule.
  if (head) return { ...base, AND: [{ id: { in: head.engagementIds } }] };
  if (me.roles.includes('account_manager')) return { ...base, amId: me.id };
  const self = await prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { teamId: true } });
  if (!self.teamId) return { AND: [base, { id: '__none__' }] };
  return { ...base, am: { teamId: self.teamId } };
}

export const isLeadership = (me: Me) => me.roles.some((r) => ['founder', 'admin', 'am_lead'].includes(r));
