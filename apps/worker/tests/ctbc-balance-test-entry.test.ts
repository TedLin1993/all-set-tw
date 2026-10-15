import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/platform/env";
const calls = vi.hoisted(() => ({
  fetch: vi.fn(async (..._args: unknown[]) => new Response("test")),
  queue: vi.fn(),
  scheduled: vi.fn(),
}));
vi.mock("../src/index", () => ({ default: calls }));
import handler from "../src/ctbc-balance-test-entry";
import { runConnectorSync } from "../src/features/sync/registry";

afterEach(() => vi.clearAllMocks());
describe("獨立外幣餘額測試入口", () => {
  it.each([
    "/api/connectors/esun/sync",
    "/api/sync-schedule",
    "/api/manual-assets",
    "/api/connectors/ctbc/sync/other",
  ])("拒絕範圍外寫入 %s", async (path) => {
    const response = await handler.fetch(
      new Request("https://test.invalid" + path, { method: "POST" }),
      {} as Env,
      {} as ExecutionContext,
    );
    expect(response.status).toBe(403);
    expect(calls.fetch).not.toHaveBeenCalled();
  });
  it("中信同步強制餘額模式並保留 Access 驗證，不接受繞過設定", async () => {
    const response = await handler.fetch(
      new Request("https://test.invalid/api/connectors/ctbc/sync", {
        method: "POST",
      }),
      { LOCAL_DEV_MODE: true, DEMO_MODE: true } as Env,
      {} as ExecutionContext,
    );
    expect(calls.fetch.mock.calls[0][1]).toMatchObject({
      CTBC_FOREIGN_BALANCE_TEST: "1",
      CTBC_CREDIT_CARD_TEST: "1",
      LOCAL_DEV_MODE: undefined,
      DEMO_MODE: undefined,
    });
    expect(response.headers.get("X-All-Set-TW-Test-Scope")).toBe(
      "ctbc-foreign-balances-and-twd-cards",
    );
  });
  it("排程不執行；Queue 丟棄範圍外訊息", async () => {
    await handler.scheduled();
    const ack = vi.fn();
    await handler.queue(
      {
        messages: [{ body: { type: "run-next-scheduled-sync" }, ack }],
      } as unknown as MessageBatch<any>,
      {} as Env,
    );
    expect(ack).toHaveBeenCalledOnce();
    expect(calls.queue).not.toHaveBeenCalled();
    expect(calls.scheduled).not.toHaveBeenCalled();
  });
  it("範圍外 connector 或排程即使進入背景工作仍被拒絕", () => {
    const env = { CTBC_FOREIGN_BALANCE_TEST: "1" } as Env;
    expect(() => runConnectorSync(env, "esun", "manual")).toThrow(
      "測試站只允許",
    );
    expect(() => runConnectorSync(env, "ctbc", "scheduled")).toThrow(
      "測試站只允許",
    );
  });
});
