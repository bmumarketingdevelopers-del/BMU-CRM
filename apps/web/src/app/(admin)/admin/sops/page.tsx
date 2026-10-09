"use client";

import { use, useMemo, useState } from "react";
import type { SopMeta, SopView } from "@bmu/shared";
import { Empty, Panel, StatRow, StatTile } from "@/components/dash";
import { Badge, Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Field, Message, PlainDoc, Textarea, type Msg } from "../_platform/kit";

type Draft = { id?: string; title: string; departmentId: string; body: string; status?: "draft" | "published" };
const TEMPLATE = "# Purpose\nWhy this SOP exists in one or two lines.\n\n## Steps\n1. First step\n2. Second step\n\n## Checklist\n- Item to check\n- Item to check";

/** `?sop=<id>` (from search and notifications) opens that SOP. */
export default function SopsPage({ searchParams }: { searchParams: Promise<{ sop?: string }> }) {
  const { sop: linked } = use(searchParams);
  const meta = useLoad(() => api.adminPlatform.sopMeta());
  const sops = useLoad(() => api.adminPlatform.sops());
  const [dept, setDept] = useState<string>("all");
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState<string | undefined>(linked);
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();


  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (sops.data ?? []).filter((s) => (dept === "all" || s.department.id === dept) && (!term || s.title.toLowerCase().includes(term) || s.body.toLowerCase().includes(term)));
  }, [sops.data, dept, q]);
  const current = filtered.find((s) => s.id === selected) ?? filtered[0];

  if (!meta.data || !sops.data) {
    return (
      <>
        <PageTitle title="SOP Library" subtitle="Step-by-step ways of working for each department." />
        <LoadState loading={meta.loading || sops.loading} error={meta.error ?? sops.error} />
      </>
    );
  }

  const m = meta.data;
  const all = sops.data;
  const withSops = m.departments.filter((d) => d.count > 0).length;

  async function setStatus(s: SopView, status: "draft" | "published") {
    setBusy(true);
    setError(undefined);
    try {
      const r: SopView & { notice?: string } = await api.adminPlatform.setSopStatus(s.id, status);
      setNotice(r.notice);
      sops.reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function saved(s: SopView & { notice?: string }) {
    setNotice(s.notice);
    setDraft(undefined);
    setSelected(s.id);
    sops.reload();
    meta.reload();
  }

  return (
    <>
      <PageTitle
        title="SOP Library"
        subtitle="Step-by-step ways of working for each department. The team reads these in the Team app; every edit is saved as a new version."
        action={
          m.canCreate && !draft ? (
            <Button onClick={() => setDraft({ title: "", departmentId: dept !== "all" && m.editableDepartmentIds.includes(dept) ? dept : m.editableDepartmentIds[0], body: TEMPLATE })}>New SOP</Button>
          ) : undefined
        }
      />

      {notice && (
        <p className="mb-4 border border-border bg-surface-raised px-4 py-2 text-sm" role="status" data-testid="sop-notice">
          {notice}
        </p>
      )}
      <div className="mb-6">
        <StatRow cols={3}>
          <StatTile label="SOPs" value={all.length} hint="across all departments" />
          <StatTile label="Departments covered" value={`${withSops} of ${m.departments.length}`} tone={withSops < m.departments.length ? "warn" : "good"} hint={withSops < m.departments.length ? "some departments have none yet" : "every department has an SOP"} />
          <StatTile label="Most revised" value={all.length ? `v${Math.max(...all.map((s) => s.version))}` : "—"} hint={all.length ? [...all].sort((a, b) => b.version - a.version)[0].title : undefined} />
        </StatRow>
      </div>

      {draft ? (
        <SopEditor key={draft.id ?? "new"} draft={draft} meta={m} onCancel={() => setDraft(undefined)} onSaved={saved} />
      ) : (
        <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-[320px_1fr]">
          <div className="space-y-4">
            <Input placeholder="Search titles and steps…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search SOPs" />
            <Select className="w-full" value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department">
              <option value="all">All departments ({all.length})</option>
              {m.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} ({d.count})
                </option>
              ))}
            </Select>
            <Panel flush>
              {filtered.length === 0 ? (
                <Empty>{all.length ? "No SOP matches your search." : "No SOPs yet. Create the first one."}</Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {filtered.map((s) => (
                    <li key={s.id}>
                      <button onClick={() => setSelected(s.id)} className={`block w-full px-4 py-3 text-left hover:bg-canvas/50 ${current?.id === s.id ? "border-l-2 border-charcoal bg-canvas/60" : "border-l-2 border-transparent"}`}>
                        <span className="block text-sm font-medium">
                          {s.title} {s.status === "draft" && <Badge tone="amber">Draft</Badge>}
                        </span>
                        <span className="mt-0.5 block text-xs text-ink-muted">
                          {s.department.name} · v{s.version}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>
          <div>
            {current ? (
              <Panel
                title={current.title}
                subtitle={`${current.department.name} · version ${current.version}${current.status === "draft" ? " · draft, only editors can see it" : ` · ${current.acknowledged ?? 0} read and acknowledged this version`}`}
                action={
                  current.canEdit ? (
                    <div className="flex gap-2">
                      {current.status === "draft" ? (
                        <Button disabled={busy} onClick={() => setStatus(current, "published")}>
                          Publish
                        </Button>
                      ) : (
                        <Button variant="ghost" disabled={busy} onClick={() => setStatus(current, "draft")}>
                          Unpublish
                        </Button>
                      )}
                      <Button variant="secondary" onClick={() => setDraft({ id: current.id, title: current.title, departmentId: current.department.id, body: current.body, status: current.status })}>
                        Edit
                      </Button>
                    </div>
                  ) : (
                    <Badge>Read only</Badge>
                  )
                }
              >
                {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
                <div className="max-w-2xl">
                  <PlainDoc body={current.body} />
                </div>
              </Panel>
            ) : (
              <Panel>
                <Empty>Pick an SOP to read it.</Empty>
              </Panel>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function SopEditor({ draft, meta, onCancel, onSaved }: { draft: Draft; meta: SopMeta; onCancel: () => void; onSaved: (s: SopView) => void }) {
  const [d, setD] = useState(draft);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>();
  const depts = meta.departments.filter((x) => meta.editableDepartmentIds.includes(x.id));

  async function save(status?: "draft" | "published") {
    setBusy(true);
    setMsg(undefined);
    try {
      const input = { title: d.title, departmentId: d.departmentId, body: d.body, ...(status ? { status } : {}) };
      onSaved(d.id ? await api.adminPlatform.updateSop(d.id, input) : await api.adminPlatform.createSop(input));
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message });
      setBusy(false);
    }
  }

  return (
    <Panel title={d.id ? "Edit SOP" : "New SOP"} subtitle={d.id ? "Saving creates the next version. The old text stays in the audit log." : "Write the steps in plain text. Use # for headings, - for bullets and 1. for steps."}>
      <div className="grid gap-6 [&>*]:min-w-0 lg:grid-cols-2">
        <div className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
            <Field label="Title">
              <Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} placeholder="e.g. Design QC" />
            </Field>
            <Field label="Department">
              <Select className="w-full py-2" value={d.departmentId} onChange={(e) => setD({ ...d, departmentId: e.target.value })}>
                {depts.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <Field label="Steps">
            <Textarea rows={20} className="font-mono text-[13px]" value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} />
          </Field>
          <Message msg={msg} />
          <div className="flex gap-3">
            <Button disabled={busy} onClick={() => save(d.id ? undefined : "published")}>
              {busy ? "Saving…" : d.id ? (d.status === "draft" ? "Save draft" : "Save new version") : "Publish SOP"}
            </Button>
            {!d.id && (
              <Button variant="secondary" disabled={busy} onClick={() => save("draft")}>
                Save as draft
              </Button>
            )}
            <Button variant="ghost" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
          </div>
        </div>
        <div className="border border-border bg-canvas/30 p-5">
          <p className="mb-4 text-[11px] uppercase tracking-[0.1em] text-ink-muted">Preview</p>
          {d.title && <p className="mb-3 text-[15px] font-semibold">{d.title}</p>}
          <PlainDoc body={d.body} />
        </div>
      </div>
    </Panel>
  );
}
