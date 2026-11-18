"use client";

// v45: the quotation editor, used for a quotation (client, prepared-for lines, valid until, template) and for a
// template (name, service). Everything else is the document: project, highlights, cost lines (quantity × rate or a
// percentage of the fees) and the advance % invoiced when the client accepts. v46: scope and timeline are optional.
// v52: ONE form for quotations and invoices (kind): Details, Bill to, Items (Description, Qty, Rate, Amount, with
// Service, Sub service and Billing; "Add item" opens a searchable price list), one GST rate for the whole document with
// an "Add GST" switch, the overview written by rules until the user types in it, Signature and seal, Notes and terms.
import { useEffect, useMemo, useRef, useState } from "react";
import {
  formatINR,
  itemBillingLabels,
  priceListEntries,
  QUOTE_GST_RATES,
  QUOTE_OVERVIEW_MAX,
  QUOTE_VALID_UNTIL_RE,
  quoteDefaultTerms,
  quoteGstSplit,
  quoteOverviewText,
  quoteTermsChanges,
  quoteTermsFromText,
  quoteTermsToText,
  quoteTermsWithValidUntil,
  quoteTotals,
  SERVICE_GST_STATES,
  type ClientServiceRow,
  type PriceList,
  type QuoteContent,
  type QuoteLine,
  type ServiceSummary,
} from "@bmu/shared";
import { Button, Input, Select } from "@/components/ui";
import { api } from "@/lib/api";

const area = "w-full border border-border bg-surface px-3 py-2 text-sm";
const rupees = (p: number) => (p ? String(p / 100) : "");
const paise = (v: string) => Math.round((Number(v.replace(/[^\d.]/g, "")) || 0) * 100);

export const emptyContent = (): QuoteContent => ({
  title: "",
  overview: "",
  projectLines: [],
  stats: [],
  lines: [{ title: "", details: "", kind: "unit", qty: 1, unitPricePaise: 0, pct: 0, service: "", billing: "" }],
  scope: [],
  timeline: [],
  terms: [],
  advancePct: 50,
  footerLine: "",
  signWith: "mine",
  seal: true,
  notes: "",
  gstRatePct: 18,
});

/** Before saving: optional cards and steps left blank are dropped. */
export const cleanContent = (c: QuoteContent): QuoteContent => ({ ...c, scope: c.scope.filter((s) => s.title.trim()), timeline: c.timeline.filter((t) => t.title.trim() && t.label.trim()) });

const tierName = (tier: string) => tier.charAt(0).toUpperCase() + tier.slice(1);
export const blankLine = (): QuoteLine => ({ title: "", details: "", kind: "unit", qty: 1, unitPricePaise: 0, pct: 0, service: "", billing: "" });
const isBlank = (x: QuoteLine) => !x.title.trim() && !x.details.trim() && !x.unitPricePaise && !x.pct;

type Choice = { key: string; label: string; line: QuoteLine };

/**
 * v52: a new document starts with the client's current services and bundles as items, at the client's plan price (or the
 * lowest priced plan when none is chosen). Bundles are monthly, described by their sub services joined with " + ".
 */
export function linesFromClientServices(rows: ClientServiceRow[]): QuoteLine[] {
  return rows
    .filter((r) => r.status === "active" && r.pricePaise != null)
    .map((r) => ({ ...blankLine(), title: `${r.name}${r.pricedPlan ? ` (${tierName(r.pricedPlan)} plan)` : ""}`.slice(0, 160), details: r.description.slice(0, 600), unitPricePaise: r.pricePaise ?? 0, service: r.service, billing: r.billing }));
}

/**
 * "Add item" opens this: a searchable price list. Sub-services and bundles at each plan (today's prices), and the old
 * price list that running projects still use. Picking one fills the description, rate, service, sub service and billing.
 */
function PriceListPicker({ onPick, onBlank, onCancel }: { onPick: (line: QuoteLine) => void; onBlank: () => void; onCancel: () => void }) {
  const [list, setList] = useState<PriceList>();
  const [old, setOld] = useState<ServiceSummary[]>();
  const [error, setError] = useState<string>();
  const [q, setQ] = useState("");
  useEffect(() => {
    api.catalogue.priceList().then(setList, (e: Error) => setError(e.message));
    api.services().then(setOld, () => setOld([]));
  }, []);
  const choices: Choice[] = useMemo(
    () => [
      ...(list ? priceListEntries(list) : []).map((e) => ({
        key: e.key,
        label: e.label,
        line: { ...blankLine(), title: `${e.name} (${tierName(e.plan)} plan)`.slice(0, 160), details: e.description.slice(0, 600), unitPricePaise: e.pricePaise, service: e.service, billing: e.billing },
      })),
      ...(old ?? []).flatMap((s) =>
        s.tiers
          .filter((t) => t.pricePaise > 0)
          .map((t) => ({
            key: `old:${s.id}:${t.tier}`,
            label: `Old price list › ${s.track} › ${s.name} — ${tierName(t.tier)} · ${formatINR(t.pricePaise)} ${s.billingType === "monthly" ? "per month" : "one time"}`,
            line: { ...blankLine(), title: `${s.name} (${tierName(t.tier)} plan)`.slice(0, 160), details: (s.excludedNote ?? "").slice(0, 600), unitPricePaise: t.pricePaise, service: s.track, billing: (s.billingType === "monthly" ? "monthly" : s.billingType === "per_unit" ? "per_unit" : "one_time") as QuoteLine["billing"] },
          })),
      ),
    ],
    [list, old],
  );
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const shown = choices.filter((c) => words.every((w) => c.label.toLowerCase().includes(w))).slice(0, 80);
  return (
    <div className="quote-price-list-picker grid gap-2 border border-border p-3 sm:max-w-2xl" data-testid="quote-price-list">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs font-medium">Add from the price list</span>
        <span className="flex gap-3 text-xs">
          <button type="button" className="underline" onClick={onBlank} data-testid="quote-add-blank">
            Add a blank item instead
          </button>
          <button type="button" className="text-ink-muted underline" onClick={onCancel}>
            Cancel
          </button>
        </span>
      </div>
      <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={list ? "Search a sub service, bundle or plan…" : error ? "Could not load the price list" : "Loading…"} aria-label="Search the price list" autoFocus />
      <ul className="quote-price-list-options max-h-64 overflow-y-auto border border-border text-sm" role="listbox" aria-label="Add from the price list">
        {shown.map((c) => (
          <li key={c.key}>
            <button type="button" role="option" aria-selected={false} className="w-full px-3 py-1.5 text-left hover:bg-canvas" onClick={() => onPick(c.line)}>
              {c.label}
            </button>
          </li>
        ))}
        {list && !shown.length && <li className="px-3 py-2 text-xs text-ink-muted">Nothing matches. Add a blank item instead.</li>}
      </ul>
      <span className="text-xs text-ink-muted">Fills in the description and rate, before GST. For a monthly service, set Qty to the number of months.</span>
    </div>
  );
}

/** One titled card of the form (Details, Bill to, Items, …), with a short hint under the title. */
export function QuoteFormSection({ title, hint, children, testId }: { title: string; hint?: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="quote-form-section border border-border bg-surface-raised" data-testid={testId}>
      <header className="quote-form-section-header border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold">{title}</h2>
        {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
      </header>
      <div className="quote-form-section-body grid gap-3 p-4">{children}</div>
    </section>
  );
}

const emptyBillTo = { name: "", gstin: "", placeOfSupply: "", address: "" };
export type FormSettings = { gstRatePct: number; sellerStateCode: string; sellerState: string; company: string };

/**
 * The form, in the order of the document: Details, Bill to, Items (quotations: scope and timeline after them),
 * Signature and seal, Notes and terms. `details` is the client / dates part; without it (the template editor) only the
 * document parts are shown.
 */
export function QuoteEditor({
  value,
  onChange,
  gstRatePct: fixedRate,
  details,
  kind = "quotation",
  clientName = "",
  validUntil,
  onItemsEdited,
  mixedRates,
}: {
  value: QuoteContent;
  onChange: (v: QuoteContent) => void;
  /** An older saved document without its own rate keeps the GST % it was made with. */
  gstRatePct?: number;
  clientOrgId?: string;
  details?: React.ReactNode;
  kind?: "quotation" | "invoice";
  clientName?: string;
  /** Quotation: the date the valid-until terms line follows. */
  validUntil?: string;
  /** Called when the items are changed by hand (so they are no longer filled from the client's services). */
  onItemsEdited?: () => void;
  /** Older items had different GST rates. */
  mixedRates?: boolean;
}) {
  const v = value;
  const quote = kind === "quotation";
  const doc = !!details;
  const set = <K extends keyof QuoteContent>(k: K, x: QuoteContent[K]) => onChange({ ...v, [k]: x });
  const [settings, setSettings] = useState<FormSettings>();
  useEffect(() => {
    api.quotes.formSettings().then(setSettings, () => undefined);
  }, []);
  const gstRatePct = v.gstRatePct ?? fixedRate ?? settings?.gstRatePct ?? 18;
  const gstOn = gstRatePct > 0;
  const [lastRate, setLastRate] = useState(gstOn ? gstRatePct : 18);
  const t = quoteTotals(v.lines, gstRatePct);
  const billTo = { ...emptyBillTo, ...v.billTo };
  const setBillTo = (patch: Partial<typeof billTo>) => set("billTo", { ...billTo, ...patch });
  const split = quoteGstSplit(t.gstPaise, settings?.sellerStateCode ?? "29", billTo.placeOfSupply, billTo.gstin);
  const half = gstRatePct / 2;

  // Terms. Quotations: BMU's standard terms with the valid-until line, which follows the date while it is automatic.
  const defaults = quote && validUntil ? quoteDefaultTerms(validUntil) : [];
  const terms = v.terms.length ? v.terms : defaults;
  const termsChanged = quote && quoteTermsChanges(terms).any;
  const [termsDraft, setTermsDraft] = useState<string>();
  useEffect(() => {
    if (!quote || !validUntil || !v.terms.length) return;
    const moved = quoteTermsWithValidUntil(v.terms, validUntil);
    if (moved.some((x, i) => x.text !== v.terms[i].text)) {
      setTermsDraft(undefined);
      onChange({ ...v, terms: moved });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validUntil]);

  // Overview: written by rules from the client and items, rewritten as they change until the user types in it.
  const auto = quoteOverviewText({ company: settings?.company ?? "BMU Marketing", client: clientName, kind, lines: v.lines });
  const lastAuto = useRef<string>(v.overview ?? "");
  useEffect(() => {
    if (!doc) return;
    const current = v.overview ?? "";
    if ((current === "" || current === lastAuto.current) && auto !== current) {
      lastAuto.current = auto;
      set("overview", auto);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  const setLines = (lines: QuoteLine[]) => {
    onItemsEdited?.();
    set("lines", lines);
  };
  const line = (i: number, patch: Partial<QuoteLine>) => setLines(v.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const [bulletsDraft, setBulletsDraft] = useState<Record<number, string>>({});
  const [picking, setPicking] = useState(false);
  // A price-list pick takes the place of the empty starting line, if there is one.
  const addLine = (l: QuoteLine) => {
    const last = v.lines[v.lines.length - 1];
    setLines(l.title && last && isBlank(last) ? [...v.lines.slice(0, -1), l] : [...v.lines, l]);
    setPicking(false);
  };
  // v46: unticking keeps what was typed, so ticking again brings it back.
  const kept = useRef<{ scope: QuoteContent["scope"]; timeline: QuoteContent["timeline"] }>({ scope: [], timeline: [] });
  const toggleScope = (on: boolean) => {
    setBulletsDraft({});
    if (!on) kept.current.scope = v.scope;
    set("scope", on ? (kept.current.scope.length ? kept.current.scope : [{ title: "", bullets: [] }]) : []);
  };
  const toggleTimeline = (on: boolean) => {
    if (!on) kept.current.timeline = v.timeline;
    set("timeline", on ? (kept.current.timeline.length ? kept.current.timeline : [{ label: "Week 1", title: "", text: "" }]) : []);
  };
  const ratesOnItems = new Set(v.lines.map((l) => l.gstRatePct).filter((r): r is number => typeof r === "number"));
  const showMixed = mixedRates || ratesOnItems.size > 1;

  return (
    <div className="grid gap-6" data-testid="quote-editor">
      <QuoteFormSection title="Details" testId="quote-section-details">
        {details}
        {quote && (
          <>
            <Input value={v.title} onChange={(e) => set("title", e.target.value)} placeholder="Project name, e.g. Bengaluru Influencer Campaign" aria-label="Project name" maxLength={160} />
            <label className="grid gap-1 text-xs font-medium sm:w-72">
              Plan (printed under the project name)
              <Select value={v.planType ?? ""} onChange={(e) => set("planType", e.target.value as QuoteContent["planType"])} aria-label="Plan">
                <option value="">Not shown</option>
                <option value="one_time">One-time project</option>
                <option value="monthly">Monthly project</option>
                <option value="mixed">Monthly and one-time project</option>
              </Select>
            </label>
          </>
        )}
        <div className="grid gap-1">
          <span className="text-xs font-medium">Project overview</span>
          <textarea
            className={`${area} h-20`}
            value={v.overview ?? ""}
            onChange={(e) => set("overview", e.target.value)}
            placeholder="Written for you from the client and the items. Type here to write your own."
            aria-label="Project overview"
            maxLength={QUOTE_OVERVIEW_MAX}
            data-testid="quote-overview"
          />
          <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-ink-muted">
            <span>Up to three lines, printed under who it is for.</span>
            {doc && auto && v.overview !== auto && (
              <button
                type="button"
                className="underline"
                onClick={() => {
                  lastAuto.current = auto;
                  set("overview", auto);
                }}
                data-testid="quote-overview-again"
              >
                Write it again from the services
              </button>
            )}
          </span>
        </div>
      </QuoteFormSection>

      {doc && (
        <QuoteFormSection title="Bill to" hint="Filled in from the client. Change them here for this document only." testId="quote-section-bill-to">
          <div className="grid items-start gap-3 sm:grid-cols-3">
            <label className="grid min-w-0 gap-1 text-xs font-medium">
              Name
              <Input value={billTo.name} onChange={(e) => setBillTo({ name: e.target.value })} aria-label="Bill to name" maxLength={200} />
            </label>
            <label className="grid min-w-0 gap-1 text-xs font-medium">
              Client GSTIN
              <Input value={billTo.gstin} onChange={(e) => setBillTo({ gstin: e.target.value.toUpperCase() })} placeholder="15 characters, if registered" aria-label="Client GSTIN" maxLength={15} />
            </label>
            <label className="grid min-w-0 gap-1 text-xs font-medium">
              Place of supply
              <Select className="w-full min-w-0" value={billTo.placeOfSupply} onChange={(e) => setBillTo({ placeOfSupply: e.target.value })} aria-label="Place of supply">
                <option value="">Not set</option>
                {SERVICE_GST_STATES.map((s) => (
                  <option key={s.code} value={s.code}>
                    {s.name}
                  </option>
                ))}
              </Select>
              <span className="font-normal text-ink-muted">
                Within {settings?.sellerState ?? "Karnataka"} is charged CGST and SGST. Anywhere else is charged IGST.
              </span>
            </label>
          </div>
          <label className="grid gap-1 text-xs font-medium">
            Address
            <textarea className={`${area} h-16`} value={billTo.address} onChange={(e) => setBillTo({ address: e.target.value })} aria-label="Bill to address" maxLength={600} />
          </label>
        </QuoteFormSection>
      )}

      <QuoteFormSection title="Items" hint={doc ? "The client's services are added for you. Check the rates and quantities." : "Check the rates and quantities. Prices are before GST."} testId="quote-section-items">
        {v.lines.map((l, i) => (
          <div key={i} className="quote-item grid gap-2 border border-border p-3" data-testid="quote-line">
            <div className="grid items-start gap-2 sm:grid-cols-[1fr_5rem_8rem_8rem_auto]">
              <label className="grid min-w-0 gap-1 text-xs font-medium">
                Description
                <textarea className={`${area} h-16`} value={l.details} onChange={(e) => line(i, { details: e.target.value })} placeholder="What it covers" aria-label={`Line ${i + 1} details`} maxLength={600} />
              </label>
              {l.kind === "percent" ? (
                <label className="grid min-w-0 gap-1 text-xs font-medium sm:col-span-2">
                  % of the fees
                  <Input type="number" min={0} max={100} step={0.5} value={l.pct || ""} onChange={(e) => line(i, { pct: Number(e.target.value) || 0 })} placeholder="15" aria-label={`Line ${i + 1} percent`} />
                </label>
              ) : (
                <>
                  <label className="grid min-w-0 gap-1 text-xs font-medium">
                    Qty
                    <Input type="number" min={0} step={1} value={l.qty || ""} onChange={(e) => line(i, { qty: Number(e.target.value) || 0 })} placeholder="Qty" aria-label={`Line ${i + 1} quantity`} />
                  </label>
                  <label className="grid min-w-0 gap-1 text-xs font-medium">
                    Rate (₹)
                    <Input inputMode="decimal" value={rupees(l.unitPricePaise)} onChange={(e) => line(i, { unitPricePaise: paise(e.target.value) })} placeholder="Rate" aria-label={`Line ${i + 1} rate in rupees`} />
                  </label>
                </>
              )}
              <span className="grid gap-1 text-xs font-medium">
                Amount
                <span className="py-2 text-right text-sm tabular-nums" data-testid="quote-line-amount">
                  {formatINR(t.amounts[i] ?? 0)}
                </span>
              </span>
              <button type="button" className="self-center text-xs text-ink-muted underline hover:text-red disabled:opacity-40 sm:mt-5" disabled={v.lines.length <= 1} onClick={() => setLines(v.lines.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
            <div className="grid gap-2 sm:grid-cols-[1fr_1.4fr_10rem_9rem]">
              <Input value={l.service ?? ""} onChange={(e) => line(i, { service: e.target.value })} placeholder="Service" aria-label={`Line ${i + 1} service`} maxLength={120} />
              <Input value={l.title} onChange={(e) => line(i, { title: e.target.value })} placeholder="Sub service, e.g. SEO (Growth plan)" aria-label={`Line ${i + 1} title`} maxLength={160} />
              <Select value={l.billing ?? ""} onChange={(e) => line(i, { billing: e.target.value as QuoteLine["billing"] })} aria-label={`Line ${i + 1} billing`}>
                {Object.entries(itemBillingLabels).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>
              {quote ? (
                <Select value={l.kind} onChange={(e) => line(i, { kind: e.target.value as QuoteLine["kind"] })} aria-label={`Line ${i + 1} type`}>
                  <option value="unit">Qty × rate</option>
                  <option value="percent">% of the fees</option>
                </Select>
              ) : (
                <span />
              )}
            </div>
          </div>
        ))}
        {v.lines.length < 100 &&
          (picking ? (
            <PriceListPicker onPick={addLine} onBlank={() => addLine(blankLine())} onCancel={() => setPicking(false)} />
          ) : (
            <button type="button" className="justify-self-start border border-border px-3 py-1.5 text-sm hover:border-ink" onClick={() => setPicking(true)} data-testid="quote-add-line">
              Add item
            </button>
          ))}
        <div className="quote-totals ml-auto grid w-full max-w-xs gap-1 text-sm" data-testid="quote-totals">
          <label className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-2 font-medium">
              <input
                type="checkbox"
                checked={gstOn}
                onChange={(e) => {
                  if (gstOn) setLastRate(gstRatePct);
                  onItemsEdited?.();
                  onChange({ ...v, gstRatePct: (e.target.checked ? lastRate || 18 : 0) as QuoteContent["gstRatePct"] });
                }}
                data-testid="quote-gst-switch"
              />
              Add GST
            </span>
            {gstOn && (
              <Select className="w-24 py-1" value={String(gstRatePct)} onChange={(e) => set("gstRatePct", Number(e.target.value) as QuoteContent["gstRatePct"])} aria-label="GST rate">
                {QUOTE_GST_RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}%
                  </option>
                ))}
              </Select>
            )}
          </label>
          {gstOn ? (
            <>
              <span className="flex justify-between">
                <span>Taxable value</span>
                <span className="tabular-nums">{formatINR(t.subtotalPaise)}</span>
              </span>
              {split.interState ? (
                <span className="flex justify-between">
                  <span>IGST ({gstRatePct}%)</span>
                  <span className="tabular-nums">{formatINR(split.igstPaise)}</span>
                </span>
              ) : (
                <>
                  <span className="flex justify-between">
                    <span>CGST ({half}%)</span>
                    <span className="tabular-nums">{formatINR(split.cgstPaise)}</span>
                  </span>
                  <span className="flex justify-between">
                    <span>SGST ({half}%)</span>
                    <span className="tabular-nums">{formatINR(split.sgstPaise)}</span>
                  </span>
                </>
              )}
            </>
          ) : (
            <span className="flex justify-between">
              <span>Subtotal</span>
              <span className="tabular-nums">{formatINR(t.subtotalPaise)}</span>
            </span>
          )}
          <span className="flex justify-between border-t border-border pt-1 font-semibold">
            <span>Total</span>
            <span className="tabular-nums" data-testid="quote-editor-total">
              {formatINR(t.totalPaise)}
            </span>
          </span>
          {!gstOn && <span className="text-xs text-ink-muted">No GST: the total is the items alone.</span>}
          {showMixed && <span className="text-xs text-[#9a6b00]">The items had different GST rates. Saving applies this one to all of them.</span>}
        </div>
        {quote && (
          <label className="flex items-center gap-2 text-sm">
            Advance to invoice first:
            <Input type="number" min={0} max={100} className="w-20" value={v.advancePct} onChange={(e) => set("advancePct", Math.max(0, Math.min(100, Number(e.target.value) || 0)))} aria-label="Advance percent" />% ({formatINR(Math.round((t.subtotalPaise * v.advancePct) / 100))}
            {gstOn ? " + GST" : ""})
          </label>
        )}
      </QuoteFormSection>

      {quote && (
        <QuoteFormSection title="Scope and timeline" hint="Optional. Printed on page 2." testId="quote-section-scope">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={v.scope.length > 0} onChange={(e) => toggleScope(e.target.checked)} data-testid="quote-scope-toggle" />
            Add the scope of work (optional)
          </label>
          {v.scope.map((s, i) => (
            <div key={i} className="grid gap-2 border border-border p-3">
              <div className="flex gap-2">
                <Input value={s.title} onChange={(e) => set("scope", v.scope.map((x, j) => (j === i ? { ...x, title: e.target.value } : x)))} placeholder="Card title, e.g. Deliverables per influencer" aria-label={`Scope card ${i + 1} title`} />
                <button type="button" className="text-xs text-ink-muted underline hover:text-red" onClick={() => (setBulletsDraft({}), set("scope", v.scope.filter((_, j) => j !== i)))}>
                  Remove
                </button>
              </div>
              <textarea
                className={`${area} h-24`}
                value={bulletsDraft[i] ?? s.bullets.join("\n")}
                onChange={(e) => {
                  setBulletsDraft({ ...bulletsDraft, [i]: e.target.value });
                  set("scope", v.scope.map((x, j) => (j === i ? { ...x, bullets: e.target.value.split("\n").map((b) => b.trim()).filter(Boolean).slice(0, 10) } : x)));
                }}
                placeholder="One point per line"
                aria-label={`Scope card ${i + 1} points`}
              />
            </div>
          ))}
          {v.scope.length > 0 && v.scope.length < 6 && (
            <button type="button" className="justify-self-start text-sm underline" onClick={() => set("scope", [...v.scope, { title: "", bullets: [] }])}>
              + Add a card
            </button>
          )}
          <label className="flex items-center gap-2 text-sm font-medium">
            <input type="checkbox" checked={v.timeline.length > 0} onChange={(e) => toggleTimeline(e.target.checked)} data-testid="quote-timeline-toggle" />
            Add the timeline (optional)
          </label>
          {v.timeline.map((x, i) => (
            <div key={i} className="grid gap-2 sm:grid-cols-[7rem_12rem_1fr_auto]">
              <Input value={x.label} onChange={(e) => set("timeline", v.timeline.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} placeholder="Week 1" aria-label={`Timeline ${i + 1} label`} />
              <Input value={x.title} onChange={(e) => set("timeline", v.timeline.map((y, j) => (j === i ? { ...y, title: e.target.value } : y)))} placeholder="Shortlist & approve" aria-label={`Timeline ${i + 1} title`} />
              <Input value={x.text} onChange={(e) => set("timeline", v.timeline.map((y, j) => (j === i ? { ...y, text: e.target.value } : y)))} placeholder="What happens" aria-label={`Timeline ${i + 1} text`} />
              <button type="button" className="text-xs text-ink-muted underline hover:text-red" onClick={() => set("timeline", v.timeline.filter((_, j) => j !== i))}>
                Remove
              </button>
            </div>
          ))}
          {v.timeline.length > 0 && v.timeline.length < 8 && (
            <button type="button" className="justify-self-start text-sm underline" onClick={() => set("timeline", [...v.timeline, { label: `Week ${v.timeline.length + 1}`, title: "", text: "" }])}>
              + Add a step
            </button>
          )}
        </QuoteFormSection>
      )}

      {doc && (
        <QuoteFormSection title="Signature and seal" hint="Printed at the bottom, with your name and title under the signature." testId="quote-section-signature">
          <label className="grid gap-1 text-xs font-medium">
            Signature
            <Select value={v.signWith ?? "mine"} onChange={(e) => set("signWith", e.target.value as QuoteContent["signWith"])} aria-label="Signature">
              <option value="mine">Sign with my signature</option>
              <option value="blank">No signature (sign by hand after printing)</option>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={v.seal !== false} onChange={(e) => set("seal", e.target.checked)} data-testid="quote-seal-toggle" />
            Add the company seal under the signature
          </label>
        </QuoteFormSection>
      )}

      <QuoteFormSection title={doc ? "Notes and terms" : "Last page"} hint={doc ? "Both are printed on the document the client sees." : undefined} testId="quote-section-notes">
        {doc && (
          <label className="grid gap-1 text-xs font-medium">
            Notes
            <textarea className={`${area} h-20`} value={v.notes ?? ""} onChange={(e) => set("notes", e.target.value)} aria-label="Notes" maxLength={1000} />
          </label>
        )}
        {doc ? (
          <label className="grid gap-1 text-xs font-medium">
            <span className="flex flex-wrap items-center justify-between gap-2">
              Terms
              {quote && (
                <button type="button" className="font-normal underline disabled:opacity-40" disabled={!termsChanged} onClick={() => (setTermsDraft(undefined), set("terms", defaults))} data-testid="quote-terms-reset">
                  Reset to BMU&apos;s standard terms
                </button>
              )}
            </span>
            <textarea
              className={`${area} h-48`}
              value={termsDraft ?? quoteTermsToText(terms)}
              onChange={(e) => {
                setTermsDraft(e.target.value);
                set("terms", quoteTermsFromText(e.target.value));
              }}
              placeholder={quote ? undefined : "Leave empty for BMU's standard invoice terms."}
              aria-label="Terms"
              data-testid="quote-terms-input"
            />
            <span className={`font-normal ${termsChanged ? "text-[#9a6b00]" : "text-ink-muted"}`} data-testid="quote-terms-hint">
              One term per line (up to 12).{" "}
              {quote
                ? termsChanged
                  ? "These differ from BMU's standard terms: the Admin is told when you send this quotation."
                  : `These are BMU's standard terms.${terms.some((x) => QUOTE_VALID_UNTIL_RE.test(x.text)) ? " The valid-until line follows the Valid until date." : ""}`
                : "Empty: BMU's standard invoice terms are printed."}
            </span>
          </label>
        ) : (
          <p className="text-sm text-ink-muted">The terms &amp; conditions and payment details are added to every quotation automatically.</p>
        )}
        {quote && <Input value={v.footerLine} onChange={(e) => set("footerLine", e.target.value)} placeholder="Thank-you line, e.g. Let's put your project in front of Bengaluru's home buyers." aria-label="Thank-you line" maxLength={160} />}
      </QuoteFormSection>
    </div>
  );
}

/**
 * v52 autosave: about 4 seconds after a change, once the required fields are valid, and at once when the tab is hidden.
 * Returns the line to show: "Draft saved at 3:42 pm" or "Not saved yet: <reason>".
 */
export function useDocAutosave({ value, problem, save, enabled = true }: { value: unknown; problem: string | null; save: () => Promise<void>; enabled?: boolean }) {
  const [status, setStatus] = useState<string>();
  const json = JSON.stringify(value);
  const last = useRef<string | null>(null);
  const busy = useRef(false);
  const latest = useRef({ problem, save, json });
  latest.current = { problem, save, json };
  const flush = useRef(async () => {
    const { problem: p, save: s, json: j } = latest.current;
    if (busy.current || j === last.current) return;
    if (p) {
      setStatus(`Not saved yet: ${p}`);
      return;
    }
    busy.current = true;
    try {
      await s();
      last.current = j;
      setStatus(`Draft saved at ${new Date().toLocaleTimeString("en-IN", { hour: "numeric", minute: "2-digit", hour12: true })}`);
    } catch (e) {
      setStatus(`Not saved yet: ${(e as Error).message}`);
    } finally {
      busy.current = false;
    }
  });
  useEffect(() => {
    if (!enabled) return;
    if (last.current === null) {
      last.current = json;
      return;
    }
    const id = window.setTimeout(() => void flush.current(), 4000);
    return () => window.clearTimeout(id);
  }, [json, enabled]);
  useEffect(() => {
    if (!enabled) return;
    const onHide = () => document.visibilityState === "hidden" && void flush.current();
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, [enabled]);
  return { status, markSaved: () => (last.current = latest.current.json), flush: () => flush.current() };
}

/** What still stops a draft from being saved, in plain words (null when it can be saved). */
export function quoteProblem(meta: { clientOrgId: string }, c: QuoteContent): string | null {
  if (!meta.clientOrgId) return "pick the client";
  if (c.title.trim().length < 2) return "name the project";
  if (!c.lines.some((l) => l.title.trim() && (l.unitPricePaise > 0 || l.pct > 0))) return "add an item with a rate";
  if (c.lines.some((l) => !l.title.trim() && (l.unitPricePaise > 0 || l.details.trim()))) return "give every item a sub service name";
  return null;
}

export function SaveBar({ busy, error, children }: { busy?: boolean; error?: string; children: React.ReactNode }) {
  return (
    <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-3 border-t border-border bg-surface-raised py-3">
      {children}
      {busy && <span className="text-xs text-ink-muted">Saving…</span>}
      {error && <span className="text-sm text-red">{error}</span>}
    </div>
  );
}

export { Button };
