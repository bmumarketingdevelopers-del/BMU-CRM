"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { clientsCanAdd, clientsCanImport, clientsCanReassignAm, clientsOffboardStatusLabels, type ClientsListQuery, type ClientsListRow } from "@bmu/shared";
import { useActions } from "@/components/actions/actions-provider";
import { ActionDialog, Field, inputCls } from "@/components/actions/action-drawer";
import { BulkBar, BulkButton, useSelection } from "@/components/actions/bulk-bar";
import { ImportWizard } from "@/components/actions/import-wizard";
import { SavedViewsMenu } from "@/components/actions/saved-views-menu";
import { CsvButton } from "@/components/charts";
import { StatRow, StatTile } from "@/components/dash";
import { Badge, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";
import { healthLabel, healthTone } from "@/components/clients-table";

type Filters = Required<Pick<ClientsListQuery, "am" | "health" | "industry" | "branch" | "status" | "tag" | "archived" | "service" | "onboardedFrom" | "onboardedTo">>;
const EMPTY: Filters = { am: "", health: "", industry: "", branch: "", status: "", tag: "", archived: "", service: "", onboardedFrom: "", onboardedTo: "" };
const STATUS: { value: string; label: string }[] = [
  { value: "active", label: "Active services" },
  { value: "onboarding", label: "Onboarding" },
  { value: "payment_pending", label: "Payment pending" },
  { value: "offboarding", label: "Offboarding" },
  { value: "no_services", label: "No services" },
];
/** Today's date in India (YYYY-MM-DD), shifted by whole months. */
const istDay = (monthsBack = 0, firstOfMonth = false) => {
  const d = new Date(Date.now() + 330 * 60_000);
  if (monthsBack || firstOfMonth) d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - monthsBack);
  return d.toISOString().slice(0, 10);
};
const ONBOARDED_PICKS: { label: string; from: () => string }[] = [
  { label: "This month", from: () => istDay(0, true) },
  { label: "Last 3 months", from: () => istDay(2, true) },
  { label: "This year", from: () => `${istDay().slice(0, 4)}-01-01` },
];
const fmtDay = (iso: string) => new Date(iso).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const toggleCls = (on: boolean) => `border px-2.5 py-1.5 text-xs ${on ? "border-charcoal bg-charcoal text-ivory" : "border-border text-ink-muted hover:text-ink"}`;

/** The Clients list: search, filters, saved views, bulk (reassign CM, tag, archive, export), add / migrate / import. */
export function ClientsList() {
  const { me, openNew, openReassign, notify, version, changed } = useActions();
  const [q, setQ] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [panel, setPanel] = useState<"import" | "tag" | "archive" | "restore" | null>(null);
  const [list, setList] = useState<{ data?: ClientsListRow[]; error?: string; loading: boolean }>({ loading: true });
  useEffect(() => {
    let live = true;
    api.clientsActions
      .list({ ...filters })
      .then((data) => live && setList({ data, loading: false }))
      .catch((e: Error) => live && setList({ error: e.message, loading: false }));
    return () => {
      live = false;
    };
  }, [filters, version]);
  const opts = useLoad(() => (clientsCanAdd(me) || clientsCanReassignAm(me) ? api.clientsActions.formOptions() : Promise.resolve(null)));
  const all = list.data;
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (all ?? []).filter((c) => !needle || `${c.name} ${c.industry ?? ""} ${c.am?.name ?? ""} ${c.contact.name ?? ""} ${c.contact.phone ?? ""} ${c.contact.email ?? ""}`.toLowerCase().includes(needle));
  }, [all, q]);
  const ids = useMemo(() => rows.map((r) => r.id), [rows]);
  const sel = useSelection(ids);
  const set = (p: Partial<Filters>) => setFilters((f) => ({ ...f, ...p }));
  const active = Object.values(filters).filter(Boolean).length;
  const canAdd = clientsCanAdd(me);
  const tags = useMemo(() => [...new Map((all ?? []).flatMap((c) => c.tags).map((t) => [t.name, t])).values()], [all]);
  const ams = useMemo(() => [...new Map([...(opts.data?.ams.map((a) => [a.id, a.name] as [string, string]) ?? []), ...(all ?? []).filter((c) => c.am).map((c) => [c.am!.id, c.am!.name] as [string, string])]).entries()].sort((a, b) => a[1].localeCompare(b[1])), [all, opts.data]);
  const services = useMemo(() => [...new Set([...(opts.data?.services.map((s) => s.name) ?? []), ...(all ?? []).flatMap((c) => c.services.map((s) => s.serviceName))])].sort(), [all, opts.data]);

  return (
    <div className="grid gap-4 [&>*]:min-w-0">
      <div className="flex flex-wrap items-center gap-2">
        {canAdd && (
          <button type="button" data-testid="clients-add" onClick={() => openNew("client")} className="bg-charcoal px-3 py-1.5 text-sm font-medium text-ivory">
            + Add
          </button>
        )}
        {canAdd && opts.data?.canMigrate && (
          <button type="button" onClick={() => openNew("client", { mode: "migration" })} className="border border-border px-3 py-1.5 text-sm">
            Migrate existing client
          </button>
        )}
        {clientsCanImport(me) && (
          <button type="button" onClick={() => setPanel("import")} className="border border-border px-3 py-1.5 text-sm">
            Import CSV
          </button>
        )}
        <span className="hidden flex-1 sm:block" />
        <SavedViewsMenu entity="client" filters={filters} onApply={(f) => setFilters({ ...EMPTY, ...(f as Partial<Filters>) })} />
        <CsvButton
          filename="clients.csv"
          rows={rows}
          columns={[
            { header: "Client", value: (r) => r.name },
            { header: "Industry", value: (r) => r.industry },
            { header: "Client Manager", value: (r) => r.am?.name },
            { header: "Branch", value: (r) => r.branch },
            { header: "Contact", value: (r) => r.contact.name },
            { header: "Phone", value: (r) => r.contact.phone },
            { header: "Email", value: (r) => r.contact.email },
            { header: "Health", value: (r) => healthLabel(r.health) },
            { header: "Active services", value: (r) => r.activeServices },
            { header: "Services", value: (r) => r.services.map((s) => `${s.serviceName} (${s.currentGate})`).join("; ") },
            { header: "Tags", value: (r) => r.tags.map((t) => t.name).join("; ") },
            { header: "Onboarded", value: (r) => fmtDay(r.onboardedAt) },
            { header: "Added", value: (r) => r.createdAt.slice(0, 10) },
          ]}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className={toggleCls(!filters.archived)} onClick={() => set({ archived: "" })}>
          Current
        </button>
        <button type="button" className={toggleCls(filters.archived === "only")} onClick={() => set({ archived: "only" })}>
          Archived
        </button>
      </div>

      <details className="border border-border bg-surface-raised" open={active > 0 && !(active === 1 && filters.archived)}>
        <summary className="cursor-pointer px-3 py-2 text-sm">Filters{active ? ` (${active})` : ""}</summary>
        <div className="grid gap-2 px-3 pb-3 sm:grid-cols-2 lg:grid-cols-3">
          <select className={inputCls} value={filters.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status">
            <option value="">Any status</option>
            {STATUS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <select className={inputCls} value={filters.health} onChange={(e) => set({ health: e.target.value })} aria-label="Health">
            <option value="">Any health</option>
            <option value="green">Healthy</option>
            <option value="amber">Watch</option>
            <option value="red">At risk</option>
          </select>
          <select className={inputCls} value={filters.am} onChange={(e) => set({ am: e.target.value })} aria-label="Client Manager">
            <option value="">Any Client Manager</option>
            <option value="none">Unassigned</option>
            {ams.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select className={inputCls} value={filters.service} onChange={(e) => set({ service: e.target.value })} aria-label="Service">
            <option value="">Any service</option>
            {services.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <select className={inputCls} value={filters.industry} onChange={(e) => set({ industry: e.target.value })} aria-label="Industry">
            <option value="">Any industry</option>
            {(opts.data?.industries ?? [...new Set((all ?? []).map((c) => c.industry).filter(Boolean) as string[])]).map((i) => (
              <option key={i} value={i}>
                {i}
              </option>
            ))}
          </select>
          {opts.data && opts.data.branches.length > 0 && (
            <select className={inputCls} value={filters.branch} onChange={(e) => set({ branch: e.target.value })} aria-label="Branch">
              <option value="">Any branch</option>
              {opts.data.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          )}
          {tags.length > 0 && (
            <select className={inputCls} value={filters.tag} onChange={(e) => set({ tag: e.target.value })} aria-label="Tag">
              <option value="">Any tag</option>
              {tags.map((t) => (
                <option key={t.id} value={t.name}>
                  {t.name}
                </option>
              ))}
            </select>
          )}
          <div className="grid gap-1.5 sm:col-span-2 lg:col-span-3" data-testid="clients-onboarded">
            <span className="text-xs text-ink-muted">Onboarded between</span>
            <div className="flex flex-wrap items-center gap-2">
              <input type="date" className={`${inputCls} w-auto`} value={filters.onboardedFrom} max={filters.onboardedTo || undefined} onChange={(e) => set({ onboardedFrom: e.target.value })} aria-label="Onboarded from" />
              <span className="text-xs text-ink-muted">to</span>
              <input type="date" className={`${inputCls} w-auto`} value={filters.onboardedTo} min={filters.onboardedFrom || undefined} onChange={(e) => set({ onboardedTo: e.target.value })} aria-label="Onboarded to" />
              {ONBOARDED_PICKS.map((p) => (
                <button key={p.label} type="button" className={toggleCls(filters.onboardedFrom === p.from() && filters.onboardedTo === istDay())} onClick={() => set({ onboardedFrom: p.from(), onboardedTo: istDay() })}>
                  {p.label}
                </button>
              ))}
              {(filters.onboardedFrom || filters.onboardedTo) && (
                <button type="button" className="text-xs text-ink-muted underline" onClick={() => set({ onboardedFrom: "", onboardedTo: "" })}>
                  Any date
                </button>
              )}
            </div>
          </div>
          {active > 0 && (
            <button type="button" className="justify-self-start text-xs text-ink-muted underline" onClick={() => setFilters(EMPTY)}>
              Clear filters
            </button>
          )}
        </div>
      </details>

      {!all ? (
        <LoadState loading={list.loading} error={list.error} />
      ) : (
        <>
          <StatRow cols={4}>
            <StatTile label="Clients" value={all.length} />
            <StatTile label="Active services" value={all.reduce((s, c) => s + c.activeServices, 0)} />
            <StatTile label="Payment pending" value={all.filter((c) => c.paymentStatus === "pending").length} tone={all.some((c) => c.paymentStatus === "pending") ? "warn" : "default"} />
            <StatTile label="Watch or at risk" value={all.filter((c) => c.health !== "green").length} tone={all.some((c) => c.health === "red") ? "bad" : all.some((c) => c.health !== "green") ? "warn" : "default"} />
          </StatRow>
          {/* Find client: sits on top of the list it searches (name, industry, contact, phone, email, Client Manager). */}
          <div>
          <div className="-mb-px flex items-center gap-2 border border-border bg-surface-raised px-3 py-2" data-testid="clients-search">
            <svg aria-hidden width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-ink-muted">
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Find client…"
              aria-label="Find client"
              title="Search by client name, industry, contact name, phone, email or Client Manager"
              className="min-w-0 flex-1 bg-transparent py-1 text-sm outline-none"
            />
            {q && (
              <>
                <span className="shrink-0 text-xs text-ink-muted">
                  {rows.length} of {all.length}
                </span>
                <button type="button" onClick={() => setQ("")} aria-label="Clear search" className="shrink-0 px-1 text-ink-muted hover:text-ink">
                  ×
                </button>
              </>
            )}
          </div>
          {rows.length === 0 ? (
            <div className="border border-border bg-surface-raised px-5 py-10 text-center text-sm" data-testid="clients-empty">
              {all.length || active || q ? (
                <p className="text-ink-muted">{q ? `No client matches "${q}".` : "No clients match these filters."}</p>
              ) : (
                <>
                  <p className="text-ink-muted">No clients yet</p>
                  {canAdd && (
                    <button type="button" onClick={() => openNew("client")} className="mt-3 bg-charcoal px-3 py-1.5 text-sm font-medium text-ivory">
                      Add client
                    </button>
                  )}
                </>
              )}
            </div>
          ) : (
            <ClientRows rows={rows} sel={sel} />
          )}
          </div>
        </>
      )}

      <BulkBar count={sel.count} onClear={sel.clear} label="clients">
        {clientsCanReassignAm(me) && (
          <BulkButton onClick={() => openReassign({ type: "client_am", ids: sel.ids, title: `Reassign Client Manager for ${sel.count} clients`, onDone: () => (sel.clear(), changed()) })}>Reassign CM</BulkButton>
        )}
        {clientsCanAdd(me) && <BulkButton onClick={() => setPanel("tag")}>Tag</BulkButton>}
        {clientsCanImport(me) && filters.archived !== "only" && <BulkButton onClick={() => setPanel("archive")}>Archive</BulkButton>}
        {clientsCanImport(me) && filters.archived === "only" && <BulkButton onClick={() => setPanel("restore")}>Restore</BulkButton>}
        <CsvButton filename="clients-selected.csv" label="Export" rows={rows.filter((r) => sel.has(r.id))} columns={[{ header: "Client", value: (r) => r.name }, { header: "Client Manager", value: (r) => r.am?.name }, { header: "Phone", value: (r) => r.contact.phone }, { header: "Email", value: (r) => r.contact.email }, { header: "Health", value: (r) => healthLabel(r.health) }]} />
      </BulkBar>

      {panel === "import" && <ImportWizard entity="clients" open onClose={() => setPanel(null)} onDone={() => changed()} />}
      {(panel === "tag" || panel === "archive" || panel === "restore") && (
        <BulkClientsDialog
          action={panel}
          ids={sel.ids}
          onClose={() => setPanel(null)}
          onDone={(m, undo) => {
            setPanel(null);
            sel.clear();
            notify(m, undo);
            changed();
          }}
        />
      )}
    </div>
  );
}

function ClientRows({ rows, sel }: { rows: ClientsListRow[]; sel: ReturnType<typeof useSelection> }) {
  return (
    <div className="border border-border bg-surface-raised">
      <div className="hidden grid-cols-[2rem_minmax(0,2.4fr)_minmax(0,1.4fr)_minmax(0,2fr)_7rem] gap-2 border-b border-border bg-canvas/50 px-3 py-2 text-xs text-ink-muted md:grid">
        <input type="checkbox" checked={sel.allSelected} onChange={sel.toggleAll} aria-label="Select all clients" />
        <span>Client</span>
        <span>Client Manager</span>
        <span>Services</span>
        <span>Health</span>
      </div>
      <ul>
        {rows.map((c) => (
          <li key={c.id} data-client-row={c.id} className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-2 border-b border-border px-3 py-2.5 text-sm last:border-b-0 md:grid-cols-[2rem_minmax(0,2.4fr)_minmax(0,1.4fr)_minmax(0,2fr)_7rem] md:items-center">
            <input type="checkbox" checked={sel.has(c.id)} onChange={() => sel.toggle(c.id)} aria-label={`Select ${c.name}`} className="mt-1 md:mt-0" />
            <div className="min-w-0">
              <Link href={`/team/clients/${c.id}`} className="font-medium hover:underline">
                {c.name}
              </Link>
              <p className="flex flex-wrap gap-x-2 text-xs text-ink-muted">
                {c.industry && <span>{c.industry}</span>}
                {c.contact.name && <span>{c.contact.name}</span>}
                {c.branch && <span>{c.branch}</span>}
                <span>Onboarded {fmtDay(c.onboardedAt)}</span>
              </p>
              <p className="mt-0.5 flex flex-wrap gap-1">
                {c.paymentStatus === "pending" && <Badge tone="amber">Payment pending</Badge>}
                {c.startMode === "migration" && <Badge>Migrated</Badge>}
                {c.offboarding && <Badge tone="red">{clientsOffboardStatusLabels[c.offboarding]}</Badge>}
                {c.archivedAt && <Badge>Archived</Badge>}
                {c.tags.map((t) => (
                  <Badge key={t.id}>{t.name}</Badge>
                ))}
              </p>
            </div>
            <div className="col-start-2 min-w-0 text-xs md:col-start-auto md:text-sm">{c.am?.name ?? <span className="text-ink-muted">Unassigned</span>}</div>
            <div className="col-start-2 min-w-0 text-xs md:col-start-auto">
              {c.services.length ? (
                <ul className="space-y-0.5">
                  {c.services.slice(0, 3).map((s) => (
                    <li key={s.id} className="truncate">
                      {s.serviceName} <span className="text-ink-muted">· {s.status.replace(/_/g, " ")} · {s.currentGate}</span>
                    </li>
                  ))}
                  {c.services.length > 3 && <li className="text-ink-muted">+{c.services.length - 3} more</li>}
                </ul>
              ) : (
                <span className="text-ink-muted">No services</span>
              )}
            </div>
            <div className="col-start-2 md:col-start-auto">
              <Badge tone={healthTone(c.health)}>{healthLabel(c.health)}</Badge>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function BulkClientsDialog({ action, ids, onClose, onDone }: { action: "tag" | "archive" | "restore"; ids: string[]; onClose: () => void; onDone: (m: string, undo?: Parameters<ReturnType<typeof useActions>["notify"]>[1]) => void }) {
  const [tag, setTag] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const title = { tag: "Tag clients", archive: "Archive clients", restore: "Restore clients" }[action];
  async function submit() {
    setError(undefined);
    if (action === "tag" && !tag.trim()) return setError("Type a tag");
    if (action === "archive" && reason.trim().length < 3) return setError("Give a short reason (at least 3 characters)");
    setBusy(true);
    try {
      const r = await api.clientsActions.bulk({ ids, action, tag: tag.trim() || undefined, reason: reason.trim() || undefined });
      onDone(r.message, r.undo);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <ActionDialog
      open
      title={`${title} (${ids.length})`}
      onClose={onClose}
      testId="clients-bulk-dialog"
      footer={
        <>
          <button type="button" className={`px-4 py-2 text-sm font-medium text-ivory disabled:opacity-40 ${action === "archive" ? "bg-red" : "bg-charcoal"}`} disabled={busy} onClick={submit}>
            {busy ? "Saving…" : "Apply"}
          </button>
          <button type="button" className="border border-border px-3 py-2 text-sm" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      {action === "tag" && (
        <Field label="Tag" required>
          <input className={inputCls} value={tag} onChange={(e) => setTag(e.target.value)} maxLength={40} aria-label="Tag" />
        </Field>
      )}
      {action === "archive" && (
        <>
          <p className="text-sm text-ink-muted">Archived clients leave the list (you can restore them from Archived). Clients with running services can&apos;t be archived: offboard them first.</p>
          <Field label="Reason" required>
            <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" />
          </Field>
        </>
      )}
      {action === "restore" && <p className="text-sm text-ink-muted">These clients come back to the list.</p>}
      {error && <p className="text-sm text-red">{error}</p>}
    </ActionDialog>
  );
}
