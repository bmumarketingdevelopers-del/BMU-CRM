"use client";

// v47: Admin → Catalogue: the services and sub-services a Client Manager can pick. Hiding keeps running projects as they are.
// v52: "Services and industries": each sub-service has its billing, description and Starter / Growth / Premium prices
// before GST; bundles of sub-services (price worked out: members' prices minus the saving); and the industries list.
import { useState } from "react";
import { billingLabels, bundlePrices, formatINR, planLabels, PLANS, SUB_SERVICE_BILLING, type BundleView, type IndustryView, type Plan, type ServiceGroupView, type SubServiceBilling, type SubServiceInput, type SubServiceView } from "@bmu/shared";
import { Badge, Button, Input, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const area = "h-20 w-full border border-border bg-surface px-3 py-2 text-sm";
const link = "text-xs underline";
type Run = (label: string, fn: () => Promise<unknown>) => void;

/** Rupees typed in a box ↔ paise; empty means the plan is not offered. */
const toPaise = (v: string) => (v.trim() === "" ? null : Math.round((Number(v.replace(/[^\d.]/g, "")) || 0) * 100));
const toRupees = (p: number | null) => (p == null ? "" : String(p / 100));
type PriceDraft = Record<Plan, string>;
const draftOf = (s?: SubServiceView): PriceDraft => ({ starter: toRupees(s?.prices.starter ?? null), growth: toRupees(s?.prices.growth ?? null), premium: toRupees(s?.prices.premium ?? null) });
const priceInput = (billing: SubServiceBilling, d: PriceDraft): Pick<SubServiceInput, "billing" | "starterPaise" | "growthPaise" | "premiumPaise"> => ({ billing, starterPaise: toPaise(d.starter), growthPaise: toPaise(d.growth), premiumPaise: toPaise(d.premium) });

function PriceFields({ billing, onBilling, prices, onPrices, label }: { billing: SubServiceBilling; onBilling: (b: SubServiceBilling) => void; prices: PriceDraft; onPrices: (p: PriceDraft) => void; label: string }) {
  return (
    <div className="price-list-plan-fields grid gap-2 sm:grid-cols-4">
      <label className="grid min-w-0 gap-1 text-xs font-medium">
        Billing
        <Select value={billing} onChange={(e) => onBilling(e.target.value as SubServiceBilling)} aria-label={`${label} billing`}>
          {SUB_SERVICE_BILLING.map((b) => (
            <option key={b} value={b}>
              {billingLabels[b]}
            </option>
          ))}
        </Select>
      </label>
      {PLANS.map((p) => (
        <label key={p} className="grid min-w-0 gap-1 text-xs font-medium">
          {planLabels[p]} (₹, before GST)
          <Input className="py-1" inputMode="decimal" value={prices[p]} onChange={(e) => onPrices({ ...prices, [p]: e.target.value })} placeholder="Not offered" aria-label={`${label} ${planLabels[p]} price`} />
        </label>
      ))}
    </div>
  );
}

function SubRow({ s, onSave }: { s: SubServiceView; onSave: (input: SubServiceInput, label: string) => void }) {
  const [name, setName] = useState(s.name);
  const [covers, setCovers] = useState(s.covers);
  const [billing, setBilling] = useState<SubServiceBilling>(s.billing);
  const [prices, setPrices] = useState<PriceDraft>(draftOf(s));
  const start = draftOf(s);
  const changed = name !== s.name || covers !== s.covers || billing !== s.billing || PLANS.some((p) => toPaise(prices[p]) !== toPaise(start[p]));
  return (
    <li className="grid gap-2 py-3" data-testid="sub-service-row">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="min-w-[200px] flex-1 py-1" value={name} onChange={(e) => setName(e.target.value)} aria-label={`${s.name} name`} maxLength={120} />
        {s.archived && <Badge>hidden</Badge>}
        {changed && (
          <Button type="button" variant="secondary" className="py-1" onClick={() => onSave({ name: name.trim(), covers: covers.trim(), ...priceInput(billing, prices) }, `${name.trim()} saved`)}>
            Save
          </Button>
        )}
        <button type="button" className={link} onClick={() => onSave({ name: s.name, covers: s.covers, archived: !s.archived }, `${s.name} ${s.archived ? "shown again" : "hidden"}`)}>
          {s.archived ? "Show" : "Hide"}
        </button>
      </div>
      <PriceFields billing={billing} onBilling={setBilling} prices={prices} onPrices={setPrices} label={s.name} />
      <textarea className={area} value={covers} onChange={(e) => setCovers(e.target.value)} placeholder="Description, printed under the item on quotations and invoices" aria-label={`${s.name} what it covers`} maxLength={600} />
    </li>
  );
}

function NewSub({ onAdd }: { onAdd: (input: SubServiceInput) => void }) {
  const [name, setName] = useState("");
  const [covers, setCovers] = useState("");
  const [billing, setBilling] = useState<SubServiceBilling>("monthly");
  const [prices, setPrices] = useState<PriceDraft>(draftOf());
  return (
    <form
      className="grid gap-2 border-t border-border pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        onAdd({ name: name.trim(), covers: covers.trim(), ...priceInput(billing, prices) });
        setName("");
        setCovers("");
        setPrices(draftOf());
      }}
    >
      <p className="text-xs text-ink-muted">Add a sub-service</p>
      <Input className="py-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="Sub-service name" aria-label="New sub-service name" required minLength={2} maxLength={120} />
      <PriceFields billing={billing} onBilling={setBilling} prices={prices} onPrices={setPrices} label="New sub-service" />
      <textarea className={area} value={covers} onChange={(e) => setCovers(e.target.value)} placeholder="Description, printed under the item on quotations and invoices" aria-label="New sub-service what it covers" maxLength={600} />
      <Button type="submit" variant="secondary" className="justify-self-start py-1">
        Add sub-service
      </Button>
    </form>
  );
}

function GroupCard({ g, run }: { g: ServiceGroupView; run: Run }) {
  const [name, setName] = useState(g.name);
  const live = g.subServices.filter((s) => !s.archived).length;
  return (
    <details className="border border-border bg-surface-raised" data-testid="service-group">
      <summary className="flex cursor-pointer items-center justify-between gap-3 px-4 py-3 font-medium">
        <span>
          {g.name} {g.archived && <Badge>hidden</Badge>}
        </span>
        <span className="text-xs font-normal text-ink-muted">
          {live} sub-service{live === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="grid gap-3 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input className="min-w-[200px] flex-1 py-1" value={name} onChange={(e) => setName(e.target.value)} aria-label={`${g.name} service name`} maxLength={120} />
          {name.trim() !== g.name && (
            <Button type="button" variant="secondary" className="py-1" onClick={() => run(`${name.trim()} saved`, () => api.catalogue.saveGroup(g.id, { name: name.trim() }))}>
              Rename
            </Button>
          )}
          <button type="button" className={link} onClick={() => run(`${g.name} ${g.archived ? "shown again" : "hidden"}`, () => api.catalogue.saveGroup(g.id, { name: g.name, archived: !g.archived }))}>
            {g.archived ? "Show this service" : "Hide this service"}
          </button>
        </div>
        <ul className="divide-y divide-border">
          {g.subServices.map((s) => (
            <SubRow key={`${s.id}-${s.billing}-${s.prices.starter}-${s.prices.growth}-${s.prices.premium}`} s={s} onSave={(input, label) => run(label, () => api.catalogue.saveSubService(s.id, input))} />
          ))}
        </ul>
        <NewSub onAdd={(input) => run(`${input.name} added to ${g.name}`, () => api.catalogue.addSubService(g.id, input))} />
      </div>
    </details>
  );
}

/** Bundle editor: name, sub-services in order (each once), saving %, "Can be chosen"; shows each plan's worked-out price. */
function BundleForm({ groups, bundle, onSave, onCancel }: { groups: ServiceGroupView[]; bundle?: BundleView; onSave: (input: { name: string; subServiceIds: string[]; savingPct: number; selectable: boolean }) => void; onCancel?: () => void }) {
  const [name, setName] = useState(bundle?.name ?? "");
  const [ids, setIds] = useState<string[]>(bundle?.subServiceIds ?? []);
  const [saving, setSaving] = useState(String(bundle?.savingPct ?? 10));
  const [selectable, setSelectable] = useState(bundle?.selectable ?? true);
  const subs = new Map(groups.flatMap((g) => g.subServices.map((s) => [s.id, { ...s, group: g.name }] as const)));
  const pct = Math.max(0, Math.min(90, Number(saving) || 0));
  const prices = bundlePrices(ids, subs, pct);
  const offered = groups.flatMap((g) => g.subServices.filter((s) => !s.archived && !ids.includes(s.id)).map((s) => ({ id: s.id, label: `${g.name} › ${s.name}` })));
  return (
    <form
      className="grid gap-2 border border-border p-3"
      data-testid="bundle-form"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ name: name.trim(), subServiceIds: ids, savingPct: pct, selectable });
        if (!bundle) {
          setName("");
          setIds([]);
          setSaving("10");
          setSelectable(true);
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-[2fr_1fr_auto] sm:items-end">
        <label className="grid min-w-0 gap-1 text-xs font-medium">
          Bundle name
          <Input className="py-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Brand Launch" aria-label="Bundle name" required minLength={2} maxLength={120} />
        </label>
        <label className="grid min-w-0 gap-1 text-xs font-medium">
          Saving (%)
          <Input className="py-1" type="number" min={0} max={90} value={saving} onChange={(e) => setSaving(e.target.value)} aria-label="Bundle saving percent" />
        </label>
        <label className="flex items-center gap-2 pb-1.5 text-sm">
          <input type="checkbox" checked={selectable} onChange={(e) => setSelectable(e.target.checked)} aria-label="Can be chosen" />
          Can be chosen
        </label>
      </div>
      <ol className="grid gap-1 text-sm">
        {ids.map((id, i) => (
          <li key={id} className="flex flex-wrap items-center gap-2" data-testid="bundle-member">
            <span className="w-5 text-ink-muted">{i + 1}.</span>
            <span className="flex-1">{subs.get(id) ? `${subs.get(id)!.group} › ${subs.get(id)!.name}` : "Removed from the price list"}</span>
            <button type="button" className={link} disabled={i === 0} onClick={() => setIds(ids.map((x, j) => (j === i - 1 ? id : j === i ? ids[i - 1] : x)))}>
              Up
            </button>
            <button type="button" className={`${link} hover:text-red`} onClick={() => setIds(ids.filter((x) => x !== id))}>
              Remove
            </button>
          </li>
        ))}
      </ol>
      {ids.length < 20 && (
        <Select value="" onChange={(e) => e.target.value && setIds([...ids, e.target.value])} aria-label="Add a sub service to the bundle">
          <option value="">+ Add a sub service ({ids.length}/20, at least 2)</option>
          {offered.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </Select>
      )}
      <p className="text-xs text-ink-muted" data-testid="bundle-prices">
        Monthly price:{" "}
        {PLANS.map((p) => `${planLabels[p]} ${prices[p] == null ? "not offered" : formatINR(prices[p]!)}`).join(" · ")}. A plan is offered only when every sub service has a price for it.
      </p>
      <div className="flex gap-2">
        <Button type="submit" variant="secondary" className="py-1" disabled={ids.length < 2}>
          {bundle ? "Save bundle" : "Add bundle"}
        </Button>
        {onCancel && (
          <button type="button" className={link} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </form>
  );
}

function BundlesAdmin({ groups, run }: { groups: ServiceGroupView[]; run: Run }) {
  const bundles = useLoad(() => api.catalogue.bundles());
  const [editing, setEditing] = useState<string>();
  return (
    <div className="mt-8" data-testid="bundles-admin">
      <h3 className="font-semibold">Bundles</h3>
      <p className="mb-3 text-sm text-ink-muted">Sub services sold together as one monthly project. The price is worked out from today&apos;s prices, minus the saving.</p>
      <LoadState loading={bundles.loading} error={bundles.error} />
      <div className="grid gap-2">
        {(bundles.data ?? []).map((b) =>
          editing === b.id ? (
            <BundleForm key={b.id} groups={groups} bundle={b} onCancel={() => setEditing(undefined)} onSave={(input) => (run(`${input.name} saved`, async () => { await api.catalogue.saveBundle(b.id, input); bundles.reload(); }), setEditing(undefined))} />
          ) : (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 border border-border bg-surface-raised px-4 py-3 text-sm" data-testid="bundle-row">
              <span>
                <strong>{b.name}</strong> {!b.selectable && <Badge>hidden</Badge>} · {b.subServiceIds.length} sub services · saving {b.savingPct}% ·{" "}
                {PLANS.filter((p) => b.prices[p] != null).map((p) => `${planLabels[p]} ${formatINR(b.prices[p]!)}`).join(" · ") || "no plan has a price yet"}
              </span>
              <button type="button" className={link} onClick={() => setEditing(b.id)}>
                Edit
              </button>
            </div>
          ),
        )}
      </div>
      <p className="mt-3 text-xs text-ink-muted">Add a bundle</p>
      <BundleForm groups={groups} onSave={(input) => run(`${input.name} added`, async () => { await api.catalogue.addBundle(input); bundles.reload(); })} />
    </div>
  );
}

function IndustriesAdmin({ run }: { run: Run }) {
  const list = useLoad(() => api.catalogue.industries());
  const [name, setName] = useState("");
  const go = (label: string, fn: () => Promise<IndustryView[]>) => run(label, async () => { await fn(); list.reload(); });
  return (
    <div className="mt-8" data-testid="industries-admin">
      <h3 className="font-semibold">Industries</h3>
      <p className="mb-3 text-sm text-ink-muted">The industries a client can be in. Hidden ones stay on clients that already use them.</p>
      <LoadState loading={list.loading} error={list.error} />
      <ul className="flex flex-wrap gap-2">
        {(list.data ?? []).map((i) => (
          <li key={i.id} className="flex items-center gap-2 border border-border bg-surface-raised px-3 py-1 text-sm">
            {i.name} {i.archived && <Badge>hidden</Badge>}
            <button type="button" className={link} onClick={() => go(`${i.name} ${i.archived ? "shown again" : "hidden"}`, () => api.catalogue.saveIndustry(i.id, { name: i.name, archived: !i.archived }))}>
              {i.archived ? "Show" : "Hide"}
            </button>
          </li>
        ))}
      </ul>
      <form
        className="mt-3 flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const n = name.trim();
          go(`${n} added`, () => api.catalogue.addIndustry({ name: n }));
          setName("");
        }}
      >
        <Input className="min-w-[220px] flex-1 py-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="New industry" aria-label="New industry" required minLength={2} maxLength={80} />
        <Button type="submit" variant="secondary" className="py-1">
          Add industry
        </Button>
      </form>
    </div>
  );
}

export function ServiceGroupsAdmin() {
  const groups = useLoad(() => api.catalogue.groups());
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();
  const [name, setName] = useState("");
  const [version, setVersion] = useState(0);
  async function run(label: string, fn: () => Promise<unknown>) {
    setError(undefined);
    setSaved(undefined);
    try {
      await fn();
      setSaved(label);
      groups.reload();
      setVersion((x) => x + 1);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <section className="mb-10" data-testid="service-groups-admin">
      <h2 className="font-semibold">Services and industries</h2>
      <p className="mb-3 text-sm text-ink-muted">What Client Managers can add to a client, with each plan&apos;s price before GST. The description is printed under the item on quotations and invoices.</p>
      {error && <p className="mb-3 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
      {saved && !error && <p className="mb-3 border border-green bg-green/10 px-4 py-2 text-sm">{saved}</p>}
      <LoadState loading={groups.loading} error={groups.error} />
      <div className="grid gap-2">
        {(groups.data ?? []).map((g) => (
          <GroupCard key={g.id} g={g} run={run} />
        ))}
      </div>
      {groups.data && (
        <form
          className="mt-3 flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            run(`${n} added`, () => api.catalogue.addGroup({ name: n }));
            setName("");
          }}
        >
          <Input className="min-w-[220px] flex-1 py-1" value={name} onChange={(e) => setName(e.target.value)} placeholder="New service name" aria-label="New service name" required minLength={2} maxLength={120} />
          <Button type="submit" variant="secondary" className="py-1">
            Add service
          </Button>
        </form>
      )}
      {groups.data && <BundlesAdmin key={version} groups={groups.data} run={run} />}
      <IndustriesAdmin run={run} />
    </section>
  );
}
