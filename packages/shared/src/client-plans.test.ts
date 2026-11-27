import { describe, expect, it } from "vitest";
import { clientServicesPlanProblems, type PriceList } from "./index.js";

const none = { starter: null, growth: null, premium: null };
const list: PriceList = {
  groups: [
    {
      id: "g1",
      name: "Web & AI",
      serviceId: "s1",
      archived: false,
      subServices: [
        { id: "priced", name: "Website Design", covers: "", archived: false, billing: "one_time", prices: { starter: 2_000_000, growth: 3_000_000, premium: null } },
        { id: "unpriced", name: "Domain set-up", covers: "", archived: false, billing: "one_time", prices: none },
      ],
    },
  ],
  bundles: [
    { id: "b-priced", name: "Launch pack", subServiceIds: ["priced"], savingPct: 10, selectable: true, prices: { starter: 1_800_000, growth: null, premium: null } },
    { id: "b-unpriced", name: "Care pack", subServiceIds: ["unpriced"], savingPct: 0, selectable: true, prices: none },
  ],
};

describe("plans when adding a client (v56)", () => {
  it("asks for a plan only for items that have plan prices", () => {
    expect(clientServicesPlanProblems({ groupIds: ["g1"], subServiceIds: ["priced", "unpriced"], bundleIds: ["b-priced", "b-unpriced"], plans: {} }, list)).toEqual(["Choose a plan for Website Design, Launch pack."]);
  });

  it("is satisfied when every priced item has a plan, with no plan on the unpriced ones", () => {
    expect(clientServicesPlanProblems({ groupIds: ["g1"], subServiceIds: ["priced", "unpriced"], bundleIds: ["b-priced", "b-unpriced"], plans: { priced: "growth", "b-priced": "starter" } }, list)).toEqual([]);
  });

  it("needs no plan at all when nothing picked has plans", () => {
    expect(clientServicesPlanProblems({ groupIds: ["g1"], subServiceIds: ["unpriced"], bundleIds: ["b-unpriced"], plans: {} }, list)).toEqual([]);
  });
});

describe("amount and billing for items without plans (v56)", () => {
  it("reads an amount with its billing, and defaults to no amount, billed monthly", async () => {
    const { clientServicesInputSchema } = await import("./index.js");
    const v = clientServicesInputSchema.parse({ subServiceIds: ["unpriced", "other"], custom: { unpriced: { pricePaise: 1_200_000, billing: "one_time" }, other: {} } });
    expect(v.custom.unpriced).toEqual({ pricePaise: 1_200_000, billing: "one_time" });
    expect(v.custom.other).toEqual({ pricePaise: null, billing: "monthly" });
    expect(clientServicesInputSchema.safeParse({ custom: { x: { pricePaise: -5 } } }).success).toBe(false);
    expect(clientServicesInputSchema.safeParse({ custom: { x: { billing: "per_unit" } } }).success).toBe(false);
  });
});
