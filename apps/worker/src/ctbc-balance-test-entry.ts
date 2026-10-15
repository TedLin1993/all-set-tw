import worker from "./index";
import type { Env, SyncQueueMessage } from "./platform/env";

/** Dedicated entry for a new test Worker/D1/Queue; never use in production. */
export function balanceTestEnv(env: Env): Env {
  return {
    ...env,
    CTBC_FOREIGN_BALANCE_TEST: "1",
    CTBC_CREDIT_CARD_TEST: "1",
    DEMO_MODE: undefined,
    LOCAL_DEV_MODE: undefined,
    CTBC_API_RELAY_URL: undefined,
    CTBC_API_RELAY_TOKEN: undefined,
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const path = new URL(request.url).pathname;
    const safe = ["GET", "HEAD", "OPTIONS"].includes(request.method);
    const allowedWrite =
      (request.method === "PUT" && path === "/api/connectors/ctbc/settings") ||
      (request.method === "POST" && path === "/api/connectors/ctbc/sync");
    if (!safe && !allowedWrite) {
      return Response.json(
        {
          success: false,
          error: {
            code: "TEST_SCOPE_RESTRICTED",
            message: "測試站只允許中信外幣活存餘額與已確認範圍的信用卡同步。",
          },
        },
        { status: 403 },
      );
    }
    const response = await worker.fetch(request, balanceTestEnv(env), ctx);
    const result = new Response(response.body, response);
    result.headers.set(
      "X-All-Set-TW-Test-Scope",
      "ctbc-foreign-balances-and-twd-cards",
    );
    return result;
  },
  // No scheduled bank access, even if a trigger is accidentally added later.
  async scheduled() {},
  async queue(batch, env) {
    const allowed = batch.messages.filter((message) => {
      if (message.body.type === "run-manual-sync") return true;
      message.ack();
      return false;
    });
    if (allowed.length)
      await worker.queue({ ...batch, messages: allowed }, balanceTestEnv(env));
  },
} satisfies ExportedHandler<Env, SyncQueueMessage>;
