"use client";

import { useMemo, useState } from "react";
import { formatINR, priceProposal, withGst, type ServiceSummary, type Tier } from "@bmu/shared";
import { PaymentPlan } from "@/components/proposal-summary";
import { Button, Input } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const TIERS: Tier[] = ["starter", "growth", "premium"];

/**
 * Website package builder. Prices, bundles and add-ons come live from the active price book, and the totals use the
 * same pricing rules as the team's proposals (bundle saving, 18% GST, retainers monthly in advance, projects 50/50).
 */
export function PackageBuilder({ services }: { services: ServiceSummary[] }) {
  const live = useLoad(() => api.sell.publicPricing());
  const [picked, setPicked] = useState<Record<string, Tier>>({});
  const [addOns, setAddOns] = useState<Record<string, number>>({});
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const tracks = useMemo(() => Map.groupBy(services, (s) => s.track), [services]);
  const priceOf = (id: string, tier: Tier) =>
    live.data?.services.find((s) => s.key === id)?.tiers.find((t) => t.tier === tier)?.pricePaise ?? services.find((s) => s.id === id)?.tiers.find((t) => t.tier === tier)?.pricePaise ?? 0;
  const ids = Object.keys(picked);
  const pricedAddOns = (live.data?.addOns ?? []).filter((a) => !a.isCustomQuote && a.pricePaise !== null);

  const result = useMemo(() => {
    if (!live.data || Object.keys(picked).length === 0) return null;
    try {
      return priceProposal({
        ...live.data,
        serviceLines: Object.entries(picked).map(([serviceKey, tier]) => ({ serviceKey, tier })),
        addOnLines: Object.entries(addOns)
          .filter(([, q]) => q > 0)
          .map(([addOnId, qty]) => ({ addOnId, qty })),
        extraDiscountPct: 0,
      });
    } catch {
      return null;
    }
  }, [live.data, picked, addOns]);

  const monthly = result?.lines.filter((l) => l.billingType === "monthly").reduce((s, l) => s + l.netPaise, 0) ?? 0;
  const oneTime = result?.lines.filter((l) => l.billingType !== "monthly").reduce((s, l) => s + l.netPaise, 0) ?? 0;

  function toggle(id: string) {
    setPicked((p) => {
      const next = { ...p };
      if (next[id]) delete next[id];
      else next[id] = "growth";
      return next;
    });
  }

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const summary = (result?.lines ?? []).map((l) => (l.kind === "service" ? `${l.name} (${l.tier})` : `${l.name} × ${l.qty}`)).join(", ");
    setError(undefined);
    setBusy(true);
    try {
      await api.createEnquiry({
        name: String(f.get("name")),
        email: String(f.get("email")),
        phone: String(f.get("phone")).replace(/\s+/g, ""),
        company: String(f.get("company") || "") || undefined,
        need: `Package builder: ${summary}${result?.bundle ? ` · ${result.bundle.name} bundle` : ""}. Estimate ${formatINR(result?.totalPaise ?? 0)} incl. GST, ${formatINR(result?.firstPayment.totalPaise ?? 0)} to start.`,
        budgetRupees: Math.round(monthly / 100) || undefined,
        serviceIds: ids,
      });
      setSent(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_360px]">
      <div className="space-y-8">
        {[...tracks.entries()].map(([track, list]) => (
          <section key={track}>
            <h2 className="mb-2 font-semibold">{track}</h2>
            <div className="grid gap-2">
              {list.map((s) => {
                const tier = picked[s.id];
                return (
                  <div key={s.id} className={`border bg-surface-raised p-3 ${tier ? "border-green" : "border-border"}`}>
                    <label className="flex cursor-pointer items-center gap-3">
                      <input type="checkbox" checked={!!tier} onChange={() => toggle(s.id)} className="size-4 accent-[#8BB72C]" />
                      <span className="flex-1 font-medium">{s.name}</span>
                      <span className="text-sm text-ink-muted">from {formatINR(priceOf(s.id, "starter") || (s.tiers[0]?.pricePaise ?? 0))}</span>
                    </label>
                    {tier && (
                      <div className="mt-3 grid grid-cols-3 gap-2" role="radiogroup" aria-label={`${s.name} tier`}>
                        {TIERS.map((t) => (
                          <button
                            key={t}
                            type="button"
                            role="radio"
                            aria-checked={tier === t}
                            onClick={() => setPicked((p) => ({ ...p, [s.id]: t }))}
                            className={`border px-2 py-2 text-left text-sm ${tier === t ? "border-charcoal bg-charcoal text-ivory" : "border-border"}`}
                          >
                            <span className="block capitalize">{t}</span>
                            <span className="text-xs opacity-80">
                              {formatINR(priceOf(s.id, t))}
                              {s.billingType === "monthly" ? "/mo" : ""}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </section>
        ))}

        {pricedAddOns.length > 0 && (
          <section>
            <h2 className="mb-2 font-semibold">Add-ons</h2>
            <div className="grid gap-2">
              {pricedAddOns.map((a) => (
                <div key={a.id} className="flex flex-wrap items-center gap-3 border border-border bg-surface-raised p-3 text-sm">
                  <span className="min-w-0 flex-1">{a.name}</span>
                  <span className="text-ink-muted">{formatINR(a.pricePaise ?? 0)}</span>
                  <div className="w-20 shrink-0">
                    <Input
                      type="number"
                      min={0}
                      max={10}
                      value={addOns[a.id] ?? 0}
                      onChange={(e) => setAddOns((x) => ({ ...x, [a.id]: Math.max(0, Math.min(10, Number(e.target.value) || 0)) }))}
                      aria-label={`${a.name} quantity`}
                    />
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}
      </div>

      <aside className="h-fit border border-border bg-surface-raised p-5 lg:sticky lg:top-6">
        <h2 className="font-display text-lg">Your package</h2>
        {ids.length === 0 && <p className="mt-3 text-sm text-ink-muted">Tick a service to start.</p>}
        {live.error && <p className="mt-3 text-sm text-ink-muted">Live prices are unavailable right now; we&apos;ll confirm exact prices in your proposal.</p>}
        {result?.bundle && (
          <p className="mt-3 bg-green/15 px-3 py-2 text-sm">
            <strong>{result.bundle.name}</strong> bundle detected. You save {result.bundle.discountPct}% on its services.
          </p>
        )}
        <ul className="mt-3 divide-y divide-border text-sm">
          {result?.lines.map((l) => (
            <li key={`${l.kind}-${l.key}`} className="flex justify-between gap-2 py-2">
              <span>
                {l.name}
                {l.qty > 1 ? ` × ${l.qty}` : ""}
                <span className="block text-xs capitalize text-ink-muted">
                  {l.tier ? `${l.tier} · ` : ""}
                  {l.billingType === "monthly" ? "monthly" : "one time"}
                </span>
              </span>
              <span className="text-right">
                {formatINR(l.netPaise)}
                {l.bundleDiscountPaise > 0 && <span className="block text-xs text-ink-muted line-through">{formatINR(l.grossPaise)}</span>}
              </span>
            </li>
          ))}
        </ul>
        {result && (
          <>
            <dl className="mt-3 space-y-1 border-t border-border pt-3 text-sm">
              {monthly > 0 && <Row label="Monthly" value={`${formatINR(monthly)} + ${formatINR(withGst(monthly).gst)} GST`} />}
              {oneTime > 0 && <Row label="One time" value={`${formatINR(oneTime)} + ${formatINR(withGst(oneTime).gst)} GST`} />}
              {result.bundleDiscountPaise > 0 && <Row label="Bundle saving" value={`−${formatINR(result.bundleDiscountPaise)}`} />}
              <Row label="GST (18%)" value={formatINR(result.gstPaise)} />
              <Row label="Due now to start, incl. GST" value={formatINR(result.firstPayment.totalPaise)} strong />
            </dl>
            <PaymentPlan lines={result.lines} />
          </>
        )}

        {result && !sent && (
          <form onSubmit={submit} className="mt-5 grid gap-2">
            <Input name="name" placeholder="Your name" required />
            <Input name="email" type="email" placeholder="Email" required />
            <Input name="phone" type="tel" placeholder="Mobile" required />
            <Input name="company" placeholder="Business name (optional)" />
            {error && <p className="text-sm text-red">{error}</p>}
            <Button type="submit" disabled={busy}>
              {busy ? "Sending…" : "Get my proposal"}
            </Button>
          </form>
        )}
        {sent && <p className="mt-5 border border-green bg-green/10 p-3 text-sm">Thanks! We&apos;ll call you within one working day and send your proposal.</p>}
      </aside>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-2 ${strong ? "font-semibold" : ""}`}>
      <dt>{label}</dt>
      <dd className="text-right">{value}</dd>
    </div>
  );
}
