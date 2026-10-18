import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { decryptJson, encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import type { CtbcConfig } from "../../../src/sources/ctbc/protocol";
import { syncCtbc } from "../../../src/sources/ctbc/sync";
import { withManualSyncLock } from "../../../src/features/sync/manual-sync";
import { getConnectorSettingsView } from "../../../src/features/connectors/service";
import { findNextDueSyncJob } from "../../../src/db";
import { NeedsUserActionError } from "../../../src/features/sync/errors";

const key = "synthetic-test-encryption-key";
const credentials = {
  userId: "synthetic-id",
  account: "synthetic-account",
  password: "synthetic-password",
};
const NOW = "2026-10-12T00:00:00.000Z";
let harness: Awaited<ReturnType<typeof createTestD1>>;
let env: Env;

async function savedConfig() {
  const row = await env.DB.prepare(
    "SELECT encrypted_config, sync_cursor FROM connector_settings WHERE connector_id = 'ctbc'",
  ).first<{ encrypted_config: string; sync_cursor: string | null }>();
  return {
    row: row!,
    config: await decryptJson<CtbcConfig>(row!.encrypted_config, key),
  };
}

function bankApi(
  responses: Response[],
  beforeRequest?: (index: number) => Promise<void>,
) {
  let index = 0;
  const fetcher = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) => {
      // Synthetic no-FX-account response, independent of login/logout fixtures.
      if (String(_init?.body).includes('"/twrbm-fx/qu001/010"'))
        return Response.json({
          code: "0000",
          rsData: {
            fxAcctSummaryResponse: {
              demDepBalSummaryResponse: { rspCode: "9002", infoList: [] },
            },
          },
        });
      await beforeRequest?.(index++);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected bank request");
      return response;
    },
  );
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}

function bootstrap(login: Record<string, unknown>, seed = "private-seed") {
  return [
    Response.json({ access_token: "private-oauth" }),
    Response.json({ statusCode: "0000" }),
    Response.json({
      success: true,
      token: "private-handshake",
      rsData: { seed },
    }),
    Response.json(
      { code: "0000", token: "private-login", rsData: login },
      { headers: { "x-auth-token": "private-auth" } },
    ),
  ];
}

function emptyAccounts() {
  return [
    Response.json({ code: "0000", rsData: {} }),
    Response.json({ code: "0000", rsData: { cardDataList: [], billData: {} } }),
    Response.json({ code: "0000" }),
  ];
}

beforeAll(async () => {
  harness = await createTestD1();
  env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
}, 60_000);
afterAll(async () => {
  await harness?.mf.dispose();
});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM connector_settings"),
    env.DB.prepare(
      "UPDATE sync_jobs SET enabled = 0, last_status = NULL, last_run_at = NULL, last_success_at = NULL, locked_by = NULL, locked_until = NULL",
    ),
    env.DB.prepare(
      "UPDATE sync_jobs SET enabled = 1, next_run_at = ?, interval_minutes = 60 WHERE connector_id = 'ctbc'",
    ).bind(NOW),
    env.DB.prepare(
      "INSERT INTO connector_settings(id, connector_id, encrypted_config, created_at, updated_at) VALUES ('ctbc', 'ctbc', ?, ?, ?)",
    ).bind(await encryptJson(credentials, key), NOW, NOW),
  ]);
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("中信裝置、互動驗證與憑證版本（隔離 D1）", () => {
  it("排程完成初始化、登入、查帳與登出後不留下驗證暫存", async () => {
    const fetcher = bankApi([...bootstrap({}), ...emptyAccounts()]);
    await syncCtbc(env, "scheduled");
    expect(fetcher).toHaveBeenCalledTimes(8);
    expect((await savedConfig()).config.pendingSession).toBeUndefined();
  });

  it("跨同步沿用加密保存的裝置與 seed，不將識別保存視為銀行信任登記", async () => {
    const first = bankApi(
      bootstrap({ isTwoStageLogin: true, twoStageCountDownSec: 120 }),
      async () => {
        expect((await savedConfig()).config.deviceCode).toMatch(
          /^[\da-f-]{36}$/,
        );
      },
    );
    await expect(
      withManualSyncLock(env, "ctbc", "all", (syncEnv) =>
        syncCtbc(syncEnv, "manual"),
      ),
    ).rejects.toMatchObject({ name: "CtbcTwoStageRequiredError" });
    expect(first).toHaveBeenCalledTimes(4);
    const before = await savedConfig();
    expect(before.config.deviceSeed).toBe("private-seed");
    expect(before.config.pendingSession).toMatchObject({
      method: "app",
      transactionToken: "private-login",
    });
    expect(before.row.encrypted_config).not.toContain("private-");
    expect(before.row.sync_cursor).toBeNull();
    const view = await getConnectorSettingsView(env, "ctbc");
    expect(view).toMatchObject({
      verificationPending: true,
      verificationChannel: "app",
      verificationExpiresAt: before.config.pendingSession!.expiresAt,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /private-|synthetic-|deviceCode|deviceSeed|loginRequest|Token/,
    );
    expect(
      await env.DB.prepare(
        "SELECT last_status FROM sync_jobs WHERE connector_id = 'ctbc'",
      ).first("last_status"),
    ).toBe("needs_user_action");
    expect(await findNextDueSyncJob(env.DB)).toBeNull();

    // An outstanding challenge from the previous version already has the
    // bank-issued seed; upgrading must retain it when resuming the approval.
    const legacyConfig = { ...before.config };
    delete legacyConfig.deviceSeed;
    await env.DB.prepare(
      "UPDATE connector_settings SET encrypted_config = ? WHERE connector_id = 'ctbc'",
    )
      .bind(await encryptJson(legacyConfig, key))
      .run();

    const resumed = bankApi([
      Response.json({
        code: "0000",
        rsData: { keepListen: false, twoStageVerifySuccess: true },
      }),
      Response.json({ code: "0000", rsData: {} }),
      ...emptyAccounts(),
    ]);
    await withManualSyncLock(env, "ctbc", "all", (syncEnv) =>
      syncCtbc(syncEnv, "manual", { verification: "check" }),
    );
    const after = await savedConfig();
    expect(after.config.deviceCode).toBe(before.config.deviceCode);
    expect(after.config.deviceSeed).toBe(before.config.deviceSeed);
    expect(after.config.pendingSession).toBeUndefined();
    expect(after.row.sync_cursor).not.toMatch(
      /private-|deviceCode|deviceSeed|Token|loginRequest/,
    );
    expect(
      JSON.parse(String(resumed.mock.calls[1]?.[1]?.body)).rqData.loginType,
    ).toBe("TWO_STAGE_VERIFY");
    expect(await getConnectorSettingsView(env, "ctbc")).toMatchObject({
      verificationPending: false,
    });

    // This fixture checks reused identity. A real bank can still require MFA.
    const next = bankApi([
      ...bootstrap({ isTwoStageLogin: false }, "private-new-handshake-seed"),
      ...emptyAccounts(),
    ]);
    await syncCtbc(env, "scheduled");
    const requests = next.mock.calls
      .slice(2)
      .map(([, init]) => JSON.parse(String(init?.body)));
    expect(new Set(requests.map((request) => request.seed))).toEqual(
      new Set([before.config.deviceSeed]),
    );
    expect(new Set(requests.map((request) => request.deviceIxd))).toEqual(
      new Set([before.config.deviceCode!.replaceAll("-", "")]),
    );
    expect((await savedConfig()).config).toMatchObject({
      deviceCode: before.config.deviceCode,
      deviceSeed: before.config.deviceSeed,
    });
  });

  it.each(["expired", "denied"])(
    "%s 的驗證不重新登入、不查帳，清除暫存且排程仍暫停",
    async (mode) => {
      bankApi(bootstrap({ isTwoStageLogin: true, twoStageCountDownSec: 120 }));
      await expect(syncCtbc(env, "manual")).rejects.toMatchObject({
        name: "CtbcTwoStageRequiredError",
      });
      const before = await savedConfig();
      if (mode === "expired") {
        before.config.pendingSession!.expiresAt = "2020-01-01T00:00:00.000Z";
        await env.DB.prepare(
          "UPDATE connector_settings SET encrypted_config = ? WHERE connector_id = 'ctbc'",
        )
          .bind(await encryptJson(before.config, key))
          .run();
      }
      const fetcher = bankApi([
        Response.json({
          code: "0000",
          rsData: { keepListen: false, twoStageVerifySuccess: false },
        }),
      ]);
      await expect(
        withManualSyncLock(env, "ctbc", "all", (syncEnv) =>
          syncCtbc(syncEnv, "manual", { verification: "check" }),
        ),
      ).rejects.toMatchObject({ name: "CtbcVerificationExpiredError" });
      expect(fetcher).toHaveBeenCalledTimes(mode === "expired" ? 0 : 1);
      const after = await savedConfig();
      expect(after.config.deviceCode).toBe(before.config.deviceCode);
      expect(after.config.deviceSeed).toBe(before.config.deviceSeed);
      expect(after.config.pendingSession).toBeUndefined();
      expect(after.row.sync_cursor).toBeNull();
      expect(await findNextDueSyncJob(env.DB)).toBeNull();
    },
  );

  it("設定在登入後被更新時，舊同步不能覆蓋新憑證、cursor 或帳戶資料", async () => {
    const replacement = {
      ...credentials,
      password: "replacement-private-password",
    };
    bankApi(
      [
        ...bootstrap({}),
        Response.json({
          code: "0000",
          rsData: {
            twdAcctSummaryResponse: {
              demDepBalSummaryResponse: {
                infoList: [{ accountId: "123456789012", balance: 100.25 }],
              },
            },
          },
        }),
        Response.json({ code: "0000", rsData: {} }),
        ...Array.from({ length: 3 }, () =>
          Response.json({ code: "0000", rsData: { detailList: [] } }),
        ),
        Response.json({
          code: "0000",
          rsData: { cardDataList: [], billData: {} },
        }),
        Response.json({ code: "0000" }),
      ],
      async (index) => {
        if (index === 4)
          await env.DB.prepare(
            "UPDATE connector_settings SET encrypted_config = ? WHERE connector_id = 'ctbc'",
          )
            .bind(await encryptJson(replacement, key))
            .run();
      },
    );
    const failure = await syncCtbc(env, "manual").catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(NeedsUserActionError);
    expect(failure).toMatchObject({
      message: "中國信託設定在同步期間已變更，請重新同步。",
    });
    expect((await savedConfig()).config).toEqual(replacement);
    expect((await savedConfig()).row.sync_cursor).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM bank_accounts WHERE connector_id = 'ctbc'",
      ).first("count"),
    ).toBe(0);
  });
});
