import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  MANUAL_ACCOUNT_ID,
  MANUAL_CONNECTOR_ID,
  isConnectorId,
  matchInvoicesToTransactions,
} from "@taiwan-fin-hub/shared";
import { createTestD1 } from "../../helpers/d1";
import {
  getBankAccounts,
  getBankRange,
} from "../../../src/features/bank/service";
import {
  ManualTransactionNotFoundError,
  recordManualTransactions,
  removeManualTransaction,
} from "../../../src/features/manual-transactions/service";
import { manualTransactionsSchema } from "../../../src/features/manual-transactions/schema";
import { ClassificationCategoryNotFoundError } from "../../../src/features/classification/service";
import { calculateBankDepositValue } from "../../../src/features/net-worth/repository";

const BANK_BALANCE = 50_000;

describe("手動記錄的現金帳戶（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;

  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
    const now = "2026-10-01T00:00:00Z";
    await db.batch([
      db
        .prepare(
          `INSERT INTO bank_accounts (id, connector_id, source_id, account_type, currency, created_at, updated_at)
           VALUES ('bank-a', 'taishin', 'bank-a', 'checking', 'TWD', ?, ?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO bank_balance_snapshots (id, connector_id, account_id, source_id, balance, currency, as_of_at, created_at, updated_at)
           VALUES ('bank-a:balance', 'taishin', 'bank-a', 'bank-a', ?, 'TWD', ?, ?, ?)`,
        )
        .bind(BANK_BALANCE, now, now, now),
      ...[
        ["atm-out", "2026-10-05", -3_000, "範例提款"],
        ["pay-out", "2026-10-07", -800, "範例代付"],
      ].map(([id, day, amount, description]) =>
        db
          .prepare(
            `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, created_at, updated_at)
             VALUES (?, 'taishin', 'bank-a', ?, ?, ?, 'TWD', ?, ?, ?)`,
          )
          .bind(id, id, day, amount, description, now, now),
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  async function loadById() {
    const { transactions } = await getBankRange(db, {
      from: "2026-10-01",
      to: "2026-11-01",
    });
    return new Map(
      transactions.map((transaction) => [transaction.id, transaction]),
    );
  }

  async function cashAccount() {
    return (await getBankAccounts(db)).find(
      (account) => account.id === MANUAL_ACCOUNT_ID,
    );
  }

  it("手動帳戶的 connector id 不與資料來源衝突", () => {
    expect(isConnectorId(MANUAL_CONNECTOR_ID)).toBe(false);
  });

  it("沒有手動記錄時不建立現金帳戶", async () => {
    expect(await cashAccount()).toBeUndefined();
  });

  it("支出存負數、收入存正數，現金餘額等於記錄加總並計入存款", async () => {
    const result = await recordManualTransactions(db, {
      transactions: [
        {
          externalId: "night-market",
          date: "2026-10-06",
          type: "expense",
          amount: 350,
          description: "範例夜市",
          categoryId: "food",
          note: "範例備註",
        },
        {
          externalId: "red-envelope",
          date: "2026-10-07",
          type: "income",
          amount: 800,
          description: "範例紅包",
        },
        {
          externalId: "atm",
          date: "2026-10-05",
          type: "transfer_in",
          amount: 3_000,
          description: "範例領現",
        },
      ],
    });

    expect(result).toEqual({
      transactions: [
        {
          id: "manual:night-market",
          externalId: "night-market",
          created: true,
        },
        {
          id: "manual:red-envelope",
          externalId: "red-envelope",
          created: true,
        },
        { id: "manual:atm", externalId: "atm", created: true },
      ],
      balance: 3_450,
    });
    expect(await cashAccount()).toMatchObject({
      connectorId: MANUAL_CONNECTOR_ID,
      accountType: "stored_value",
      balance: 3_450,
    });
    expect(
      await calculateBankDepositValue(
        db,
        new Date().toISOString().slice(0, 10),
      ),
    ).toBe(BANK_BALANCE + 3_450);
    // 每個日期讀到的是到當天為止的現金，重建過去的歷史淨值不會漏掉或提前計入。
    for (const [date, cash] of [
      ["2026-10-04", 0],
      ["2026-10-05", 3_000],
      ["2026-10-06", 2_650],
      ["2026-10-07", 3_450],
    ] as const)
      expect(await calculateBankDepositValue(db, date)).toBe(
        BANK_BALANCE + cash,
      );

    const byId = await loadById();
    expect(byId.get("manual:night-market")).toMatchObject({
      amount: -350,
      excludedFromCalculation: false,
      note: "範例備註",
      classification: { source: "override", categoryId: "food" },
    });
    expect(byId.get("manual:red-envelope")).toMatchObject({
      amount: 800,
      excludedFromCalculation: false,
    });
  });

  it("提款與手動轉入配成互轉，兩邊都不計入收支；手動收入不與同日同額的轉出配對", async () => {
    const byId = await loadById();

    for (const id of ["atm-out", "manual:atm"])
      expect(byId.get(id)).toMatchObject({
        excludedFromCalculation: true,
        classification: { source: "auto_transfer" },
      });
    expect(byId.get("pay-out")).toMatchObject({
      excludedFromCalculation: false,
    });
    expect(byId.get("pay-out")?.classification?.source).not.toBe(
      "auto_transfer",
    );
    expect(byId.get("manual:red-envelope")?.classification?.source).not.toBe(
      "auto_transfer",
    );
  });

  it("現金移動不自動配發票，手動支出照常配對", async () => {
    await recordManualTransactions(db, {
      transactions: [
        {
          externalId: "deposit",
          date: "2026-10-20",
          type: "transfer_out",
          amount: 350,
          description: "範例存入",
        },
      ],
    });
    const byId = await loadById();
    const transactions = [
      byId.get("manual:deposit")!,
      byId.get("manual:night-market")!,
    ];
    const matches = matchInvoicesToTransactions(transactions, [
      { id: "invoice-deposit-day", invoiceDate: "2026-10-20", amount: 350 },
      { id: "invoice-market-day", invoiceDate: "2026-10-06", amount: 350 },
    ]);

    expect([...matches.invoiceToTransactionId]).toEqual([
      ["invoice-market-day", "manual:night-market"],
    ]);
    expect(await removeManualTransaction(db, "manual:deposit")).toEqual({
      balance: 3_450,
    });
  });

  it("相同 externalId 重送只更新同一筆，省略的分類與備註保留", async () => {
    const result = await recordManualTransactions(db, {
      transactions: [
        {
          externalId: "night-market",
          date: "2026-10-06",
          type: "expense",
          amount: 400,
          description: "範例夜市",
        },
      ],
    });

    expect(result.transactions).toEqual([
      { id: "manual:night-market", externalId: "night-market", created: false },
    ]);
    expect(result.balance).toBe(3_400);
    const byId = await loadById();
    expect(
      [...byId.keys()].filter((id) => id.startsWith("manual:")),
    ).toHaveLength(3);
    expect(byId.get("manual:night-market")).toMatchObject({
      amount: -400,
      note: "範例備註",
      classification: { source: "override", categoryId: "food" },
    });
  });

  it("更新日期時，原日期起的存款歷史一併重算", async () => {
    const today = new Date(Date.now() + 8 * 60 * 60 * 1000);
    const day = (offset: number) =>
      new Date(today.getTime() - offset * 24 * 60 * 60 * 1000)
        .toISOString()
        .slice(0, 10);
    const history = async (date: string) =>
      (
        await db
          .prepare(
            `SELECT net_worth AS value FROM net_worth_history
             WHERE date = ? AND source = 'bank' AND asset_type = 'deposit'`,
          )
          .bind(date)
          .first<{ value: number }>()
      )?.value;
    const moved = {
      externalId: "moved",
      type: "expense" as const,
      amount: 100,
      description: "範例支出",
    };

    await recordManualTransactions(db, {
      transactions: [{ ...moved, date: day(5) }],
    });
    const before = await history(day(4));
    await recordManualTransactions(db, {
      transactions: [{ ...moved, date: day(2) }],
    });

    expect(await history(day(4))).toBe(before! + 100);
    expect(await history(day(2))).toBe(before);
    await removeManualTransaction(db, "manual:moved");
  });

  it("分類不存在時整批不寫入", async () => {
    await expect(
      recordManualTransactions(db, {
        transactions: [
          {
            externalId: "rejected",
            date: "2026-10-08",
            type: "expense",
            amount: 100,
            description: "範例支出",
            categoryId: "missing-category",
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ClassificationCategoryNotFoundError);
    expect((await loadById()).has("manual:rejected")).toBe(false);
    expect((await cashAccount())?.balance).toBe(3_400);
  });

  it("餘額校正補一筆不計入收支的調整，已一致時不寫入", async () => {
    const corrected = await recordManualTransactions(db, { balance: 2_000 });

    expect(corrected.balance).toBe(2_000);
    expect(corrected.adjustment?.amount).toBe(-1_400);
    const { results } = await db
      .prepare(
        `SELECT txn.id, preference.excluded_from_calculation AS excluded
         FROM bank_transactions txn
         JOIN bank_transaction_preferences preference ON preference.transaction_id = txn.id
         WHERE txn.id = ?`,
      )
      .bind(corrected.adjustment!.id)
      .all();
    expect(results).toEqual([{ id: corrected.adjustment!.id, excluded: 1 }]);

    const unchanged = await recordManualTransactions(db, { balance: 2_000 });
    expect(unchanged).toEqual({ transactions: [], balance: 2_000 });
  });

  it("刪除會清掉分類與備註並重算餘額，且只能刪除手動記錄", async () => {
    expect(await removeManualTransaction(db, "manual:night-market")).toEqual({
      balance: 2_400,
    });
    expect((await cashAccount())?.balance).toBe(2_400);
    const leftovers = await db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM bank_transactions WHERE id = ?1) +
           (SELECT COUNT(*) FROM bank_transaction_preferences WHERE transaction_id = ?1) +
           (SELECT COUNT(*) FROM classification_overrides WHERE target_id = ?1) AS count`,
      )
      .bind("manual:night-market")
      .first<{ count: number }>();
    expect(leftovers?.count).toBe(0);

    await expect(removeManualTransaction(db, "atm-out")).rejects.toBeInstanceOf(
      ManualTransactionNotFoundError,
    );
    expect((await loadById()).has("atm-out")).toBe(true);
  });

  it("拒絕重複的 externalId、非正整數金額與現金移動的分類", () => {
    const item = {
      date: "2026-10-06",
      type: "expense",
      amount: 100,
      description: "範例支出",
    };
    const invalid = [
      {},
      { transactions: [{ ...item, amount: -100 }] },
      { transactions: [{ ...item, amount: 10.5 }] },
      {
        transactions: [
          { ...item, externalId: "same" },
          { ...item, externalId: "same" },
        ],
      },
      { transactions: [{ ...item, type: "transfer_in", categoryId: "food" }] },
    ];
    for (const body of invalid)
      expect(manualTransactionsSchema.safeParse(body).success).toBe(false);
    expect(manualTransactionsSchema.safeParse({ balance: 0 }).success).toBe(
      true,
    );
  });
});
