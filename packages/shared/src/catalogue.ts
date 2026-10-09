import { catalogueSeed } from "./data/catalogue.js";
import { rupeesToPaise } from "./money.js";

export { catalogueSeed };

export const TIERS = ["starter", "growth", "premium"] as const;
export type Tier = (typeof TIERS)[number];

export type CatalogueService = (typeof catalogueSeed.services)[number];
export type ServiceId = CatalogueService["id"];
export type CatalogueBundle = (typeof catalogueSeed.bundles.items)[number];

export const services: readonly CatalogueService[] = catalogueSeed.services;
export const bundles: readonly CatalogueBundle[] = catalogueSeed.bundles.items;

export function getService(id: string): CatalogueService | undefined {
  return services.find((s) => s.id === id);
}

/** Price of one service tier in paise (GST exclusive). */
export function tierPricePaise(serviceId: string, tier: Tier): number {
  const service = getService(serviceId);
  if (!service) throw new Error(`Unknown service: ${serviceId}`);
  return rupeesToPaise(service.tiers[tier]);
}

/**
 * Bundle price: combined value of the selected tier across included services
 * less the bundle discount (catalogue_seed.bundles.rule).
 */
export function bundlePricePaise(bundleId: string, tier: Tier) {
  const bundle = bundles.find((b) => b.id === bundleId);
  if (!bundle) throw new Error(`Unknown bundle: ${bundleId}`);
  const gross = bundle.services.reduce((sum, id) => sum + tierPricePaise(id, tier), 0);
  const discount = Math.round((gross * catalogueSeed.bundles.discount_pct) / 100);
  return { gross, discount, net: gross - discount };
}

/** Returns the bundle whose services are all selected, if any (package builder bundle detection). */
export function detectBundle(selectedServiceIds: readonly string[]): CatalogueBundle | undefined {
  const selected = new Set(selectedServiceIds);
  return [...bundles]
    .sort((a, b) => b.services.length - a.services.length)
    .find((b) => b.services.every((id) => selected.has(id)));
}

export function groupServicesByTrack() {
  const byTrack = new Map<string, CatalogueService[]>();
  for (const s of services) {
    byTrack.set(s.track, [...(byTrack.get(s.track) ?? []), s]);
  }
  return byTrack;
}
