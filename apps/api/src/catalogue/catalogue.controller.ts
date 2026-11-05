import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { addOnInputSchema, rupeesToPaise, SERVICE_GROUPS_BOOK, serviceGroupInputSchema, services, setBundleDiscountSchema, setTierPriceSchema, subServiceInputSchema, type CatalogueAdmin, type Me, type ServiceGroupView, type ServiceSummary } from '@bmu/shared';
import { AuditService } from '../audit/audit.service.js';
import { ClientIp, CurrentUser, Public, RequireCapability } from '../common/decorators.js';
import { parse } from '../common/zod.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CatalogueService } from './catalogue.service.js';
import { createServiceGroupTx, listServiceGroups } from './service-groups.js';

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
      throw new ForbiddenException('Branch Managers can propose price changes; only the Founder can apply them');
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
    if (me.permissions.catalogue_pricing_engine?.rule !== 'full') throw new ForbiddenException('Branch Managers can propose price changes; only the Founder can apply them');
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

  // v47: service groups and sub-services. Hiding keeps running projects intact; the name of a group is its project's name.

  @Get('groups')
  @RequireCapability('catalogue_pricing_engine')
  groups(@CurrentUser() me: Me): Promise<ServiceGroupView[]> {
    return listServiceGroups(this.prisma, me.orgId, { all: true });
  }

  @Post('groups')
  @RequireCapability('catalogue_pricing_engine')
  async addGroup(@CurrentUser() me: Me, @Body() body: unknown, @ClientIp() ip?: string): Promise<ServiceGroupView[]> {
    const { name } = parse(serviceGroupInputSchema, body);
    const all = await listServiceGroups(this.prisma, me.orgId, { all: true });
    if (all.some((g) => g.name.toLowerCase() === name.toLowerCase())) throw new BadRequestException('A service with that name already exists');
    const g = await this.prisma.$transaction((tx) => createServiceGroupTx(tx, me.orgId, name, all.length));
    await this.audit.log(me, 'service_group.created', 'ServiceGroup', g.id, null, { name }, ip);
    return listServiceGroups(this.prisma, me.orgId, { all: true });
  }

  @Patch('groups/:id')
  @RequireCapability('catalogue_pricing_engine')
  async saveGroup(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string): Promise<ServiceGroupView[]> {
    const input = parse(serviceGroupInputSchema, body);
    const g = await this.prisma.serviceGroup.findFirst({ where: { id, orgId: me.orgId } });
    if (!g) throw new NotFoundException('Service not found');
    if (await this.prisma.serviceGroup.count({ where: { orgId: me.orgId, name: { equals: input.name, mode: 'insensitive' }, id: { not: id } } })) throw new BadRequestException('A service with that name already exists');
    await this.prisma.$transaction([
      this.prisma.serviceGroup.update({ where: { id }, data: { name: input.name, ...(input.archived === undefined ? {} : { archivedAt: input.archived ? (g.archivedAt ?? new Date()) : null }) } }),
      this.prisma.service.update({ where: { id: g.serviceId }, data: { name: input.name, track: input.name } }),
    ]);
    await this.audit.log(me, 'service_group.changed', 'ServiceGroup', id, { name: g.name, archived: !!g.archivedAt }, input, ip);
    return listServiceGroups(this.prisma, me.orgId, { all: true });
  }

  @Post('groups/:id/sub-services')
  @RequireCapability('catalogue_pricing_engine')
  async addSubService(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string): Promise<ServiceGroupView[]> {
    const { name, covers } = parse(subServiceInputSchema, body);
    const g = await this.prisma.serviceGroup.findFirst({ where: { id, orgId: me.orgId }, include: { subServices: true } });
    if (!g) throw new NotFoundException('Service not found');
    if (g.subServices.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new BadRequestException('That sub-service is already listed');
    const s = await this.prisma.subService.create({ data: { orgId: me.orgId, groupId: id, name, covers, sortOrder: g.subServices.length } });
    await this.audit.log(me, 'sub_service.created', 'SubService', s.id, null, { group: g.name, name }, ip);
    return listServiceGroups(this.prisma, me.orgId, { all: true });
  }

  @Patch('sub-services/:id')
  @RequireCapability('catalogue_pricing_engine')
  async saveSubService(@CurrentUser() me: Me, @Param('id') id: string, @Body() body: unknown, @ClientIp() ip?: string): Promise<ServiceGroupView[]> {
    const input = parse(subServiceInputSchema, body);
    const s = await this.prisma.subService.findFirst({ where: { id, orgId: me.orgId } });
    if (!s) throw new NotFoundException('Sub-service not found');
    if (await this.prisma.subService.count({ where: { groupId: s.groupId, name: { equals: input.name, mode: 'insensitive' }, id: { not: id } } })) throw new BadRequestException('That sub-service is already listed');
    await this.prisma.subService.update({ where: { id }, data: { name: input.name, covers: input.covers, ...(input.archived === undefined ? {} : { archivedAt: input.archived ? (s.archivedAt ?? new Date()) : null }) } });
    await this.audit.log(me, 'sub_service.changed', 'SubService', id, { name: s.name, covers: s.covers, archived: !!s.archivedAt }, input, ip);
    return listServiceGroups(this.prisma, me.orgId, { all: true });
  }

  /** Price book history: every version and how many proposals were priced from it. */
  @Get('versions')
  @RequireCapability('catalogue_pricing_engine')
  async versions(@CurrentUser() me: Me) {
    const books = await this.prisma.priceBook.findMany({ where: { orgId: me.orgId, version: { not: SERVICE_GROUPS_BOOK } }, orderBy: { effectiveFrom: 'desc' }, take: 30 });
    const counts = await this.prisma.proposal.groupBy({ by: ['priceBookId'], where: { priceBookId: { in: books.map((b) => b.id) } }, _count: true });
    return books.map((b) => ({ id: b.id, version: b.version, status: b.status, effectiveFrom: b.effectiveFrom.toISOString(), proposals: counts.find((c) => c.priceBookId === b.id)?._count ?? 0 }));
  }
}
