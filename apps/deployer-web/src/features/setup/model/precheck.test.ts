import { describe, expect, it } from "vitest";
import { precheckSummary } from "./precheck";

describe("precheck summary", () => {
  it("keeps the user on a resumable state when Access is missing", () => {
    const summary = precheckSummary([
      {
        id: "workers_subdomain",
        ok: true,
        blocking: true,
      },
      {
        id: "access_organization",
        ok: false,
        blocking: true,
        dashboardUrl: "https://one.dash.cloudflare.com/",
      },
      { id: "worker_name", ok: true, blocking: true },
    ]);
    expect(summary.ready).toBe(false);
    expect(summary.missing[0]?.dashboardUrl).toContain(
      "one.dash.cloudflare.com",
    );
  });
});
