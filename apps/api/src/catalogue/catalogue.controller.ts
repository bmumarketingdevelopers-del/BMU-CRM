import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Put } from '@nestjs/common';
import { addOnInputSchema, rupeesToPaise, services, setBundleDiscountSchema, setTierPriceSchema, type CatalogueAdmin, type Me, type ServiceSummary } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { ClientIp, CurrentUser, Public, RequireCapability } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CatalogueService } from './catalogue.service.js';

@Controller('catalogue')
export class CatalogueController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly catalogue: CatalogueService,
  ) {}

  /** Services from the active price book; falls back to the bundled catalogue seed if the DB is empty or down. */
  @Public()
  @Get('services')
  async services(): Promise<ServiceSummary[]> {
    try {
      const rows = await this.prisma.service.findMany({
        where: { priceBook: { status: 'active' } },
        include: { tiers: { orderBy: { pricePaise: 'asc' } } },
        orderBy: [{ track: 'asc' }, { name: 'asc' }],
      });
      if (rows.length > 0) {
        return rows.map((s) => ({
          id: s.key,
          name: s.name,
          track: s.track,
          billingType: s.billingType,
          tiers: s.tiers.map((t) => ({ tier: t.tier, pricePaise: t.pricePaise })),
        }));
      }
    } catch {
      // fall through to seed data
    }
    return services.map((s) => ({
      id: s.id,
      name: s.name,
      track: s.track,
      billingType: s.billing_type,
      tiers: Object.entries(s.tiers).map(([tier, rupees]) => ({
        tier,
        pricePaise: rupeesToPaise(rupees),
      })),
    }));
  }

  @Get('admin')
  @RequireCapability('catalogue_pricing_engine')
  async admin(@CurrentUser() me: Me): Promise<CatalogueAdmin> {
    const book = await this.catalogue.activeBook(me.orgId);
    return {
      priceBook: { id: book.id, version: book.version, status: book.status },
      services: book.services.map((s) => ({
        id: s.key,
        name: s.name,
        track: s.track,
        billingType: s.billingType,
        excludedNote: s.excludedNote,
        tiers: s.tiers.map((t) => ({ tier: t.tier, pricePaise: t.pricePaise })),
      })),
      bundles: book.bundles.map((b) => ({ key: b.key, name: b.name, serviceKeys: b.serviceKeys, discountPct: b.discountPct })),
      addOns: book.addOns.map((a) => ({ id: a.id, name: a.name, pricePaise: a.pricePaise, unit: a.unit, isCustomQuote: a.isCustomQuote })),
    };
  }

  /** Only the Founder changes prices (catalogue_pricing_engine: admin may only propose). */
  @Patch('tiers')
  @RequireCapability('catalogue_pricing_engine')
  async setTierPrice(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string): Promise<CatalogueAdmin> {
    if (me.permissions.catalogue_pricing_engine?.rule !== 'full') {
      throw new ForbiddenException('Admins can propose price changes; only the Founder can apply them');
    }
    const { serviceKey, tier, priceRupees } = parse(setTierPriceSchema, body);
    const book = await this.catalogue.activeBook(me.orgId);
    const current = book.services.find((s) => s.key === serviceKey)?.tiers.find((t) => t.tier === tier);
    if (!current) throw new NotFoundException('Service tier not found');

    const { version, previousVersion } = await this.catalogue.newVersionWithPrice(me.orgId, serviceKey, tier, rupeesToPaise(priceRupees));
    await this.audit.log(
      me,
      'price.changed',
      'ServiceTier',
      `${serviceKey}:${tier}`,
      { pricePaise: current.pricePaise, priceBook: previousVersion },
      { pricePaise: rupeesToPaise(priceRupees), priceBook: version },
      ip,
    );
    return this.admin(me);
  }

  private assertPriceSetter(me: Me) {
    if (me.permissions.catalogue_pricing_engine?.rule !== 'full') throw new ForbiddenException('Admins can propose price changes; only the Founder can apply them');
  }

  /** Bundle saving %: a new price book version. */
  @Patch('bundles/:key')
  @RequireCapability('catalogue_pricing_engine')
  async setBundle(@CurrentUser() me: Me, @Param('key') key: string, @Body() body: unknown, @ClientIp() ip?: string): Promise<CatalogueAdmin> {
    this.assertPriceSetter(me);
    const { discountPct } = parse(setBundleDiscountSchema, body);
    const book = await this.catalogue.activeBook(me.orgId);
    const bundle = book.bundles.find((b) => b.key === key);
    if (!bundle) throw new NotFoundException('Bundle not found');
    if (bundle.discountPct === discountPct) return this.admin(me);
    const { version, previousVersion } = await this.catalogue.newVersion(me.orgId, { bundle: { key, discountPct } });
    await this.audit.log(me, 'bundle.changed', 'Bundle', key, { discountPct: bundle.discountPct, priceBook: previousVersion }, { discountPct, priceBook: version }, ip);
    return this.admin(me);
  }

  /** Create or change an add-on (by its current name): a new price book version. */
  @Put('add-ons/:name')
  @RequireCapability('catalogue_pricing_engine')
  async saveAddOn(@CurrentUser() me: Me, @Param('name') name: string, @Body() body: unknown, @ClientIp() ip?: string): Promise<CatalogueAdmin> {
    this.assertPriceSetter(me);
    const input = parse(addOnInputSchema, body);
    const book = await this.catalogue.activeBook(me.orgId);
    const existing = book.addOns.find((a) => a.name === name);
    if (input.name !== name && book.addOns.some((a) => a.name === input.name)) throw new ForbiddenException('An add-on with that name already exists');
    const next = { name: input.name, pricePaise: input.isCustomQuote || input.priceRupees === null ? null : rupeesToPaise(input.priceRupees), unit: input.unit ?? null, isCustomQuote: input.isCustomQuote ?? false };
    const { version, previousVersion } = await this.catalogue.newVersion(me.orgId, { addOn: { name, next } });
    await this.audit.log(me, existing ? 'addon.changed' : 'addon.created', 'AddOn', input.name, existing ? { name: existing.name, pricePaise: existing.pricePaise, unit: existing.unit, priceBook: previousVersion } : null, { ...next, priceBook: version }, ip);
    return this.admin(me);
  }

  @Delete('add-ons/:name')
  @RequireCapability('catalogue_pricing_engine')
  async removeAddOn(@CurrentUser() me: Me, @Param('name') name: string, @ClientIp() ip?: string): Promise<CatalogueAdmin> {
    this.assertPriceSetter(me);
    const book = await this.catalogue.activeBook(me.orgId);
    const existing = book.addOns.find((a) => a.name === name);
    if (!existing) throw new NotFoundException('Add-on not found');
    const { version, previousVersion } = await this.catalogue.newVersion(me.orgId, { addOn: { name, next: null } });
    await this.audit.log(me, 'addon.removed', 'AddOn', name, { name, pricePaise: existing.pricePaise, priceBook: previousVersion }, { priceBook: version }, ip);
    return this.admin(me);
  }

  /** Price book history: every version and how many proposals were priced from it. */
  @Get('versions')
  @RequireCapability('catalogue_pricing_engine')
  async versions(@CurrentUser() me: Me) {
    const books = await this.prisma.priceBook.findMany({ where: { orgId: me.orgId }, orderBy: { effectiveFrom: 'desc' }, take: 30 });
    const counts = await this.prisma.proposal.groupBy({ by: ['priceBookId'], where: { priceBookId: { in: books.map((b) => b.id) } }, _count: true });
    return books.map((b) => ({ id: b.id, version: b.version, status: b.status, effectiveFrom: b.effectiveFrom.toISOString(), proposals: counts.find((c) => c.priceBookId === b.id)?._count ?? 0 }));
  }
}
