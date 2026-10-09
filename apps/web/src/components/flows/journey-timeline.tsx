"use client";
// Journey timeline for one engagement: every step from proposal to final files, gate milestones as larger
// nodes, the current step in green, future steps grey with expected dates, late steps amber.
import { useEffect, useState } from "react";
import type { FlowJourney, FlowJourneyEvent, FlowJourneyOption } from "@bmu/shared";
import { Badge, LoadState, Select } from "@/components/ui";
import { api } from "@/lib/api";

const fmt = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
const fmtYear = new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" });
const d = (iso: string) => {
  const date = new Date(iso);
  return date.getFullYear() === new Date().getFullYear() ? fmt.format(date) : fmtYear.format(date);
};
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** "1 day early", "on time", "2 days late", or for open steps "3 days overdue". */
export function timingText(e: FlowJourneyEvent) {
  if (!e.timing) return null;
  if (e.timing === "on_time") return "on time";
  const n = Math.abs(e.varianceDays ?? 0);
  if (e.timing === "early") return `${plural(n, "day")} early`;
  return e.at ? `${plural(n, "day")} late` : `${plural(n, "day")} overdue`;
}

function gateLine(e: FlowJourneyEvent, friendly: boolean) {
  const n = Number(e.gate?.slice(1));
  const name = friendly ? `Milestone ${n}: ${e.title}` : `${e.gate} · ${e.title}`;
  const t = timingText(e);
  if (e.at) return `${name}${friendly ? ` on ${d(e.at)}` : ""}${t ? `, ${t}` : ""}`;
  if (e.state === "current") return `${name}${t ? ` (${t})` : ""}`;
  return name;
}

export function JourneyTimeline({ journey, friendly = false }: { journey: FlowJourney; friendly?: boolean }) {
  const [all, setAll] = useState(true);
  const events = all ? journey.events : journey.events.filter((e) => e.gate);
  return (
    <div>
      {/* Gate durations */}
      <ol className="grid grid-cols-2 gap-px border border-border bg-border sm:grid-cols-5">
        {journey.gates.map((g, i) => {
          const ev = journey.events.find((e) => e.gate === g.gate);
          const current = ev?.state === "current";
          const late = ev?.timing === "late";
          return (
            <li key={g.gate} className={`bg-surface-raised px-3 py-2.5 ${i === 4 ? "col-span-2 sm:col-span-1" : ""}`}>
              <p className="text-[11px] tracking-wide text-ink-muted uppercase">{friendly ? `Milestone ${i + 1}` : g.gate}</p>
              <p className="truncate text-sm font-medium">{g.name}</p>
              <p className={`mt-0.5 text-xs ${g.passedAt ? (late ? "text-[#9a6b00]" : "text-ink") : current ? (late ? "text-[#9a6b00]" : "text-[#5f8a12]") : "text-ink-muted"}`}>
                {g.passedAt ? d(g.passedAt) : current ? (g.plannedAt ? `Due ${d(g.plannedAt)}` : "In progress") : g.plannedAt ? `Expected ${d(g.plannedAt)}` : "Not started"}
              </p>
              <p className="text-[11px] text-ink-muted">{g.daysFromPrevious !== null ? `${plural(g.daysFromPrevious, "day")} after ${i === 0 ? "start" : journey.gates[i - 1].gate}` : " "}</p>
            </li>
          );
        })}
      </ol>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm">{journey.summary}</p>
        <div className="inline-flex border border-border text-xs">
          {[
            { v: true, l: "Every step" },
            { v: false, l: "Milestones only" },
          ].map((o) => (
            <button key={o.l} type="button" onClick={() => setAll(o.v)} className={`px-2.5 py-1 ${all === o.v ? "bg-charcoal text-ivory" : "text-ink-muted hover:text-ink"}`}>
              {o.l}
            </button>
          ))}
        </div>
      </div>

      <ol className="relative mt-5">
        {events.map((e, i) => {
          const last = i === events.length - 1;
          const isGate = !!e.gate;
          const late = e.timing === "late";
          const marker = isGate
            ? e.state === "current"
              ? late
                ? "bg-amber text-charcoal"
                : "bg-green text-charcoal"
              : e.state === "upcoming"
                ? "border border-border bg-surface-raised text-ink-muted"
                : late
                  ? "bg-amber text-charcoal"
                  : "bg-charcoal text-ivory"
            : e.internal
              ? "border border-ink-muted bg-surface-raised"
              : "bg-ink-muted";
          return (
            <li key={e.id} className="relative flex gap-4 pb-4">
              {!last && <span className={`absolute top-6 bottom-0 left-[13px] w-px ${e.state === "done" && events[i + 1]?.state === "done" ? "bg-ink/30" : "border-l border-dashed border-border bg-transparent"}`} aria-hidden />}
              <span className="flex w-7 shrink-0 justify-center pt-0.5">
                {isGate ? (
                  <span className={`relative z-10 flex h-7 w-7 items-center justify-center text-xs font-semibold ${marker}`}>{e.gate!.slice(1)}</span>
                ) : (
                  <span className={`relative z-10 mt-1.5 h-2 w-2 ${marker}`} />
                )}
              </span>
              <div className={`min-w-0 flex-1 ${isGate ? "pt-0.5" : ""}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <p className={`${isGate ? "font-semibold" : "text-sm"} ${e.state === "upcoming" ? "text-ink-muted" : ""}`}>
                    {isGate ? gateLine(e, friendly) : e.title}
                    {e.internal && (
                      <span className="ml-2 align-middle">
                        <Badge>Internal</Badge>
                      </span>
                    )}
                  </p>
                  <p className={`shrink-0 text-xs tabular-nums ${late ? "text-[#9a6b00]" : "text-ink-muted"}`}>
                    {e.at ? d(e.at) : e.plannedAt ? `${e.state === "current" ? "Due" : "Expected"} ${d(e.plannedAt)}` : e.state === "current" ? "In progress" : "Date to be set"}
                  </p>
                </div>
                {e.detail && <p className="mt-0.5 text-xs text-ink-muted">{e.detail}</p>}
                {isGate && e.at && e.plannedAt && !friendly && <p className="text-[11px] text-ink-muted">Planned {d(e.plannedAt)}</p>}
                {e.state === "current" && <p className={`mt-1 text-xs font-medium ${late ? "text-[#9a6b00]" : "text-[#5f8a12]"}`}>{late ? "Behind plan" : "In progress now"}</p>}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/** Engagement switcher plus timeline. Staff pass a clientId; client users see their own engagements. */
export function JourneyPanel({ clientId, friendly = false }: { clientId?: string; friendly?: boolean }) {
  const [options, setOptions] = useState<FlowJourneyOption[]>();
  const [selected, setSelected] = useState<string>();
  const [journey, setJourney] = useState<FlowJourney>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let live = true;
    api.flows
      .journeys(clientId)
      .then((rows) => {
        if (!live) return;
        setOptions(rows);
        // Default to the live service furthest along its milestones.
        const open = rows.filter((r) => !["delivered", "closed"].includes(r.status)).sort((a, b) => b.currentGate.localeCompare(a.currentGate) || (b.status === "in_review" ? 1 : 0) - (a.status === "in_review" ? 1 : 0));
        const firstLive = open[0] ?? rows[0];
        setSelected(firstLive?.id);
      })
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [clientId]);

  useEffect(() => {
    if (!selected) return;
    let live = true;
    api.flows
      .journey(selected)
      .then((j) => live && (setJourney(j), setError(undefined)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [selected]);

  if (!options) return <LoadState loading={!error} error={error} />;
  if (!options.length) return <p className="py-6 text-center text-sm text-ink-muted">{friendly ? "Your project journey appears here once your first service starts." : "No services yet."}</p>;
  return (
    <div>
      {options.length > 1 && (
        <label className="mb-5 flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-muted">{friendly ? "Service" : "Engagement"}</span>
          <Select value={selected} onChange={(e) => (setJourney(undefined), setSelected(e.target.value))} className="min-w-0 max-w-full">
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {friendly ? `${o.serviceName} · ${["delivered", "closed"].includes(o.status) ? "delivered" : `milestone ${o.currentGate.slice(1)} of 5`}` : `${o.serviceName} · ${o.currentGate} · ${o.status.replaceAll("_", " ")}`}
              </option>
            ))}
          </Select>
        </label>
      )}
      {error && <LoadState loading={false} error={error} />}
      {!error && !journey && <LoadState loading />}
      {journey && journey.engagement.id === selected && <JourneyTimeline journey={journey} friendly={friendly} />}
    </div>
  );
}
