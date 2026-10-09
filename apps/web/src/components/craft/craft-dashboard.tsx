"use client";
// v10 craft: the specialist workspace shell. My Day essentials as a strip, personal KPIs vs the previous period,
// "what to do next", the specialty's own panels and a weekly workload chart.
import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { dashboardDefaultLayout, type CraftDashboard as Dash, type CraftStrip, type MyDayView } from "@bmu/shared";
import { DashGrid, type DashLayoutProps } from "@/components/dashboards/grid";
import { Heatmap, Insight, LineChart, PeriodPicker, usePeriod } from "@/components/charts";
import { Panel, StatRow, StatTile, Tabs } from "@/components/dash";
import { Button, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { ErrorLine, NextList, fmtDay, fmtKpi, fmtTime, kpiDelta, useAction } from "./craft-bits";
import { VideoPanels } from "./panels-video";
import { ScriptPanels } from "./panels-script";
import { SocialPanels } from "./panels-social";
import { DevPanels } from "./panels-dev";
import { UxPanels } from "./panels-ux";
import { GraphicPanels } from "./panels-graphic";

export function CraftDashboard({ userId, layout, wrap }: { userId?: string } & DashLayoutProps) {
  const { period, setPeriod } = usePeriod("30d");
  const [data, setData] = useState<Dash>();
  const [error, setError] = useState<string>();
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    api.craft
      .dashboard({ userId, from: period.from, to: period.to })
      .then((d) => live && (setData(d), setError(undefined)))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [userId, period.from, period.to, tick]);

  if (!data) return <LoadState loading={!error} error={error} />;
  const reload = () => setTick((t) => t + 1);
  const d = data;

  const sections: Record<string, ReactNode> = {
    strip: <Strip strip={d.strip} readOnly={d.readOnly} onChanged={reload} />,
    kpis: (
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <PeriodPicker value={period} onChange={setPeriod} />
          <p className="text-xs text-ink-muted">
            {fmtDay(d.period.from)} – {fmtDay(d.period.to)}, compared with {fmtDay(d.period.prevFrom)} – {fmtDay(d.period.prevTo)}
          </p>
        </div>
        {error && <ErrorLine error={error} />}
        <StatRow cols={5}>
          {d.kpis.map((k) => (
            <StatTile key={k.key} label={k.label} value={fmtKpi(k)} delta={kpiDelta(k)} hint={k.hint} href={k.href} />
          ))}
        </StatRow>
      </div>
    ),
    next: (
      <Panel className="h-full" title="What to do next" subtitle="Overdue first, then today, client feedback and anything blocked." flush>
        <div className="px-5">
          <NextList items={d.next} />
        </div>
      </Panel>
    ),
    insights: (
      <Panel className="h-full" title="What the numbers say" subtitle="Plain-English notes from your own work.">
        {d.insights.length ? (
          <div className="-mt-4">
            {d.insights.map((t) => (
              <Insight key={t} tone={/waiting|missing|late|failed|over|blocked|only/i.test(t) ? "warn" : /strong|up from|in a row/i.test(t) ? "good" : "default"}>
                {t}
              </Insight>
            ))}
          </div>
        ) : (
          <p className="text-sm text-ink-muted">Not enough history yet. Insights appear once you finish a few tasks.</p>
        )}
      </Panel>
    ),
    panels: d.specialty ? (
      <div className="grid gap-6 [&>*]:min-w-0">
        {d.specialty === "video_editor" && <VideoPanels p={d.panels} readOnly={d.readOnly} />}
        {d.specialty === "script_writer" && <ScriptPanels p={d.panels} readOnly={d.readOnly} onChanged={reload} />}
        {d.specialty === "social_media_manager" && <SocialPanels p={d.panels} readOnly={d.readOnly} onChanged={reload} />}
        {d.specialty === "developer" && <DevPanels p={d.panels} readOnly={d.readOnly} onChanged={reload} />}
        {d.specialty === "ux_ui_designer" && <UxPanels p={d.panels} readOnly={d.readOnly} />}
        {d.specialty === "graphic_designer" && <GraphicPanels p={d.panels} readOnly={d.readOnly} onChanged={reload} />}
      </div>
    ) : null,
    workload: <Workload d={d} />,
  };

  return (
    <div className="grid gap-6 [&>*]:min-w-0" data-craft={d.specialty ?? "none"}>
      {d.readOnly && (
        <p className="border border-border bg-canvas/60 px-4 py-2.5 text-sm">
          You are viewing <strong>{d.person.name}</strong>&apos;s {d.person.specialtyLabel.toLowerCase() || "team"} dashboard (read-only). Actions are hidden.{" "}
          <Link href="/team/specialists" className="underline">
            Back to specialists
          </Link>
        </p>
      )}
      <DashGrid host="specialist" items={layout ?? dashboardDefaultLayout("specialist")} sections={sections} wrap={wrap} />
    </div>
  );
}

function Workload({ d }: { d: Dash }) {
  const [view, setView] = useState<"hours" | "tasks" | "heat">("hours");
  const w = d.workload;
  const past = w.weeks.length - w.future;
  const hours = w.hours.filter((x): x is number => x !== null);
  const last4 = hours.slice(-4);
  const prev4 = hours.slice(-8, -4);
  const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10 : 0);
  const busiestRow = w.heat.values.map((r) => r.reduce<number>((s, x) => s + (x ?? 0), 0));
  const busiestDay = w.heat.rows[busiestRow.indexOf(Math.max(...busiestRow))];
  const nextDue = w.due.slice(past).reduce((s, x) => s + x, 0);
  return (
    <Panel
      title="Weekly workload"
      subtitle="Hours on finished tasks and tasks finished per week; shaded weeks are planned work still to come."
      action={<Tabs value={view} onChange={setView} options={[{ value: "hours", label: "Hours" }, { value: "tasks", label: "Tasks" }, { value: "heat", label: "By day" }]} />}
    >
      {view === "heat" ? (
        <Heatmap rows={w.heat.rows} cols={w.heat.cols} values={w.heat.values} cellTitle={(r, c, v) => `${w.heat.rows[r]}, week of ${w.heat.cols[c]}: ${v ?? 0} finished`} />
      ) : (
        <LineChart
          labels={w.weeks}
          splitAt={past}
          series={
            view === "hours"
              ? [{ key: "hours", label: "Hours logged", values: w.hours, area: true }]
              : [
                  { key: "done", label: "Tasks finished", values: w.done, area: true },
                  { key: "due", label: "Tasks due", values: w.due, color: "grey", dashed: true },
                ]
          }
          format={(n) => (view === "hours" ? `${Math.round(n * 10) / 10}h` : String(Math.round(n)))}
        />
      )}
      <Insight>
        {view === "heat"
          ? `${busiestDay} is when you finish the most work. ${nextDue ? `${nextDue} task${nextDue === 1 ? " is" : "s are"} due in the next two weeks.` : ""}`
          : `You averaged ${avg(last4)}h a week over the last four weeks${prev4.length ? ` (${avg(prev4)}h the four before)` : ""}. ${nextDue ? `${nextDue} task${nextDue === 1 ? " is" : "s are"} due in the next two weeks.` : "Nothing is scheduled for the next two weeks yet."}`}
      </Insight>
    </Panel>
  );
}

/** My Day essentials: check-in/out, overdue / today counts and the end-of-day report. */
export function Strip({ strip, readOnly, onChanged }: { strip: CraftStrip; readOnly: boolean; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const [eodOpen, setEodOpen] = useState(false);
  return (
    <div>
      <div className="grid gap-px border border-border bg-border sm:grid-cols-[1.3fr_repeat(4,1fr)]">
        <div className="flex flex-wrap items-center justify-between gap-3 bg-surface-raised px-5 py-4">
          <div>
            <p className="text-[13px] text-ink-muted">Attendance</p>
            <p className="mt-1 text-sm font-medium">
              {!strip.checkIn ? "Not checked in yet" : strip.checkOut ? `Out at ${fmtTime(strip.checkOut)}` : `In since ${fmtTime(strip.checkIn)}`}
            </p>
          </div>
          {!readOnly &&
            (!strip.checkIn ? (
              <Button className="px-3 py-1.5 text-xs" disabled={!!busy} onClick={() => run("in", () => api.myDay.checkIn()).then((r) => r && onChanged())}>
                Check in
              </Button>
            ) : !strip.checkOut ? (
              <Button variant="secondary" className="px-3 py-1.5 text-xs" disabled={!!busy} onClick={() => run("out", () => api.myDay.checkOut()).then((r) => r && onChanged())}>
                Check out
              </Button>
            ) : null)}
        </div>
        <StripStat label="Overdue" value={strip.overdue} tone={strip.overdue ? "bad" : undefined} />
        <StripStat label="Due today" value={strip.dueToday} tone={strip.dueToday ? "warn" : undefined} />
        <StripStat label="Blocked" value={strip.blocked} tone={strip.blocked ? "bad" : undefined} />
        <div className="flex flex-col justify-center bg-surface-raised px-5 py-4">
          <p className="text-[13px] text-ink-muted">End-of-day report</p>
          {strip.eodSubmitted ? (
            <p className="mt-1 text-sm text-[#5f8a12]">Sent ✓</p>
          ) : readOnly ? (
            <p className="mt-1 text-sm">Not sent yet</p>
          ) : (
            <button className="mt-1 text-left text-sm underline underline-offset-2" onClick={() => setEodOpen((v) => !v)}>
              {eodOpen ? "Close" : "Write it now"}
            </button>
          )}
        </div>
      </div>
      <ErrorLine error={error} />
      {eodOpen && !readOnly && (
        <EodQuick
          onDone={() => {
            setEodOpen(false);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

function StripStat({ label, value, tone }: { label: string; value: number; tone?: "bad" | "warn" }) {
  const cls = tone === "bad" ? "text-[#b4432c]" : tone === "warn" ? "text-[#9a6b00]" : "text-ink";
  return (
    <Link href="/team/tasks" className="flex flex-col justify-center bg-surface-raised px-5 py-4 hover:bg-canvas/50">
      <p className="text-[13px] text-ink-muted">{label}</p>
      <p className={`mt-1 text-2xl leading-none font-semibold tabular-nums ${cls}`}>{value}</p>
    </Link>
  );
}

const lines = (v: string) => v.split("\n").map((l) => l.trim()).filter(Boolean);

/** Compact end-of-day report, pre-filled from today's tasks (same report as My Day). */
function EodQuick({ onDone }: { onDone: () => void }) {
  const [day, setDay] = useState<MyDayView>();
  const [v, setV] = useState<Record<"completed" | "pending" | "blocked" | "waiting", string>>();
  const { busy, error, run } = useAction();
  useEffect(() => {
    api.myDay.get().then((d) => {
      setDay(d);
      setV({ completed: d.eod.completed.join("\n"), pending: d.eod.pending.join("\n"), blocked: d.eod.blocked.join("\n"), waiting: d.eod.waiting.join("\n") });
    });
  }, []);
  if (!day || !v) return <p className="mt-3 text-sm text-ink-muted">Loading your day…</p>;
  const field = (k: keyof typeof v, label: string) => (
    <label className="block text-sm">
      <span className="text-[11px] uppercase tracking-[0.1em] text-ink-muted">{label}</span>
      <textarea className="mt-1 w-full border border-border bg-surface-raised px-3 py-2 text-sm" rows={3} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} placeholder="One item per line" />
    </label>
  );
  return (
    <div className="mt-3 border border-border bg-surface-raised p-4" data-eod>
      <div className="grid gap-3 md:grid-cols-4">
        {field("completed", "Completed")}
        {field("pending", "Pending")}
        {field("blocked", "Blocked")}
        {field("waiting", "Waiting")}
      </div>
      <Button
        className="mt-3"
        disabled={!!busy}
        onClick={() => run("eod", () => api.myDay.submitEod({ completed: lines(v.completed), pending: lines(v.pending), blocked: lines(v.blocked), waiting: lines(v.waiting) })).then((r) => r && onDone())}
      >
        {busy ? "Sending…" : "Submit report"}
      </Button>
      <ErrorLine error={error} />
    </div>
  );
}
