import { describe, expect, it } from "vitest";
import { recentMonthRange } from "./date-range";

describe("recentMonthRange", () => {
  it("returns the inclusive range for the most recent six months", () => {
    expect(recentMonthRange(6, new Date(2026, 6, 25))).toEqual({
      from: "2026-02",
      to: "2026-07",
    });
  });

  it("handles a year boundary", () => {
    expect(recentMonthRange(6, new Date(2026, 0, 25))).toEqual({
      from: "2025-08",
      to: "2026-01",
    });
  });
});
