"use client";

import { useState } from "react";
import { serviceEmailKindLabels, serviceEmailStatusLabels, type ServiceOutboxDetail, type ServiceOutboxRow } from "@bmu/shared";
import { DataTable, Panel, StatRow, StatTile, type Column } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { FormNote, fmtDateTime } from "../_insights/kit";

const tone = (s: string) => (s === "sent" ? "green" : s === "failed" ? "red" : s === "sending" ? "amber" : "neutral");

export default function OutboxPage() {
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [q, setQ] = useState("");
  const state = useLoad(() => api.service.outbox());
  const [view, setView] = useState<Awaited<ReturnType<typeof api.service.outbox>>>();
  const [open, setOpen] = useState<ServiceOutboxDetail>();
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const data = view ?? state.data;

  async function filter(next: { status?: string; kind?: string; q?: string }) {
    const f = { status, kind, q, ...next };
    setStatus(f.status);
    setKind(f.kind);
    setQ(f.q);
    try {
      setView(await api.service.outbox({ status: f.status || undefined, kind: f.kind || undefined, q: f.q || undefined }));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function show(id: string) {
    setErr(null);
    try {
      setOpen(await api.service.outboxEmail(id));
    } catch (e) {
      setErr((e as Error).message);
    }
  }

  async function resend() {
    if (!open) return;
    setBusy(true);
    setErr(null);
    try {
      setOpen(await api.service.resendEmail(open.id));
      filter({});
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) return <LoadState loading={state.loading} error={state.error} />;
  const columns: Column<ServiceOutboxRow>[] = [
    { key: "at", header: "When", cell: (r) => <span className="whitespace-nowrap">{fmtDateTime(r.createdAt)}</span> },
    { key: "to", header: "To", cell: (r) => <span className="break-all">{r.toName ? `${r.toName} · ` : ""}{r.to}</span> },
    {
      key: "subject",
      header: "Subject",
      cell: (r) => (
        <button className="text-left hover:underline" onClick={() => show(r.id)}>
          {r.subject}
        </button>
      ),
    },
    { key: "kind", header: "Type", cell: (r) => <span className="text-ink-muted">{serviceEmailKindLabels[r.kind] ?? r.kind.replace(/_/g, " ")}</span> },
    { key: "status", header: "Status", cell: (r) => <Badge tone={tone(r.status)}>{serviceEmailStatusLabels[r.status] ?? r.status}</Badge> },
  ];
  return (
    <>
      <PageTitle
        title="Outbox"
        subtitle={data.smtp.configured ? `Every email the app sends, via ${data.smtp.host} from ${data.smtp.from}.` : "Every email the app would send. No email server is set up yet, so they are saved here instead of being sent (add SMTP_* to apps/api/.env)."}
      />
      <div className="space-y-8">
        <StatRow cols={4}>
          <StatTile label="Emails" value={data.counts.total} hint="all time" />
          <StatTile label="Last 7 days" value={data.counts.last7Days} />
          <StatTile label="Failed" value={data.counts.failed} tone={data.counts.failed ? "bad" : "default"} />
          <StatTile label="Email server" value={data.smtp.configured ? "Connected" : "Not set up"} tone={data.smtp.configured ? "good" : "warn"} hint={data.smtp.configured ? data.smtp.from : "emails are only stored"} />
        </StatRow>
        <div className="flex flex-wrap items-end gap-3">
          <Select value={status} onChange={(e) => filter({ status: e.target.value })} aria-label="Status">
            <option value="">Any status</option>
            {Object.entries(serviceEmailStatusLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
          <Select value={kind} onChange={(e) => filter({ kind: e.target.value })} aria-label="Type">
            <option value="">Any type</option>
            {data.counts.byKind.map((k) => (
              <option key={k.kind} value={k.kind}>
                {serviceEmailKindLabels[k.kind] ?? k.kind.replace(/_/g, " ")} ({k.count})
              </option>
            ))}
          </Select>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              filter({});
            }}
            className="flex gap-2"
          >
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search email or subject" />
            <Button variant="secondary">Search</Button>
          </form>
        </div>
        <FormNote error={err} />
        <div className="grid gap-6 xl:grid-cols-[1.2fr_1fr]">
          <Panel className="min-w-0" title="Emails" subtitle="Newest first. Click a subject to see the email." flush>
            <DataTable rows={data.rows} columns={columns} rowKey={(r) => r.id} empty="No emails yet. Sign-in codes, invoices, quotes and reminders will appear here." />
          </Panel>
          {open && (
            <Panel
              className="min-w-0"
              title={open.subject}
              subtitle={`To ${open.to} · ${fmtDateTime(open.createdAt)} · ${serviceEmailStatusLabels[open.status] ?? open.status}${open.error ? ` · ${open.error}` : ""}`}
              action={
                <div className="flex gap-2">
                  {data.canResend && open.kind !== "otp" && (
                    <Button variant="secondary" className="!py-1 text-xs" disabled={busy} onClick={resend}>
                      Send again
                    </Button>
                  )}
                  <Button variant="ghost" className="!py-1 text-xs" onClick={() => setOpen(undefined)}>
                    Close
                  </Button>
                </div>
              }
              flush
            >
              <iframe title="Email preview" srcDoc={open.html} sandbox="" className="h-[32rem] w-full border-0 bg-white" data-testid="outbox-preview" />
            </Panel>
          )}
        </div>
        <WhatsAppQueue />
      </div>
    </>
  );
}

/** v14: WhatsApp messages queued by workflows. They wait here until WhatsApp Business is connected. */
function WhatsAppQueue() {
  const wa = useLoad(() => api.workflows.whatsappQueue(), { live: ["WhatsAppMessage"] });
  return (
    <Panel className="min-w-0" title="WhatsApp queue" subtitle="Messages workflows want to send. Until WhatsApp Business is connected (Integrations), copy them and send from your phone." flush>
      {!wa.data ? (
        <LoadState loading={wa.loading} error={wa.error} />
      ) : (
        <DataTable
          rows={wa.data}
          rowKey={(r) => r.id}
          empty="No WhatsApp messages yet. Workflows with a “Send a WhatsApp” step put them here."
          columns={[
            { key: "at", header: "When", cell: (r) => <span className="whitespace-nowrap text-ink-muted">{fmtDateTime(r.createdAt)}</span> },
            { key: "to", header: "To", cell: (r) => (r.link ? <a href={r.link} className="hover:underline">{r.toName ?? r.toPhone}</a> : (r.toName ?? r.toPhone)) },
            { key: "phone", header: "Phone", cell: (r) => <a href={`https://wa.me/${r.toPhone.replace(/\D/g, "")}?text=${encodeURIComponent(r.body)}`} target="_blank" rel="noreferrer" className="font-mono text-xs underline">{r.toPhone}</a> },
            { key: "body", header: "Message", className: "min-w-80", cell: (r) => <span className="text-xs">{r.body}</span> },
            { key: "status", header: "Status", cell: (r) => <Badge tone={tone(r.status)}>{r.status === "queued" ? "Waiting" : r.status}</Badge> },
          ]}
        />
      )}
    </Panel>
  );
}
