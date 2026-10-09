"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { FormRow } from "@bmu/shared";
import { DataTable, Panel } from "@/components/dash";
import { Badge, Button, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { WithData, ago } from "../automations/_parts/kit";

const STARTER_FIELDS = [
  { id: "name", type: "name" as const, label: "Your name", required: true },
  { id: "company", type: "company" as const, label: "Business name", required: false },
  { id: "phone", type: "phone" as const, label: "Phone / WhatsApp", required: true },
  { id: "email", type: "email" as const, label: "Email", required: false },
  { id: "services", type: "services" as const, label: "What can we help with?", required: false },
  { id: "message", type: "message" as const, label: "Tell us a little about your business", required: false },
];

export default function FormsPage() {
  const router = useRouter();
  const state = useLoad(() => api.forms.list());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const f = await api.forms.create({ name: `Enquiry form ${new Date().toLocaleDateString("en-IN", { day: "numeric", month: "short" })}`, title: "Tell us about your business", intro: "Fill this in and our team will call you within one working day.", fields: STARTER_FIELDS, submitLabel: "Send", successMessage: "Thank you! We will get back to you within one working day.", serviceIds: [], enabled: true });
      router.push(`/admin/forms/${f.id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  return (
    <>
      <PageTitle
        title="Forms"
        subtitle="Enquiry forms for your website or a shared link. Every answer becomes a lead and starts your new-lead workflow."
        action={
          <Button onClick={create} disabled={busy}>
            {busy ? "Creating…" : "New form"}
          </Button>
        }
      />
      {error && <p className="mb-6 border border-red bg-red/10 px-4 py-3 text-sm">{error}</p>}
      <WithData state={state}>
        {(rows) => (
          <Panel flush className="min-w-0">
            <DataTable<FormRow>
              rows={rows}
              rowKey={(r) => r.id}
              empty="No forms yet. Create one and paste it into your website."
              columns={[
                {
                  key: "name",
                  header: "Form",
                  className: "min-w-60",
                  cell: (r) => (
                    <Link href={`/admin/forms/${r.id}`} className="block hover:underline">
                      <span className="font-medium">{r.name}</span>
                      <span className="block text-xs text-ink-muted">
                        {r.title} · {r.fieldCount} question{r.fieldCount === 1 ? "" : "s"}
                      </span>
                    </Link>
                  ),
                },
                {
                  key: "link",
                  header: "Link",
                  cell: (r) => (
                    <a href={`/f/${r.slug}`} target="_blank" rel="noreferrer" className="font-mono text-xs hover:underline">
                      /f/{r.slug}
                    </a>
                  ),
                },
                { key: "on", header: "Status", cell: (r) => (r.enabled ? <Badge tone="green">Live</Badge> : <Badge>Off</Badge>) },
                { key: "subs", header: "Leads", align: "right", cell: (r) => r.submitCount },
                { key: "last", header: "Last lead", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{ago(r.lastSubmissionAt)}</span> },
              ]}
            />
          </Panel>
        )}
      </WithData>
    </>
  );
}
