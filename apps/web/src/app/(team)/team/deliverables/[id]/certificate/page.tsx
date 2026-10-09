"use client";

import { use } from "react";
import { Certificate } from "@/components/creative/certificate";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function TeamCertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const c = useLoad(() => api.proofing.certificate(id), { live: false });
  return <Certificate c={c.data} loading={c.loading} error={c.error} back={{ href: `/team/deliverables/${id}`, label: "Back to the work" }} />;
}
