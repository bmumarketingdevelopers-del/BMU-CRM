// v52: what a client has bought: one row per sub-service OR bundle, each with its plan. Saved in one transaction
// (set_client_services): permission, then the shared check, then end the rows not chosen (kept as history), add the
// new ones and update plans. The name is copied from the price list so history stays readable after renames.
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  clientServicesProblems,
  lowestPlan,
  PLANS,
  type ClientServiceRow,
  type ClientServicesInput,
  type Me,
  type Plan,
  type PriceList,
  type SubServiceBilling,
} from '@bmu/shared';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { priceList } from '../catalogue/service-groups.js';
import { loadClient } from './clients-access.js';

type Db = PrismaService | Prisma.TransactionClient;
const planOf = (p: string | null | undefined): Plan | null => ((PLANS as readonly string[]).includes(p ?? '') ? (p as Plan) : null);

/**
 * Who may change a client's services: its Client Manager (own scope) or leadership (all clients), as everywhere else;
 * and the person who added the client may set its first services even when someone else is its Client Manager.
 */
export async function clientForServices(prisma: PrismaService, me: Me, clientId: string) {
  try {
    return (await loadClient(prisma, me, clientId, { write: true })).client;
  } catch (e) {
    if (!(e instanceof ForbiddenException)) throw e;
    const c = await prisma.clientOrg.findFirst({ where: { id: clientId, orgId: me.orgId, deletedAt: null } });
    if (c && c.createdById === me.id && !(await prisma.clientService.count({ where: { clientOrgId: c.id } }))) return c;
    throw e;
  }
}

/** The client's rows as the client page and the quotation / invoice form use them, with today's plan price. */
export async function clientServiceRows(db: Db, orgId: string, clientOrgId: string, list?: PriceList): Promise<ClientServiceRow[]> {
  const rows = await db.clientService.findMany({ where: { orgId, clientOrgId }, orderBy: [{ createdAt: 'asc' }] });
  if (!rows.length) return [];
  const full = list ?? (await priceList(db as PrismaService, orgId, { all: true }));
  const subs = new Map(full.groups.flatMap((g) => g.subServices.map((s) => [s.id, { ...s, group: g.name }] as const)));
  const bundles = new Map(full.bundles.map((b) => [b.id, b]));
  return rows.map((r) => {
    const sub = r.subServiceId ? subs.get(r.subServiceId) : undefined;
    const bundle = r.bundleId ? bundles.get(r.bundleId) : undefined;
    const prices = sub?.prices ?? bundle?.prices;
    const plan = planOf(r.plan);
    const pricedPlan = prices ? (plan && prices[plan] != null ? plan : lowestPlan(prices)) : null;
    // v56: no plan prices in the price list: the amount and billing agreed for this client, when set.
    const custom = !pricedPlan && r.customPricePaise != null;
    const adminBilling = (r.bundleId ? 'monthly' : (sub?.billing ?? 'monthly')) as SubServiceBilling;
    return {
      id: r.id,
      kind: r.bundleId ? 'bundle' : 'sub',
      itemId: (r.bundleId ?? r.subServiceId)!,
      service: r.bundleId ? 'Bundle' : (sub?.group ?? ''),
      name: sub?.name ?? bundle?.name ?? r.name,
      plan,
      status: r.status as ClientServiceRow['status'],
      startDate: r.startDate?.toISOString().slice(0, 10) ?? null,
      billing: !pricedPlan && r.customBilling ? (r.customBilling as SubServiceBilling) : adminBilling,
      pricePaise: custom ? r.customPricePaise : prices && pricedPlan ? prices[pricedPlan] : null,
      pricedPlan,
      custom,
      description: bundle ? bundle.subServiceIds.map((id) => subs.get(id)?.name).filter(Boolean).join(' + ') : (sub?.covers ?? ''),
    };
  });
}

/**
 * set_client_services: one transaction. Rows not chosen are ended (kept as history), new ones added, plans updated.
 * Returns what changed for the audit log.
 */
export async function setClientServicesTx(tx: Prisma.TransactionClient, me: Me, clientOrgId: string, input: ClientServicesInput, list: PriceList) {
  const problems = clientServicesProblems(input, list);
  if (problems.length) throw new BadRequestException(problems[0]);
  const subs = new Map(list.groups.flatMap((g) => g.subServices.map((s) => [s.id, s] as const)));
  const bundles = new Map(list.bundles.map((b) => [b.id, b]));
  // The server confirms every id exists for this organisation (the shared check only knows the list it was given).
  const subIds = input.subServiceIds ?? [];
  const bundleIds = input.bundleIds ?? [];
  if ((await tx.subService.count({ where: { orgId: me.orgId, id: { in: subIds } } })) !== subIds.length) throw new BadRequestException('Some of the chosen sub services are not in the price list');
  if ((await tx.serviceBundle.count({ where: { orgId: me.orgId, id: { in: bundleIds } } })) !== bundleIds.length) throw new BadRequestException('Some of the chosen bundles are not in the price list');
  const plans = input.plans ?? {};
  // v56: an item with no plan prices can carry its own amount and billing; items with plan prices never do.
  const custom = input.custom ?? {};
  const priced = (id: string) => Object.values(subs.get(id)?.prices ?? bundles.get(id)?.prices ?? {}).some((p) => p != null);
  const customOf = (id: string) => {
    if (priced(id)) return { customPricePaise: null, customBilling: null };
    const c = custom[id];
    const adminBilling = subs.get(id)?.billing;
    return { customPricePaise: c?.pricePaise ?? null, customBilling: c?.billing ?? (adminBilling === 'one_time' ? 'one_time' : 'monthly') };
  };
  const current = await tx.clientService.findMany({ where: { orgId: me.orgId, clientOrgId, status: { not: 'ended' } } });
  const chosen = [...subIds.map((id) => ({ kind: 'sub' as const, id })), ...bundleIds.map((id) => ({ kind: 'bundle' as const, id }))];
  const keyOf = (r: { subServiceId: string | null; bundleId: string | null }) => r.subServiceId ?? r.bundleId;
  const ended = current.filter((r) => !chosen.some((c) => c.id === keyOf(r)));
  const now = new Date();
  if (ended.length) {
    const n = await tx.clientService.updateMany({ where: { id: { in: ended.map((r) => r.id) }, orgId: me.orgId, clientOrgId }, data: { status: 'ended', endedAt: now } });
    if (n.count !== ended.length) throw new ForbiddenException('You cannot change these services');
  }
  const added: string[] = [];
  const replanned: { name: string; from: string | null; to: string | null }[] = [];
  for (const c of chosen) {
    const plan = planOf(plans[c.id]);
    const existing = current.find((r) => keyOf(r) === c.id);
    const own = customOf(c.id);
    if (existing) {
      const repriced = (existing.customPricePaise ?? null) !== own.customPricePaise || (existing.customBilling ?? null) !== own.customBilling;
      if ((existing.plan ?? null) !== plan || repriced) {
        const rows = await tx.clientService.updateManyAndReturn({ where: { id: existing.id, orgId: me.orgId, clientOrgId }, data: { plan, ...own } });
        if (!rows.length) throw new ForbiddenException('You cannot change these services');
        replanned.push({ name: existing.name, from: existing.plan, to: plan });
      }
      continue;
    }
    const name = c.kind === 'sub' ? subs.get(c.id)!.name : bundles.get(c.id)!.name;
    await tx.clientService.create({ data: { orgId: me.orgId, clientOrgId, subServiceId: c.kind === 'sub' ? c.id : null, bundleId: c.kind === 'bundle' ? c.id : null, plan, status: 'active', startDate: now, name, createdById: me.id, ...own } });
    added.push(name);
  }
  return { added, ended: ended.map((r) => r.name), replanned };
}

/** One row of a client's services, checked against the client (never trust the id alone). */
export async function loadClientServiceRow(db: Db, orgId: string, clientOrgId: string, rowId: string) {
  const row = await db.clientService.findFirst({ where: { id: rowId, orgId, clientOrgId } });
  if (!row) throw new NotFoundException('Service not found on this client');
  return row;
}
