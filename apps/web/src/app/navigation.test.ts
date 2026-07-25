import { describe, expect, it } from "vitest";
import { parseViewHash, viewHash } from "./navigation";

describe("view hash navigation", () => {
  it("parses supported hash routes", () => {
    expect(parseViewHash("#/assets")).toBe("assets");
    expect(parseViewHash("#classification-rules")).toBe("classification-rules");
    expect(parseViewHash("#/sync-notifications")).toBe("sync-notifications");
  });

  it("rejects unknown routes and formats valid views", () => {
    expect(parseViewHash("#/unknown")).toBeNull();
    expect(viewHash("manual-assets")).toBe("#/manual-assets");
  });
});
