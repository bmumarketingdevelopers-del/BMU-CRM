"use client";

// v57: QC checklists have their own page (they used to sit at the bottom of Department Flow Templates). One checklist
// per kind of work; the QC reviewer ticks these items on every version before it can go to the client.
import { useState } from "react";
import type { QcTemplateView } from "@bmu/shared";
import { Button, Card, Input, LoadState, PageTitle } from "@/components/ui";
import { useCanPublish } from "@/components/templates/can-publish";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

export default function QcChecklistsPage() {
  const qc = useLoad(() => api.templates.qc());
  return (
    <>
      <PageTitle
        title="QC checklists"
        subtitle="What the QC reviewer checks on every version before it can go to the client, one list per kind of work. Saving creates a new version; checks already done keep the list they used."
      />
      {!qc.data ? <LoadState loading={qc.loading} error={qc.error} /> : <div className="grid gap-4 md:grid-cols-2">{qc.data.map((c) => <QcEditor key={`${c.key}-${c.version}`} list={c} />)}</div>}
    </>
  );
}

function QcEditor({ list }: { list: QcTemplateView }) {
  const canPublish = useCanPublish();
  const [name, setName] = useState(list.name);
  const [items, setItems] = useState(list.items.join("\n"));
  const [version, setVersion] = useState(list.version);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  async function save() {
    try {
      const saved = await api.templates.saveQc(list.key, { name, items: items.split("\n").map((s) => s.trim()).filter(Boolean) });
      setVersion(saved.find((c) => c.key === list.key)?.version ?? version);
      setMsg({ ok: true, text: canPublish ? "Saved." : "Sent to a Branch Manager to publish. The current version stays live until then." });
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
    }
  }
  return (
    <Card>
      <div className="mb-2 flex items-center justify-between gap-2">
        <Input value={name} onChange={(e) => setName(e.target.value)} className="font-semibold" aria-label="Checklist name" />
        <span className="shrink-0 text-xs text-ink-muted">v{version}</span>
      </div>
      <textarea className="w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={6} value={items} onChange={(e) => setItems(e.target.value)} aria-label={`Checks in ${name}`} />
      <p className="text-xs text-ink-muted">One check per line.</p>
      <div className="mt-2 flex items-center gap-2">
        <Button onClick={save}>Save</Button>
        {msg && <span className={`text-sm ${msg.ok ? "text-ink-muted" : "text-red"}`}>{msg.text}</span>}
      </div>
    </Card>
  );
}
