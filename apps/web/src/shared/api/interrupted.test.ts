import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./client";
import { isRequestInterrupted } from "./interrupted";

describe("isRequestInterrupted", () => {
  it("把瀏覽器的連線中斷視為中斷，而非同步失敗", () => {
    expect(isRequestInterrupted(new TypeError("Load failed"))).toBe(true);
    expect(isRequestInterrupted(new TypeError("Failed to fetch"))).toBe(true);
    expect(
      isRequestInterrupted(new Error("The network connection was lost.")),
    ).toBe(true);
  });

  it("伺服器回覆的錯誤與一般錯誤不算中斷", () => {
    expect(
      isRequestInterrupted(new ApiRequestError("SYNC_FAILED", "失敗", 500)),
    ).toBe(false);
    expect(isRequestInterrupted(new Error("台新同步失敗"))).toBe(false);
    expect(isRequestInterrupted("Load failed")).toBe(false);
  });
});
