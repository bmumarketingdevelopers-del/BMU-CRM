"use client";

import { useState } from "react";
import type { DataClientRow } from "@bmu/shared";
import { Column, DataTable, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Message, type Msg } from "../_platform/kit";

const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });

export default function DataPage() {
  const data = useLoad(() => api.adminPlatform.dataClients());
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<Msg>();
  const [deleting, setDeleting] = useState<DataClientRow>();

  async function exportClient(c: DataClientRow) {
    setBusy(c.id);
    setMsg(undefined);
    try {
      const out = await api.adminPlatform.exportClient(c.id);
      const url = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `${c.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg({ ok: true, text: `Downloaded all data for ${c.name}. The export is recorded in the audit log.` });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(undefined);
    }
  }

  const rows = (data.data?.clients ?? []).filter((c) => c.name.toLowerCase().includes(q.trim().toLowerCase()));
  const columns: Column<DataClientRow>[] = [
    {
      key: "name",
      header: "Client",
      cell: (c) => (
        <div>
          <span className="font-medium">{c.name}</span>
          <span className="block text-xs text-ink-muted">Since {day.format(new Date(c.createdAt))}</span>
        </div>
      ),
    },
    {
      key: "users",
      header: "People",
      cell: (c) => (
        <span className="whitespace-nowrap">
          {c.users}
          {c.anonymisedUsers > 0 && <span className="ml-2 text-xs text-ink-muted">{c.anonymisedUsers === c.users ? "all deleted" : `${c.anonymisedUsers} deleted`}</span>}
        </span>
      ),
    },
    { key: "eng", header: "Services", align: "right", cell: (c) => c.engagements },
    { key: "unpaid", header: "Unpaid invoices", cell: (c) => (c.unpaidInvoices ? <Badge tone="amber">{c.unpaidInvoices} unpaid</Badge> : <span className="text-ink-muted">None</span>) },
    {
      key: "actions",
      header: "",
      align: "right",
      cell: (c) => (
        <div className="flex justify-end gap-2 whitespace-nowrap">
          <Button variant="secondary" className="px-3 py-1.5" disabled={busy === c.id} onClick={() => exportClient(c)}>
            {busy === c.id ? "Preparing…" : "Export all data"}
          </Button>
          <Button variant="ghost" className="px-3 py-1.5 text-[#b4432c] hover:text-[#b4432c]" disabled={c.users === 0 || c.anonymisedUsers === c.users} onClick={() => setDeleting(c)}>
            Delete personal data
          </Button>
        </div>
      ),
    },
  ];

  return (
    <>
      <PageTitle title="Data Export / Deletion (DPDP)" subtitle="Give a client a copy of everything we hold about them, or erase their people's personal details, as required by India's Digital Personal Data Protection Act. Founder and Admin only; every action is audit-logged." />
      {!data.data ? (
        <LoadState loading={data.loading} error={data.error} />
      ) : (
        <div className="space-y-6">
          <StatRow cols={3}>
            <StatTile label="Clients" value={data.data.clients.length} />
            <StatTile label="Data kept for" value={`${data.data.retentionDays} days`} hint={<a href="/admin/tenant" className="underline">change in Tenant Settings</a>} />
            <StatTile label="Clients with unpaid invoices" value={data.data.clients.filter((c) => c.unpaidInvoices).length} hint="personal data can't be deleted until paid" />
          </StatRow>
          {deleting && (
            <DeletePanel
              key={deleting.id}
              client={deleting}
              onClose={() => setDeleting(undefined)}
              onDone={(n) => {
                setDeleting(undefined);
                setMsg({ ok: true, text: `Personal data of ${n} ${n === 1 ? "person" : "people"} at ${deleting.name} was deleted.` });
                data.reload();
              }}
            />
          )}
          <Message msg={msg} />
          <Panel flush title="Clients" action={<Input className="w-56! py-1.5" placeholder="Find a client…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find a client" />}>
            <DataTable rows={rows} columns={columns} rowKey={(c) => c.id} empty={q ? "No client matches." : "No clients yet."} />
          </Panel>
          <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
            <Panel title="What the export contains">
              <p className="text-sm text-ink-muted">A JSON file with the client account, their people, services and cycles, deliverables (details only, no files), requests, messages (internal team notes are left out), invoices, payments and approvals.</p>
            </Panel>
            <Panel title="What deletion does">
              <p className="text-sm text-ink-muted">Every person on the client account is renamed “Deleted user”, their email and phone are removed and they can no longer sign in. Invoices, approvals and work records stay for tax and legal reasons. This cannot be undone.</p>
            </Panel>
          </div>
        </div>
      )}
    </>
  );
}

function DeletePanel({ client, onClose, onDone }: { client: DataClientRow; onClose: () => void; onDone: (n: number) => void }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>();
  const matches = name.trim().toLowerCase() === client.name.trim().toLowerCase();

  async function run() {
    setBusy(true);
    setMsg(undefined);
    try {
      onDone((await api.adminPlatform.anonymiseClient(client.id, name)).anonymised);
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      setBusy(false);
    }
  }

  return (
    <section className="border border-red bg-red/5 p-5">
      <h2 className="text-[15px] font-semibold">Delete personal data for {client.name}?</h2>
      <p className="mt-1 text-sm text-ink-muted">
        {client.users} {client.users === 1 ? "person" : "people"} will be anonymised and lose access. This cannot be undone.
      </p>
      {client.unpaidInvoices > 0 && <p className="mt-3 text-sm">This client has {client.unpaidInvoices} unpaid invoice(s). Settle or void them first; the request will be refused.</p>}
      <label className="mt-4 block text-sm">
        <span className="mb-1 block text-xs font-medium text-ink-muted">Type the client name to confirm: {client.name}</span>
        <Input className="max-w-sm" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </label>
      <div className="mt-4 space-y-3">
        <Message msg={msg} />
        <div className="flex gap-3">
          <Button className="bg-[#b4432c]" disabled={!matches || busy} onClick={run}>
            {busy ? "Deleting…" : "Delete personal data"}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    </section>
  );
}
