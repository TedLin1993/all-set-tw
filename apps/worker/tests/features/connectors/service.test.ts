import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectorCatalog, type ConnectorId } from "@taiwan-fin-hub/shared";
import { createTestD1 } from "../../helpers/d1";
import { getConnectorSettings } from "../../../src/db";
import { decryptJson, encryptJson } from "../../../src/platform/crypto";
import type { Env } from "../../../src/platform/env";
import {
  ConnectorSyncRunningError,
  getConnectorDataSummary,
  getConnectorSettingsView,
  unlinkConnector,
  updateConnectorSettings,
} from "../../../src/features/connectors/service";
import { saveConnectorSettings } from "../../../src/features/connectors/repository";
import { calculateBankDepositValue } from "../../../src/features/net-worth/repository";

const key = "synthetic-test-encryption-key";
const credentials = {
  userId: "A123456789",
  account: "synthetic-user",
  password: "synthetic-password",
};

describe("連線設定的憑證安全（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  beforeAll(async () => {
    harness = await createTestD1();
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });

  // Zod 3 接受所有 8-4-4-4-12 十六進位裝置識別碼；升級不得拒絕既有設定。
  it("證券來源加密儲存帳密，公開設定不回傳帳密、cookie 或憑證", async () => {
    const env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
    await updateConnectorSettings(env, "sinotrade", {
      userId: credentials.userId,
      password: credentials.password,
    });
    const state = {
      userId: credentials.userId,
      password: credentials.password,
      webState: {
        newweb: {
          cookies: [
            {
              name: "ASP.NET_SessionId",
              value: "synthetic-cookie",
              domain: ".sinotrade.com.tw",
              path: "/",
            },
          ],
          localStorage: {
            TWCACertIdxRef: '{"TWCA123":{}}',
            TWCA123: "synthetic-certificate",
            newweb_token: "synthetic-token",
          },
          capturedAt: "2027-01-01T00:00:00.000Z",
        },
      },
    };
    await env.DB.prepare(
      "UPDATE connector_settings SET encrypted_config = ? WHERE connector_id = 'sinotrade'",
    )
      .bind(await encryptJson(state, key))
      .run();
    const view = await getConnectorSettingsView(env, "sinotrade");
    expect(view).toMatchObject({
      configured: true,
      credentialsComplete: true,
      sessionAvailable: false,
      publicConfig: null,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /synthetic-cookie|synthetic-certificate|synthetic-token|webState|A123456789|synthetic-password/,
    );
    const stored = await getConnectorSettings(env.DB, "sinotrade");
    expect(stored!.encrypted_config).not.toContain("synthetic-certificate");
  });
  it("更新新光設定時保留舊版可接受的裝置識別碼與加密憑證", async () => {
    const env = {
      DB: harness.binding,
      CONFIG_ENCRYPTION_KEY: key,
      GENERATED_CONFIG_ENCRYPTION_KEY: "synthetic-unused-generated-key",
    } as Env;
    const config = {
      nationalId: credentials.userId,
      alias: credentials.account,
      password: credentials.password,
      deviceId: "00000000-0000-0000-0000-000000000001",
    };
    await updateConnectorSettings(env, "skbank", config);
    await updateConnectorSettings(env, "skbank", {});

    const stored = await getConnectorSettings(env.DB, "skbank");
    expect(await decryptJson(stored!.encrypted_config, key)).toEqual(config);
    expect(stored?.encrypted_config).not.toContain(config.password);
    expect(
      JSON.stringify(await getConnectorSettingsView(env, "skbank")),
    ).not.toContain(config.deviceId);
  });

  it("auto 使用已保存的隨機金鑰，重新部署後仍可讀取既有設定", async () => {
    const generatedKey = "a".repeat(64);
    const env = {
      DB: harness.binding,
      CONFIG_ENCRYPTION_KEY: "auto",
      GENERATED_CONFIG_ENCRYPTION_KEY: generatedKey,
    } as Env;
    await updateConnectorSettings(env, "taishin", credentials);
    const stored = await getConnectorSettings(env.DB, "taishin");
    expect(await decryptJson(stored!.encrypted_config, generatedKey)).toEqual(
      credentials,
    );
    await expect(
      decryptJson(stored!.encrypted_config, "auto"),
    ).rejects.toThrow();

    await updateConnectorSettings({ ...env }, "taishin", {});
    expect(await getConnectorSettingsView({ ...env }, "taishin")).toMatchObject(
      {
        configured: true,
        credentialsComplete: true,
      },
    );
    expect(
      JSON.stringify(await getConnectorSettingsView(env, "taishin")),
    ).not.toContain(generatedKey);
  });

  it("auto 缺少真正金鑰時拒絕寫入，也不把 auto 本身當成金鑰", async () => {
    const env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: "auto" } as Env;
    for (const generatedKey of [undefined, "auto"]) {
      await expect(
        updateConnectorSettings(
          { ...env, GENERATED_CONFIG_ENCRYPTION_KEY: generatedKey },
          "esun",
          credentials,
        ),
      ).rejects.toThrow(/requires GENERATED_CONFIG_ENCRYPTION_KEY/);
    }
    expect(await getConnectorSettings(env.DB, "esun")).toBeNull();
  });

  it("主金鑰設定遺失時不自動切換到 generated 金鑰", async () => {
    const env = {
      DB: harness.binding,
      GENERATED_CONFIG_ENCRYPTION_KEY: "synthetic-generated-key",
    } as Env;
    await expect(
      updateConnectorSettings(env, "esun", credentials),
    ).rejects.toThrow(/CONFIG_ENCRYPTION_KEY is required/);
    expect(await getConnectorSettings(env.DB, "esun")).toBeNull();
  });

  it("加密儲存且公開 view 不洩漏秘密，變更帳密後移除舊 session 與 cursor", async () => {
    const env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
    await updateConnectorSettings(env, "sinopac", credentials);
    const encrypted = await encryptJson(
      {
        ...credentials,
        protocol: "sinopac-mobile-app-json-v1",
        sessionCookies: "synthetic-private-cookie",
        browserSessionId: "synthetic-private-challenge",
        captcha: "123456",
      },
      key,
    );
    await env.DB.prepare(
      "UPDATE connector_settings SET encrypted_config = ?, sync_cursor = 'old-cursor' WHERE connector_id = 'sinopac'",
    )
      .bind(encrypted)
      .run();
    const stored = await getConnectorSettings(env.DB, "sinopac");
    expect(stored?.encrypted_config).not.toContain(credentials.password);
    expect(stored?.encrypted_config).not.toContain("synthetic-private");
    await expect(decryptJson(encrypted, "incorrect-key")).rejects.toThrow();
    const view = await getConnectorSettingsView(env, "sinopac");
    expect(view).toMatchObject({
      configured: true,
      credentialsComplete: true,
      sessionAvailable: true,
      publicConfig: null,
    });
    expect(JSON.stringify(view)).not.toMatch(
      /synthetic-|sessionCookies|password|captcha/,
    );

    await updateConnectorSettings(env, "sinopac", { account: "new-user" });
    const updated = await getConnectorSettings(env.DB, "sinopac");
    expect(await decryptJson(updated!.encrypted_config, key)).toEqual({
      ...credentials,
      account: "new-user",
    });
    expect(updated?.sync_cursor).toBeNull();
    expect(updated?.public_config).toBeNull();
    expect(updated?.id).toBe(stored?.id);
    expect(await getConnectorSettingsView(env, "sinopac")).toMatchObject({
      credentialsComplete: true,
      sessionAvailable: false,
    });
  });

  it("中信換密碼保留裝置但清除待驗證登入，切換帳號才更換裝置", async () => {
    const env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
    const deviceCode = "11111111-2222-4333-8444-555555555555";
    await updateConnectorSettings(env, "ctbc", credentials);
    await env.DB.prepare(
      "UPDATE connector_settings SET encrypted_config = ?, sync_cursor = 'old-cursor' WHERE connector_id = 'ctbc'",
    )
      .bind(
        await encryptJson(
          {
            ...credentials,
            deviceCode,
            deviceSeed: "private-device-seed",
            pendingSession: {
              clientNo: "private-client",
              accessToken: "private-access",
              xAuthToken: "private-auth",
              transactionToken: "private-transaction",
              seed: "private-seed",
              loginRequest: { pin: "private-pin" },
              method: "email",
              expiresAt: new Date(Date.now() + 120_000).toISOString(),
            },
          },
          key,
        ),
      )
      .run();
    const view = await getConnectorSettingsView(env, "ctbc");
    expect(view).toMatchObject({
      verificationPending: true,
      verificationChannel: "email",
    });
    expect(JSON.stringify(view)).not.toMatch(
      /private-|deviceCode|deviceSeed|synthetic-|Token|pin/,
    );
    await updateConnectorSettings(env, "ctbc", { password: "new-password" });
    let stored = (await getConnectorSettings(env.DB, "ctbc"))!;
    expect(await decryptJson(stored.encrypted_config, key)).toEqual({
      ...credentials,
      password: "new-password",
      deviceCode,
      deviceSeed: "private-device-seed",
    });
    expect(stored.sync_cursor).toBeNull();
    await updateConnectorSettings(env, "ctbc", { account: "different-user" });
    stored = (await getConnectorSettings(env.DB, "ctbc"))!;
    expect(await decryptJson(stored.encrypted_config, key)).toEqual({
      ...credentials,
      password: "new-password",
      account: "different-user",
    });
  });
  it("依各來源保存的 secret state 回報 session 與待驗證狀態", async () => {
    const env = { DB: harness.binding, CONFIG_ENCRYPTION_KEY: key } as Env;
    const future = new Date(Date.now() + 120_000).toISOString();
    const past = new Date(Date.now() - 120_000).toISOString();
    async function viewWith(
      connectorId: ConnectorId,
      secret: Record<string, unknown>,
      withCredentials = true,
    ) {
      const creds = withCredentials
        ? Object.fromEntries(
            connectorCatalog[connectorId].credentialFields.map(({ key }) => [
              key,
              `synthetic-${key}`,
            ]),
          )
        : {};
      await saveConnectorSettings(env.DB, {
        id: `view-${connectorId}`,
        connectorId,
        encryptedConfig: await encryptJson({ ...creds, ...secret }, key),
        publicConfig: null,
        now: new Date().toISOString(),
      });
      const view = await getConnectorSettingsView(env, connectorId);
      return {
        sessionAvailable: view.sessionAvailable,
        verificationPending: view.verificationPending,
        verificationChannel: view.verificationChannel,
        verificationExpiresAt: view.verificationExpiresAt,
      };
    }
    const none = {
      sessionAvailable: false,
      verificationPending: false,
      verificationChannel: null,
      verificationExpiresAt: null,
    };
    const deviceCookie = (expires: number) =>
      JSON.stringify([
        {
          name: "CUB.eBank.DeviceId",
          value: "synthetic-device",
          expires,
          domain: ".cathaybk.com.tw",
        },
      ]);

    expect(await viewWith("tdcc", { session: { tokenId: "t" } })).toEqual({
      ...none,
      sessionAvailable: true,
    });
    expect(
      await viewWith("tdcc", { session: { tokenId: "t" } }, false),
    ).toEqual(none);
    for (const connectorId of ["esun", "taishin", "firstbank", "hncb"] as const)
      expect(await viewWith(connectorId, { sessionCookies: "c" })).toEqual({
        ...none,
        sessionAvailable: true,
      });
    expect(await viewWith("esun", { sessionCookies: "" })).toEqual(none);
    expect(
      await viewWith("sinopac", {
        sessionCookies: "c",
        protocol: "sinopac-mobile-app-json-v1",
      }),
    ).toEqual({ ...none, sessionAvailable: true });
    expect(await viewWith("sinopac", { sessionCookies: "c" })).toEqual(none);
    expect(await viewWith("megabank", { sessionCookies: "c" })).toEqual(none);
    expect(
      await viewWith("cathaybk", {
        sessionCookies: deviceCookie(Date.now() / 1000 + 3_600),
        browserSessionId: "b",
        browserSessionExpiresAt: future,
        otpChannel: "sms",
      }),
    ).toEqual({
      sessionAvailable: true,
      verificationPending: true,
      verificationChannel: "sms",
      verificationExpiresAt: future,
    });
    expect(
      await viewWith("cathaybk", {
        sessionCookies: deviceCookie(Date.now() / 1000 - 3_600),
        browserSessionId: "b",
        browserSessionExpiresAt: past,
        otpChannel: "sms",
      }),
    ).toEqual({ ...none, verificationExpiresAt: past });
    expect(
      await viewWith("ctbc", {
        pendingSession: {
          clientNo: "c",
          accessToken: "a",
          xAuthToken: "x",
          transactionToken: "t",
          seed: "s",
          loginRequest: {},
          method: "app",
          expiresAt: past,
        },
      }),
    ).toEqual({ ...none, verificationExpiresAt: past });
  });
});

describe("解除連結資料來源（隔離 D1）", () => {
  const T = "2026-01-05T00:00:00.000Z";
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;
  let env: Env;
  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
    env = { DB: db, CONFIG_ENCRYPTION_KEY: key } as Env;
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });

  const run = (query: string, ...values: unknown[]) =>
    db
      .prepare(query)
      .bind(...values)
      .run();
  const count = async (query: string, ...values: unknown[]) =>
    (await db
      .prepare(query)
      .bind(...values)
      .first<number>("n"))!;
  const account = (id: string, connectorId: string, type: string) =>
    run(
      "INSERT INTO bank_accounts (id, connector_id, source_id, account_type, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      id,
      connectorId,
      id,
      type,
      T,
      T,
    );
  const snapshot = (
    accountId: string,
    connectorId: string,
    date: string,
    balance: number,
  ) =>
    run(
      "INSERT INTO bank_balance_snapshots (id, connector_id, account_id, source_id, balance, as_of_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      `${accountId}:${date}`,
      connectorId,
      accountId,
      date,
      balance,
      `${date}T00:00:00.000Z`,
      T,
      T,
    );
  const transaction = (id: string, connectorId: string, accountId: string) =>
    run(
      "INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, created_at, updated_at) VALUES (?, ?, ?, ?, '2026-01-03', -100, ?, ?)",
      id,
      connectorId,
      accountId,
      id,
      T,
      T,
    );
  const invoice = (id: string) =>
    run(
      "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES (?, 'einvoice', ?, '2026-01-03', 100, ?, ?)",
      id,
      id,
      T,
      T,
    );

  it("只解除連結時刪除憑證與 run 內的憑證副本並重設同步狀態，保留資料；同步中拒絕", async () => {
    await updateConnectorSettings(env, "tdcc", {
      nationalId: credentials.userId,
      password: credentials.password,
    });
    await account("tdcc:settlement", "tdcc", "settlement_cash");
    await run(
      "INSERT INTO tdcc_sync_runs (id, trigger, status, encrypted_config, encrypted_session, created_at, updated_at) VALUES ('tdcc-run', 'manual', 'completed', 'synthetic-config-copy', 'synthetic-session-copy', ?, ?)",
      T,
      T,
    );
    await run(
      "UPDATE sync_jobs SET enabled = 1, last_success_at = ?1, last_status = 'failed', last_error = 'synthetic', last_error_code = 'SYNC_FAILED', locked_until = '2999-01-01T00:00:00.000Z', locked_by = 'other-run' WHERE connector_id = 'tdcc'",
      T,
    );

    await expect(unlinkConnector(db, "tdcc", false)).rejects.toBeInstanceOf(
      ConnectorSyncRunningError,
    );
    expect(await getConnectorSettings(db, "tdcc")).not.toBeNull();

    await run(
      "UPDATE sync_jobs SET locked_until = NULL, locked_by = NULL WHERE connector_id = 'tdcc'",
    );
    expect(await unlinkConnector(db, "tdcc", false)).toEqual({
      connectorId: "tdcc",
      configured: false,
      dataDeleted: false,
    });
    expect(await getConnectorSettings(db, "tdcc")).toBeNull();
    expect(await getConnectorSettingsView(env, "tdcc")).toMatchObject({
      configured: false,
    });
    expect(await count("SELECT COUNT(*) AS n FROM tdcc_sync_runs")).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT enabled, last_success_at, last_status, last_error, last_error_code FROM sync_jobs WHERE id = 'tdcc:all'",
        )
        .first(),
    ).toEqual({
      enabled: 0,
      last_success_at: null,
      last_status: null,
      last_error: null,
      last_error_code: null,
    });
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM bank_accounts WHERE connector_id = 'tdcc'",
      ),
    ).toBe(1);
  });

  it("刪除資料時清掉該來源所有資料與指向它的引用，保留其他來源與無法重建的決定，並重算存款歷史", async () => {
    await updateConnectorSettings(env, "taishin", credentials);
    await account("taishin:deposit", "taishin", "savings");
    await account("taishin:card", "taishin", "credit");
    await account("firstbank:deposit", "firstbank", "savings");
    // 非直連來源的同一個帳戶，合併到被刪除的直連帳戶。
    await account("tdcc:mirror", "tdcc", "settlement_cash");
    await run(
      "UPDATE bank_accounts SET canonical_account_id = 'taishin:deposit' WHERE id = 'tdcc:mirror'",
    );
    await snapshot("taishin:deposit", "taishin", "2026-01-01", 1000);
    await snapshot("taishin:deposit", "taishin", "2026-01-03", 1500);
    await snapshot("firstbank:deposit", "firstbank", "2026-01-02", 500);
    // 合併帳戶的餘額早於被刪帳戶；解除合併後，這段較早的歷史也要重算。
    await snapshot("tdcc:mirror", "tdcc", "2025-12-31", 1500);
    for (const date of [
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ])
      await run(
        "INSERT INTO net_worth_history (id, date, net_worth, asset_type, source, snapshotted_at) VALUES (?, ?, 99999, 'deposit', 'bank', ?)",
        `bank:deposit:${date}`,
        date,
        T,
      );
    await run(
      "INSERT INTO credit_card_bills (id, connector_id, account_id, source_id, billing_period, created_at, updated_at) VALUES ('bill', 'taishin', 'taishin:card', 'bill', '2026-01', ?, ?)",
      T,
      T,
    );

    await transaction("taishin:transfer", "taishin", "taishin:deposit");
    await transaction("firstbank:transfer", "firstbank", "firstbank:deposit");
    await run(
      "UPDATE bank_transactions SET transfer_peer_id = CASE id WHEN 'taishin:transfer' THEN 'firstbank:transfer' ELSE 'taishin:transfer' END WHERE id IN ('taishin:transfer', 'firstbank:transfer')",
    );
    await transaction("taishin:card-spend", "taishin", "taishin:card");
    await transaction("firstbank:spend", "firstbank", "firstbank:deposit");
    for (const transactionId of ["taishin:card-spend", "firstbank:spend"]) {
      await run(
        "INSERT INTO classification_overrides VALUES (?, 'bank_transaction', ?, 'shopping', ?, ?)",
        `override:${transactionId}`,
        transactionId,
        T,
        T,
      );
      await run(
        "INSERT INTO bank_transaction_preferences (transaction_id, note, created_at, updated_at) VALUES (?, 'synthetic note', ?, ?)",
        transactionId,
        T,
        T,
      );
    }
    await run(
      "INSERT INTO ai_classifications (transaction_id, category_id, probability, input_hash, model, created_at, updated_at) VALUES ('taishin:card-spend', 'shopping', 0.9, 'hash', 'model', ?, ?)",
      T,
      T,
    );
    for (const id of ["invoice:linked", "invoice:separate", "invoice:other"])
      await invoice(id);
    await run(
      "INSERT INTO invoice_transaction_preferences VALUES ('invoice:linked', 'taishin:card-spend', 'linked', ?, ?), ('invoice:separate', 'taishin:transfer', 'separate', ?, ?), ('invoice:other', 'firstbank:spend', 'linked', ?, ?)",
      T,
      T,
      T,
      T,
      T,
      T,
    );
    await run(
      "INSERT INTO bank_account_payment_accounts (account_id, payment_account_id, created_at, updated_at) VALUES ('taishin:card', 'taishin:deposit', ?1, ?1), ('firstbank:card', 'taishin:deposit', ?1, ?1), ('firstbank:loan', 'firstbank:deposit', ?1, ?1)",
      T,
    );
    await run(
      "INSERT INTO scheduled_sync_batches (id, created_at) VALUES ('batch', ?)",
      T,
    );
    for (const connectorId of ["taishin", "firstbank"]) {
      await run(
        "INSERT INTO sync_activity_runs (id, batch_id, connector_id, created_at) VALUES (?1, 'batch', ?1, ?2)",
        connectorId,
        T,
      );
      await run(
        "INSERT INTO sync_activity_changes (run_id, entity_type, record_id, change_kind, snapshot) VALUES (?, 'bank_transaction', 'record', 'created', '{}')",
        connectorId,
      );
      await run(
        "INSERT INTO scheduled_sync_batch_results (batch_id, job_id, connector_id, status) VALUES ('batch', ?, ?, 'success')",
        `${connectorId}:all`,
        connectorId,
      );
    }

    expect(await getConnectorDataSummary(db, "taishin")).toEqual({
      connectorId: "taishin",
      data: {
        accounts: 2,
        transactions: 2,
        balanceSnapshots: 2,
        creditCardBills: 1,
        invoices: 0,
        investmentPositions: 0,
        investmentTransactions: 0,
      },
      userEdits: {
        categoryOverrides: 1,
        transactionPreferences: 1,
        invoiceLinks: 2,
        paymentAccounts: 2,
      },
    });

    await unlinkConnector(db, "taishin", true);

    for (const table of [
      "bank_accounts",
      "bank_transactions",
      "bank_balance_snapshots",
      "credit_card_bills",
      "sync_activity_runs",
      "scheduled_sync_batch_results",
    ])
      expect(
        await count(
          `SELECT COUNT(*) AS n FROM ${table} WHERE connector_id = 'taishin'`,
        ),
      ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM sync_activity_changes WHERE run_id = 'taishin'",
      ),
    ).toBe(0);
    expect(await getConnectorSettings(db, "taishin")).toBeNull();
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM ai_classifications WHERE transaction_id = 'taishin:card-spend'",
      ),
    ).toBe(0);
    // 其他來源的交易與使用者決定保留，只清掉指向被刪交易的引用。
    expect(
      await db
        .prepare(
          "SELECT transfer_peer_id FROM bank_transactions WHERE id = 'firstbank:transfer'",
        )
        .first("transfer_peer_id"),
    ).toBeNull();
    expect(
      (
        await db
          .prepare(
            "SELECT target_id FROM classification_overrides ORDER BY target_id",
          )
          .all()
      ).results,
    ).toEqual([{ target_id: "firstbank:spend" }]);
    expect(
      (
        await db
          .prepare(
            "SELECT transaction_id FROM bank_transaction_preferences ORDER BY transaction_id",
          )
          .all()
      ).results,
    ).toEqual([{ transaction_id: "firstbank:spend" }]);
    expect(
      (
        await db
          .prepare(
            "SELECT invoice_id, transaction_id, decision FROM invoice_transaction_preferences ORDER BY invoice_id",
          )
          .all()
      ).results,
    ).toEqual([
      {
        invoice_id: "invoice:other",
        transaction_id: "firstbank:spend",
        decision: "linked",
      },
      {
        invoice_id: "invoice:separate",
        transaction_id: null,
        decision: "separate",
      },
    ]);
    expect(
      (
        await db
          .prepare("SELECT account_id FROM bank_account_payment_accounts")
          .all()
      ).results,
    ).toEqual([{ account_id: "firstbank:loan" }]);
    expect(
      await db
        .prepare(
          "SELECT canonical_account_id FROM bank_accounts WHERE id = 'tdcc:mirror'",
        )
        .first("canonical_account_id"),
    ).toBeNull();
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM scheduled_sync_batch_results WHERE connector_id = 'firstbank'",
      ),
    ).toBe(1);

    // 存款歷史與逐日計算一致；早於剩餘最早餘額的日期移除。
    const history = (
      await db
        .prepare(
          "SELECT date, net_worth FROM net_worth_history WHERE source = 'bank' ORDER BY date",
        )
        .all<{ date: string; net_worth: number }>()
    ).results;
    expect(history.map(({ date }) => date)).toEqual([
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
      "2026-01-04",
    ]);
    for (const { date, net_worth } of history)
      expect(net_worth).toBe(await calculateBankDepositValue(db, date));
    expect(history.map(({ net_worth }) => net_worth)).toEqual([
      1500, 1500, 2000, 2000, 2000,
    ]);

    expect(await getConnectorDataSummary(db, "taishin")).toMatchObject({
      data: { accounts: 0, transactions: 0, balanceSnapshots: 0 },
      userEdits: { categoryOverrides: 0, invoiceLinks: 0, paymentAccounts: 0 },
    });

    // 刪除發票來源時，發票與它的配對決定一起刪除，交易保留。
    await unlinkConnector(db, "einvoice", true);
    expect(await count("SELECT COUNT(*) AS n FROM invoices")).toBe(0);
    expect(
      await count("SELECT COUNT(*) AS n FROM invoice_transaction_preferences"),
    ).toBe(0);
    expect(
      await count(
        "SELECT COUNT(*) AS n FROM bank_transactions WHERE id = 'firstbank:spend'",
      ),
    ).toBe(1);
  });
});
