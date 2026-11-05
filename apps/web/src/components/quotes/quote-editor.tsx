"use client";

// v45: the quotation editor, used for a quotation (client, prepared-for lines, valid until, template) and for a
// template (name, service). Everything else is the document: project, highlights, cost lines (quantity × rate or a
// percentage of the fees) and the advance % invoiced when the client accepts. v46: scope and timeline are optional;
// the terms are fixed, so they are not edited here (the server adds them to every quotation).
import { useRef, useState } from "react";
import { formatINR, quoteTotals, type QuoteContent, type QuoteLine } from "@bmu/shared";
import { Button, Input, Select } from "@/components/ui";

const h = "text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted";
const area = "w-full border border-border bg-surface px-3 py-2 text-sm";
const rupees = (p: number) => (p ? String(p / 100) : "");
const paise = (v: string) => Math.round((Number(v.replace(/[^\d.]/g, "")) || 0) * 100);

export const emptyContent = (): QuoteContent => ({
  title: "",
  projectLines: [],
  stats: [],
  lines: [{ title: "", details: "", kind: "unit", qty: 1, unitPricePaise: 0, pct: 0 }],
  scope: [],
  timeline: [],
  terms: [],
  advancePct: 50,
  footerLine: "",
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

export function QuoteEditor({
  value,
  onChange,
  gstRatePct = 18,
}: {
  value: QuoteContent;
  onChange: (v: QuoteContent) => void;
  gstRatePct?: number;
}) {
  const v = value;
  const set = <K extends keyof QuoteContent>(k: K, x: QuoteContent[K]) => onChange({ ...v, [k]: x });
  const t = quoteTotals(v.lines, gstRatePct);
  const line = (i: number, patch: Partial<QuoteLine>) => set("lines", v.lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const [bulletsDraft, setBulletsDraft] = useState<Record<number, string>>({});
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
      <section className="grid gap-3">
        <p className={h}>Project</p>
        <Input value={v.title} onChange={(e) => set("title", e.target.value)} placeholder="Project name, e.g. Bengaluru Influencer Campaign" aria-label="Project name" maxLength={160} />
        <Fixed label="Lines under the project name" values={v.projectLines} max={3} onChange={(x) => set("projectLines", x)} placeholder="e.g. 6 micro-influencers" />
        <div className="grid gap-1">
          <span className="text-xs font-medium">Highlights beside the total (up to 3)</span>
          {[0, 1, 2].map((i) => {
            const s = v.stats[i] ?? { value: "", label: "" };
            const put = (patch: Partial<typeof s>) => {
              const next = [...v.stats];
              next[i] = { ...s, ...patch };
              set("stats", next.filter((x) => x && (x.value || x.label)));
            };
            return (
              <div key={i} className="grid grid-cols-[8rem_1fr] gap-2">
                <Input value={s.value} onChange={(e) => put({ value: e.target.value })} placeholder={i === 0 ? "6" : ""} aria-label={`Highlight ${i + 1} value`} maxLength={24} />
                <Input value={s.label} onChange={(e) => put({ label: e.target.value })} placeholder={i === 0 ? "Influencers" : ""} aria-label={`Highlight ${i + 1} label`} maxLength={40} />
              </div>
            );
          })}
        </div>
      </section>

      <section className="grid gap-3">
        <p className={h}>Cost breakdown</p>
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
        {v.lines.length < 30 && (
          <button type="button" className="justify-self-start text-sm underline" onClick={() => set("lines", [...v.lines, { title: "", details: "", kind: "unit", qty: 1, unitPricePaise: 0, pct: 0 }])} data-testid="quote-add-line">
            + Add a line
          </button>
        )}
        <div className="ml-auto grid w-72 gap-1 text-sm">
          <span className="flex justify-between">
            <span>Subtotal</span>
            <span className="tabular-nums">{formatINR(t.subtotalPaise)}</span>
          </span>
          <span className="flex justify-between">
            <span>GST @ {gstRatePct}%</span>
            <span className="tabular-nums">{formatINR(t.gstPaise)}</span>
          </span>
          <span className="flex justify-between border-t border-border pt-1 font-semibold">
            <span>Grand total</span>
            <span className="tabular-nums" data-testid="quote-editor-total">
              {formatINR(t.totalPaise)}
            </span>
          </span>
        </div>
        <label className="flex items-center gap-2 text-sm">
          Advance invoiced when the client accepts:
          <Input type="number" min={0} max={100} className="w-20" value={v.advancePct} onChange={(e) => set("advancePct", Math.max(0, Math.min(100, Number(e.target.value) || 0)))} aria-label="Advance percent" />% ({formatINR(Math.round((t.subtotalPaise * v.advancePct) / 100))} + GST)
        </label>
        {v.advancePct !== 50 && <p className="text-xs text-[#9a6b00]">The fixed terms on the quotation say 50% advance.</p>}
      </section>

      <section className="grid gap-3">
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
      </section>

      <section className="grid gap-3">
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
      </section>

      <section className="grid gap-3">
        <p className={h}>Last page</p>
        <p className="text-sm text-ink-muted">The terms &amp; conditions, payment details and signature lines are added to every quotation automatically.</p>
        <Input value={v.footerLine} onChange={(e) => set("footerLine", e.target.value)} placeholder="Thank-you line, e.g. Let's put your project in front of Bengaluru's home buyers." aria-label="Thank-you line" maxLength={160} />
      </section>
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
