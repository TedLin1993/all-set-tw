import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { unstable_splitSqlQuery } from "wrangler";
import { createTestD1 } from "../../helpers/d1";
import { manualActivityRoutes } from "../../../src/features/manual-activity/route";
import {
  getBankAccounts,
  getBankRange,
} from "../../../src/features/bank/service";
import { calculateBankDepositValue } from "../../../src/features/net-worth/repository";
import { getDashboardSummary } from "../../../src/features/dashboard/service";
import { listAssetCurrencyAmounts } from "../../../src/features/exchange-rates/repository";

const now = "2026-10-15T00:00:00Z";
const migrationsDirectory = fileURLToPath(
  new URL("../../../migrations/", import.meta.url),
);

describe("手動記帳（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;
  const env = () => ({ DB: db });

  const call = (method: string, path: string, body?: unknown) =>
    manualActivityRoutes.request(
      path,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      env(),
    );

  async function create(overrides: Record<string, unknown> = {}) {
    const response = await call("POST", "/activity/manual", {
      date: "2026-10-05",
      kind: "expense",
      categoryId: "user:test-food",
      name: "範例早餐",
      amount: 120,
      ...overrides,
    });
    expect(response.status).toBe(201);
    return ((await response.json()) as { id: string }).id;
  }

  const transactionRow = (id: string) =>
    db
      .prepare(
        "SELECT account_id, connector_id, source_id, amount, currency, raw_payload FROM bank_transactions WHERE id = ?",
      )
      .bind(id)
      .first<{
        account_id: string;
        connector_id: string;
        source_id: string;
        amount: number;
        currency: string;
        raw_payload: string;
      }>();
  const overrideCategory = async (id: string) =>
    (
      await db
        .prepare(
          "SELECT category_id FROM classification_overrides WHERE target_type = 'bank_transaction' AND target_id = ?",
        )
        .bind(id)
        .first<{ category_id: string }>()
    )?.category_id;

  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
    await db.batch([
      ...[
        ["user:test-food", "範例餐飲"],
        ["user:test-other", "範例其他"],
      ].map(([id, label], index) =>
        db
          .prepare(
            `INSERT INTO classification_categories (id, label, sort_order, is_system, created_at, updated_at)
             VALUES (?, ?, ?, 0, ?, ?)`,
          )
          .bind(id, label, 100 + index, now, now),
      ),
      db
        .prepare(
          `INSERT INTO bank_accounts (id, connector_id, source_id, account_type, currency, created_at, updated_at)
           VALUES ('real-account', 'taishin', 'real-account', 'checking', 'TWD', ?, ?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, created_at, updated_at)
           VALUES ('bank-tx', 'taishin', 'real-account', 'bank-tx', '2026-10-05', -50, 'TWD', '範例銀行交易', ?, ?)`,
        )
        .bind(now, now),
    ]);
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("建立時支出存負數、收入存正數，台幣入帳並寫入分類 override 與原幣紀錄", async () => {
    const fx = { currency: "USD", amount: 4, rate: 30 };
    const expenseId = await create({ amount: 120, fx });
    const incomeId = await create({ kind: "income", amount: 300 });

    expect(expenseId).toMatch(/^manual:/);
    const expense = await transactionRow(expenseId);
    expect(expense).toMatchObject({
      account_id: "manual:cash",
      connector_id: "manual",
      source_id: expenseId,
      amount: -120,
      currency: "TWD",
    });
    expect(JSON.parse(expense!.raw_payload)).toEqual({
      origin: "manual",
      fx,
    });
    expect((await transactionRow(incomeId))?.amount).toBe(300);
    expect(await overrideCategory(expenseId)).toBe("user:test-food");
  });

  it("輸入不合法回 400、分類不存在回 404", async () => {
    expect(
      (await call("POST", "/activity/manual", { date: "2026-10-05" })).status,
    ).toBe(400);
    expect((await call("POST", "/activity/manual", { amount: 0 })).status).toBe(
      400,
    );
    const missingCategory = await call("POST", "/activity/manual", {
      date: "2026-10-05",
      kind: "expense",
      categoryId: "user:missing",
      name: "範例",
      amount: 10,
    });
    expect(missingCategory.status).toBe(404);
    const id = await create();
    expect((await call("PUT", `/activity/manual/${id}`, {})).status).toBe(400);
  });

  it("編輯 kind 會翻轉正負號，分類與外幣紀錄跟著更新", async () => {
    const id = await create({ amount: 200 });

    expect(
      (await call("PUT", `/activity/manual/${id}`, { kind: "income" })).status,
    ).toBe(200);
    expect((await transactionRow(id))?.amount).toBe(200);

    await call("PUT", `/activity/manual/${id}`, {
      kind: "expense",
      amount: 80,
      categoryId: "user:test-other",
      fx: { currency: "JPY", amount: 400, rate: 0.2 },
    });
    const row = await transactionRow(id);
    expect(row?.amount).toBe(-80);
    expect(JSON.parse(row!.raw_payload).fx).toEqual({
      currency: "JPY",
      amount: 400,
      rate: 0.2,
    });
    expect(await overrideCategory(id)).toBe("user:test-other");
  });

  it("刪除會清掉交易、分類 override 與計算偏好", async () => {
    const id = await create();
    await db
      .prepare(
        `INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at)
         VALUES (?, 1, ?, ?)`,
      )
      .bind(id, now, now)
      .run();

    expect((await call("DELETE", `/activity/manual/${id}`)).status).toBe(200);
    expect(await transactionRow(id)).toBeNull();
    expect(await overrideCategory(id)).toBeUndefined();
    const preference = await db
      .prepare(
        "SELECT 1 AS found FROM bank_transaction_preferences WHERE transaction_id = ?",
      )
      .bind(id)
      .first();
    expect(preference).toBeNull();
  });

  it("對非手動交易或不存在的 id 編輯、刪除回 404，且不動到原資料", async () => {
    expect(
      (await call("PUT", "/activity/manual/bank-tx", { amount: 1 })).status,
    ).toBe(404);
    expect((await call("DELETE", "/activity/manual/bank-tx")).status).toBe(404);
    expect(
      (await call("DELETE", "/activity/manual/manual:missing")).status,
    ).toBe(404);
    expect((await transactionRow("bank-tx"))?.amount).toBe(-50);
  });

  it("交易 API 以 manual 旗標標示手動記錄", async () => {
    const fx = { currency: "USD", amount: 4, rate: 30 };
    const id = await create({ date: "2026-10-09", fx });
    const { transactions } = await getBankRange(db, {
      from: "2026-10-01",
      to: "2026-11-01",
    });
    const byId = new Map(transactions.map((t) => [t.id, t]));
    expect(byId.get(id)).toMatchObject({
      manual: true,
      manualFx: fx,
      amount: -120,
    });
    expect(byId.get("bank-tx")).toMatchObject({ manual: false });
    expect(byId.get("bank-tx")?.manualFx).toBeUndefined();
  });

  it("淨值、總覽、資產帳戶清單與幣別清單不含 is_manual 帳戶", async () => {
    await db.batch([
      db
        .prepare(
          `INSERT INTO bank_balance_snapshots (id, connector_id, account_id, source_id, balance, currency, as_of_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'TWD', ?, ?, ?)`,
        )
        .bind(
          "snap-real",
          "taishin",
          "real-account",
          "real-account",
          1_000,
          now,
          now,
          now,
        ),
      // 即使虛擬帳戶被誤塞了餘額快照，也不應計入。
      db
        .prepare(
          `INSERT INTO bank_balance_snapshots (id, connector_id, account_id, source_id, balance, currency, as_of_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'TWD', ?, ?, ?)`,
        )
        .bind(
          "snap-manual",
          "manual",
          "manual:cash",
          "manual:cash",
          777,
          now,
          now,
          now,
        ),
    ]);

    expect(await calculateBankDepositValue(db, "2026-10-31")).toBe(1_000);
    expect(await getDashboardSummary(db)).toMatchObject({
      bankAccountCount: 1,
      totalBankBalance: 1_000,
    });
    expect((await getBankAccounts(db)).map((a) => a.id)).toEqual([
      "real-account",
    ]);
    const currencies = await listAssetCurrencyAmounts(db);
    expect(currencies).toEqual([{ currency: "TWD", amount: 1_000 }]);
  });

  it("手動交易不參與轉帳配對，同額同日的銀行交易維持原分類", async () => {
    await db.batch([
      db
        .prepare(
          `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, created_at, updated_at)
           VALUES ('pair-bank', 'taishin', 'real-account', 'pair-bank', '2026-10-12', 4321, 'TWD', '範例入帳', ?, ?)`,
        )
        .bind(now, now),
    ]);
    const id = await create({
      date: "2026-10-12",
      amount: 4321,
      name: "範例同額支出",
    });
    // 拿掉 override，讓「不參與配對」只能靠 is_manual 旗標擋下。
    await db
      .prepare("DELETE FROM classification_overrides WHERE target_id = ?")
      .bind(id)
      .run();
    const { transactions } = await getBankRange(db, {
      from: "2026-10-01",
      to: "2026-11-01",
    });
    const byId = new Map(transactions.map((t) => [t.id, t]));
    expect(byId.get("pair-bank")?.classification?.source).not.toBe(
      "auto_transfer",
    );
    expect(byId.get(id)).toMatchObject({
      excludedFromCalculation: false,
      classification: { source: "fallback" },
    });
  });
});

describe("0066 migration", () => {
  const fileNames = readdirSync(migrationsDirectory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const target = fileNames.find((name) => name.startsWith("0066_"))!;
  const before = fileNames
    .filter((name) => name < target)
    .map((name) => readFileSync(`${migrationsDirectory}/${name}`, "utf8"));

  async function applyTarget(binding: D1Database) {
    const sql = readFileSync(`${migrationsDirectory}/${target}`, "utf8");
    await binding.batch(
      unstable_splitSqlQuery(sql)
        .map((statement) => statement.trim())
        .filter(Boolean)
        .map((statement) => binding.prepare(statement)),
    );
  }

  it("已有 manual:cash 列（無旗標）的資料庫套用後保留該列並補上 is_manual = 1", async () => {
    const harness = await createTestD1(undefined, before);
    try {
      await harness.binding
        .prepare(
          `INSERT INTO bank_accounts (id, connector_id, source_id, institution_name, account_name, account_type, currency, created_at, updated_at)
           VALUES ('manual:cash', 'manual', 'manual:cash', '手動記錄', '現金與其他', 'unknown', 'TWD', '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z')`,
        )
        .run();
      await applyTarget(harness.binding);
      const rows = await harness.binding
        .prepare(
          "SELECT is_manual, created_at FROM bank_accounts WHERE id = 'manual:cash'",
        )
        .all<{ is_manual: number; created_at: string }>();
      expect(rows.results).toEqual([
        { is_manual: 1, created_at: "2026-09-25T00:00:00.000Z" },
      ]);
    } finally {
      await harness.mf.dispose();
    }
  }, 60_000);

  it("全新資料庫會建立 is_manual = 1 的虛擬帳戶，其他帳戶預設為 0", async () => {
    const harness = await createTestD1(undefined, before);
    try {
      await harness.binding
        .prepare(
          `INSERT INTO bank_accounts (id, connector_id, source_id, currency, created_at, updated_at)
           VALUES ('a', 'taishin', 'a', 'TWD', '2026-09-25T00:00:00.000Z', '2026-09-25T00:00:00.000Z')`,
        )
        .run();
      await applyTarget(harness.binding);
      const rows = await harness.binding
        .prepare("SELECT id, is_manual FROM bank_accounts ORDER BY id")
        .all<{ id: string; is_manual: number }>();
      expect(rows.results).toEqual([
        { id: "a", is_manual: 0 },
        { id: "manual:cash", is_manual: 1 },
      ]);
    } finally {
      await harness.mf.dispose();
    }
  }, 60_000);
});
