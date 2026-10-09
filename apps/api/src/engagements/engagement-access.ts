import type { Me } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

const ALL_CLIENTS = ['founder', 'admin', 'am_lead', 'department_head'];

/**
 * Engagements a staff member can see: leadership all; an Account Manager their own clients;
 * strategists and producers the clients of their pod (same team as the client's AM).
 */
export async function visibleEngagementWhere(prisma: PrismaService, me: Me): Promise<Prisma.EngagementWhereInput> {
  const base: Prisma.EngagementWhereInput = { orgId: me.orgId, deletedAt: null };
  if (me.type !== 'staff') return { AND: [base, { id: '__none__' }] };
  if (me.roles.some((r) => ALL_CLIENTS.includes(r))) return base;
  if (me.roles.includes('account_manager')) return { ...base, amId: me.id };
  const self = await prisma.user.findUniqueOrThrow({ where: { id: me.id }, select: { teamId: true } });
  if (!self.teamId) return { AND: [base, { id: '__none__' }] };
  return { ...base, am: { teamId: self.teamId } };
}

export const isLeadership = (me: Me) => me.roles.some((r) => ['founder', 'admin', 'am_lead'].includes(r));
