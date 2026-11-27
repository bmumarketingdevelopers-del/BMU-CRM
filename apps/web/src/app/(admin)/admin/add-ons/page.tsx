"use client";

// v57: Add-ons have their own page (they were a section of Services & Tiers).
import { PriceBookSections, usePriceBookLine } from "@/components/catalogue/price-book";
import { PageTitle } from "@/components/ui";

export default function AddOnsPage() {
  const line = usePriceBookLine();
  return (
    <>
      <PageTitle title="Add-ons" subtitle={line ? `Extras sold on top of a service, with a fixed price or a custom quote. ${line}` : "Extras sold on top of a service, with a fixed price or a custom quote."} />
      <PriceBookSections show={["addons"]} />
    </>
  );
}
