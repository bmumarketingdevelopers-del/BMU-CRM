import { Injectable, NotFoundException } from '@nestjs/common';
import type { PricedAddOn, PricedBundle, PricedService } from '@bmu/shared';
import { PrismaService } from '../prisma/prisma.service.js';

const bookInclude = {
  services: { include: { tiers: { orderBy: { pricePaise: 'asc' as const } } }, orderBy: [{ track: 'asc' as const }, { name: 'asc' as const }] },
  bundles: { orderBy: { name: 'asc' as const } },
  addOns: { orderBy: { name: 'asc' as const } },
};

@Injectable()
export class CatalogueService {
  constructor(private readonly prisma: PrismaService) {}

  async activeBook(orgId: string) {
    const book = await this.prisma.priceBook.findFirst({
      where: { orgId, status: 'active' },
      orderBy: { effectiveFrom: 'desc' },
      include: bookInclude,
    });
    if (!book) throw new NotFoundException('No active price book. Run the seed.');
    return book;
  }

  /** Active price book in the shape the shared pricing engine expects. */
  async pricing(orgId: string): Promise<{ priceBookId: string; services: PricedService[]; addOns: PricedAddOn[]; bundles: PricedBundle[] }> {
    const book = await this.activeBook(orgId);
    return {
      priceBookId: book.id,
      services: book.services.map((s) => ({
        key: s.key,
        name: s.name,
        billingType: s.billingType,
        tiers: s.tiers.map((t) => ({ tier: t.tier, pricePaise: t.pricePaise })),
      })),
      addOns: book.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise, isCustomQuote: a.isCustomQuote })),
      bundles: book.bundles.map((b) => ({ key: b.key, name: b.name, serviceKeys: b.serviceKeys, discountPct: b.discountPct })),
    };
  }

  /**
   * Applies a tier price change as a new price book version (acceptance criteria:
   * "Catalogue price changes create a new price book version; existing proposals keep their original prices").
   */
  async newVersionWithPrice(orgId: string, serviceKey: string, tier: string, pricePaise: number) {
    return this.newVersion(orgId, { tier: { serviceKey, tier, pricePaise } });
  }

  /** Copies the active book into a new active version with one change applied (tier price, bundle saving or add-on). */
  async newVersion(
    orgId: string,
    change: {
      tier?: { serviceKey: string; tier: string; pricePaise: number };
      bundle?: { key: string; discountPct: number };
      addOn?: { name: string; next: { name: string; pricePaise: number | null; unit: string | null; isCustomQuote: boolean } | null };
    },
  ) {
    const current = await this.activeBook(orgId);
    const major = current.version.split('.')[0];
    const count = await this.prisma.priceBook.count({ where: { orgId, version: { startsWith: `${major}.` } } });
    let version = `${major}.${count + 1}`;
    while (await this.prisma.priceBook.findFirst({ where: { orgId, version } })) version = `${major}.${Number(version.split('.')[1]) + 1}`;

    const addOns = current.addOns
      .filter((a) => !(change.addOn && a.name === change.addOn.name && change.addOn.next === null))
      .map((a) => (change.addOn?.next && a.name === change.addOn.name ? { ...a, ...change.addOn.next } : a));
    if (change.addOn?.next && !current.addOns.some((a) => a.name === change.addOn!.name)) addOns.push({ ...change.addOn.next } as (typeof addOns)[number]);

    return this.prisma.$transaction(async (tx) => {
      await tx.priceBook.update({ where: { id: current.id }, data: { status: 'archived' } });
      const book = await tx.priceBook.create({ data: { orgId, version, effectiveFrom: new Date(), status: 'active' } });
      for (const s of current.services) {
        await tx.service.create({
          data: {
            orgId,
            priceBookId: book.id,
            key: s.key,
            name: s.name,
            track: s.track,
            billingType: s.billingType,
            unit: s.unit,
            excludedNote: s.excludedNote,
            tiers: {
              create: s.tiers.map((t) => ({
                tier: t.tier,
                pricePaise: change.tier && s.key === change.tier.serviceKey && t.tier === change.tier.tier ? change.tier.pricePaise : t.pricePaise,
                isFromPrice: t.isFromPrice,
                withShootPricePaise: t.withShootPricePaise,
                deliverables: t.deliverables,
                revisionRounds: t.revisionRounds,
              })),
            },
          },
        });
      }
      await tx.bundle.createMany({
        data: current.bundles.map((b) => ({ orgId, priceBookId: book.id, key: b.key, name: b.name, serviceKeys: b.serviceKeys, discountPct: change.bundle && b.key === change.bundle.key ? change.bundle.discountPct : b.discountPct })),
      });
      await tx.addOn.createMany({
        data: addOns.map((a) => ({ orgId, priceBookId: book.id, name: a.name, pricePaise: a.isCustomQuote ? null : a.pricePaise, unit: a.unit ?? null, isCustomQuote: a.isCustomQuote })),
      });
      return { version, previousVersion: current.version, priceBookId: book.id };
    });
  }
}
