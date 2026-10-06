import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { connectorRoutes } from "../../src/features/connectors/route";
import type { AppBindings, Env } from "../../src/platform/env";
import {
  apiErrorResponse,
  demoReadOnlyMiddleware,
  encodePageCursor,
  parseKeysetPagination,
} from "../../src/platform/http";

function testApp() {
  const app = new Hono<AppBindings>();
  app.use("*", demoReadOnlyMiddleware);
  app.get("/resource", (c) => c.json({ ok: true }));
  app.put("/resource", (c) => c.json({ updated: true }));
  return app;
}

const demoEnv = { DEMO_MODE: "true" } as Env;

describe("demo read-only middleware", () => {
  it("allows reads", async () => {
    const response = await testApp().request("/resource", undefined, demoEnv);
    expect(response.status).toBe(200);
  });

  it("blocks writes before a route handler can mutate state", async () => {
    const response = await testApp().request(
      "/resource",
      { method: "PUT" },
      demoEnv,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "DEMO_MODE_READ_ONLY" },
    });
  });
});

describe("HTTP helpers", () => {
  // 預期依據：後端架構的 API 錯誤契約要求固定 error code，且不得洩漏輸入。
  it("Zod 分頁驗證失敗仍回傳固定 400，且不洩漏 cursor 內容", async () => {
    const app = new Hono();
    app.onError(apiErrorResponse);
    app.get("/resource", (c) =>
      c.json(
        parseKeysetPagination(
          c.req.query(),
          z.object({ lastPostedDate: z.string(), lastId: z.string() }),
        ),
      ),
    );
    const cursor = encodePageCursor({ lastId: "synthetic-private-cursor" });
    const response = await app.request(`/resource?cursor=${cursor}`);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "INVALID_REQUEST",
        message: "Request data does not match the expected format.",
      },
    });
  });

  it("Hono 的 Zod 驗證失敗仍回傳固定錯誤，且不洩漏設定內容", async () => {
    const response = await connectorRoutes.request(
      "/connectors/sinopac/settings",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config: "synthetic-private-config" }),
      },
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: {
        code: "INVALID_REQUEST_BODY",
        message: "Request body must include a config object.",
      },
    });
  });

  it("maps unexpected errors to a generic 500 response", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = apiErrorResponse(new Error("secret database detail"));
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain(
      "secret database detail",
    );
    spy.mockRestore();
  });
});
