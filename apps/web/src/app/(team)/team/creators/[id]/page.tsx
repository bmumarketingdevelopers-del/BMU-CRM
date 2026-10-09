"use client";

import Link from "next/link";
import { use, useState } from "react";
import { formatINR, type OpsCreatorDetail } from "@bmu/shared";
import { Panel } from "@/components/dash";
import { Badge, Button, LoadState, PageTitle } from "@/components/ui";
import { HistoryTab } from "@/components/actions/history-tab";
import { RowMenu } from "@/components/actions/row-menu";
import { useActions } from "@/components/actions/actions-provider";
import { Field, inputCls } from "@/components/actions/action-drawer";
import { errMsg, fmtDay, ReasonDialog } from "@/components/ops/kit";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { CustomFieldsPanel } from "@/components/custom-fields-panel";

export default function CreatorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const loaded = useLoad(() => api.ops.creators.get(id));
  const { notify, changed } = useActions();
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const c = loaded.data;

  return (
    <div className="[&_.grid>*]:min-w-0">
      <Link href="/team/creators" className="text-sm text-ink-muted hover:text-ink">
        ← Creators
      </Link>
      {!c ? (
        <div className="mt-6">
          <LoadState loading={loaded.loading} error={loaded.error} />
        </div>
      ) : (
        <>
          <PageTitle
        presence={{ entity: "Creator", id: id }}
            title={c.name}
            subtitle={[c.handle ? `@${c.handle.replace(/^@/, "")}` : null, c.city, c.phone].filter(Boolean).join(" · ")}
            action={
              <div className="flex items-center gap-2">
                {c.archivedAt ? <Badge tone="neutral">Archived</Badge> : <Button variant="secondary" onClick={() => setEditing((v) => !v)}>{editing ? "Close" : "Edit"}</Button>}
                <RowMenu
                  label={`More actions for ${c.name}`}
                  items={[
                    { key: "history", label: "History", href: "#history" },
                    { key: "archive", label: "Archive", danger: true, hidden: !!c.archivedAt, disabledReason: c.activeBriefs ? "Has open briefs. Move or cancel them first." : null, onSelect: () => setArchiving(true) },
                  ]}
                />
              </div>
            }
          />
          {c.archivedAt && <p className="mb-4 border border-border bg-canvas px-4 py-2 text-sm">Archived{c.archivedReason ? `: ${c.archivedReason}` : ""}.</p>}
          {editing && <EditCreator c={c} onDone={(m) => (notify(m), setEditing(false), loaded.reload(), changed())} />}
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <Panel title="Briefs" flush>
              {c.briefs.length === 0 ? (
                <p className="p-4 text-sm text-ink-muted">No briefs yet.</p>
              ) : (
                <ul className="divide-y divide-border text-sm">
                  {c.briefs.map((b) => (
                    <li key={b.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
                      <Link href={`/team/creators/briefs/${b.id}`} className="underline-offset-2 hover:underline">
                        {b.title}
                        <span className="block text-xs text-ink-muted">{b.client ?? "Internal"}</span>
                      </Link>
                      <span className="text-xs text-ink-muted">
                        {b.status} · {formatINR(b.feePaise)}
                        {(b.status === "approved" || b.status === "paid") && !b.rated ? " · not rated yet" : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
            <div className="grid content-start gap-6">
              <Panel title="Profile">
                <dl className="space-y-1 text-sm">
                  <div>{c.email ?? "No email"}</div>
                  <div className="flex flex-wrap gap-1">
                    {c.niche.map((n) => (
                      <Badge key={n}>{n}</Badge>
                    ))}
                  </div>
                  <div className="text-ink-muted">{c.rates.map((r) => `${r.label} ${formatINR(r.pricePaise)}`).join(" · ") || "No rates"}</div>
                  <div>Pending payouts {formatINR(c.pendingPayoutPaise)}</div>
                </dl>
              </Panel>
              <CustomFieldsPanel entity="creator" id={c.id} />
              <Panel title={c.rating ? `Rating ${c.rating.toFixed(1)} / 5` : "Rating"} subtitle={`${c.ratingCount} rating${c.ratingCount === 1 ? "" : "s"}`}>
                {c.ratings.length === 0 ? (
                  <p className="text-sm text-ink-muted">Rate the creator from a brief once the work is approved.</p>
                ) : (
                  <ul className="space-y-3 text-sm">
                    {c.ratings.map((r) => (
                      <li key={r.id}>
                        <span className="font-medium">{"★".repeat(r.score)}</span>
                        <span className="text-ink-muted">{"★".repeat(5 - r.score)}</span> · {r.brief}
                        <p className="text-ink-muted">{r.note}</p>
                        <p className="text-xs text-ink-muted">
                          {r.by} · {fmtDay(r.at)}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>
            </div>
          </div>
          <div className="mt-6" id="history">
            <HistoryTab entity="Creator" id={c.id} />
          </div>
          <ReasonDialog
            open={archiving}
            title={`Archive ${c.name}?`}
            confirm="Archive"
            danger
            onClose={() => setArchiving(false)}
            onConfirm={async (reason) => {
              const r = await api.actions.archive("creator", c.id, reason);
              notify(`${c.name} archived`, r.undo);
              loaded.reload();
              changed();
            }}
          />
        </>
      )}
    </div>
  );
}

function EditCreator({ c, onDone }: { c: OpsCreatorDetail; onDone: (message: string) => void }) {
  const [v, setV] = useState({ name: c.name, email: c.email ?? "", handle: c.handle ?? "", city: c.city ?? "", niche: c.niche.join(", ") });
  const [rates, setRates] = useState(c.rates.map((r) => ({ label: r.label, price: String(r.pricePaise / 100) })));
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof v) => (e: { target: { value: string } }) => setV((x) => ({ ...x, [k]: e.target.value }));
  async function save() {
    const niche = v.niche.split(",").map((n) => n.trim()).filter(Boolean);
    const good = rates.filter((r) => r.label.trim() && Number(r.price) > 0);
    if (v.name.trim().length < 2) return setError("Enter the creator's name");
    if (!niche.length) return setError("Add at least one niche");
    if (!good.length) return setError("Add at least one rate");
    setBusy(true);
    setError(undefined);
    try {
      const r = await api.ops.creators.edit(c.id, { name: v.name.trim(), email: v.email.trim(), handle: v.handle.trim(), city: v.city.trim(), niche, rates: good.map((x) => ({ label: x.label.trim(), pricePaise: Math.round(Number(x.price) * 100) })) });
      onDone(r.message);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Panel title="Edit creator" className="mb-6">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Name" required>
          <input className={inputCls} value={v.name} onChange={set("name")} aria-label="Name" />
        </Field>
        <Field label="Email">
          <input className={inputCls} value={v.email} onChange={set("email")} aria-label="Email" />
        </Field>
        <Field label="Handle" required>
          <input className={inputCls} value={v.handle} onChange={set("handle")} aria-label="Handle" />
        </Field>
        <Field label="City" required>
          <input className={inputCls} value={v.city} onChange={set("city")} aria-label="City" />
        </Field>
        <Field label="Niche" required hint="Separate with commas">
          <input className={inputCls} value={v.niche} onChange={set("niche")} aria-label="Niche" />
        </Field>
        <div className="grid gap-2">
          <span className="text-xs font-medium">Rates</span>
          {rates.map((r, i) => (
            <div key={i} className="grid grid-cols-[1fr_110px] gap-2">
              <input className={inputCls} value={r.label} onChange={(e) => setRates((rs) => rs.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} aria-label={`Rate ${i + 1} label`} />
              <input className={inputCls} inputMode="numeric" value={r.price} onChange={(e) => setRates((rs) => rs.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} aria-label={`Rate ${i + 1} price`} />
            </div>
          ))}
          <button type="button" className="justify-self-start text-sm underline" onClick={() => setRates((rs) => [...rs, { label: "", price: "" }])}>
            + Add a rate
          </button>
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-red">{error}</p>}
      <Button className="mt-3" disabled={busy} onClick={save}>
        {busy ? "Saving…" : "Save changes"}
      </Button>
    </Panel>
  );
}
