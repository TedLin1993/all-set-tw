import { describe, expect, it, vi } from "vitest";
import {
  API_RESPONSE_MAX_CHARS,
  listApiEndpoints,
  serializeApiResult,
} from "../../../src/features/mcp/api";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

describe("MCP list_api_endpoints", () => {
  it("每個 /api 端點都有說明，且不帶 resource 時只列端點清單", async () => {
    const { api } = await import("../../../src/index");

    const index = listApiEndpoints(api);
    if (!("resources" in index)) throw new Error("expected resource index");
    expect(JSON.stringify(index)).not.toContain("credentialFields");

    const missing: string[] = [];
    let total = 0;
    for (const { resource, endpoints } of index.resources) {
      const detail = listApiEndpoints(api, resource);
      if (!("endpoints" in detail)) throw new Error(`missing ${resource}`);
      expect(detail.endpoints.map((e) => `${e.method} ${e.path}`)).toEqual(
        endpoints,
      );
      expect("connectors" in detail).toBe(resource === "connectors");
      total += detail.endpoints.length;
      for (const endpoint of detail.endpoints)
        if (!endpoint.note) missing.push(`${endpoint.method} ${endpoint.path}`);
    }

    expect(total).toBeGreaterThan(0);
    // 新增 API 時在 features/mcp/api.ts 的 ENDPOINT_NOTES 補上說明。
    expect(missing).toEqual([]);
    expect(listApiEndpoints(api, "unknown")).toMatchObject({
      error: expect.stringContaining("unknown"),
      resources: index.resources,
    });
  });
});

describe("MCP query_api 回應大小", () => {
  const large = {
    status: 200,
    headers: { "X-Has-More": "true" },
    body: { items: ["x".repeat(API_RESPONSE_MAX_CHARS)] },
  };

  it("讀取的回應過大時不回傳內容，並保留分頁 headers", () => {
    const { text, tooLarge } = serializeApiResult("GET", large);

    expect(tooLarge).toBe(true);
    expect(JSON.parse(text)).toMatchObject({
      status: 200,
      headers: { "X-Has-More": "true" },
      error: { code: "RESPONSE_TOO_LARGE" },
    });
    expect(text.length).toBeLessThan(1000);
  });

  it("寫入的回應與未超過上限的讀取完整回傳", () => {
    expect(serializeApiResult("POST", large)).toEqual({
      text: JSON.stringify(large),
      tooLarge: false,
    });
    const small = { status: 200, headers: {}, body: { ok: true } };
    expect(serializeApiResult("GET", small)).toEqual({
      text: JSON.stringify(small),
      tooLarge: false,
    });
  });
});
