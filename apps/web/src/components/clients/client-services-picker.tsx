"use client";

// v52: a client's services in steps. 1 Services (groups) → 2 Sub services (only of the chosen groups) and Bundles →
// 3 Plans (one row per sub service and bundle; only plans with a price are listed). Searchable multi-select lists.
// The same check as on the server (clientServicesProblems) gives messages that follow the current choices.
import { useState } from "react";
import { billingPer, CUSTOM_BILLING, customBillingLabels, formatINR, planLabels, PLANS, rupeesToPaise, type ClientServiceRow, type CustomBilling, type ClientServicesInput, type Plan, type PriceList } from "@bmu/shared";
import { api } from "@/lib/api";
import { inputCls } from "@/components/actions/action-drawer";

// v56: custom = the amount (rupees, as typed) and billing for items that have no plan prices.
export type ServicesValue = { groupIds: string[]; subServiceIds: string[]; bundleIds: string[]; plans: Record<string, "" | "starter" | "growth" | "premium">; custom?: Record<string, { amount: string; billing: CustomBilling }> };
export const emptyServices = (): ServicesValue => ({ groupIds: [], subServiceIds: [], bundleIds: [], plans: {}, custom: {} });
export const toServicesInput = (v: ServicesValue): ClientServicesInput => ({
  groupIds: v.groupIds,
  subServiceIds: v.subServiceIds,
  bundleIds: v.bundleIds,
  plans: v.plans,
  custom: Object.fromEntries(
    Object.entries(v.custom ?? {})
      .filter(([id]) => v.subServiceIds.includes(id) || v.bundleIds.includes(id))
      .map(([id, c]) => [id, { pricePaise: c.amount.trim() && Number(c.amount) >= 0 ? rupeesToPaise(Number(c.amount)) : null, billing: c.billing }]),
  ),
});

/** A searchable list of tick boxes. */
function MultiPick({ label, options, value, onChange, testId, empty }: { label: string; options: { id: string; label: string; hint?: string }[]; value: string[]; onChange: (ids: string[]) => void; testId: string; empty: string }) {
  const [q, setQ] = useState("");
  const shown = options.filter((o) => o.label.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="client-services-step grid gap-1" data-testid={testId}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">{label}</span>
        {value.length > 0 && <span className="text-xs text-ink-muted">{value.length} chosen</span>}
      </div>
      {options.length > 6 && <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label={`Search ${label.toLowerCase()}`} />}
      {options.length ? (
        <div className="client-services-options grid max-h-56 gap-x-4 gap-y-1 overflow-y-auto border border-border p-2 text-sm sm:grid-cols-2">
          {shown.map((o) => (
            <label key={o.id} className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={value.includes(o.id)} onChange={(e) => onChange(e.target.checked ? [...value, o.id] : value.filter((x) => x !== o.id))} aria-label={o.label} />
              <span>
                {o.label}
                {o.hint && <span className="block text-xs text-ink-muted">{o.hint}</span>}
              </span>
            </label>
          ))}
          {!shown.length && <span className="text-xs text-ink-muted">Nothing matches.</span>}
        </div>
      ) : (
        <p className="text-xs text-ink-muted">{empty}</p>
      )}
    </div>
  );
}

export function ClientServicesPicker({ list, value, onChange, problems }: { list: PriceList; value: ServicesValue; onChange: (v: ServicesValue) => void; problems?: string[] }) {
  const subs = new Map(list.groups.flatMap((g) => g.subServices.map((s) => [s.id, { ...s, groupId: g.id, group: g.name }] as const)));
  // Removing a group removes its sub services (and their plans).
  const setGroups = (groupIds: string[]) => {
    const subServiceIds = value.subServiceIds.filter((id) => groupIds.includes(subs.get(id)?.groupId ?? ""));
    const plans = Object.fromEntries(Object.entries(value.plans).filter(([id]) => subServiceIds.includes(id) || value.bundleIds.includes(id)));
    onChange({ ...value, groupIds, subServiceIds, plans });
  };
  const rows = [
    ...value.subServiceIds.flatMap((id) => (subs.get(id) ? [{ id, label: `${subs.get(id)!.group} › ${subs.get(id)!.name}`, prices: subs.get(id)!.prices, per: billingPer[subs.get(id)!.billing], billing: (subs.get(id)!.billing === "one_time" ? "one_time" : "monthly") as CustomBilling }] : [])),
    ...value.bundleIds.flatMap((id) => {
      const b = list.bundles.find((x) => x.id === id);
      return b ? [{ id, label: `Bundle › ${b.name}`, prices: b.prices, per: "per month", billing: "monthly" as CustomBilling }] : [];
    }),
  ];
  return (
    <div className="client-services-picker grid gap-4" data-testid="client-services-picker">
      <MultiPick label="Step 1 · Services" testId="client-services-groups" value={value.groupIds} onChange={setGroups} options={list.groups.map((g) => ({ id: g.id, label: g.name }))} empty="No services in the price list yet." />
      <MultiPick
        label="Step 2 · Sub services"
        testId="client-services-subs"
        value={value.subServiceIds}
        onChange={(subServiceIds) => onChange({ ...value, subServiceIds })}
        options={list.groups.filter((g) => value.groupIds.includes(g.id)).flatMap((g) => g.subServices.map((s) => ({ id: s.id, label: `${g.name} › ${s.name}` })))}
        empty="Choose a service first."
      />
      <MultiPick
        label="Bundles (optional)"
        testId="client-services-bundles"
        value={value.bundleIds}
        onChange={(bundleIds) => onChange({ ...value, bundleIds, plans: Object.fromEntries(Object.entries(value.plans).filter(([id]) => value.subServiceIds.includes(id) || bundleIds.includes(id))) })}
        options={list.bundles.map((b) => ({ id: b.id, label: b.name, hint: b.subServiceIds.map((id) => subs.get(id)?.name).filter(Boolean).join(" + ") }))}
        empty="No bundles yet."
      />
      <div className="grid gap-1" data-testid="client-services-plans">
        <span className="text-xs font-medium">Step 3 · Plans</span>
        {rows.length ? (
          rows.map((r) => (
            <label key={r.id} className="grid gap-1 text-sm sm:grid-cols-[1fr_16rem] sm:items-center">
              <span>{r.label}</span>
              {/* v56: no plan prices in the price list: enter this client's amount and how it is billed instead.
                  Once the admin sets plan prices for it, the plan list below shows instead. */}
              {!PLANS.some((p) => r.prices[p] != null) ? (
                <span className="grid grid-cols-[1fr_auto] gap-2" data-testid="client-services-custom">
                  <span className="flex items-center border border-border bg-surface-raised">
                    <span className="pl-3 text-sm text-ink-muted">₹</span>
                    <input
                      className="w-full bg-transparent px-2 py-2 text-sm outline-none"
                      type="number"
                      min={0}
                      step="any"
                      inputMode="decimal"
                      placeholder="Amount (optional)"
                      value={value.custom?.[r.id]?.amount ?? ""}
                      onChange={(e) => onChange({ ...value, custom: { ...value.custom, [r.id]: { billing: value.custom?.[r.id]?.billing ?? r.billing, amount: e.target.value } } })}
                      aria-label={`Amount for ${r.label}`}
                    />
                  </span>
                  <select
                    className={inputCls}
                    value={value.custom?.[r.id]?.billing ?? r.billing}
                    onChange={(e) => onChange({ ...value, custom: { ...value.custom, [r.id]: { amount: value.custom?.[r.id]?.amount ?? "", billing: e.target.value as CustomBilling } } })}
                    aria-label={`Billing for ${r.label}`}
                  >
                    {CUSTOM_BILLING.map((b) => (
                      <option key={b} value={b}>
                        {customBillingLabels[b]}
                      </option>
                    ))}
                  </select>
                </span>
              ) : (
              <select className={inputCls} value={value.plans[r.id] ?? ""} onChange={(e) => onChange({ ...value, plans: { ...value.plans, [r.id]: e.target.value as ServicesValue["plans"][string] } })} aria-label={`Plan for ${r.label}`}>
                <option value="">Not chosen</option>
                {PLANS.filter((p) => r.prices[p] != null).map((p) => (
                  <option key={p} value={p}>
                    {planLabels[p]} · {formatINR(r.prices[p]!)} {r.per}
                  </option>
                ))}
              </select>
              )}
            </label>
          ))
        ) : (
          <p className="text-xs text-ink-muted">Choose at least one sub service or bundle.</p>
        )}
      </div>
      {problems && problems.length > 0 && (
        <ul className="grid gap-0.5 text-xs text-red" data-testid="client-services-problems">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * v52 Client 360 → Services and plans: what the client has bought, e.g. "Marketing & Visibility › SEO — Growth plan ·
 * Active" and "Bundle › Brand Launch — Growth plan · Monthly". Add one (sub service or bundle, plan, status, start date),
 * change its plan or status, or remove it (it stays in the history as ended); a client keeps at least one service.
 */
export function ClientServicesPanel({ clientId, rows, list, canEdit, onDone, onError }: { clientId: string; rows: ClientServiceRow[]; list: PriceList | undefined; canEdit: boolean; onDone: (m: string) => void; onError: (m: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [pick, setPick] = useState("");
  const [plan, setPlan] = useState<"" | Plan>("");
  const [status, setStatus] = useState<"active" | "paused">("active");
  const [start, setStart] = useState("");
  const live = rows.filter((r) => r.status !== "ended");
  const ended = rows.filter((r) => r.status === "ended");
  const run = async (fn: () => Promise<{ message: string }>) => {
    try {
      onDone((await fn()).message);
    } catch (e) {
      onError((e as Error).message);
    }
  };
  const choices = list ? [...list.groups.flatMap((g) => g.subServices.map((s) => ({ key: `sub:${s.id}`, label: `${g.name} › ${s.name}`, prices: s.prices }))), ...list.bundles.map((b) => ({ key: `bundle:${b.id}`, label: `Bundle › ${b.name}`, prices: b.prices }))] : [];
  const chosen = choices.find((c) => c.key === pick);
  const line = (r: ClientServiceRow) => `${r.service} › ${r.name}${r.plan ? ` — ${planLabels[r.plan]} plan` : ""}`;
  return (
    <div className="client-services-panel grid gap-3" data-testid="client-services-panel">
      {live.length ? (
        <ul className="divide-y divide-border">
          {live.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 text-sm" data-testid="client-service-row">
              <span className="min-w-0">
                <span className="font-medium">{line(r)}</span>
                <span className="text-ink-muted">
                  {" · "}
                  {r.status === "paused" ? "Paused" : r.kind === "bundle" ? "Monthly" : "Active"}
                  {r.pricePaise != null ? ` · ${formatINR(r.pricePaise)} ${billingPer[r.billing]}${r.custom ? " (agreed for this client)" : r.plan || !r.pricedPlan ? "" : ` (${planLabels[r.pricedPlan]}, no plan chosen)`}` : ""}
                </span>
              </span>
              {canEdit && (
                <span className="flex flex-wrap items-center gap-2">
                  <select className="border border-border bg-surface px-2 py-1 text-xs" value={r.plan ?? ""} onChange={(e) => run(() => api.clientsActions.editClientService(clientId, r.id, { plan: e.target.value as "" | Plan }))} aria-label={`Plan for ${r.name}`}>
                    <option value="">No plan</option>
                    {PLANS.map((p) => (
                      <option key={p} value={p}>
                        {planLabels[p]}
                      </option>
                    ))}
                  </select>
                  <select className="border border-border bg-surface px-2 py-1 text-xs" value={r.status} onChange={(e) => run(() => api.clientsActions.editClientService(clientId, r.id, { status: e.target.value as "active" | "paused" }))} aria-label={`Status of ${r.name}`}>
                    <option value="active">Active</option>
                    <option value="paused">Paused</option>
                  </select>
                  <button
                    type="button"
                    className="text-xs text-ink-muted underline hover:text-red disabled:opacity-40"
                    disabled={live.length <= 1}
                    title={live.length <= 1 ? "A client keeps at least one service" : undefined}
                    onClick={() => window.confirm(`Remove ${r.name} from this client? It stays in the history.`) && run(() => api.clientsActions.removeClientService(clientId, r.id))}
                  >
                    Remove
                  </button>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-5 py-3 text-sm text-ink-muted">No services chosen yet.</p>
      )}
      {canEdit && list && (
        <div className="px-5 pb-4">
          {adding ? (
            <form
              className="grid gap-2 border border-border p-3 sm:grid-cols-[2fr_1fr_1fr_1fr_auto] sm:items-end"
              data-testid="client-service-add"
              onSubmit={(e) => {
                e.preventDefault();
                const [kind, itemId] = pick.split(":");
                run(async () => {
                  const r = await api.clientsActions.addClientService(clientId, { ...(kind === "bundle" ? { bundleId: itemId } : { subServiceId: itemId }), plan, status, startDate: start });
                  setAdding(false);
                  setPick("");
                  setPlan("");
                  return r;
                });
              }}
            >
              <label className="grid min-w-0 gap-1 text-xs font-medium">
                Sub service or bundle
                <select className={inputCls} value={pick} onChange={(e) => (setPick(e.target.value), setPlan(""))} aria-label="Sub service or bundle" required>
                  <option value="">Choose…</option>
                  {choices.map((c) => (
                    <option key={c.key} value={c.key}>
                      {c.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-medium">
                Plan
                <select className={inputCls} value={plan} onChange={(e) => setPlan(e.target.value as "" | Plan)} aria-label="Plan">
                  <option value="">Not chosen</option>
                  {chosen &&
                    PLANS.filter((p) => chosen.prices[p] != null).map((p) => (
                      <option key={p} value={p}>
                        {planLabels[p]} · {formatINR(chosen.prices[p]!)}
                      </option>
                    ))}
                </select>
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-medium">
                Status
                <select className={inputCls} value={status} onChange={(e) => setStatus(e.target.value as "active" | "paused")} aria-label="Status">
                  <option value="active">Active</option>
                  <option value="paused">Paused</option>
                </select>
              </label>
              <label className="grid min-w-0 gap-1 text-xs font-medium">
                Start date
                <input type="date" className={inputCls} value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start date" />
              </label>
              <span className="flex gap-2">
                <button type="submit" className="border border-charcoal bg-charcoal px-3 py-2 text-sm text-ivory">
                  Add
                </button>
                <button type="button" className="text-xs underline" onClick={() => setAdding(false)}>
                  Cancel
                </button>
              </span>
            </form>
          ) : (
            <button type="button" className="text-sm underline" onClick={() => setAdding(true)} data-testid="client-service-add-open">
              + Add a service or bundle
            </button>
          )}
        </div>
      )}
      {ended.length > 0 && (
        <details className="px-5 pb-3 text-xs text-ink-muted">
          <summary className="cursor-pointer">Ended ({ended.length})</summary>
          <ul className="mt-1 grid gap-0.5">
            {ended.map((r) => (
              <li key={r.id}>{line(r)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
