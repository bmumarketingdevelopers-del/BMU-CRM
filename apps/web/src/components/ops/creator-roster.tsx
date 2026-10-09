"use client";

/** Creator roster: + Add, import, search and filters, saved views, bulk archive, export, row menu, empty state. */
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { formatINR, type OpsCreatorRow } from "@bmu/shared";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { Badge, Input, LoadState, Select } from "@/components/ui";
import { useActions } from "@/components/actions/actions-provider";
import { BulkBar, BulkButton, useSelection } from "@/components/actions/bulk-bar";
import { ImportWizard } from "@/components/actions/import-wizard";
import { RowMenu } from "@/components/actions/row-menu";
import { SavedViewsMenu } from "@/components/actions/saved-views-menu";
import { CsvButton } from "@/components/charts";
import { AddButton, EmptyAdd, errMsg, GhostButton, ReasonDialog } from "./kit";

type F = { q: string; niche: string; city: string; minRating: string; archived: boolean };
const EMPTY: F = { q: "", niche: "", city: "", minRating: "", archived: false };

export function CreatorRoster() {
  const { openNew, canNew, notify, version, changed } = useActions();
  const [f, setF] = useState<F>(EMPTY);
  const archivedRef = useRef(false);
  const list = useLoad(() => api.ops.creators.list(archivedRef.current));
  const [importing, setImporting] = useState(false);
  const [archiving, setArchiving] = useState<string[] | null>(null);
  const reload = list.reload;
  useEffect(() => {
    if (version) reload();
  }, [version, reload]);
  useEffect(() => {
    if (archivedRef.current !== f.archived) {
      archivedRef.current = f.archived;
      reload();
    }
  }, [f.archived, reload]);

  const rows = useMemo(() => list.data ?? [], [list.data]);
  const niches = useMemo(() => [...new Set(rows.flatMap((c) => c.niche))].sort(), [rows]);
  const cities = useMemo(() => [...new Set(rows.map((c) => c.city).filter(Boolean) as string[])].sort(), [rows]);
  const shown = useMemo(() => {
    const q = f.q.trim().toLowerCase().replace(/^@/, "");
    return rows.filter((c) => {
      if (q && ![c.name, c.handle, c.city, c.phone, c.email, ...c.niche].some((x) => x?.toLowerCase().includes(q))) return false;
      if (f.niche && !c.niche.includes(f.niche)) return false;
      if (f.city && c.city !== f.city) return false;
      if (f.minRating && (c.rating ?? 0) < Number(f.minRating)) return false;
      return true;
    });
  }, [rows, f]);
  const ids = useMemo(() => shown.map((c) => c.id), [shown]);
  const sel = useSelection(ids);
  const add = canNew("creator") ? () => openNew("creator", undefined, () => reload()) : null;
  const active = JSON.stringify(f) !== JSON.stringify(EMPTY);

  async function archive(list: string[], reason: string) {
    const failed: string[] = [];
    let undo = null;
    for (const id of list) {
      try {
        const r = await api.actions.archive("creator", id, reason);
        if (list.length === 1) undo = r.undo;
      } catch (e) {
        failed.push(`${rows.find((c) => c.id === id)?.name ?? id}: ${errMsg(e)}`);
      }
    }
    if (failed.length === list.length) throw new Error(failed.join("; "));
    notify(failed.length ? `${list.length - failed.length} archived. Not archived: ${failed.join("; ")}` : list.length === 1 ? "Creator archived" : `${list.length} creators archived`, undo, failed.length ? "error" : "ok");
    sel.clear();
    changed();
  }

  return (
    <section aria-label="Creator roster" className="mt-6 border border-border bg-surface-raised">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-3">
        <h2 className="font-semibold">Creator roster</h2>
        <div className="flex flex-wrap items-center gap-2">
          {add && (
            <AddButton onClick={add} testId="add-creator">
              + Add creator
            </AddButton>
          )}
          {add && <GhostButton onClick={() => setImporting(true)}>Import CSV</GhostButton>}
          <CsvButton
            rows={shown}
            filename="creators.csv"
            label="Export"
            columns={[
              { header: "Name", value: (c: OpsCreatorRow) => c.name },
              { header: "Mobile", value: (c) => c.phone ?? "" },
              { header: "Email", value: (c) => c.email ?? "" },
              { header: "Handle", value: (c) => c.handle ?? "" },
              { header: "City", value: (c) => c.city ?? "" },
              { header: "Niche", value: (c) => c.niche.join("; ") },
              { header: "Rates", value: (c) => c.rates.map((r) => `${r.label} ${r.pricePaise / 100}`).join("; ") },
              { header: "Rating", value: (c) => c.rating ?? "" },
              { header: "Active briefs", value: (c) => c.activeBriefs },
            ]}
          />
          <SavedViewsMenu entity="creators" filters={f} onApply={(x) => setF({ ...EMPTY, ...(x as Partial<F>) })} />
        </div>
      </div>
      <div className="grid gap-2 border-b border-border p-3 sm:grid-cols-2 lg:grid-cols-5" role="search" aria-label="Filter creators">
        <Input placeholder="Search name, handle, city…" aria-label="Search creators" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} className="lg:col-span-2" />
        <Select aria-label="Filter by niche" value={f.niche} onChange={(e) => setF({ ...f, niche: e.target.value })}>
          <option value="">Any niche</option>
          {niches.map((n) => (
            <option key={n}>{n}</option>
          ))}
        </Select>
        <Select aria-label="Filter by city" value={f.city} onChange={(e) => setF({ ...f, city: e.target.value })}>
          <option value="">Any city</option>
          {cities.map((c) => (
            <option key={c}>{c}</option>
          ))}
        </Select>
        <Select aria-label="Filter by rating" value={f.minRating} onChange={(e) => setF({ ...f, minRating: e.target.value })}>
          <option value="">Any rating</option>
          <option value="4">4 and above</option>
          <option value="3">3 and above</option>
        </Select>
      </div>
      <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs text-ink-muted">
        <span>
          {shown.length} of {rows.length} creators
        </span>
        {active && (
          <button type="button" className="underline" onClick={() => setF(EMPTY)}>
            Clear filters
          </button>
        )}
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" className="accent-[#8BB72C]" checked={f.archived} onChange={(e) => setF({ ...f, archived: e.target.checked })} /> Show archived
        </label>
      </div>
      {!list.data ? (
        <div className="p-4">
          <LoadState loading={list.loading} error={list.error} />
        </div>
      ) : rows.length === 0 ? (
        <div className="p-4">
          <EmptyAdd title={f.archived ? "No archived creators" : "No creators yet"} body="Add the UGC creators and influencers you work with. They sign in to the creator portal with their mobile number." action={add && !f.archived ? <AddButton onClick={add}>+ Add the first creator</AddButton> : undefined} />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[860px] text-sm" data-testid="creator-table">
            <thead>
              <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                <th className="w-8 px-3 py-2">
                  <input type="checkbox" className="accent-[#8BB72C]" aria-label="Select all creators" checked={sel.allSelected} onChange={sel.toggleAll} />
                </th>
                <th className="px-3 py-2">Creator</th>
                <th className="px-3 py-2">Niche</th>
                <th className="px-3 py-2">Rates</th>
                <th className="px-3 py-2 text-right">Active</th>
                <th className="px-3 py-2 text-right">Rating</th>
                <th className="w-10 px-3 py-2" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {shown.map((c) => (
                <tr key={c.id} className="border-b border-border align-top" data-creator={c.name}>
                  <td className="px-3 py-2">
                    <input type="checkbox" className="accent-[#8BB72C]" aria-label={`Select ${c.name}`} checked={sel.has(c.id)} onChange={() => sel.toggle(c.id)} />
                  </td>
                  <td className="px-3 py-2">
                    <Link href={`/team/creators/${c.id}`} className="font-medium underline-offset-2 hover:underline">
                      {c.name}
                    </Link>
                    <span className="block text-xs text-ink-muted">
                      {[c.handle ? `@${c.handle.replace(/^@/, "")}` : null, c.city, c.phone].filter(Boolean).join(" · ")}
                    </span>
                    {c.archivedAt && <Badge tone="neutral">archived{c.archivedReason ? `: ${c.archivedReason}` : ""}</Badge>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {c.niche.map((n) => (
                        <Badge key={n}>{n}</Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs text-ink-muted">{c.rates.map((r) => `${r.label} ${formatINR(r.pricePaise)}`).join(" · ") || "—"}</td>
                  <td className="px-3 py-2 text-right">{c.activeBriefs}</td>
                  <td className="px-3 py-2 text-right">{c.rating ? `${c.rating.toFixed(1)} (${c.ratingCount})` : "—"}</td>
                  <td className="px-3 py-2">
                    <RowMenu
                      label={`More actions for ${c.name}`}
                      items={[
                        { key: "open", label: "Open", href: `/team/creators/${c.id}` },
                        { key: "history", label: "History", href: `/team/creators/${c.id}#history` },
                        { key: "archive", label: "Archive", danger: true, hidden: !!c.archivedAt || !add, disabledReason: c.activeBriefs ? "Has open briefs. Move or cancel them first." : null, onSelect: () => setArchiving([c.id]) },
                      ]}
                    />
                  </td>
                </tr>
              ))}
              {shown.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-3 py-6 text-center text-ink-muted">
                    No creators match these filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {add && (
        <BulkBar count={sel.count} onClear={sel.clear} label="creators">
          <BulkButton onClick={() => setArchiving(sel.ids)}>Archive</BulkButton>
        </BulkBar>
      )}
      <ReasonDialog open={!!archiving} title={archiving?.length === 1 ? "Archive this creator?" : `Archive ${archiving?.length ?? 0} creators?`} confirm="Archive" danger onClose={() => setArchiving(null)} onConfirm={(reason) => archive(archiving ?? [], reason)}>
        <p className="text-sm text-ink-muted">Archived creators can&apos;t sign in or get new briefs. Their past work and payouts stay.</p>
      </ReasonDialog>
      <ImportWizard entity="creators" open={importing} onClose={() => setImporting(false)} onDone={() => (reload(), changed())} />
    </section>
  );
}
