"use client";

// v57: Bundles have their own page (they were a section of Services & Tiers). First the bundles of sub-services that
// clients, quotations and invoices use; then the old price book bundles that running proposals still use.
import { PriceBookSections } from "@/components/catalogue/price-book";
import { ServiceBundlesAdmin } from "@/components/catalogue/service-groups-admin";
import { PageTitle } from "@/components/ui";

export default function BundlesPage() {
  return (
    <>
      <PageTitle title="Bundles" subtitle="Sub-services sold together as one project, priced from today's plan prices minus the saving. Prices exclude GST." />
      <ServiceBundlesAdmin />
      <PriceBookSections show={["bundles"]} />
    </>
  );
}
