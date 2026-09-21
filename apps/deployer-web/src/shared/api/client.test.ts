import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiClient, setCsrfToken } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
  setCsrfToken("");
});

describe("deployer API client", () => {
  it("sends cookies and the CSRF header on mutating requests", async () => {
    setCsrfToken("csrf-1");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await createApiClient().post("/api/precheck", { accountId: "acct-1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/precheck",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
      }),
    );
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-CSRF-Token")).toBe("csrf-1");
  });
});
