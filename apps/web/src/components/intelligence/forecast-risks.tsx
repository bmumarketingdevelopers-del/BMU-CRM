"use client";

// v20 "Forecast & risks": revenue forecast with its range, churn risk, likely wins, tasks likely to slip and
// capacity gaps, each with the reasons behind it. Used on the founder dashboard and the Intelligence page.
import { useState } from "react";
import Link from "next/link";
import {
  formatMetric,
  goalStatusLabels,
  type ForecastView,
  type IntelligenceOverview,
} from "@bmu/shared";
import { LineChart } from "@/components/charts";
import { Empty, Grid, Meter, Panel } from "@/components/dash";
import { Badge, LoadState } from "@/components/ui";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/use-load";

const rs = (p: number) => formatMetric(p, "paise");
const when = new Intl.DateTimeFormat("en-IN", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "Asia/Kolkata",
});

export function Reasons({
  reasons,
  max = 3,
}: {
  reasons: ForecastView["reasons"];
  max?: number;
}) {
  if (!reasons.length) return null;
  return (
    <ul className="mt-1 grid gap-0.5 text-xs text-ink-muted">
      {reasons.slice(0, max).map((r) => (
        <li key={r.label}>
          {r.impact > 0 ? "▲" : r.impact < 0 ? "▼" : "·"} {r.label}
          {r.detail ? <span className="opacity-80"> ({r.detail})</span> : null}
        </li>
      ))}
    </ul>
  );
}

function RiskList({
  items,
  empty,
  right,
}: {
  items: ForecastView[];
  empty: string;
  right: (f: ForecastView) => React.ReactNode;
}) {
  if (!items.length) return <Empty>{empty}</Empty>;
  return (
    <ul className="divide-y divide-border">
      {items.map((f) => (
        <li
          key={f.subjectId}
          className="flex items-start justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
        >
          <div className="min-w-0">
            {f.href ? (
              <Link href={f.href} className="font-medium hover:underline">
                {f.title}
              </Link>
            ) : (
              <span className="font-medium">{f.title}</span>
            )}
            <Reasons reasons={f.reasons} />
          </div>
          <div className="shrink-0 text-right text-sm">{right(f)}</div>
        </li>
      ))}
    </ul>
  );
}

const riskTone = (s: number | null) =>
  (s ?? 0) >= 60 ? "red" : (s ?? 0) >= 35 ? "amber" : "neutral";

export function ForecastRisksView({
  o,
  compact = false,
  onRefresh,
}: {
  o: IntelligenceOverview;
  compact?: boolean;
  onRefresh?: () => void;
}) {
  const n = compact ? 5 : 10;
  return (
    <div className="grid gap-6">
      {o.revenue && (
        <Panel
          title="Revenue forecast"
          subtitle={`Next month about ${rs(o.revenue.nextMonthPaise)}${o.revenue.targetPaise ? ` against a target of ${rs(o.revenue.targetPaise)}` : ""}. The shaded band is the likely range.`}
        >
          <LineChart
            labels={o.revenue.months.map((m) => m.label)}
            series={[
              {
                key: "expected",
                label: "Expected",
                values: o.revenue.months.map((m) => m.expectedPaise),
                color: "dark",
              },
              {
                key: "trend",
                label: "Trend",
                values: o.revenue.months.map((m) => m.trendPaise),
                color: "grey",
                dashed: true,
              },
            ]}
            band={{
              low: o.revenue.months.map((m) => m.lowPaise),
              high: o.revenue.months.map((m) => m.highPaise),
              label: "Likely range",
            }}
            target={
              o.revenue.targetPaise
                ? { value: o.revenue.targetPaise, label: "Target" }
                : undefined
            }
            format={rs}
            height={compact ? 160 : 220}
          />
          <p className="mt-3 text-xs font-semibold uppercase tracking-[0.12em] text-ink-muted">
            Why
          </p>
          <Reasons reasons={o.revenue.reasons} max={6} />
        </Panel>
      )}
      <Grid>
        <Panel
          title="Clients at risk of leaving"
          subtitle="Churn risk from activity, missed deadlines, overdue invoices, feedback and renewal date."
        >
          <RiskList
            items={o.churn.slice(0, n)}
            empty="No client shows a real risk right now."
            right={(f) => (
              <>
                <Badge tone={riskTone(f.score)}>{f.score}% risk</Badge>
                {f.value > 0 && (
                  <span className="mt-1 block text-xs text-ink-muted">
                    {rs(f.value)}/mo at risk
                  </span>
                )}
              </>
            )}
          />
        </Panel>
        <Panel
          title="Deals most likely to close"
          subtitle="Win chance from stage, how recently they engaged, proposal views and similar past deals."
        >
          <RiskList
            items={o.win.slice(0, n)}
            empty="No open deals."
            right={(f) => (
              <>
                <Badge tone={(f.score ?? 0) >= 60 ? "green" : "neutral"}>
                  {f.score}% win
                </Badge>
                {f.value > 0 && (
                  <span className="mt-1 block text-xs text-ink-muted">
                    {rs(f.value)} weighted
                  </span>
                )}
              </>
            )}
          />
        </Panel>
        <Panel
          title="Work likely to slip"
          subtitle="Open tasks unlikely to meet their deadline, from time left, the owner's load and past speed."
        >
          <RiskList
            items={o.slip.slice(0, n)}
            empty="Nothing looks likely to slip."
            right={(f) => (
              <Badge tone={riskTone(f.score)}>{f.score}% slip</Badge>
            )}
          />
        </Panel>
        <Panel
          title="Capacity next 4 weeks"
          subtitle="Hours of work booked against hours available, by skill."
        >
          {o.capacity.length ? (
            <ul className="grid gap-3">
              {o.capacity.slice(0, compact ? 6 : 12).map((c) => (
                <li key={c.subjectId}>
                  <div>
                    <p className="mb-1 text-sm">{`${c.title}${c.value > 0 ? ` · ${Math.round(c.value)}h short` : ""}`}</p>
                    <Meter
                      value={Math.min(c.score ?? 0, 150)}
                      label={`${c.title}${c.value > 0 ? ` · ${Math.round(c.value)}h short` : ""}`}
                      tone={
                        (c.score ?? 0) > 100
                          ? "bad"
                          : (c.score ?? 0) > 85
                            ? "warn"
                            : "good"
                      }
                    />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <Empty>No booked work to compare yet.</Empty>
          )}
        </Panel>
      </Grid>
      {!compact && (o.alerts.length > 0 || o.goals.length > 0) && (
        <Grid>
          <Panel title="Recent alerts">
            {o.alerts.length ? (
              <ul className="divide-y divide-border text-sm">
                {o.alerts.map((a) => (
                  <li key={a.id} className="py-2 first:pt-0">
                    {a.message}
                    <span className="block text-xs text-ink-muted">
                      {when.format(new Date(a.createdAt))}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No alerts fired.</Empty>
            )}
          </Panel>
          <Panel title="Company goals">
            {o.goals.length ? (
              <ul className="grid gap-3">
                {o.goals.map((g) => (
                  <li key={g.id}>
                    <div>
                      <p className="mb-1 text-sm">{`${g.title} · ${g.display.current} of ${g.display.target} · ${goalStatusLabels[g.status]}`}</p>
                      <Meter
                        value={g.progress}
                        label={`${g.title} · ${g.display.current} of ${g.display.target} · ${goalStatusLabels[g.status]}`}
                        tone={
                          g.status === "behind" || g.status === "missed"
                            ? "bad"
                            : g.status === "at_risk"
                              ? "warn"
                              : "good"
                        }
                      />
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty>No company goals yet.</Empty>
            )}
          </Panel>
        </Grid>
      )}
      <p className="text-xs text-ink-muted">
        {o.computedAt
          ? `Worked out ${when.format(new Date(o.computedAt))}`
          : "Not worked out yet"}{" "}
        · {o.source === "python" ? "forecasting service" : "built-in model"}
        {!o.pythonAvailable &&
          " (the optional Python forecasting service is not running; the built-in model is used)"}
        {onRefresh && (
          <>
            {" · "}
            <button className="underline" onClick={onRefresh}>
              Recalculate now
            </button>
          </>
        )}
      </p>
    </div>
  );
}

/** Loads and shows the overview (founder dashboard section). */
export function ForecastRisks({ compact = false }: { compact?: boolean }) {
  const o = useLoad(() => api.intelligence.overview(), { live: false });
  const [busy, setBusy] = useState(false);
  if (!o.data) return <LoadState loading={o.loading} error={o.error} />;
  return (
    <div className={busy ? "opacity-60" : ""}>
      <ForecastRisksView
        o={o.data}
        compact={compact}
        onRefresh={() => {
          setBusy(true);
          void api.intelligence
            .refresh()
            .then(o.reload)
            .finally(() => setBusy(false));
        }}
      />
    </div>
  );
}
