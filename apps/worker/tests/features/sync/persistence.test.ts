import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  persistStagedSyncWrite,
  promoteStagedSyncWrite,
  stageSyncWriteRecords,
  type SyncWriteRecord,
} from "../../../src/features/sync/persistence";
import {
  connectorStateStatement,
  updateConnectorEncryptedConfigIfCurrent,
  linkCanonicalBankAccountsStatement,
} from "../../../src/features/sync/connector-repository";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
} from "../../../src/features/sync/record-mapper";
import { prepareTaishinAuthorizationWrite } from "../../../src/sources/taishin/authorizations";
import {
  parseTaishinCreditCardData,
  type TaishinCreditCardData,
  type TaishinCreditCardPayloads,
} from "../../../src/sources/taishin/protocol";
import {
  fetchTaishinDeposits,
  type TaishinDepositData,
} from "../../../src/sources/taishin/deposit-protocol";
import {
  listBankAccounts,
  listBankTransactions,
} from "../../../src/features/bank/repository";
import { rebuildBankDepositHistory } from "../../../src/features/net-worth/service";
import {
  bankNow,
  bill as taishinBill,
  depositRequest,
  emptyRealtime,
  emptyUnbilled,
  realtime,
  unbilled,
} from "../../sources/taishin/fixtures/bank-data";

const taishinBase: TaishinCreditCardPayloads = {
  summary: { error: null, value: {} },
  bills: [],
  realtime: emptyRealtime,
  unbilled: emptyUnbilled,
};
function taishinRecords(data: TaishinCreditCardData | TaishinDepositData) {
  return [
    ...data.bankAccounts.map((row) => bankAccountRecord("taishin", row, now)),
    ...data.bankBalanceSnapshots.map((row) =>
      bankBalanceSnapshotRecord("taishin", row, now),
    ),
    ...data.bankTransactions.map((row) =>
      bankTransactionRecord("taishin", row, now),
    ),
  ];
}

const now = "2026-09-01T10:30:00+08:00";
const account: SyncWriteRecord = {
  entityType: "bank_account",
  recordKey: "sinopac:card",
  payload: {
    id: "sinopac:card",
    connector_id: "sinopac",
    source_id: "card",
    account_type: "credit",
    currency: "TWD",
    raw_payload: "{}",
    created_at: now,
    updated_at: now,
  },
};
function transaction(status: "pending" | "posted"): SyncWriteRecord {
  return {
    entityType: "bank_transaction",
    recordKey: "sinopac:purchase",
    payload: {
      id: "sinopac:purchase",
      connector_id: "sinopac",
      account_id: account.recordKey,
      source_id: "purchase",
      amount: -252,
      currency: "TWD",
      authorized_at: status === "pending" ? now : "2026-09-01",
      posted_date: status === "posted" ? "2026-09-03" : null,
      status,
      raw_payload: JSON.stringify({ status }),
      created_at: now,
      updated_at: now,
    },
  };
}

describe("同步資料完整性（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;
  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
  }, 60_000);
  afterAll(async () => {
    await harness?.mf.dispose();
  });
  beforeEach(async () => {
    await db.batch([
      ...[
        "bank_transaction_preferences",
        "invoice_transaction_preferences",
        "classification_overrides",
        "invoices",
        "bank_balance_snapshots",
        "credit_card_bills",
        "bank_transactions",
        "bank_accounts",
        "sync_write_staging",
        "connector_settings",
      ].map((table) => db.prepare(`DELETE FROM ${table}`)),
      db.prepare(
        "INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at) VALUES ('sinopac', 'sinopac', 'old-config', 'old-cursor', 't', 't')",
      ),
    ]);
  });

  async function taishinSettings() {
    await db
      .prepare(
        "INSERT INTO connector_settings (id, connector_id, encrypted_config, sync_cursor, created_at, updated_at) VALUES ('taishin', 'taishin', 'config', 'old-cursor', 't', 't')",
      )
      .run();
  }
  async function writeTaishin(
    data: TaishinCreditCardData | TaishinDepositData,
  ) {
    const prepared = await prepareTaishinAuthorizationWrite(
      db,
      taishinRecords(data),
      "config",
    );
    return persistStagedSyncWrite(db, {
      records: prepared.records,
      settingsGuard: { connectorId: "taishin", encryptedConfig: "config" },
      afterPromoteStatements: [
        ...prepared.afterPromoteStatements,
        linkCanonicalBankAccountsStatement(db, {
          connectorId: "taishin",
          encryptedConfig: "config",
        }),
      ],
    });
  }

  it("台新授權消失、店名變化及出帳後只計一次，保留時間、分類、排除及發票關係", async () => {
    await taishinSettings();
    const pending = parseTaishinCreditCardData(
      { ...taishinBase, realtime },
      bankNow,
    );
    await writeTaishin(pending);
    const pendingId = taishinRecords(pending).find(
      (row) => row.entityType === "bank_transaction",
    )!.recordKey;
    await db.batch([
      db
        .prepare(
          "INSERT INTO bank_transaction_preferences VALUES (?, 1, 'created', 'updated')",
        )
        .bind(pendingId),
      db
        .prepare(
          "INSERT INTO classification_overrides VALUES ('taishin-category', 'bank_transaction', ?, 'shopping', 'created', 'updated')",
        )
        .bind(pendingId),
      db.prepare(
        "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES ('invoice', 'einvoice', 'invoice', '2026-10-05', 252, 't', 't')",
      ),
      db
        .prepare(
          "INSERT INTO invoice_transaction_preferences VALUES ('invoice', ?, 'linked', 'created', 'updated')",
        )
        .bind(pendingId),
    ]);
    const posted = parseTaishinCreditCardData(
      { ...taishinBase, unbilled },
      bankNow,
    );
    expect((await writeTaishin(posted)).bankTransactions).toBe(1);
    const postedId = taishinRecords(posted).find(
      (row) => row.entityType === "bank_transaction",
    )!.recordKey;
    for (const data of [
      posted,
      parseTaishinCreditCardData(
        { ...taishinBase, bills: [taishinBill] },
        bankNow,
      ),
      pending,
    ])
      expect((await writeTaishin(data)).bankTransactions).toBe(0);
    const visible = await listBankTransactions(db, 20);
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({
      id: postedId,
      amount: -252,
      currency: "TWD",
      status: "posted",
      authorizedAt: "2026-10-05T09:15:30+08:00",
      postedDate: "2026-10-06",
      calculationPreference: 1,
    });
    expect(
      await db
        .prepare(
          "SELECT matched_transaction_id FROM bank_transactions WHERE id = ?",
        )
        .bind(pendingId)
        .first("matched_transaction_id"),
    ).toBe(postedId);
    expect(
      await db
        .prepare(
          "SELECT category_id FROM classification_overrides WHERE target_id = ?",
        )
        .bind(postedId)
        .first("category_id"),
    ).toBe("shopping");
    expect(
      await db
        .prepare(
          "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = 'invoice'",
        )
        .first("transaction_id"),
    ).toBe(postedId);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM bank_transactions")
        .first("n"),
    ).toBe(2);
    expect(
      (await db.prepare("PRAGMA foreign_key_check").all()).results,
    ).toEqual([]);
  });

  it.each([
    "重複授權",
    "卡片不明",
    "店名不明",
    "不同卡",
    "不同消費日",
    "不同幣別",
    "不同方向",
  ])("台新不強配%s", async (scenario) => {
    await taishinSettings();
    const authorization = structuredClone(realtime);
    if (scenario === "重複授權")
      authorization.value.fmtRealTxListMap[0].txlist.push([
        ...authorization.value.fmtRealTxListMap[0].txlist[0],
      ]);
    if (scenario === "卡片不明")
      authorization.value.fmtRealTxListMap[0].cardname = "無卡號";
    if (scenario === "店名不明") {
      authorization.value.fmtRealTxListMap[0].txlist[0][2] = "";
      authorization.value.fmtRealTxListMap[0].txlist[0][6] = "";
    }
    await writeTaishin(
      parseTaishinCreditCardData(
        { ...taishinBase, realtime: authorization },
        bankNow,
      ),
    );
    const incoming = parseTaishinCreditCardData(
      { ...taishinBase, unbilled },
      bankNow,
    );
    if (scenario === "不同卡")
      incoming.bankTransactions[0].raw = { cardLast4: "5678" };
    if (scenario === "店名不明")
      incoming.bankTransactions[0].description = "台新信用卡交易";
    if (scenario === "不同消費日")
      incoming.bankTransactions[0].authorizedAt = "2026-10-04";
    if (scenario === "不同幣別") incoming.bankTransactions[0].currency = "USD";
    if (scenario === "不同方向") incoming.bankTransactions[0].amount = 252;
    await writeTaishin(incoming);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM bank_transactions WHERE matched_transaction_id IS NOT NULL",
        )
        .first("n"),
    ).toBe(0);
  });

  it("台新正式交易已有決定時保留分類、排除與發票衝突，不覆寫或重新分配關係", async () => {
    await taishinSettings();
    const pending = parseTaishinCreditCardData(
      { ...taishinBase, realtime },
      bankNow,
    );
    const posted = parseTaishinCreditCardData(
      { ...taishinBase, unbilled },
      bankNow,
    );
    await persistStagedSyncWrite(db, {
      records: [...taishinRecords(pending), ...taishinRecords(posted)],
    });
    const pendingId = taishinRecords(pending).find(
      (row) => row.entityType === "bank_transaction",
    )!.recordKey;
    const postedId = taishinRecords(posted).find(
      (row) => row.entityType === "bank_transaction",
    )!.recordKey;
    for (const [id, excluded, category] of [
      [pendingId, 1, "shopping"],
      [postedId, 0, "food"],
    ] as const) {
      await db.batch([
        db
          .prepare(
            "INSERT INTO bank_transaction_preferences VALUES (?, ?, 't', 't')",
          )
          .bind(id, excluded),
        db
          .prepare(
            "INSERT INTO classification_overrides VALUES (?, 'bank_transaction', ?, ?, 't', 't')",
          )
          .bind(`override:${id}`, id, category),
        db
          .prepare(
            "INSERT INTO invoices (id, connector_id, source_id, invoice_date, amount, created_at, updated_at) VALUES (?, 'einvoice', ?, '2026-10-05', 252, 't', 't')",
          )
          .bind(`invoice:${id}`, id),
        db
          .prepare(
            "INSERT INTO invoice_transaction_preferences VALUES (?, ?, 'linked', 't', 't')",
          )
          .bind(`invoice:${id}`, id),
      ]);
    }
    await writeTaishin(posted);
    expect(
      await db
        .prepare(
          "SELECT excluded_from_calculation FROM bank_transaction_preferences WHERE transaction_id = ?",
        )
        .bind(postedId)
        .first("excluded_from_calculation"),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT category_id FROM classification_overrides WHERE target_id = ?",
        )
        .bind(postedId)
        .first("category_id"),
    ).toBe("food");
    expect(
      await db
        .prepare(
          "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = ?",
        )
        .bind(`invoice:${pendingId}`)
        .first("transaction_id"),
    ).toBe(pendingId);
    expect(
      await db
        .prepare(
          "SELECT transaction_id FROM invoice_transaction_preferences WHERE invoice_id = ?",
        )
        .bind(`invoice:${postedId}`)
        .first("transaction_id"),
    ).toBe(postedId);
  });

  it("台新相同 ID 入帳及舊版借用授權 ID 的正式紀錄維持一筆", async () => {
    await taishinSettings();
    const pending = parseTaishinCreditCardData(
      { ...taishinBase, realtime },
      bankNow,
    );
    await writeTaishin(pending);
    const sameId = structuredClone(pending);
    sameId.bankTransactions[0].status = "posted";
    sameId.bankTransactions[0].postedDate = "2026-10-06";
    sameId.bankTransactions[0].authorizedAt = "2026-10-05";
    await writeTaishin(sameId);
    const official = parseTaishinCreditCardData(
      { ...taishinBase, unbilled },
      bankNow,
    );
    expect((await writeTaishin(official)).bankTransactions).toBe(0);
    expect(await listBankTransactions(db, 20)).toHaveLength(1);
    expect((await listBankTransactions(db, 20))[0].authorizedAt).toBe(
      "2026-10-05T09:15:30+08:00",
    );
  });

  it("台新 promotion 失敗一起回滾配對與 cursor，憑證變更後舊同步也不能移動偏好", async () => {
    await taishinSettings();
    const pending = parseTaishinCreditCardData(
      { ...taishinBase, realtime },
      bankNow,
    );
    const posted = parseTaishinCreditCardData(
      { ...taishinBase, unbilled },
      bankNow,
    );
    await writeTaishin(pending);
    const prepared = await prepareTaishinAuthorizationWrite(
      db,
      taishinRecords(posted),
      "config",
    );
    const finalize = connectorStateStatement(
      db,
      "taishin",
      "new-session",
      null,
      "new-cursor",
      now,
      "config",
    );
    await expect(
      persistStagedSyncWrite(db, {
        records: prepared.records,
        settingsGuard: { connectorId: "taishin", encryptedConfig: "config" },
        afterPromoteStatements: prepared.afterPromoteStatements,
        finalizeStatements: [
          finalize,
          db.prepare(
            "INSERT INTO bank_transaction_preferences VALUES ('missing', 1, 't', 't')",
          ),
        ],
      }),
    ).rejects.toThrow();
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM bank_transactions")
        .first("n"),
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT matched_transaction_id FROM bank_transactions")
        .first("matched_transaction_id"),
    ).toBeNull();
    expect(
      await db
        .prepare(
          "SELECT sync_cursor FROM connector_settings WHERE connector_id = 'taishin'",
        )
        .first("sync_cursor"),
    ).toBe("old-cursor");
    // Both transactions already exist: clearing staging alone would not protect
    // their relationship from a stale authorization promotion.
    await persistStagedSyncWrite(db, { records: taishinRecords(posted) });
    const stale = await prepareTaishinAuthorizationWrite(db, [], "config");
    await db
      .prepare(
        "UPDATE connector_settings SET encrypted_config = 'changed' WHERE connector_id = 'taishin'",
      )
      .run();
    await persistStagedSyncWrite(db, {
      records: stale.records,
      settingsGuard: { connectorId: "taishin", encryptedConfig: "config" },
      afterPromoteStatements: stale.afterPromoteStatements,
      finalizeStatements: [finalize],
    });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM bank_transactions WHERE matched_transaction_id IS NOT NULL",
        )
        .first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT encrypted_config, sync_cursor FROM connector_settings WHERE connector_id = 'taishin'",
        )
        .first(),
    ).toEqual({ encrypted_config: "changed", sync_cursor: "old-cursor" });
  });

  it("台新無卡仍保存存款，重抓不增副本，集保同帳戶不重複計入資產", async () => {
    await taishinSettings();
    const deposits = await fetchTaishinDeposits(depositRequest, bankNow);
    const credit = parseTaishinCreditCardData(
      { ...taishinBase, hasCreditCard: false },
      bankNow,
    );
    const merged = {
      bankAccounts: [...deposits.bankAccounts, ...credit.bankAccounts],
      bankBalanceSnapshots: [
        ...deposits.bankBalanceSnapshots,
        ...credit.bankBalanceSnapshots,
      ],
      bankTransactions: [
        ...deposits.bankTransactions,
        ...credit.bankTransactions,
      ],
    };
    const settlement = bankAccountRecord(
      "tdcc",
      {
        sourceId: "settlement:812:1234:TWD",
        accountType: "settlement_cash",
        currency: "TWD",
      },
      now,
    );
    await persistStagedSyncWrite(db, {
      records: [
        settlement,
        bankBalanceSnapshotRecord(
          "tdcc",
          {
            accountId: "settlement:812:1234:TWD",
            sourceId: "balance",
            balance: 1000,
            currency: "TWD",
            asOfAt: bankNow.toISOString(),
          },
          now,
        ),
      ],
    });
    expect((await writeTaishin(merged)).bankTransactions).toBe(5);
    expect((await writeTaishin(merged)).bankTransactions).toBe(0);
    await db
      .prepare(
        "INSERT INTO exchange_rates (currency, rate_to_twd, updated_at) VALUES ('USD', 31, 't') ON CONFLICT(currency) DO UPDATE SET rate_to_twd = 31",
      )
      .run();
    const accounts = await listBankAccounts(db);
    expect(accounts).toHaveLength(3);
    expect(
      accounts.every(
        (row) => row.connectorId === "taishin" && row.bankCode === "812",
      ),
    ).toBe(true);
    expect(accounts.find((row) => row.currency === "TWD")).toMatchObject({
      accountLast4: "1234",
      accountName: "末四碼 1234",
      balance: 2000,
    });
    await rebuildBankDepositHistory(db, ["2026-10-07"]);
    expect(
      await db
        .prepare(
          "SELECT net_worth FROM net_worth_history WHERE id = 'bank:deposit:2026-10-07'",
        )
        .first("net_worth"),
    ).toBe(5883);
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM bank_balance_snapshots WHERE connector_id = 'taishin'",
        )
        .first("n"),
    ).toBe(3);
  });

  it("重抓與入帳只保留一筆交易、原始時刻及使用者排除決定，空結果也保留歷史", async () => {
    const records = [account, transaction("pending")];
    expect(
      (await persistStagedSyncWrite(db, { records })).bankTransactions,
    ).toBe(1);
    await db
      .prepare(
        "INSERT INTO bank_transaction_preferences VALUES ('sinopac:purchase', 1, 'created', 'updated')",
      )
      .run();
    for (const records of [
      [transaction("posted")],
      [transaction("pending")],
      [],
    ]) {
      expect(
        (await persistStagedSyncWrite(db, { records })).bankTransactions,
      ).toBe(0);
    }
    expect(
      (
        await db
          .prepare(
            "SELECT id, amount, status, authorized_at, posted_date, raw_payload FROM bank_transactions",
          )
          .all()
      ).results,
    ).toEqual([
      {
        id: "sinopac:purchase",
        amount: -252,
        status: "posted",
        authorized_at: now,
        posted_date: "2026-09-03",
        raw_payload: JSON.stringify({ status: "posted" }),
      },
    ]);
    expect(
      await db.prepare("SELECT * FROM bank_transaction_preferences").first(),
    ).toEqual({
      transaction_id: "sinopac:purchase",
      excluded_from_calculation: 1,
      created_at: "created",
      updated_at: "updated",
    });
  });

  it("後續資料缺少繳款欄位時保留已確認的繳款資料", async () => {
    const bill: SyncWriteRecord = {
      entityType: "credit_card_bill",
      recordKey: "sinopac:bill",
      payload: {
        id: "sinopac:bill",
        connector_id: "sinopac",
        account_id: account.recordKey,
        source_id: "bill",
        billing_period: "2026-09",
        statement_amount: 1000,
        paid_amount: 1000,
        is_paid: 1,
        currency: "TWD",
        raw_payload: "{}",
        created_at: now,
        updated_at: now,
      },
    };
    await persistStagedSyncWrite(db, { records: [account, bill] });
    await persistStagedSyncWrite(db, {
      records: [
        {
          ...bill,
          payload: { ...bill.payload, paid_amount: null, is_paid: null },
        },
      ],
    });
    expect(
      await db
        .prepare("SELECT paid_amount, is_paid FROM credit_card_bills")
        .first(),
    ).toEqual({ paid_amount: 1000, is_paid: 1 });
  });

  it("暫存後變更憑證時，舊同步不能寫入金融資料或覆蓋新憑證與 cursor", async () => {
    const records = [account, transaction("posted")];
    await stageSyncWriteRecords(db, "stale-run", records);
    await db
      .prepare(
        "UPDATE connector_settings SET encrypted_config = 'new-config', sync_cursor = NULL WHERE connector_id = 'sinopac'",
      )
      .run();
    const staleState = connectorStateStatement(
      db,
      "sinopac",
      "stale-session",
      null,
      "stale-cursor",
      now,
      "old-config",
    );
    await promoteStagedSyncWrite(db, {
      runId: "stale-run",
      entityTypes: ["bank_account", "bank_transaction"],
      settingsGuard: { connectorId: "sinopac", encryptedConfig: "old-config" },
      finalizeStatements: [staleState],
    });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM bank_accounts").first("n"),
    ).toBe(0);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM bank_transactions")
        .first("n"),
    ).toBe(0);
    expect(
      await updateConnectorEncryptedConfigIfCurrent(
        db,
        "sinopac",
        "old-config",
        "stale-session",
      ),
    ).toBe(false);
    expect((await staleState.run()).meta.changes).toBe(0);
    expect(
      await db
        .prepare("SELECT encrypted_config, sync_cursor FROM connector_settings")
        .first(),
    ).toEqual({ encrypted_config: "new-config", sync_cursor: null });
    expect(
      (
        await persistStagedSyncWrite(db, {
          records,
          settingsGuard: {
            connectorId: "sinopac",
            encryptedConfig: "new-config",
          },
          finalizeStatements: [
            connectorStateStatement(
              db,
              "sinopac",
              "current-session",
              null,
              "current-cursor",
              now,
              "new-config",
            ),
          ],
        })
      ).bankTransactions,
    ).toBe(1);
    expect(
      await db
        .prepare("SELECT encrypted_config, sync_cursor FROM connector_settings")
        .first(),
    ).toEqual({
      encrypted_config: "current-session",
      sync_cursor: "current-cursor",
    });
  });
});
