import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTestD1 } from "../../../../../packages/db/testing/d1";
import { encryptJson, decryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import {
  prepareFirstradeSession,
  syncFirstrade,
} from "../../../src/features/sync/firstrade-service";
import { updateConnectorSettings } from "../../../src/features/connectors/service";
import { runConnectorSync } from "../../../src/features/sync/registry";
import { syncRoutes } from "../../../src/features/sync/route";
let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;
const key = "synthetic-test-encryption-key";
beforeEach(async () => {
  harness = await createTestD1();
  env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
  await env.DB.prepare(
    "INSERT INTO connector_settings(id,connector_id,encrypted_config,created_at,updated_at) VALUES(?,?,?,?,?)",
  )
    .bind(
      "firstrade",
      "firstrade",
      await encryptJson(
        { username: "synthetic", password: "synthetic-password" },
        key,
      ),
      "v1",
      "v1",
    )
    .run();
}, 30000);
afterEach(async () => {
  vi.restoreAllMocks();
  await harness?.mf.dispose();
}, 30000);
function remote(
  options: {
    sold?: boolean;
    mismatch?: boolean;
    transientMismatch?: boolean;
    quoteDifference?: boolean;
    omitOptionalBalanceFields?: boolean;
    onBalances?: () => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const original = globalThis.fetch.bind(globalThis);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (url.origin !== "https://api3x.firstrade.com")
      return original(input, init);
    calls.push(url.pathname);
    const data: Record<string, unknown> = { error: "", statusCode: 200 };
    if (url.pathname === "/sess/login")
      Object.assign(data, {
        t_token: "secret-temp",
        mfa: false,
        otp: [{ channel: "sms", recipientId: 123, recipientMask: "***1234" }],
      });
    if (url.pathname === "/sess/request_code")
      Object.assign(data, { verificationSid: "secret-verification" });
    if (url.pathname === "/sess/verify_pin")
      Object.assign(data, { ftat: "secret-token", sid: "secret-session" });
    if (url.pathname === "/private/acct_list")
      Object.assign(data, { items: [{ account: "12345678" }] });
    if (url.pathname === "/private/balances") {
      await options.onBalances?.();
      Object.assign(data, {
        result: {
          account: "12345678",
          cash_balance: 12.34,
          ...(options.quoteDifference
            ? {
                long_stock_value: 101.25,
                ...(options.omitOptionalBalanceFields
                  ? {}
                  : {
                      long_option_value: 0,
                      short_option_value: 0,
                      margin_balance: 0,
                    }),
              }
            : {}),
          total_account_value:
            options.mismatch ||
            (options.transientMismatch &&
              calls.filter((p) => p === "/private/balances").length === 1)
              ? 999
              : options.quoteDifference
                ? 113.59
                : options.sold
                  ? 12.34
                  : 112.59,
        },
      });
    }
    if (url.pathname === "/private/positions")
      Object.assign(data, {
        account: "12345678",
        page: 1,
        pages: 1,
        total: options.sold ? 0 : 1,
        ...(options.quoteDifference ? { total_market_value: 100.25 } : {}),
        items: options.sold
          ? []
          : [
              {
                symbol: "TEST",
                company_name: "Synthetic equity",
                sec_type: 1,
                quantity: 0.5,
                market_value: 100.25,
                cost: 90,
              },
            ],
      });
    return Response.json(data);
  });
  return calls;
}
async function authenticate() {
  await prepareFirstradeSession(env);
  await prepareFirstradeSession(env, 0);
}
async function settings() {
  return (await env.DB.prepare(
    "SELECT * FROM connector_settings WHERE connector_id='firstrade'",
  ).first())!;
}
it("persists an atomic USD snapshot and removes sold positions on same-day sync", async () => {
  remote();
  await authenticate();
  const outcome = await runConnectorSync(env, "firstrade", "manual", "all", {
    otp: "123456",
  });
  expect(outcome.records).toBe(2);
  const rows = await env.DB.prepare(
    "SELECT * FROM investment_positions WHERE connector_id='firstrade'",
  ).all();
  expect(rows.results).toHaveLength(2);
  expect(JSON.stringify(rows.results)).not.toContain("12345678");
  expect(rows.results.every((r) => r.currency === "USD")).toBe(true);
  const stored = await settings();
  expect(await decryptJson(stored.encrypted_config as string, key)).toEqual({
    username: "synthetic",
    password: "synthetic-password",
  });
  expect(stored.sync_cursor).not.toMatch(/secret|token|sid|password/);
  vi.restoreAllMocks();
  remote({ sold: true });
  await authenticate();
  await syncFirstrade(env, "manual", { otp: "123456" });
  const remaining = await env.DB.prepare(
    "SELECT * FROM investment_positions WHERE connector_id='firstrade'",
  ).all();
  expect(remaining.results).toHaveLength(1);
  expect(remaining.results[0].cash_balance).toBe(12.34);
}, 30000);
it("rejects mismatch without replacing the last complete snapshot", async () => {
  remote();
  await authenticate();
  await syncFirstrade(env, "manual", { otp: "123456" });
  vi.restoreAllMocks();
  const mismatchCalls = remote({ mismatch: true });
  await authenticate();
  await expect(syncFirstrade(env, "manual", { otp: "123456" })).rejects.toThrow(
    "總值不符",
  );
  expect(mismatchCalls.filter((p) => p === "/private/balances")).toHaveLength(
    2,
  );
  expect(
    (await env.DB.prepare("SELECT * FROM investment_positions").all()).results,
  ).toHaveLength(2);
}, 30000);
it("never sends scheduled OTP and clears challenges on credential change", async () => {
  const calls = remote();
  await expect(runConnectorSync(env, "firstrade", "scheduled")).rejects.toThrow(
    "手動同步",
  );
  expect(calls).toHaveLength(0);
  await prepareFirstradeSession(env);
  expect(JSON.stringify(await settings())).not.toContain("secret-temp");
  await updateConnectorSettings(env, "firstrade", { password: "new-password" });
  const decrypted = await decryptJson<Record<string, unknown>>(
    (await settings()).encrypted_config as string,
    key,
  );
  expect(decrypted.pendingSession).toBeUndefined();
  await expect(prepareFirstradeSession(env, 0)).rejects.toThrow("失效");
  expect(calls).not.toContain("/sess/request_code");
}, 30000);
it("aborts promotion if credentials change during the external query", async () => {
  remote({
    onBalances: () =>
      updateConnectorSettings(env, "firstrade", { password: "changed" }).then(
        () => {},
      ),
  });
  await authenticate();
  await expect(
    syncFirstrade(env, "manual", { otp: "123456" }),
  ).rejects.toThrow();
  expect(
    (await env.DB.prepare("SELECT * FROM investment_positions").all()).results,
  ).toHaveLength(0);
  expect(
    (
      await decryptJson<Record<string, unknown>>(
        (await settings()).encrypted_config as string,
        key,
      )
    ).password,
  ).toBe("changed");
}, 30000);
it("offers OTP recipients through the route without returning session secrets", async () => {
  remote();
  const response = await syncRoutes.request(
    "/connectors/firstrade/challenge",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    },
    env,
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ kind: "delivery" });
  expect(JSON.stringify(body)).not.toMatch(/secret|t_token|cookies|ftat/);
  const bad = await syncRoutes.request(
    "/connectors/firstrade/sync",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otp: "bad" }),
    },
    env,
  );
  expect(bad.status).toBe(400);
  const send = await syncRoutes.request(
    "/connectors/firstrade/challenge",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientIndex: 0 }),
    },
    env,
  );
  expect(send.status).toBe(200);
  const sync = await syncRoutes.request(
    "/connectors/firstrade/sync",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ otp: "123456" }),
    },
    env,
  );
  expect(sync.status).toBe(200);
  expect(await sync.json()).toMatchObject({ success: true, records: 2 });
  const job = await env.DB.prepare(
    "SELECT enabled,last_status FROM sync_jobs WHERE id='firstrade:all'",
  ).first();
  expect(job).toMatchObject({ enabled: 0, last_status: "success" });
}, 30000);

it("re-reads an inconsistent snapshot once without repeating login or OTP", async () => {
  const calls = remote({ transientMismatch: true });
  await authenticate();
  const result = await syncFirstrade(env, "manual", { otp: "123456" });
  expect(result.records).toBe(2);
  expect(calls.filter((p) => p === "/private/balances")).toHaveLength(2);
  expect(calls.filter((p) => p === "/private/positions")).toHaveLength(2);
  for (const path of ["/sess/login", "/sess/request_code", "/sess/verify_pin"])
    expect(calls.filter((p) => p === path)).toHaveLength(1);
}, 30000);

it.each([false, true])(
  "persists separately reconciled quote values with omitted optional fields=%s",
  async (omitOptionalBalanceFields) => {
    const calls = remote({ quoteDifference: true, omitOptionalBalanceFields });
    await authenticate();
    const outcome = await syncFirstrade(env, "manual", { otp: "123456" });
    expect(outcome.warnings?.[0]).toContain("不同報價來源");
    expect(calls.filter((p) => p === "/private/balances")).toHaveLength(1);
    const rows = (
      await env.DB.prepare("SELECT * FROM investment_positions").all()
    ).results;
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.cash_balance !== null)?.cash_balance).toBe(12.34);
    expect(rows.find((r) => r.symbol === "TEST")?.market_value).toBe(100.25);
  },
  30000,
);
