// v47: service groups and sub-services. The first read for an organisation creates BMU's list from the website. Each group
// also gets a Service row in a hidden price book, because a project needs one; nothing that reads the live price book sees it.
import { SERVICE_GROUP_KEY_PREFIX, SERVICE_GROUPS_BOOK, SERVICE_GROUPS_SEED, type ServiceGroupView } from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export async function createServiceGroupTx(tx: Prisma.TransactionClient, orgId: string, name: string, sortOrder: number, subServices: { name: string; covers: string }[] = []) {
  const book = await tx.priceBook.upsert({
    where: { orgId_version: { orgId, version: SERVICE_GROUPS_BOOK } },
    update: {},
    create: { orgId, version: SERVICE_GROUPS_BOOK, effectiveFrom: new Date(), status: 'archived' },
  });
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  const service = await tx.service.create({
    data: { orgId, priceBookId: book.id, key: `${SERVICE_GROUP_KEY_PREFIX}${slug}_${sortOrder}`, name, track: name, billingType: 'monthly', tiers: { create: [{ tier: 'starter', pricePaise: 0, deliverables: [] }] } },
  });
  return tx.serviceGroup.create({
    data: { orgId, name, sortOrder, serviceId: service.id, subServices: { create: subServices.map((s, i) => ({ orgId, name: s.name, covers: s.covers, sortOrder: i })) } },
  });
}

async function ensureServiceGroups(prisma: PrismaService, orgId: string) {
  if (await prisma.serviceGroup.count({ where: { orgId } })) return;
  await prisma.$transaction(
    async (tx) => {
      // Two first reads at once must not create the list twice.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`service-groups:${orgId}`}))`;
      if (await tx.serviceGroup.count({ where: { orgId } })) return;
      for (const [i, g] of SERVICE_GROUPS_SEED.entries()) await createServiceGroupTx(tx, orgId, g.name, i, g.subServices);
    },
    { timeout: 30_000 },
  );
}

/** The list for forms (`all` also returns what an admin has hidden). */
export async function listServiceGroups(prisma: PrismaService, orgId: string, opts: { all?: boolean } = {}): Promise<ServiceGroupView[]> {
  await ensureServiceGroups(prisma, orgId);
  const live = opts.all ? {} : { archivedAt: null };
  const groups = await prisma.serviceGroup.findMany({
    where: { orgId, ...live },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { subServices: { where: live, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
  });
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    serviceId: g.serviceId,
    archived: !!g.archivedAt,
    subServices: g.subServices.map((s) => ({ id: s.id, name: s.name, covers: s.covers, archived: !!s.archivedAt })),
  }));
}
