"use client";

// v45: the quotation editor, used for a quotation (client, prepared-for lines, valid until, template) and for a
// template (name, service). Everything else is the document: project, highlights, cost lines (quantity × rate or a
// percentage of the fees) and the advance % invoiced when the client accepts. v46: scope and timeline are optional;
// the terms are fixed, so they are not edited here (the server adds them to every quotation).
import { useEffect, useRef, useState } from "react";
import { formatINR, QUOTE_FIXED_TERMS, QUOTE_OVERVIEW_MAX, quoteGstSplit, quoteTermsChanges, quoteTermsFromText, quoteTermsToText, quoteTotals, SERVICE_GST_STATES, type QuoteContent, type QuoteLine, type ServiceSummary } from "@bmu/shared";
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
  lines: [{ title: "", details: "", kind: "unit", qty: 1, unitPricePaise: 0, pct: 0 }],
  scope: [],
  timeline: [],
  terms: [],
  advancePct: 50,
  footerLine: "",
  signWith: "mine",
  seal: true,
  notes: "",
});

/** Before saving: optional cards and steps left blank are dropped. */
export const cleanContent = (c: QuoteContent): QuoteContent => ({ ...c, scope: c.scope.filter((s) => s.title.trim()), timeline: c.timeline.filter((t) => t.title.trim() && t.label.trim()) });

function Fixed({ label, values, max, onChange, placeholder }: { label: string; values: string[]; max: number; onChange: (v: string[]) => void; placeholder: string }) {
  const rows = [...values, ...Array(Math.max(0, max - values.length)).fill("")].slice(0, max);
  return (
    <div className="grid gap-1">
      <span className="text-xs font-medium">{label}</span>
      {rows.map((v, i) => (
        <Input key={i} value={v} placeholder={i === 0 ? placeholder : ""} onChange={(e) => onChange(rows.map((x, j) => (j === i ? e.target.value : x)).filter((x, j, all) => x || all.slice(j + 1).some(Boolean)))} aria-label={`${label} ${i + 1}`} />
      ))}
    </div>
  );
}

const tierName = (tier: string) => tier.charAt(0).toUpperCase() + tier.slice(1);
const blankLine = (): QuoteLine => ({ title: "", details: "", kind: "unit", qty: 1, unitPricePaise: 0, pct: 0 });

/** "+ Add a line" opens this: pick a service and plan from the old price list (today's prices), or add a blank line. */
function PriceListPicker({ onPick, onBlank, onCancel }: { onPick: (line: QuoteLine) => void; onBlank: () => void; onCancel: () => void }) {
  const [list, setList] = useState<ServiceSummary[]>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    api.services().then(setList, (e: Error) => setError(e.message));
  }, []);
  const options = (list ?? []).flatMap((s) => s.tiers.filter((t) => t.pricePaise > 0).map((t) => ({ key: `${s.id}:${t.tier}`, s, t })));
  const pick = (key: string) => {
    const o = options.find((x) => x.key === key);
    if (o) onPick({ ...blankLine(), title: `${o.s.name} (${tierName(o.t.tier)} plan)`.slice(0, 160), details: (o.s.excludedNote ?? "").slice(0, 600), unitPricePaise: o.t.pricePaise });
  };
  return (
    <div className="grid gap-2 border border-border p-3 sm:max-w-xl" data-testid="quote-price-list">
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
      <Select value="" onChange={(e) => pick(e.target.value)} aria-label="Add from the price list" disabled={!list}>
        <option value="">{list ? "Choose a service and plan" : error ? "Could not load the price list" : "Loading…"}</option>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.s.track} › {o.s.name} — {tierName(o.t.tier)} · {formatINR(o.t.pricePaise)} {o.s.billingType === "monthly" ? "per month" : "one time"}
          </option>
        ))}
      </Select>
      <span className="text-xs text-ink-muted">Fills in the description and rate, before GST. For a monthly service, set Qty to the number of months.</span>
    </div>
  );
}

/** One titled card of the quotation form (Details, Bill to, Items, …), with a short hint under the title. */
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

/**
 * The quotation form, in the order of the document: Details, Bill to, Items (with the scope and timeline after them),
 * Signature and seal, Notes and terms. `details` is the client / services / dates part (QuoteMetaForm); without it
 * (the template editor) only the document parts are shown.
 */
export function QuoteEditor({
  value,
  onChange,
  gstRatePct: fixedRate,
  clientOrgId,
  details,
}: {
  value: QuoteContent;
  onChange: (v: QuoteContent) => void;
  /** A saved quotation keeps the GST % it was made with; a new one uses today's setting. */
  gstRatePct?: number;
  clientOrgId?: string;
  details?: React.ReactNode;
}) {
  const v = value;
  const set = <K extends keyof QuoteContent>(k: K, x: QuoteContent[K]) => onChange({ ...v, [k]: x });
  const [settings, setSettings] = useState<{ gstRatePct: number; sellerStateCode: string; sellerState: string }>();
  useEffect(() => {
    api.quotes.formSettings().then(setSettings, () => undefined);
  }, []);
  const gstRatePct = fixedRate ?? settings?.gstRatePct ?? 18;
  const t = quoteTotals(v.lines, gstRatePct);
  const billTo = { ...emptyBillTo, ...v.billTo };
  const setBillTo = (patch: Partial<typeof billTo>) => set("billTo", { ...billTo, ...patch });
  const split = quoteGstSplit(t.gstPaise, settings?.sellerStateCode ?? "29", billTo.placeOfSupply, billTo.gstin);
  const half = gstRatePct / 2;
  // Terms: BMU's standard terms unless this quotation has its own. The text box keeps what is typed (blank lines too).
  const terms = v.terms.length ? v.terms : QUOTE_FIXED_TERMS;
  const termsChanged = quoteTermsChanges(terms).any;
  const [termsDraft, setTermsDraft] = useState<string>();
  const line = (i: number, patch: Partial<QuoteLine>) => set("lines", v.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const [bulletsDraft, setBulletsDraft] = useState<Record<number, string>>({});
  const [picking, setPicking] = useState(false);
  // A price-list pick takes the place of the empty starting line, if there is one.
  const addLine = (l: QuoteLine) => {
    const empty = (x: QuoteLine) => !x.title.trim() && !x.details.trim() && !x.unitPricePaise && !x.pct;
    const last = v.lines[v.lines.length - 1];
    set("lines", l.title && last && empty(last) ? [...v.lines.slice(0, -1), l] : [...v.lines, l]);
    setPicking(false);
  };
  const [writing, setWriting] = useState(false);
  const [aiNote, setAiNote] = useState<string>();
  // v49: the overview is written from the project and cost lines; the manager can change it.
  const writeOverview = async () => {
    setWriting(true);
    setAiNote(undefined);
    try {
      const r = await api.quotes.overview({ clientOrgId: clientOrgId || undefined, title: v.title, lines: v.lines.filter((l) => l.title.trim()).map((l) => ({ title: l.title, details: l.details })) });
      set("overview", r.text);
      if (!r.ai) setAiNote("AI is off, so this is plain wording. Edit it as you like.");
    } catch (e) {
      setAiNote((e as Error).message);
    } finally {
      setWriting(false);
    }
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
  return (
    <div className="grid gap-6" data-testid="quote-editor">
      <QuoteFormSection title="Details" testId="quote-section-details">
        {details}
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
        <div className="grid gap-1">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium">Project overview (about two lines on page 1)</span>
            <button type="button" className="text-xs underline disabled:opacity-40" disabled={writing} onClick={writeOverview} data-testid="quote-overview-ai">
              {writing ? "Writing…" : "Write with AI"}
            </button>
          </div>
          <textarea className={`${area} h-16`} value={v.overview ?? ""} onChange={(e) => set("overview", e.target.value)} placeholder="What BMU will do for this client. Type it, or use Write with AI." aria-label="Project overview" maxLength={QUOTE_OVERVIEW_MAX} />
          {aiNote && <span className="text-xs text-ink-muted">{aiNote}</span>}
        </div>
        <Fixed label="Lines under the project name" values={v.projectLines} max={3} onChange={(x) => set("projectLines", x)} placeholder="e.g. 6 micro-influencers" />
      </QuoteFormSection>

      {details && (
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

      <QuoteFormSection title="Items" hint="Check the rates and quantities. Prices are before GST." testId="quote-section-items">
        {v.lines.map((l, i) => (
          <div key={i} className="grid gap-2 border border-border p-3" data-testid="quote-line">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">Line {i + 1}</span>
              {v.lines.length > 1 && (
                <button type="button" className="text-xs text-ink-muted underline hover:text-red" onClick={() => set("lines", v.lines.filter((_, j) => j !== i))}>
                  Remove
                </button>
              )}
            </div>
            <Input value={l.title} onChange={(e) => line(i, { title: e.target.value })} placeholder="e.g. Influencer fees" aria-label={`Line ${i + 1} title`} maxLength={160} />
            <textarea className={`${area} h-16`} value={l.details} onChange={(e) => line(i, { details: e.target.value })} placeholder="What it covers" aria-label={`Line ${i + 1} details`} maxLength={600} />
            <div className="grid items-center gap-2 sm:grid-cols-[11rem_1fr_1fr_auto]">
              <Select value={l.kind} onChange={(e) => line(i, { kind: e.target.value as QuoteLine["kind"] })} aria-label={`Line ${i + 1} type`}>
                <option value="unit">Quantity × rate</option>
                <option value="percent">% of the fees</option>
              </Select>
              {l.kind === "percent" ? (
                <Input type="number" min={0} max={100} step={0.5} value={l.pct || ""} onChange={(e) => line(i, { pct: Number(e.target.value) || 0 })} placeholder="15" aria-label={`Line ${i + 1} percent`} />
              ) : (
                <Input type="number" min={0} step={1} value={l.qty || ""} onChange={(e) => line(i, { qty: Number(e.target.value) || 0 })} placeholder="Qty" aria-label={`Line ${i + 1} quantity`} />
              )}
              {l.kind === "percent" ? (
                <span className="text-xs text-ink-muted">of the quantity × rate lines</span>
              ) : (
                <Input inputMode="decimal" value={rupees(l.unitPricePaise)} onChange={(e) => line(i, { unitPricePaise: paise(e.target.value) })} placeholder="Rate (₹)" aria-label={`Line ${i + 1} rate in rupees`} />
              )}
              <span className="text-right text-sm font-medium tabular-nums">{formatINR(t.amounts[i] ?? 0)}</span>
            </div>
          </div>
        ))}
        {v.lines.length < 30 &&
          (picking ? (
            <PriceListPicker onPick={addLine} onBlank={() => addLine(blankLine())} onCancel={() => setPicking(false)} />
          ) : (
            <button type="button" className="justify-self-start text-sm underline" onClick={() => setPicking(true)} data-testid="quote-add-line">
              + Add a line
            </button>
          ))}
        <div className="ml-auto grid w-72 gap-1 text-sm">
          <span className="flex justify-between">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatINR(t.subtotalPaise)}</span>
          </span>
          {split.interState ? (
            <span className="flex justify-between">
              <span>IGST @ {gstRatePct}%</span>
              <span className="tabular-nums">{formatINR(split.igstPaise)}</span>
            </span>
          ) : (
            <>
              <span className="flex justify-between">
                <span>CGST @ {half}%</span>
                <span className="tabular-nums">{formatINR(split.cgstPaise)}</span>
              </span>
              <span className="flex justify-between">
                <span>SGST @ {half}%</span>
                <span className="tabular-nums">{formatINR(split.sgstPaise)}</span>
              </span>
            </>
          )}
          <span className="flex justify-between border-t border-border pt-1 font-semibold">
            <span>Grand total</span>
            <span className="tabular-nums" data-testid="quote-editor-total">
              {formatINR(t.totalPaise)}
            </span>
          </span>
        </div>
        <label className="flex items-center gap-2 text-sm">
          Advance to invoice first:
          <Input type="number" min={0} max={100} className="w-20" value={v.advancePct} onChange={(e) => set("advancePct", Math.max(0, Math.min(100, Number(e.target.value) || 0)))} aria-label="Advance percent" />% ({formatINR(Math.round((t.subtotalPaise * v.advancePct) / 100))} + GST)
        </label>
      </QuoteFormSection>

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

      {details && (
        <QuoteFormSection title="Signature and seal" hint="Printed at the bottom, with your name and title under the signature." testId="quote-section-signature">
          <label className="grid gap-1 text-xs font-medium">
            Signature
            <Select value={v.signWith ?? "mine"} onChange={(e) => set("signWith", e.target.value as QuoteContent["signWith"])} aria-label="Signature">
              <option value="mine">Sign with my signature</option>
              <option value="blank">Leave blank to sign by hand</option>
            </Select>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={v.seal !== false} onChange={(e) => set("seal", e.target.checked)} data-testid="quote-seal-toggle" />
            Add the company seal under the signature
          </label>
        </QuoteFormSection>
      )}

      <QuoteFormSection title={details ? "Notes and terms" : "Last page"} hint={details ? "Both are printed on the document the client sees." : undefined} testId="quote-section-notes">
        {details && (
          <label className="grid gap-1 text-xs font-medium">
            Notes
            <textarea className={`${area} h-20`} value={v.notes ?? ""} onChange={(e) => set("notes", e.target.value)} aria-label="Notes" maxLength={1000} />
          </label>
        )}
        {details ? (
          <label className="grid gap-1 text-xs font-medium">
            <span className="flex flex-wrap items-center justify-between gap-2">
              Terms
              <button type="button" className="font-normal underline disabled:opacity-40" disabled={!termsChanged} onClick={() => (setTermsDraft(undefined), set("terms", QUOTE_FIXED_TERMS))} data-testid="quote-terms-reset">
                Reset to BMU&apos;s standard terms
              </button>
            </span>
            <textarea
              className={`${area} h-48`}
              value={termsDraft ?? quoteTermsToText(terms)}
              onChange={(e) => {
                setTermsDraft(e.target.value);
                set("terms", quoteTermsFromText(e.target.value));
              }}
              aria-label="Terms"
              data-testid="quote-terms-input"
            />
            <span className={`font-normal ${termsChanged ? "text-[#9a6b00]" : "text-ink-muted"}`} data-testid="quote-terms-hint">
              One term per line (up to 12).{" "}
              {termsChanged ? "These differ from BMU's standard terms: the Admin is told when you send this quotation." : "These are BMU's standard terms."}
            </span>
          </label>
        ) : (
          <p className="text-sm text-ink-muted">The terms &amp; conditions and payment details are added to every quotation automatically.</p>
        )}
        <Input value={v.footerLine} onChange={(e) => set("footerLine", e.target.value)} placeholder="Thank-you line, e.g. Let's put your project in front of Bengaluru's home buyers." aria-label="Thank-you line" maxLength={160} />
      </QuoteFormSection>
    </div>
  );
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
