"use client";

import { useState } from "react";
import { formatINR, withGst, type CatalogueAdmin } from "@bmu/shared";
import { Badge, Button, Card, Input, LoadState, PageTitle } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const TIERS = ["starter", "growth", "premium"] as const;

export default function CataloguePage() {
  const cat = useLoad(() => api.catalogue.admin());
  const versions = useLoad(() => api.catalogue.versions());
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState<string>();

  async function change(label: string, fn: () => Promise<unknown>) {
    setError(undefined);
    setSaved(undefined);
    try {
      await fn();
      setSaved(label);
      cat.reload();
      versions.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function setPrice(serviceKey: string, tier: string, value: string) {
    const rupees = Number(value.replace(/[^\d]/g, ""));
    if (!rupees) return;
    setError(undefined);
    try {
      await api.catalogue.setTierPrice(serviceKey, tier, rupees);
      setSaved(`${serviceKey} ${tier} saved. A new price book version was created; sent proposals keep their old prices.`);
      cat.reload();
      versions.reload();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const data = cat.data;
  const tracks = data ? Map.groupBy(data.services, (s) => s.track) : new Map<string, CatalogueAdmin["services"]>();
  const price = (key: string, tier: string) => data?.services.find((s) => s.id === key)?.tiers.find((t) => t.tier === tier)?.pricePaise ?? 0;

  return (
    <>
      <PageTitle
        title="Catalogue & Pricing"
        subtitle={data ? `Price book ${data.priceBook.version} (${data.priceBook.status}). Prices exclude GST. The website and proposals read from here.` : undefined}
      />
      {error && <p className="mb-4 border border-red bg-red/10 px-4 py-2 text-sm">{error}</p>}
      {saved && !error && <p className="mb-4 border border-green bg-green/10 px-4 py-2 text-sm">{saved}</p>}
      <LoadState loading={cat.loading} error={cat.error} />

      {[...tracks.entries()].map(([track, list]) => (
        <section key={track} className="mb-8">
          <h2 className="mb-2 font-semibold">{track}</h2>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] bg-surface-raised text-sm">
              <thead>
                <tr className="border-b border-border text-left text-[11px] uppercase tracking-[0.12em] text-ink-muted">
                  <th className="px-3 py-2">Service</th>
                  {TIERS.map((t) => (
                    <th key={t} className="px-3 py-2 capitalize">
                      {t} (₹)
                    </th>
                  ))}
                  <th className="px-3 py-2">Billing</th>
                </tr>
              </thead>
              <tbody>
                {list.map((s) => (
                  <tr key={s.id} className="border-b border-border">
                    <td className="px-3 py-2">
                      <div className="font-medium">{s.name}</div>
                      {s.excludedNote && <div className="text-xs text-ink-muted">{s.excludedNote}</div>}
                    </td>
                    {TIERS.map((tier) => {
                      const paise = s.tiers.find((t) => t.tier === tier)?.pricePaise ?? 0;
                      return (
                        <td key={tier} className="px-3 py-2">
                          <Input
                            key={paise}
                            defaultValue={String(paise / 100)}
                            inputMode="numeric"
                            className="w-28"
                            aria-label={`${s.name} ${tier} price`}
                            onBlur={(e) => Number(e.target.value) * 100 !== paise && setPrice(s.id, tier, e.target.value)}
                          />
                        </td>
                      );
                    })}
                    <td className="px-3 py-2">
                      <Badge>{s.billingType.replace("_", " ")}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {data && (
        <>
          <h2 id="bundles" className="mt-10 mb-3 font-semibold">
            Bundles (automatic {data.bundles[0]?.discountPct ?? 10}% saving)
          </h2>
          <div className="grid gap-3 md:grid-cols-2">
            {data.bundles.map((b) => (
              <Card key={b.key}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="font-semibold">{b.name}</h3>
                  <label className="flex items-center gap-1 text-xs text-ink-muted">
                    Saving %
                    <Input
                      key={b.discountPct}
                      defaultValue={String(b.discountPct)}
                      inputMode="numeric"
                      className="w-16 py-1"
                      aria-label={`${b.name} discount percent`}
                      onBlur={(e) => {
                        const pct = Number(e.target.value);
                        if (Number.isInteger(pct) && pct !== b.discountPct) change(`${b.name} saving set to ${pct}%`, () => api.catalogue.setBundleDiscount(b.key, pct));
                      }}
                    />
                  </label>
                </div>
                <p className="text-xs text-ink-muted">{b.serviceKeys.map((k) => data.services.find((s) => s.id === k)?.name ?? k).join(" + ")}</p>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-sm">
                  {TIERS.map((tier) => {
                    const gross = b.serviceKeys.reduce((sum, k) => sum + price(k, tier), 0);
                    const net = gross - Math.round((gross * b.discountPct) / 100);
                    return (
                      <div key={tier}>
                        <dt className="text-xs capitalize text-ink-muted">{tier}</dt>
                        <dd className="font-semibold">{formatINR(net)}</dd>
                        <dd className="text-xs text-ink-muted line-through">{formatINR(gross)}</dd>
                      </div>
                    );
                  })}
                </dl>
              </Card>
            ))}
          </div>

          <h2 id="addons" className="mt-10 mb-3 font-semibold">
            Add-ons
          </h2>
          <Card>
            <ul className="divide-y divide-border text-sm">
              {data.addOns.map((a) => (
                <AddOnRow key={`${a.id}-${a.pricePaise}-${a.unit}-${a.isCustomQuote}`} addOn={a} onSave={(input) => change(`${input.name} saved`, () => api.catalogue.saveAddOn(a.name, input))} onRemove={() => window.confirm(`Remove ${a.name}?`) && change(`${a.name} removed`, () => api.catalogue.removeAddOn(a.name))} />
              ))}
            </ul>
            <NewAddOn onSave={(input) => change(`${input.name} added`, () => api.catalogue.saveAddOn(input.name, input))} />
          </Card>

          <h2 id="versions" className="mt-10 mb-3 font-semibold">
            Price book history
          </h2>
          <Card>
            {versions.data ? (
              <ul className="divide-y divide-border text-sm">
                {versions.data.map((v) => (
                  <li key={v.id} className="flex justify-between py-2">
                    <span>
                      {v.version} {v.status === "active" ? <Badge tone="green">active</Badge> : <Badge>{v.status}</Badge>}
                    </span>
                    <span className="text-ink-muted">
                      from {new Date(v.effectiveFrom).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })} · {v.proposals} proposal{v.proposals === 1 ? "" : "s"}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <LoadState loading={versions.loading} error={versions.error} />
            )}
          </Card>
        </>
      )}
    </>
  );
}

type AddOn = CatalogueAdmin["addOns"][number];
type AddOnSave = { name: string; priceRupees: number | null; unit?: string | null; isCustomQuote: boolean };

function AddOnFields({ initial, submitLabel, onSave, extra }: { initial: AddOnSave; submitLabel: string; onSave: (v: AddOnSave) => void; extra?: React.ReactNode }) {
  const [v, setV] = useState({ name: initial.name, price: initial.priceRupees === null ? "" : String(initial.priceRupees), unit: initial.unit ?? "", custom: initial.isCustomQuote });
  return (
    <form
      className="flex flex-wrap items-center gap-2 py-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave({ name: v.name.trim(), priceRupees: v.custom || v.price === "" ? null : Number(v.price.replace(/[^\d]/g, "")), unit: v.unit.trim() || null, isCustomQuote: v.custom });
      }}
    >
      <Input className="min-w-[180px] flex-1 py-1" value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} aria-label="Add-on name" placeholder="Add-on name" required />
      <Input className="w-28 py-1" value={v.price} onChange={(e) => setV({ ...v, price: e.target.value })} inputMode="numeric" aria-label="Price in rupees" placeholder="₹ price" disabled={v.custom} />
      <Input className="w-28 py-1" value={v.unit} onChange={(e) => setV({ ...v, unit: e.target.value })} aria-label="Unit" placeholder="per reel" />
      <label className="flex items-center gap-1 text-xs text-ink-muted">
        <input type="checkbox" checked={v.custom} onChange={(e) => setV({ ...v, custom: e.target.checked })} /> Custom quote
      </label>
      <Button type="submit" variant="secondary" className="py-1">
        {submitLabel}
      </Button>
      {extra}
    </form>
  );
}

function AddOnRow({ addOn: a, onSave, onRemove }: { addOn: AddOn; onSave: (v: AddOnSave) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  if (editing)
    return (
      <li>
        <AddOnFields
          initial={{ name: a.name, priceRupees: a.pricePaise === null ? null : a.pricePaise / 100, unit: a.unit, isCustomQuote: a.isCustomQuote }}
          submitLabel="Save"
          onSave={(v) => {
            setEditing(false);
            onSave(v);
          }}
          extra={
            <Button type="button" variant="ghost" className="py-1" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          }
        />
      </li>
    );
  return (
    <li className="flex items-center justify-between gap-3 py-2">
      <span>{a.name}</span>
      <span className="flex items-center gap-3">
        <span>{a.isCustomQuote ? <Badge tone="amber">custom quote</Badge> : `${formatINR(a.pricePaise ?? 0)}${a.unit ? ` ${a.unit}` : ""} + ${formatINR(withGst(a.pricePaise ?? 0).gst)} GST`}</span>
        <button className="text-xs underline" onClick={() => setEditing(true)}>
          Edit
        </button>
        <button className="text-xs text-ink-muted underline" onClick={onRemove}>
          Remove
        </button>
      </span>
    </li>
  );
}

function NewAddOn({ onSave }: { onSave: (v: AddOnSave) => void }) {
  const [n, setN] = useState(0);
  return (
    <div className="mt-2 border-t border-border pt-2">
      <p className="text-xs text-ink-muted">Add a new add-on</p>
      <AddOnFields
        key={n}
        initial={{ name: "", priceRupees: null, unit: null, isCustomQuote: false }}
        submitLabel="Add"
        onSave={(v) => {
          onSave(v);
          setN(n + 1);
        }}
      />
    </div>
  );
}
