// v11 people: default assignee for new client tasks. Clients attached to a client pod get their new tasks assigned to
// a pod member by default: a pod member in the task's department (producers first, then the strategist, then the AM),
// the one with the fewest open tasks. The task create path calls this when no assignee was picked.
import type { PrismaService } from '../prisma/prisma.service.js';

const OPEN = ['todo', 'in_progress', 'blocked', 'waiting', 'in_qc'] as const;

/** The pod a client belongs to (or null). */
export async function podForClient(prisma: PrismaService, orgId: string, clientOrgId: string) {
  return prisma.clientPod.findFirst({ where: { orgId, deletedAt: null, clientIds: { has: clientOrgId } } });
}

/**
 * Pod member to assign a new task for this client to, preferring `departmentId`. With no department given, the
 * least busy producer. Returns null when the client has no pod or nobody in the pod fits.
 */
export async function podDefaultAssignee(prisma: PrismaService, orgId: string, clientOrgId: string, departmentId?: string | null): Promise<string | null> {
  const pod = await podForClient(prisma, orgId, clientOrgId);
  if (!pod) return null;
  const order = [...pod.producerIds, pod.strategistUserId, pod.amUserId].filter((x): x is string => !!x);
  const users = await prisma.user.findMany({ where: { id: { in: order }, orgId, deletedAt: null, status: 'active', leftAt: null }, select: { id: true, departmentId: true } });
  let pool = departmentId ? users.filter((u) => u.departmentId === departmentId) : users.filter((u) => pod.producerIds.includes(u.id));
  if (!pool.length) return null;
  const counts = await prisma.task.groupBy({ by: ['ownerId'], where: { orgId, ownerId: { in: pool.map((u) => u.id) }, status: { in: [...OPEN] }, archivedAt: null }, _count: { _all: true } });
  const open = (id: string) => counts.find((c) => c.ownerId === id)?._count._all ?? 0;
  pool = [...pool].sort((a, b) => open(a.id) - open(b.id) || order.indexOf(a.id) - order.indexOf(b.id));
  return pool[0].id;
}
