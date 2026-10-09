import { describe, expect, it } from "vitest";
import { accessRule, bundlePricePaise, canAccess, detectBundle, formatINR, withGst } from "./index.js";

describe("money", () => {
  it("formats in Indian number format", () => {
    expect(formatINR(10_000_000)).toBe("₹1,00,000");
  });
  it("adds 18% GST separately", () => {
    expect(withGst(10_000)).toEqual({ net: 10_000, gst: 1_800, total: 11_800 });
  });
});

describe("bundles", () => {
  it("applies the 10% bundle discount", () => {
    const p = bundlePricePaise("digital_presence", "starter");
    expect(p.discount).toBe(Math.round(p.gross / 10));
    expect(p.net).toBe(p.gross - p.discount);
  });
  it("detects a bundle from selected services", () => {
    expect(detectBundle(["website", "seo", "gbp", "smm"])?.id).toBe("digital_presence");
    expect(detectBundle(["website"])).toBeUndefined();
  });
});

describe("permissions", () => {
  it("reads the matrix", () => {
    expect(accessRule("leads_pipeline", "sales_executive")).toBe("own");
    expect(canAccess("leads_pipeline", "client_owner")).toBe(false);
  });
  it("falls back to others", () => {
    expect(canAccess("approve_creative", "producer")).toBe(false);
    expect(canAccess("approve_creative", "client_approver")).toBe(true);
  });
});

import { priceProposal } from "./index.js";

describe("proposal pricing", () => {
  const services = [
    { key: "website", name: "Website", billingType: "one_time", tiers: [{ tier: "growth", pricePaise: 6_000_000 }] },
    { key: "seo", name: "SEO", billingType: "monthly", tiers: [{ tier: "growth", pricePaise: 3_000_000 }] },
  ];
  const bundles = [{ key: "pair", name: "Pair", serviceKeys: ["website", "seo"], discountPct: 10 }];

  it("applies bundle saving, extra discount, GST and first-payment terms", () => {
    const p = priceProposal({
      services,
      addOns: [],
      bundles,
      serviceLines: [
        { serviceKey: "website", tier: "growth" },
        { serviceKey: "seo", tier: "growth" },
      ],
      addOnLines: [],
      extraDiscountPct: 5,
    });
    expect(p.bundle?.key).toBe("pair");
    expect(p.subtotalPaise).toBe(9_000_000);
    expect(p.bundleDiscountPaise).toBe(900_000);
    expect(p.taxablePaise).toBe(7_695_000); // 8,100,000 less 5%
    expect(p.gstPaise).toBe(Math.round(7_695_000 * 0.18));
    // website 50% now (2,565,000) + seo first month (2,565,000)
    expect(p.firstPayment.netPaise).toBe(2_565_000 + 2_565_000);
  });
});

import { addWorkingDays, isWorkingDay } from "./index.js";

describe("working days", () => {
  it("skips Sundays and holidays and ends at 6:30 PM IST", () => {
    // Thursday 1 Oct 2026, 11:00 IST. +4 working days: Fri 2 (holiday), Sat 3, Sun 4 skipped, Mon 5, Tue 6, Wed 7
    const due = addWorkingDays(new Date("2026-10-01T11:00:00+05:30"), 4, ["2026-10-02"]);
    expect(due.toISOString()).toBe(new Date("2026-10-07T18:30:00+05:30").toISOString());
  });
  it("knows Sunday is off", () => {
    expect(isWorkingDay(new Date("2026-10-04T10:00:00+05:30"))).toBe(false);
    expect(isWorkingDay(new Date("2026-10-03T10:00:00+05:30"))).toBe(true);
  });
});

import { addWorkingMinutes, endOfWorkingDay, workCalendar, workingMinutesBetween } from "./working-days.js";

describe("working hours (SLA timers)", () => {
  const hol = ["2026-10-02"];
  it("pauses overnight", () => {
    // Monday 5 Oct 2026, 17:30 IST + 2 working hours → Tuesday 10:30 IST
    expect(addWorkingMinutes(new Date("2026-10-05T17:30:00+05:30"), 120, hol).toISOString()).toBe(new Date("2026-10-06T10:30:00+05:30").toISOString());
  });
  it("skips Sundays and holidays", () => {
    // Thursday 1 Oct 18:00 + 4h → Friday 2 Oct is a holiday → Saturday 3 Oct 13:00
    expect(addWorkingMinutes(new Date("2026-10-01T18:00:00+05:30"), 240, hol).toISOString()).toBe(new Date("2026-10-03T13:00:00+05:30").toISOString());
    // Saturday 18:00 + 1h → 30 min on Saturday, then Monday 10:00 (Sunday off)
    expect(addWorkingMinutes(new Date("2026-10-03T18:00:00+05:30"), 60, hol).toISOString()).toBe(new Date("2026-10-05T10:00:00+05:30").toISOString());
  });
  it("starts the clock at 9:30 for messages sent at night", () => {
    expect(addWorkingMinutes(new Date("2026-10-05T23:00:00+05:30"), 30, hol).toISOString()).toBe(new Date("2026-10-06T10:00:00+05:30").toISOString());
  });
  it("counts only working minutes between two moments", () => {
    expect(workingMinutesBetween(new Date("2026-10-03T18:00:00+05:30"), new Date("2026-10-05T10:30:00+05:30"), hol)).toBe(90);
  });
  it("same working day ends at 18:30, or the next working day after hours", () => {
    expect(endOfWorkingDay(new Date("2026-10-05T11:00:00+05:30"), hol).toISOString()).toBe(new Date("2026-10-05T18:30:00+05:30").toISOString());
    expect(endOfWorkingDay(new Date("2026-10-03T20:00:00+05:30"), hol).toISOString()).toBe(new Date("2026-10-05T18:30:00+05:30").toISOString());
  });
});

describe("custom working hours", () => {
  it("uses the configured hours and days for SLA timers", () => {
    const c = workCalendar([], { start: "10:00", end: "18:00", days: [1, 2, 3, 4, 5] });
    // Friday 17:00 IST + 120 working minutes → Monday 11:00 IST (Saturday is off).
    const due = addWorkingMinutes(new Date("2026-10-02T17:00:00+05:30"), 120, c);
    expect(due.toISOString()).toBe(new Date("2026-10-05T11:00:00+05:30").toISOString());
    expect(workingMinutesBetween(new Date("2026-10-02T17:00:00+05:30"), due, c)).toBe(120);
  });
});
