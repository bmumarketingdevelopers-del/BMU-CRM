import { describe, expect, it } from "vitest";
import { featureFlagOn, SEARCH_MIN_SCORE, searchScore } from "./platform.js";

describe("smart search scoring", () => {
  it("ranks exact, prefix and substring matches above typos", () => {
    expect(searchScore("aroma", "Aroma")).toBe(1);
    expect(searchScore("aro", "Aroma Cafe")).toBeGreaterThan(searchScore("cafe", "Aroma Cafe") - 0.01);
    expect(searchScore("cafe", "Aroma Cafe")).toBeGreaterThanOrEqual(0.8);
  });
  it("finds names with a typo", () => {
    expect(searchScore("arnoma", "Aroma Cafe")).toBeGreaterThan(SEARCH_MIN_SCORE);
    expect(searchScore("sunrse", "Sunrise Foods")).toBeGreaterThan(SEARCH_MIN_SCORE);
    expect(searchScore("priya sharam", "Priya Sharma")).toBeGreaterThan(SEARCH_MIN_SCORE);
  });
  it("ignores unrelated text", () => {
    expect(searchScore("invoice", "Sunrise Foods")).toBeLessThan(SEARCH_MIN_SCORE);
    expect(searchScore("ab", "Zed")).toBe(0);
  });
});

describe("feature flags", () => {
  it("limits by role when roles are set", () => {
    expect(featureFlagOn({ enabled: true, roles: [] }, ["video_editor"])).toBe(true);
    expect(featureFlagOn({ enabled: true, roles: ["founder"] }, ["video_editor"])).toBe(false);
    expect(featureFlagOn({ enabled: false, roles: [] }, ["founder"])).toBe(false);
  });
});
