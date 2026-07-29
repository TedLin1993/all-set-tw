import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  accessMiddleware,
  isLocalDevRequest,
} from "../../src/middleware/access";
import type { AppBindings, Env } from "../../src/platform/env";

function testApp() {
  const app = new Hono<AppBindings>();
  app.use("*", accessMiddleware);
  app.post("/resource", (c) => c.json({ updated: true }));
  return app;
}

describe("local development access", () => {
  it("allows writes from localhost when local development mode is enabled", async () => {
    const response = await testApp().request(
      "http://localhost/resource",
      { method: "POST" },
      { LOCAL_DEV_MODE: "true" } as Env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ updated: true });
  });

  it("does not bypass Access for non-local requests", () => {
    const env = { LOCAL_DEV_MODE: "true" } as Env;

    expect(isLocalDevRequest(new Request("https://example.com"), env)).toBe(
      false,
    );
    expect(isLocalDevRequest(new Request("http://127.0.0.1"), env)).toBe(true);
    expect(isLocalDevRequest(new Request("http://[::1]"), env)).toBe(true);
  });

  it("requires an explicit opt-in even on localhost", () => {
    expect(
      isLocalDevRequest(new Request("http://localhost"), {
        LOCAL_DEV_MODE: "false",
      }),
    ).toBe(false);
  });
});
