import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { AppBindings, Env } from "../../src/platform/env";
import {
  apiErrorResponse,
  demoReadOnlyMiddleware,
  deployMaintenanceMiddleware,
  encodePageCursor,
  isDemoMode,
  isDeployMaintenance,
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

  it("recognizes supported demo mode values", () => {
    expect(isDemoMode({ DEMO_MODE: true })).toBe(true);
    expect(isDemoMode({ DEMO_MODE: "YES" })).toBe(true);
    expect(isDemoMode({ DEMO_MODE: "false" })).toBe(false);
  });
});

describe("deploy maintenance middleware", () => {
  it("blocks writes while the site is being updated", async () => {
    const app = new Hono<AppBindings>();
    app.use("*", deployMaintenanceMiddleware);
    app.put("/resource", (c) => c.json({ updated: true }));
    const response = await app.request("/resource", { method: "PUT" }, {
      DEPLOY_MAINTENANCE: "1",
    } as Env);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "DEPLOY_MAINTENANCE" },
    });
  });

  it("recognizes supported maintenance flag values", () => {
    expect(isDeployMaintenance({ DEPLOY_MAINTENANCE: true })).toBe(true);
    expect(isDeployMaintenance({ DEPLOY_MAINTENANCE: "YES" })).toBe(true);
    expect(isDeployMaintenance({ DEPLOY_MAINTENANCE: "false" })).toBe(false);
  });
});

describe("HTTP helpers", () => {
  it("round-trips an opaque keyset cursor", () => {
    const schema = z.object({ effectiveDate: z.string(), name: z.string() });
    const cursor = encodePageCursor({
      effectiveDate: "2026-07-19",
      name: "台積電",
    });
    expect(parseKeysetPagination({ limit: "25", cursor }, schema)).toEqual({
      limit: 25,
      cursor: { effectiveDate: "2026-07-19", name: "台積電" },
    });
    expect(() => parseKeysetPagination({ cursor: "invalid" }, schema)).toThrow(
      z.ZodError,
    );
    expect(() => parseKeysetPagination({ limit: "101" }, schema)).toThrow(
      z.ZodError,
    );
  });

  it("maps validation errors to 400 without exposing details", async () => {
    const response = apiErrorResponse(new z.ZodError([]));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
    });
  });

  it("normalizes malformed JSON errors from Hono validators", async () => {
    const response = apiErrorResponse(
      new HTTPException(400, { message: "Malformed JSON" }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST" },
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
