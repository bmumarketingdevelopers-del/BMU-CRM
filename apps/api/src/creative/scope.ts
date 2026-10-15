// v16 creative: who can see which client's creative work. Same rule as Files: leadership, department heads and
// finance see every client; everyone else sees the clients they manage or have tasks for.
import { ForbiddenException } from '@nestjs/common';
import type { Me } from '@bmu/shared';
import type { PrismaService } from '../prisma/prisma.service.js';

export const hasRole = (me: { roles: string[] }, ...roles: string[]) => me.roles.some((r) => roles.includes(r));
export const isLeadership = (me: { roles: string[] }) => hasRole(me, 'founder', 'admin', 'am_lead');

/** Client ids a team member works on ('all' for leadership, department heads and finance). */
export async function clientScope(prisma: PrismaService, me: Me): Promise<'all' | string[]> {
  if (me.type !== 'staff') throw new ForbiddenException('Team accounts only');
  if (isLeadership(me) || hasRole(me, 'department_head', 'finance')) return 'all';
  const [clients, engs, tasks] = await Promise.all([
    prisma.clientOrg.findMany({ where: { orgId: me.orgId, amUserId: me.id }, select: { id: true } }),
    prisma.engagement.findMany({ where: { orgId: me.orgId, amId: me.id }, select: { clientOrgId: true } }),
    prisma.task.findMany({ where: { orgId: me.orgId, ownerId: me.id, OR: [{ engagementId: { not: null } }, { deliverableId: { not: null } }] }, select: { engagementId: true, deliverable: { select: { cycle: { select: { engagement: { select: { clientOrgId: true } } } } } } } }),
  ]);
  const taskEngs = tasks.filter((t) => t.engagementId).length
    ? await prisma.engagement.findMany({ where: { id: { in: [...new Set(tasks.map((t) => t.engagementId).filter((x): x is string => !!x))] } }, select: { clientOrgId: true } })
    : [];
  return [...new Set([...clients.map((c) => c.id), ...engs.map((e) => e.clientOrgId), ...taskEngs.map((e) => e.clientOrgId), ...tasks.map((t) => t.deliverable?.cycle.engagement.clientOrgId).filter((x): x is string => !!x)])];
}

export const inScope = (scope: 'all' | string[], clientOrgId: string | null) => scope === 'all' || clientOrgId === null || scope.includes(clientOrgId);

/** Client Manager of a client (null when none). */
export async function amOf(prisma: PrismaService, clientOrgId: string | null) {
  if (!clientOrgId) return null;
  return (await prisma.clientOrg.findUnique({ where: { id: clientOrgId }, select: { amUserId: true } }))?.amUserId ?? null;
}
