"use client";
// Business flow map: every stage of the agency as connected nodes (live WIP, value, days, stuck markers),
// connectors with throughput and conversion for the selected period, and a drawer listing each node's items.
import Link from "next/link";
import { useEffect, useState } from "react";
import { formatINR, type FlowEdge, type FlowItem, type FlowMap, type FlowNode } from "@bmu/shared";
import { CsvButton } from "@/components/charts";
import { Badge } from "@/components/ui";

const days = (n: number | null) => (n === null ? "—" : n < 1 ? "<1 day" : `${Math.round(n)} day${Math.round(n) === 1 ? "" : "s"}`);
const shortINR = (paise: number) => {
  const r = paise / 100;
  if (r >= 1_00_00_000) return `₹${(r / 1_00_00_000).toFixed(1)}Cr`;
  if (r >= 1_00_000) return `₹${(r / 1_00_000).toFixed(1)}L`;
  if (r >= 1000) return `₹${Math.round(r / 1000)}k`;
  return `₹${Math.round(r)}`;
};
const sevDot = { ok: "", amber: "bg-amber", red: "bg-red" } as const;
const sevText = { ok: "text-ink-muted", amber: "text-[#9a6b00]", red: "text-[#b4432c]" } as const;

function Node({ n, selected, onOpen, compact = false }: { n: FlowNode; selected: boolean; onOpen: () => void; compact?: boolean }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${n.label}: ${n.count} items${n.stuckCount ? `, ${n.stuckCount} stuck` : ""}. Open the list.`}
      className={`relative block w-full border bg-surface-raised text-left transition-colors hover:border-ink focus-visible:outline-2 focus-visible:outline-charcoal ${selected ? "border-charcoal" : "border-border"} ${compact ? "px-3 py-2.5" : "px-3.5 py-3"}`}
    >
      {n.severity !== "ok" && <span className={`absolute top-0 right-0 h-2.5 w-2.5 ${sevDot[n.severity]}`} aria-hidden />}
      <p className="text-[11px] tracking-wide text-ink-muted uppercase">{n.tag}</p>
      <p className="truncate text-sm font-medium">{n.label}</p>
      <div className={`flex items-baseline gap-2 ${compact ? "mt-1" : "mt-2"}`}>
        <span className={`${compact ? "text-xl" : "text-[26px]"} leading-none font-semibold tracking-tight tabular-nums`}>{n.count}</span>
        {n.valuePaise !== null && n.valuePaise > 0 && <span className="text-xs text-ink-muted tabular-nums">{shortINR(n.valuePaise)}</span>}
      </div>
      {!compact && <p className="mt-1.5 text-xs text-ink-muted">avg {days(n.avgDays)} here</p>}
      <p className={`mt-0.5 text-xs ${n.stuckCount ? sevText[n.severity] : "text-ink-muted"}`}>{n.stuckCount ? `${n.stuckCount} stuck` : compact ? `avg ${days(n.avgDays)}` : "None stuck"}</p>
    </button>
  );
}

/** Horizontal connector (desktop) or vertical connector (phone) with conversion and throughput. */
function Connector({ e, fork = false }: { e?: FlowEdge; fork?: boolean }) {
  if (!e) return null;
  const title = `${e.label}: ${e.throughput} in this period${e.conversionPct !== null ? `, ${e.conversionPct}% moved on` : ""}${e.prevConversionPct !== null ? ` (previous period ${e.prevConversionPct}%)` : ""}`;
  const pct = e.conversionPct !== null ? `${e.conversionPct}%` : "";
  const trend = e.conversionPct !== null && e.prevConversionPct !== null && e.conversionPct !== e.prevConversionPct ? (e.conversionPct > e.prevConversionPct ? "▲" : "▼") : "";
  return (
    <div title={title} className="shrink-0">
      {/* Phone: vertical */}
      <div className="flex items-center gap-3 py-1.5 pl-6 sm:hidden">
        <div className="relative h-8 w-px bg-ink/40">
          <span className="absolute -bottom-1 -left-[3px] h-0 w-0 border-x-[3.5px] border-t-[5px] border-x-transparent border-t-ink/60" />
        </div>
        <p className="text-xs text-ink-muted">
          {pct && <span className="mr-1 font-semibold text-ink">{pct}</span>}
          {trend && <span className={trend === "▲" ? "text-[#5f8a12]" : "text-[#b4432c]"}>{trend} </span>}
          {e.label.toLowerCase()} · {e.throughput} in period
        </p>
      </div>
      {/* Tablet and up: horizontal */}
      <div className={`hidden w-14 flex-col items-center justify-center sm:flex ${fork ? "h-full" : "h-full"}`}>
        <span className="text-xs font-semibold tabular-nums">
          {pct || " "}
          {trend && <span className={`ml-0.5 text-[9px] ${trend === "▲" ? "text-[#5f8a12]" : "text-[#b4432c]"}`}>{trend}</span>}
        </span>
        <div className="relative my-1 h-px w-full bg-ink/40">
          <span className="absolute -top-[3px] -right-px h-0 w-0 border-y-[3.5px] border-l-[5px] border-y-transparent border-l-ink/60" />
        </div>
        <span className="text-[11px] text-ink-muted tabular-nums">{e.throughput}</span>
      </div>
    </div>
  );
}

export function FlowDiagram({ map, selected, onSelect }: { map: FlowMap; selected: string | null; onSelect: (key: string) => void }) {
  const node = (k: string) => map.nodes.find((n) => n.key === k)!;
  const edgeTo = (k: string) => map.edges.find((e) => e.to === k);
  const main = ["leads", "proposals", "won", "g1", "g2", "g3", "g4", "g5"];
  return (
    <div className="flex flex-col sm:flex-row sm:flex-wrap sm:gap-y-5">
      {main.map((k) => (
        <div key={k} className="flex flex-col sm:flex-row sm:items-stretch">
          <Connector e={edgeTo(k)} />
          <div className="sm:w-36">
            <Node n={node(k)} selected={selected === k} onOpen={() => onSelect(k)} />
          </div>
        </div>
      ))}
      {/* After final delivery: retainer or offboarding */}
      <div className="flex flex-col gap-0 sm:gap-2">
        {["retainer", "offboarding"].map((k) => (
          <div key={k} className="flex flex-col sm:flex-row sm:items-stretch">
            <Connector e={edgeTo(k)} fork />
            <div className="sm:w-36">
              <Node n={node(k)} compact selected={selected === k} onOpen={() => onSelect(k)} />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const sevBadge = { ok: "neutral", amber: "amber", red: "red" } as const;
const day = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });

/** Side panel listing a node's items, most stuck first. */
export function FlowDrawer({ node, onClose }: { node: FlowNode; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const [filter, setFilter] = useState<"all" | "stuck">("all");
  const items = node.items.filter((i) => filter === "all" || i.severity !== "ok");
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={`${node.label} items`}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-charcoal/20" onClick={onClose} />
      <aside className="relative flex h-full w-full max-w-md flex-col border-l border-border bg-surface-raised shadow-xl">
        <header className="border-b border-border px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[11px] tracking-wide text-ink-muted uppercase">{node.tag}</p>
              <h2 className="text-lg font-semibold tracking-tight">{node.label}</h2>
              <p className="text-xs text-ink-muted">{node.hint}</p>
            </div>
            <button type="button" onClick={onClose} className="px-2 py-1 text-sm text-ink-muted hover:text-ink" aria-label="Close panel">
              ✕
            </button>
          </div>
          <dl className="mt-4 grid grid-cols-3 gap-px border border-border bg-border text-center">
            {[
              { k: "In this stage", v: node.count },
              { k: "Average time", v: days(node.avgDays) },
              { k: "Stuck", v: node.stuckCount },
            ].map((x) => (
              <div key={x.k} className="bg-surface-raised px-2 py-2">
                <dt className="text-[11px] text-ink-muted">{x.k}</dt>
                <dd className="text-sm font-semibold tabular-nums">{x.v}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-3 text-xs text-ink-muted">
            {node.periodCount} {node.periodLabel}
            {node.periodValuePaise ? ` (${formatINR(node.periodValuePaise)})` : ""}. Stuck means: {node.stuckRule.charAt(0).toLowerCase() + node.stuckRule.slice(1)}
          </p>
          <div className="mt-3 flex items-center justify-between gap-2">
            <div className="inline-flex border border-border text-xs">
              {(["all", "stuck"] as const).map((f) => (
                <button key={f} type="button" onClick={() => setFilter(f)} className={`px-2.5 py-1 ${filter === f ? "bg-charcoal text-ivory" : "text-ink-muted hover:text-ink"}`}>
                  {f === "all" ? `All (${node.count})` : `Stuck (${node.stuckCount})`}
                </button>
              ))}
            </div>
            <CsvButton
              rows={node.items}
              filename={`flow-${node.key}`}
              columns={[
                { header: "Item", value: (i: FlowItem) => i.title },
                { header: "Detail", value: (i) => i.subtitle },
                { header: "Days in stage", value: (i) => Math.round(i.days) },
                { header: "Value (₹)", value: (i) => (i.valuePaise === null ? "" : i.valuePaise / 100) },
                { header: "Deadline", value: (i) => (i.deadline ? i.deadline.slice(0, 10) : "") },
                { header: "Flag", value: (i) => i.reason ?? "" },
                { header: "Owner", value: (i) => i.owner ?? "" },
              ]}
            />
          </div>
        </header>
        <ul className="flex-1 divide-y divide-border overflow-y-auto">
          {items.map((i) => (
            <li key={i.id} className={`border-l-2 px-5 py-3 ${i.severity === "red" ? "border-l-red" : i.severity === "amber" ? "border-l-amber" : "border-l-transparent"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <Link href={i.href} className="font-medium hover:underline">
                    {i.title}
                  </Link>
                  <p className="truncate text-xs text-ink-muted">{i.subtitle}</p>
                </div>
                <Badge tone={sevBadge[i.severity]}>{days(i.days)}</Badge>
              </div>
              {i.reason && <p className={`mt-1 text-xs ${sevText[i.severity]}`}>{i.reason}</p>}
              <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-ink-muted">
                {i.valuePaise !== null && <span>{formatINR(i.valuePaise)}</span>}
                {i.deadline && <span>Deadline {day.format(new Date(i.deadline))}</span>}
                {i.owner && <span>{i.owner}</span>}
                {i.clientHref && (
                  <Link href={i.clientHref} className="underline hover:text-ink">
                    Client 360
                  </Link>
                )}
              </p>
            </li>
          ))}
          {items.length === 0 && <li className="px-5 py-10 text-center text-sm text-ink-muted">{filter === "stuck" ? "Nothing is stuck here." : "Nothing in this stage right now."}</li>}
        </ul>
      </aside>
    </div>
  );
}
