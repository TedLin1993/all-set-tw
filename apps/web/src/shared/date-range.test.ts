import { describe, expect, it } from "vitest";
import { recentMonthRange } from "./date-range";

describe("recentMonthRange", () => {
  it("includes the ending month and uses the following month as the exclusive end", () => {
    expect(recentMonthRange(6, new Date(2026, 6, 25))).toEqual({
      from: "2026-02",
      to: "2026-08",
    });
  });

  it("handles a year boundary", () => {
    expect(recentMonthRange(6, new Date(2026, 0, 25))).toEqual({
      from: "2025-08",
      to: "2026-02",
    });
  });
});
