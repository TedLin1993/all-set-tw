import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { unstable_splitSqlQuery } from "wrangler";
import { createTestD1, readMigrations } from "../../helpers/d1";
import { persistStagedSyncWrite } from "../../../src/features/sync/persistence";
import {
  bankAccountRecord,
  bankTransactionRecord,
} from "../../../src/features/sync/record-mapper";
import {
  chbDepositSourceId,
  chbDepositTransactions,
} from "../../../src/sources/chb/protocol";
import {
  loadChbSourceIdUpgradeStatements,
  planChbSourceIdUpgrades,
} from "../../../src/sources/chb/sync";

const ACCOUNT_NO = "00001234567890";
const ACCOUNT_SOURCE_ID = chbDepositSourceId(ACCOUNT_NO);
const CLEANUP_SQL = readFileSync(
  new URL(
    "../../../migrations/0075_chb_tx_identity_cleanup.sql",
    import.meta.url,
  ),
  "utf8",
);

let mf: Awaited<ReturnType<typeof createTestD1>>["mf"] | undefined;

afterEach(async () => {
  await mf?.dispose();
  mf = undefined;
});

describe("chb sourceId v1 -> v2 upgrade & 0075 cleanup", () => {
  it("plans deterministic 1-to-1 upgrades from v1 to v2 while ignoring exact v2 and balance mismatches", () => {
    const incoming = chbDepositTransactions(
      ACCOUNT_SOURCE_ID,
      ACCOUNT_NO,
      "TWD",
      [
        {
          amount: 52000,
          balanceAfter: 152000,
          transactionDate: "2026-10-05",
          bookingDate: "2026-10-05",
          transactionTime: "09:00:10",
          summary: "薪資入帳",
          memo: "巧翎科技",
          kind: "",
          adjustment: false,
        },
        {
          amount: -100,
          balanceAfter: 151900,
          transactionDate: "2026-10-05",
          bookingDate: "2026-10-05",
          transactionTime: "09:05:00",
          summary: "手續費",
          memo: "",
          kind: "",
          adjustment: false,
        },
      ],
    );

    const existing = [
      {
        id: "tx-v1-old",
        accountId: ACCOUNT_SOURCE_ID,
        sourceId: "chb:deposit:tx:v1:oldhash:1",
        postedDate: "2026-10-05",
        amount: 52000,
        currency: "TWD",
        description: "薪資入帳",
        rawPayload: JSON.stringify({ balanceAfter: 152000 }),
        createdAt: "2026-10-05T09:00:00Z",
      },
      {
        id: "tx-v1-diff-bal",
        accountId: ACCOUNT_SOURCE_ID,
        sourceId: "chb:deposit:tx:v1:diffbal:1",
        postedDate: "2026-10-05",
        amount: 52000,
        currency: "TWD",
        description: "薪資入帳",
        rawPayload: JSON.stringify({ balanceAfter: 204000 }),
        createdAt: "2026-10-05T09:00:00Z",
      },
      {
        id: "tx-v2-already",
        accountId: ACCOUNT_SOURCE_ID,
        sourceId: incoming[1]!.sourceId,
        postedDate: "2026-10-05",
        amount: -100,
        currency: "TWD",
        description: "手續費",
        rawPayload: JSON.stringify({ balanceAfter: 151900 }),
        createdAt: "2026-10-05T09:05:00Z",
      },
    ];

    const upgrades = planChbSourceIdUpgrades(incoming, existing);
    expect(upgrades).toEqual([
      {
        id: "tx-v1-old",
        oldSourceId: "chb:deposit:tx:v1:oldhash:1",
        newSourceId: incoming[0]!.sourceId,
      },
    ]);
  });

  it("0075 cleanup removes cross-batch duplicates, keeps same-batch pairs, preserves annotations, and respects conflicts", async () => {
    const migrations = readMigrations();
    const harness = await createTestD1(undefined, migrations.slice(0, -1));
    mf = harness.mf;
    const db = harness.binding;

    const acctStmt = db
      .prepare(
        `INSERT INTO bank_accounts (id, connector_id, source_id, institution_name, account_name, account_type, currency, created_at, updated_at)
         VALUES (?, 'chb', ?, '彰化銀行', '活存', 'savings', 'TWD', ?, ?)`,
      )
      .bind(
        "acct-1",
        ACCOUNT_SOURCE_ID,
        "2026-10-01T00:00:00Z",
        "2026-10-01T00:00:00Z",
      );

    const insTx = (
      id: string,
      sourceId: string,
      createdAt: string,
      amount = 52000,
      bal = 152000,
      desc = "薪資入帳",
    ) =>
      db
        .prepare(
          `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, authorized_at, amount, currency, description, status, raw_payload, created_at, updated_at)
           VALUES (?, 'chb', 'acct-1', ?, '2026-10-05', '2026-10-05T09:00:00+08:00', ?, 'TWD', ?, 'posted', ?, ?, ?)`,
        )
        .bind(
          id,
          sourceId,
          amount,
          desc,
          JSON.stringify({ balanceAfter: bal }),
          createdAt,
          createdAt,
        );

    await db.batch([
      acctStmt,
      // 跨批重複（created_at 不同，v1 hash 不同）→ 保留 tx-dup-1，刪除 tx-dup-2，保留偏好與覆寫
      insTx("tx-dup-1", "chb:deposit:tx:v1:h1:1", "2026-10-05T09:00:00Z"),
      insTx("tx-dup-2", "chb:deposit:tx:v1:h2:1", "2026-10-05T10:00:00Z"),
      db.prepare(
        `INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at, note)
           VALUES ('tx-dup-2', 1, '2026-10-05T10:05:00Z', '2026-10-05T10:05:00Z', '保留備註')`,
      ),
      db.prepare(
        `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
           VALUES ('override:bank_transaction:tx-dup-1', 'bank_transaction', 'tx-dup-1', 'salary', '2026-10-05T10:05:00Z', '2026-10-05T10:05:00Z')`,
      ),
      db.prepare(
        `INSERT INTO ai_classifications (transaction_id, category_id, probability, input_hash, model, created_at, updated_at)
           VALUES ('tx-dup-2', 'salary', 0.95, 'ih', 'm', '2026-10-05T10:05:00Z', '2026-10-05T10:05:00Z')`,
      ),
      // 同批兩筆真正相同交易（同 created_at，同 balanceAfter 與摘要）→ 兩筆都保留
      insTx(
        "tx-same-1",
        "chb:deposit:tx:v1:same:1",
        "2026-10-05T11:00:00Z",
        -100,
        151900,
        "ATM提款",
      ),
      insTx(
        "tx-same-2",
        "chb:deposit:tx:v1:same:2",
        "2026-10-05T11:00:00Z",
        -100,
        151900,
        "ATM提款",
      ),
      // 分類覆寫衝突 → 保留兩筆避免靜默吃掉人工標註
      insTx(
        "tx-c1",
        "chb:deposit:tx:v1:conf1:1",
        "2026-10-05T12:00:00Z",
        3000,
        154900,
        "存入",
      ),
      insTx(
        "tx-c2",
        "chb:deposit:tx:v1:conf2:1",
        "2026-10-05T13:00:00Z",
        3000,
        154900,
        "存入",
      ),
      db.prepare(
        `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
           VALUES ('override:bank_transaction:tx-c1', 'bank_transaction', 'tx-c1', 'salary', '2026-10-05T13:05:00Z', '2026-10-05T13:05:00Z')`,
      ),
      db.prepare(
        `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
           VALUES ('override:bank_transaction:tx-c2', 'bank_transaction', 'tx-c2', 'food', '2026-10-05T13:06:00Z', '2026-10-05T13:06:00Z')`,
      ),
    ]);

    const statements = unstable_splitSqlQuery(CLEANUP_SQL)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .map((s) => db.prepare(s));
    await db.batch(statements);

    const remaining = await db
      .prepare("SELECT id FROM bank_transactions ORDER BY id")
      .all<{ id: string }>();
    expect(remaining.results.map((r) => r.id)).toEqual([
      "tx-c1",
      "tx-c2",
      "tx-dup-1",
      "tx-same-1",
      "tx-same-2",
    ]);

    const pref = await db
      .prepare(
        "SELECT transaction_id, excluded_from_calculation, note FROM bank_transaction_preferences",
      )
      .all<{
        transaction_id: string;
        excluded_from_calculation: number;
        note: string;
      }>();
    expect(pref.results).toEqual([
      {
        transaction_id: "tx-dup-1",
        excluded_from_calculation: 1,
        note: "保留備註",
      },
    ]);

    const ov = await db
      .prepare(
        "SELECT target_id, category_id FROM classification_overrides WHERE target_id = 'tx-dup-1'",
      )
      .all<{ target_id: string; category_id: string }>();
    expect(ov.results).toEqual([
      { target_id: "tx-dup-1", category_id: "salary" },
    ]);
  }, 30_000);

  it("staged promotion upgrades surviving v1 row to v2 in-place with zero new rows or lost preferences", async () => {
    const harness = await createTestD1();
    mf = harness.mf;
    const db = harness.binding;

    const now = "2026-10-06T09:00:00Z";
    const incoming = chbDepositTransactions(
      ACCOUNT_SOURCE_ID,
      ACCOUNT_NO,
      "TWD",
      [
        {
          amount: 52000,
          balanceAfter: 152000,
          transactionDate: "2026-10-05",
          bookingDate: "2026-10-05",
          transactionTime: "09:02:15",
          summary: "薪資入帳",
          memo: "巧翎科技",
          kind: "",
          adjustment: false,
        },
      ],
    );
    const acctRec = bankAccountRecord(
      "chb",
      {
        sourceId: ACCOUNT_SOURCE_ID,
        institutionName: "彰化銀行",
        accountName: "活存",
        accountType: "savings",
        currency: "TWD",
      },
      now,
    );
    const dbAcctId = acctRec.recordKey;
    await db.batch([
      db
        .prepare(
          `INSERT INTO bank_accounts (id, connector_id, source_id, institution_name, account_name, account_type, currency, created_at, updated_at)
           VALUES (?, 'chb', ?, '彰化銀行', '活存', 'savings', 'TWD', ?, ?)`,
        )
        .bind(
          dbAcctId,
          ACCOUNT_SOURCE_ID,
          "2026-10-05T09:00:00Z",
          "2026-10-05T09:00:00Z",
        ),
      db
        .prepare(
          `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, authorized_at, amount, currency, description, status, raw_payload, created_at, updated_at)
           VALUES ('legacy-v1-id', 'chb', ?, 'chb:deposit:tx:v1:legacy:1', '2026-10-05', '2026-10-05T09:00:00+08:00', 52000, 'TWD', '薪資入帳', 'posted', ?, '2026-10-05T09:00:00Z', '2026-10-05T09:00:00Z')`,
        )
        .bind(dbAcctId, JSON.stringify({ balanceAfter: 152000 })),
      db.prepare(
        `INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at, note)
           VALUES ('legacy-v1-id', 0, '2026-10-05T09:10:00Z', '2026-10-05T09:10:00Z', '人工備註')`,
      ),
    ]);

    const upgradeStatements = await loadChbSourceIdUpgradeStatements(
      db,
      incoming,
    );
    expect(upgradeStatements).toHaveLength(1);

    const newRecords = await persistStagedSyncWrite(db, {
      records: [
        acctRec,
        ...incoming.map((tx) => bankTransactionRecord("chb", tx, now)),
      ],
      beforePromoteStatements: upgradeStatements,
    });
    expect(newRecords.bankTransactions).toBe(0);

    const rows = await db
      .prepare(
        "SELECT id, source_id, authorized_at FROM bank_transactions WHERE connector_id = 'chb'",
      )
      .all<{ id: string; source_id: string; authorized_at: string }>();
    expect(rows.results).toEqual([
      {
        id: "legacy-v1-id",
        source_id: incoming[0]!.sourceId,
        authorized_at: "2026-10-05T09:02:15+08:00",
      },
    ]);
  }, 30_000);
});
