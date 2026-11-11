import { describe, expect, it } from "vitest";
import { startSyncs, type ApiApp } from "../../../src/features/mcp/api";
import type { Env } from "../../../src/platform/env";

describe("MCP sync_sources", () => {
  it("逐一以不帶 body 的請求排入同步，並轉送 Access 身分", async () => {
    const requests: Request[] = [];
    const api: ApiApp = {
      routes: [],
      fetch: async (request: Request) => {
        requests.push(request);
        return new URL(request.url).pathname === "/connectors/sinopac/sync"
          ? Response.json(
              {
                success: false,
                error: { code: "SYNC_ALREADY_RUNNING", message: "同步中" },
              },
              { status: 409 },
            )
          : Response.json({ success: true, status: "queued" }, { status: 202 });
      },
    };
    const source = new Request("https://app.example/mcp", {
      method: "POST",
      headers: { "Cf-Access-Jwt-Assertion": "jwt", Authorization: "secret" },
    });

    const results = await startSyncs(api, source, {} as Env, undefined, [
      "esun",
      "sinopac",
      "esun",
    ]);

    expect(results).toEqual([
      { connectorId: "esun", queued: true },
      {
        connectorId: "sinopac",
        queued: false,
        error: { code: "SYNC_ALREADY_RUNNING", message: "同步中" },
      },
    ]);
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/connectors/esun/sync",
      "/connectors/sinopac/sync",
    ]);
    for (const request of requests) {
      expect(request.method).toBe("POST");
      expect(await request.text()).toBe("");
      expect(request.headers.get("Cf-Access-Jwt-Assertion")).toBe("jwt");
      expect(request.headers.get("Authorization")).toBeNull();
    }
  });
});
