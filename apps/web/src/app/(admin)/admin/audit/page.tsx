"use client";

import { useEffect, useState } from "react";
import type { AuditChainView, AuditPage, AuditQuery } from "@bmu/shared";
import { Button, Input, LoadState, PageTitle, Select } from "@/components/ui";
import { api } from "@/lib/api";

const fmt = new Intl.DateTimeFormat("en-IN", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Kolkata" });
const EMPTY: AuditQuery = { q: "", actor: "", area: "", from: "", to: "" };
const qs = (f: AuditQuery) => new URLSearchParams(Object.entries(f).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)])).toString();

export default function AuditPage() {
  const [filters, setFilters] = useState<AuditQuery>(EMPTY);
  // The search box waits for a pause in typing before it searches.
  const [typed, setTyped] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<AuditPage>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [chain, setChain] = useState<AuditChainView | { error: string }>();
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => {
      setFilters((f) => (f.q === typed ? f : { ...f, q: typed }));
      setPage(1);
    }, 300);
    return () => clearTimeout(t);
  }, [typed]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    api.audit
      .search({ ...filters, page })
      .then((d) => live && (setData(d), setError(undefined)))
      .catch((e: Error) => live && setError(e.message))
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [filters, page]);

  const set = (p: Partial<AuditQuery>) => {
    setFilters((f) => ({ ...f, ...p }));
    setPage(1);
  };
  const clear = () => {
    setTyped("");
    setFilters(EMPTY);
    setPage(1);
  };
  const filtered = !!(filters.q || filters.actor || filters.area || filters.from || filters.to);

  async function verify() {
    setChecking(true);
    try {
      setChain(await api.securityAdmin.auditChain());
    } catch (e) {
      setChain({ error: (e as Error).message });
    } finally {
      setChecking(false);
    }
  }

  const first = data && data.total ? (data.page - 1) * data.size + 1 : 0;
  const last = data ? Math.min(data.page * data.size, data.total) : 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.size)) : 1;

  return (
    <>
      <PageTitle
        title="Audit Log"
        subtitle={`Every change to people, roles, prices and the pipeline, newest first. Each entry is linked to the one before it, so an edited or deleted entry shows up when you verify.${data?.scope === "branch" ? " You see the changes made by people in your branch." : ""}`}
        action={
          <div className="flex flex-wrap gap-2">
            <a href={`/api/audit/export.csv?${qs(filters)}`} className="border border-border px-3 py-2 text-sm hover:border-ink" data-testid="audit-export">
              Export CSV{filtered ? " (filtered)" : ""}
            </a>
            <Button variant="secondary" disabled={checking} onClick={verify}>
              {checking ? "Checking…" : "Verify chain"}
            </Button>
          </div>
        }
      />
      {chain && "error" in chain && <p className="mb-4 border border-red bg-red/10 px-3 py-2 text-sm">{chain.error}</p>}
      {chain && !("error" in chain) && (
        <p className={`mb-4 border px-3 py-2 text-sm ${chain.ok ? "border-green bg-green/10" : "border-red bg-red/10"}`}>
          {chain.ok
            ? `Chain intact: ${chain.checked} entries checked${chain.lastSeq ? ` (up to #${chain.lastSeq})` : ""}. Nothing has been edited or deleted.`
            : `Chain broken at entry #${chain.brokenAt?.seq}: ${chain.brokenAt?.reason}. Treat this as a possible tampering incident (see Privacy → Breach runbook).`}
          {chain.unchained > 0 && ` ${chain.unchained} older entries from before v20 are not chained.`}
        </p>
      )}

      {/* Filters */}
      <div className="mb-4 grid gap-2 border border-border bg-surface-raised p-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)_auto_auto_auto]" data-testid="audit-filters">
        <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Search action, record type or id…" aria-label="Search the audit log" />
        <Select value={filters.actor} onChange={(e) => set({ actor: e.target.value })} aria-label="Person">
          <option value="">Everyone</option>
          <option value="system">System (automatic)</option>
          {data?.actors.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </Select>
        <Select value={filters.area} onChange={(e) => set({ area: e.target.value })} aria-label="Area">
          <option value="">All areas</option>
          {data?.areas.map((a) => (
            <option key={a} value={a}>
              {a.replaceAll("_", " ")}
            </option>
          ))}
        </Select>
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          From
          <Input type="date" value={filters.from} max={filters.to || undefined} onChange={(e) => set({ from: e.target.value })} aria-label="From date" />
        </label>
        <label className="flex items-center gap-2 text-xs text-ink-muted">
          To
          <Input type="date" value={filters.to} min={filters.from || undefined} onChange={(e) => set({ to: e.target.value })} aria-label="To date" />
        </label>
        <button type="button" onClick={clear} disabled={!filtered && !typed} className="justify-self-start text-sm text-ink-muted underline disabled:no-underline disabled:opacity-40">
          Clear
        </button>
      </div>

      <LoadState loading={loading && !data} error={error} />
      {data && (
        <>
          <div className="overflow-x-auto" aria-busy={loading}>
            <table className={`w-full min-w-[720px] bg-surface-raised text-sm ${loading ? "opacity-60" : ""}`}>
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                  <th className="px-3 py-2">When</th>
                  <th className="px-3 py-2">Who</th>
                  <th className="px-3 py-2">What</th>
                  <th className="px-3 py-2">Change</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.id} className="border-b border-border align-top">
                    <td className="px-3 py-2 whitespace-nowrap">{fmt.format(new Date(r.at))}</td>
                    <td className="px-3 py-2">{r.actor?.name ?? "System"}</td>
                    <td className="px-3 py-2">
                      <code>{r.action}</code>
                      <div className="text-xs text-ink-muted">
                        {r.entity} {r.entityId.slice(0, 18)}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <details>
                        <summary className="cursor-pointer text-ink-muted">Details</summary>
                        <pre className="mt-2 max-w-xl overflow-x-auto text-xs">{JSON.stringify({ before: r.before, after: r.after }, null, 2)}</pre>
                      </details>
                    </td>
                  </tr>
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-ink-muted">
                      {filtered ? "Nothing matches these filters." : "Nothing logged yet."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {/* Paging */}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-sm" data-testid="audit-paging">
            <span className="text-ink-muted">
              {data.total ? `${first}–${last} of ${data.total}` : "0 entries"}
            </span>
            <div className="flex items-center gap-2">
              <Button variant="secondary" className="px-3 py-1.5" disabled={page <= 1 || loading} onClick={() => setPage((p) => p - 1)}>
                ← Newer
              </Button>
              <span className="text-ink-muted">
                Page {data.page} of {pages}
              </span>
              <Button variant="secondary" className="px-3 py-1.5" disabled={page >= pages || loading} onClick={() => setPage((p) => p + 1)}>
                Older →
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
