// v47: service groups and sub-services. The first read for an organisation creates BMU's list from the website. Each group
// also gets a Service row in a hidden price book, because a project needs one; nothing that reads the live price book sees it.
import { bundlePrices, CLIENTS_INDUSTRIES, SERVICE_GROUP_KEY_PREFIX, SERVICE_GROUPS_BOOK, SERVICE_GROUPS_SEED, type BundleView, type IndustryView, type PriceList, type ServiceGroupView, type SubServiceBilling } from '@bmu/shared';
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
    subServices: g.subServices.map((s) => ({ id: s.id, name: s.name, covers: s.covers, archived: !!s.archivedAt, billing: s.billing as SubServiceBilling, prices: { starter: s.starterPaise, growth: s.growthPaise, premium: s.premiumPaise } })),
  }));
}

/** v52: bundles with their plan prices worked out from today's sub-service prices (`all` also returns hidden ones). */
export async function listBundles(prisma: PrismaService, orgId: string, groups: ServiceGroupView[], opts: { all?: boolean } = {}): Promise<BundleView[]> {
  const subs = new Map(groups.flatMap((g) => g.subServices.map((s) => [s.id, s] as const)));
  const rows = await prisma.serviceBundle.findMany({ where: { orgId, ...(opts.all ? {} : { selectable: true }) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  return rows.map((b) => ({ id: b.id, name: b.name, subServiceIds: b.subServiceIds, savingPct: b.savingPct, selectable: b.selectable, prices: bundlePrices(b.subServiceIds, subs, b.savingPct) }));
}

/** v52: the price list for forms: live services, sub-services and bundles (`all`: hidden ones too, for records that use them). */
export async function priceList(prisma: PrismaService, orgId: string, opts: { all?: boolean } = {}): Promise<PriceList> {
  const all = await listServiceGroups(prisma, orgId, { all: true });
  const bundles = await listBundles(prisma, orgId, all, opts);
  return { groups: opts.all ? all : all.filter((g) => !g.archived).map((g) => ({ ...g, subServices: g.subServices.filter((s) => !s.archived) })), bundles };
}

/** v52: industries for the client form; the first read starts the list from the built-in one. */
export async function listIndustries(prisma: PrismaService, orgId: string, opts: { all?: boolean } = {}): Promise<IndustryView[]> {
  if (!(await prisma.industry.count({ where: { orgId } }))) {
    const used = await prisma.clientOrg.findMany({ where: { orgId, industry: { not: null } }, select: { industry: true }, distinct: ['industry'] });
    const names = [...new Map([...CLIENTS_INDUSTRIES, ...used.map((u) => u.industry!)].filter(Boolean).map((n) => [n.toLowerCase(), n.trim()])).values()];
    await prisma.industry.createMany({ data: names.map((n, i) => ({ orgId, name: n, sortOrder: i })), skipDuplicates: true }).catch(() => undefined);
  }
  const rows = await prisma.industry.findMany({ where: { orgId, ...(opts.all ? {} : { archivedAt: null }) }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  return rows.map((r) => ({ id: r.id, name: r.name, archived: !!r.archivedAt }));
}
