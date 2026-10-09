import { describe, expect, it } from "vitest";
import { alertFires, churnRisk, fieldModeFor, goalProgress, goalStatus, holtForecast, linearTrend, METRICS, nextReportRun, slipRisk, winProbability } from "./index.js";

describe("metric layer", () => {
  it("defines every metric once with a formula", () => {
    const keys = METRICS.map((m) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(METRICS.every((m) => m.formula.length > 10)).toBe(true);
  });

  it("alerts compare windows and ignore tiny baselines", () => {
    expect(alertFires("drop_pct", 40, 5, 10)).toBe(true);
    expect(alertFires("drop_pct", 40, 7, 10)).toBe(false);
    expect(alertFires("drop_pct", 40, 0, 2)).toBe(false);
    expect(alertFires("rise_pct", 100, 8, 4)).toBe(true);
    expect(alertFires("above", 20, 21, null)).toBe(true);
    expect(alertFires("below", 20, null, null)).toBe(false);
  });

  it("goal progress works both ways and compares with time gone", () => {
    expect(goalProgress({ startValue: 0, target: 20 }, 10)).toBe(50);
    expect(goalProgress({ startValue: 30, target: 10 }, 20)).toBe(50);
    expect(goalProgress({ startValue: 0, target: 20 }, 40)).toBe(100);
    const now = new Date("2026-06-16T06:30:00Z");
    expect(goalStatus(50, "2026-06-01", "2026-06-30", now)).toBe("on_track");
    expect(goalStatus(30, "2026-06-01", "2026-06-30", now)).toBe("at_risk");
    expect(goalStatus(5, "2026-06-01", "2026-06-30", now)).toBe("behind");
    expect(goalStatus(100, "2026-06-01", "2026-06-30", now)).toBe("done");
    expect(goalStatus(80, "2026-05-01", "2026-05-30", now)).toBe("missed");
  });

  it("next report run is in IST", () => {
    // Monday 5 Oct 2026, 10:00 IST → next Monday 09:00 IST.
    const n = nextReportRun({ cadence: "weekly", dayOfWeek: 1, hourIst: 9 }, new Date("2026-10-05T04:30:00Z"));
    expect(n.toISOString()).toBe("2026-10-12T03:30:00.000Z");
    expect(nextReportRun({ cadence: "daily", hourIst: 9 }, new Date("2026-10-05T02:00:00Z")).toISOString()).toBe("2026-10-05T03:30:00.000Z");
  });
});

describe("forecast rules", () => {
  it("trends", () => {
    expect(Math.round(linearTrend([10, 20, 30]).at(1))).toBe(40);
    const h = holtForecast([100, 110, 120, 130], 2);
    expect(h[0]).toBeGreaterThan(130);
  });

  it("churn risk explains itself", () => {
    const r = churnRisk({ healthScore: 50, healthReasons: ["2 overdue invoices"], endsInDays: 10, activityChangePct: -70, tenureDays: 400, mrrSharePct: 10 });
    expect(r.score).toBe(75);
    expect(r.reasons.map((x) => x.label)).toEqual(["2 overdue invoices", "Retainer ends in 10 days with no renewal yet", "Client activity down 70% on the month before"]);
    expect(churnRisk({ healthScore: 100, healthReasons: [], endsInDays: null, activityChangePct: 5, tenureDays: 400, mrrSharePct: 0 }).score).toBe(0);
  });

  it("deal and task scores", () => {
    expect(winProbability({ stageProbabilityPct: 50, stageLabel: "Proposal sent", leadScore: 80, daysSinceActivity: 2, proposalViews: 3, followUpOverdue: false, ageDays: 10 }).score).toBe(70);
    expect(winProbability({ stageProbabilityPct: 10, stageLabel: "New", leadScore: 10, daysSinceActivity: 40, proposalViews: 0, followUpOverdue: true, ageDays: 90 }).score).toBe(2);
    expect(slipRisk({ hoursLeft: -30, estimateHours: 2, status: "todo", started: false, ownerLoadPct: 50, hasOwner: true, deadlineChanges: 0, openDependencies: 0 }).score).toBe(100);
    const s = slipRisk({ hoursLeft: 4, estimateHours: 8, status: "blocked", started: true, ownerLoadPct: 150, hasOwner: true, deadlineChanges: 0, openDependencies: 0 });
    expect(s.score).toBe(90);
    expect(s.reasons[0].label).toBe("Blocked");
  });

  it("field permissions: founder always edits; most permissive role wins", () => {
    expect(fieldModeFor("lead.budget", ["founder"], { "lead.budget": { founder: "hidden" } })).toBe("edit");
    expect(fieldModeFor("lead.budget", ["sales_executive"], { "lead.budget": { sales_executive: "hidden" } })).toBe("hidden");
    expect(fieldModeFor("lead.budget", ["sales_executive", "account_manager"], { "lead.budget": { sales_executive: "hidden" } })).toBe("read");
    expect(fieldModeFor("people.cost_rates", ["intern"])).toBe("hidden");
  });
});
