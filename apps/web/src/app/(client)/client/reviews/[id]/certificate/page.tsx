"use client";

import { use } from "react";
import { Certificate } from "@/components/creative/certificate";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function ClientCertificatePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const c = useLoad(() => api.proofing.clientCertificate(id), { live: false });
  return <Certificate c={c.data} loading={c.loading} error={c.error} back={{ href: `/client/reviews/${id}`, label: "Back to the work" }} />;
}
