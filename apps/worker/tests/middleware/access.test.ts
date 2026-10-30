import { Buffer } from "node:buffer";
import { Hono } from "hono";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { accessMiddleware } from "../../src/middleware/access";
import { mcpRoutes } from "../../src/features/mcp/route";
import type { AppBindings, Env } from "../../src/platform/env";

const issuer = "https://test-access.cloudflareaccess.com";
const audience = "synthetic-application";
const env = {
  TEAM_DOMAIN: issuer,
  POLICY_AUD: audience,
  LOCAL_DEV_MODE: "true",
} as Env;
let keys: CryptoKeyPair;
let jwk: JsonWebKey;

beforeAll(async () => {
  keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  jwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
});
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: "test-key" }] })),
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
});

async function token(state: string) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: "test-key" }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: issuer,
      aud: state === "wrong-audience" ? "other-application" : audience,
      email: "owner@example.com",
      exp: Math.floor(Date.now() / 1000) + (state === "expired" ? -60 : 3600),
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      keys.privateKey,
      new TextEncoder().encode(data),
    ),
  );
  if (state === "forged") signature[0] = signature[0]! ^ 1;
  return `${data}.${Buffer.from(signature).toString("base64url")}`;
}

function app() {
  const mutation = vi.fn();
  const api = new Hono<AppBindings>();
  api.use("*", accessMiddleware);
  api.post("/resource", (c) => {
    mutation();
    return c.json({ updated: true });
  });
  return { api, mutation };
}

describe("外部請求的授權邊界", () => {
  it.each(["valid", "missing", "expired", "wrong-audience", "forged"])(
    "%s JWT 僅在授權有效時執行寫入",
    async (state) => {
      const { api, mutation } = app();
      const response = await api.request(
        "https://example.com/resource",
        {
          method: "POST",
          headers:
            state === "missing"
              ? {}
              : { "Cf-Access-Jwt-Assertion": await token(state) },
        },
        env,
      );
      expect(response.status).toBe(state === "valid" ? 200 : 401);
      expect(mutation).toHaveBeenCalledTimes(state === "valid" ? 1 : 0);
      if (state !== "valid")
        expect(await response.json()).toMatchObject({
          error: { code: "UNAUTHORIZED" },
        });
    },
  );

  it("本機跳過登入必須明確啟用", async () => {
    const { api, mutation } = app();
    expect(
      (
        await api.request(
          "http://localhost/resource",
          { method: "POST" },
          { ...env, LOCAL_DEV_MODE: "false" },
        )
      ).status,
    ).toBe(401);
    expect(mutation).not.toHaveBeenCalled();
    expect(
      (await api.request("http://localhost/resource", { method: "POST" }, env))
        .status,
    ).toBe(200);
    expect(mutation).toHaveBeenCalledTimes(1);
  });
});

describe("MCP 端點的授權邊界", () => {
  async function callWhoami(headers: Record<string, string>) {
    // 與 src/index.ts 相同的掛載方式。
    const workerApp = new Hono<AppBindings>();
    workerApp.use("/mcp", accessMiddleware);
    workerApp.route("/mcp", mcpRoutes);
    return workerApp.request(
      "https://example.com/mcp",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...headers,
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "whoami", arguments: {} },
        }),
      },
      { ...env, LOCAL_DEV_MODE: "false" },
    );
  }

  it.each(["missing", "expired", "wrong-audience", "forged"])(
    "%s JWT 無法呼叫 MCP 工具",
    async (state) => {
      const response = await callWhoami(
        state === "missing"
          ? {}
          : { "Cf-Access-Jwt-Assertion": await token(state) },
      );
      expect(response.status).toBe(401);
    },
  );

  it("有效 JWT 可以呼叫 whoami 並取得登入 email", async () => {
    const response = await callWhoami({
      "Cf-Access-Jwt-Assertion": await token("valid"),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("owner@example.com");
  });
});
