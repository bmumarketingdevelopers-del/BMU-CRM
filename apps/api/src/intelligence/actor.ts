import type { Me } from '@bmu/shared';
import type { MeService } from '../auth/me.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

/**
 * Background jobs (forecasts, alerts, reports) compute numbers as the organisation's Founder, who sees everything.
 * What each person is then shown is filtered by their own access when they open it.
 */
export async function systemActor(prisma: PrismaService, meService: MeService, orgId: string): Promise<Me | null> {
  const founder = await prisma.user.findFirst({
    where: { orgId, type: 'staff', deletedAt: null, status: 'active', roles: { some: { role: { baseRole: 'founder' } } } },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return founder ? meService.load(founder.id) : null;
}

