import { describe, expect, it } from "vitest";
import { orgChartAddSchema, orgChartDescendants, orgChartInputSchema, orgChartMemberUpdateSchema } from "./index.js";

const chart = [
  { userId: "ceo", parentUserId: null },
  { userId: "lead", parentUserId: "ceo" },
  { userId: "a", parentUserId: "lead" },
  { userId: "b", parentUserId: "a" },
  { userId: "side", parentUserId: "ceo" },
];

describe("custom charts", () => {
  it("finds everyone below a person, at any depth", () => {
    expect([...orgChartDescendants(chart, "lead")].sort()).toEqual(["a", "b"]);
    expect(orgChartDescendants(chart, "b").size).toBe(0);
    expect(orgChartDescendants(chart, "ceo").size).toBe(4);
  });

  it("survives a loop in bad data", () => {
    expect([...orgChartDescendants([{ userId: "x", parentUserId: "y" }, { userId: "y", parentUserId: "x" }], "x")].sort()).toEqual(["x", "y"]);
  });

  it("starts empty by default and needs a real name", () => {
    expect(orgChartInputSchema.parse({ name: "Diwali team" }).startFrom).toBe("empty");
    expect(orgChartInputSchema.safeParse({ name: " " }).success).toBe(false);
  });

  it("puts a new person at the top unless told otherwise", () => {
    expect(orgChartAddSchema.parse({ userId: "u1" }).parentUserId).toBeNull();
  });

  it("a member change must move them or relabel them", () => {
    expect(orgChartMemberUpdateSchema.safeParse({}).success).toBe(false);
    expect(orgChartMemberUpdateSchema.safeParse({ parentUserId: null }).success).toBe(true);
    expect(orgChartMemberUpdateSchema.safeParse({ label: "Campaign lead" }).success).toBe(true);
  });
});
