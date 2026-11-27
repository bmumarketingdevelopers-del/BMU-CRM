"use client";

// v57: Services & Tiers: services with their sub-services and plan prices, industries, the old price list and the
// price book history. Bundles and Add-ons have their own pages.
import { PriceBookSections, usePriceBookLine } from "@/components/catalogue/price-book";
import { ServiceGroupsAdmin } from "@/components/catalogue/service-groups-admin";
import { PageTitle } from "@/components/ui";

export default function CataloguePage() {
  const line = usePriceBookLine();
  return (
    <>
      <PageTitle title="Services & tiers" subtitle={line} />
      <ServiceGroupsAdmin bundles={false} />
      <PriceBookSections show={["oldPrices", "history"]} />
    </>
  );
}
