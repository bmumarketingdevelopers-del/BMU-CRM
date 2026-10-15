"use client";

import { BrandKitCard } from "@/components/craft/craft-bits";
import { LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function ClientBrandKitPage() {
  const kit = useLoad(() => api.creative.clientBrandKit(), { live: false });
  return (
    <>
      <PageTitle title="Brand kit" subtitle="What our team follows for your brand. Tell your Client Manager if anything here is out of date." />
      {kit.data ? <BrandKitCard kit={kit.data} readOnly /> : <LoadState loading={kit.loading} error={kit.error} />}
    </>
  );
}
