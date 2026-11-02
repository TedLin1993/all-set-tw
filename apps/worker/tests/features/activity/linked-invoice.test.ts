import { activityDateKey } from "@taiwan-fin-hub/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  linkInvoiceToTransaction,
  MappingDateMismatchError,
} from "../../../src/features/activity/service";
import { searchActivity } from "../../../src/features/activity/search-service";
import { getBankTransactionsByIds } from "../../../src/features/bank/service";
import { getInvoicesByIds } from "../../../src/features/invoices/service";
import { getMonthlyCashFlow } from "../../../src/features/mcp/service";

describe("跨日手動配對的發票（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;

  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
    const stamp = "2026-10-15T00:00:00Z";
    await db.batch([
      db
        .prepare(
          `INSERT INTO bank_accounts (id, connector_id, source_id, account_type, currency, created_at, updated_at)
           VALUES ('deposit-1', 'esun', 'deposit-1', 'savings', 'TWD', ?, ?)`,
        )
        .bind(stamp, stamp),
      ...[
        ["delayed-debit", -500],
        ["different-amount", -480],
      ].map(([id, amount]) =>
        db
          .prepare(
            `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, counterparty, created_at, updated_at)
             VALUES (?, 'esun', 'deposit-1', ?, '2026-10-14', ?, 'TWD', '範例扣款', '範例扣款', ?, ?)`,
          )
          .bind(id, id, amount, stamp, stamp),
      ),
      db
        .prepare(
          `INSERT INTO invoices (id, connector_id, source_id, invoice_number, invoice_date, seller_name, amount, created_at, updated_at)
           VALUES ('invoice-1', 'einvoice', 'invoice-1', 'AB00000001', '2026-08-31T02:30:00.000Z', '範例商店', 500, ?, ?)`,
        )
        .bind(stamp, stamp),
    ]);
    // 發票日後第 44 天：不同金額拒絕，同額可配對。
    await expect(
      linkInvoiceToTransaction(db, "invoice-1", "different-amount"),
    ).rejects.toBeInstanceOf(MappingDateMismatchError);
    await linkInvoiceToTransaction(db, "invoice-1", "delayed-debit");
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("月收支只在扣款月份計入一次", async () => {
    expect((await getMonthlyCashFlow(db, "2026-08")).expense).toBe(0);
    expect((await getMonthlyCashFlow(db, "2026-10")).expense).toBe(980);
  });

  it("補讀另一端時，超過 D1 綁定參數上限的 ID 數量仍可查詢", async () => {
    const missing = Array.from(
      { length: 150 },
      (_, index) => `missing-${index}`,
    );
    const transactions = await getBankTransactionsByIds(db, [
      ...missing,
      "delayed-debit",
    ]);
    const invoices = await getInvoicesByIds(db, [...missing, "invoice-1"]);
    expect(transactions.map(({ id }) => id)).toEqual(["delayed-debit"]);
    expect(invoices.map(({ id }) => id)).toEqual(["invoice-1"]);
  });

  it("以發票或交易名稱搜尋，都只在扣款日期顯示一筆已配對活動", async () => {
    const linked = (
      items: Awaited<ReturnType<typeof searchActivity>>["items"],
    ) =>
      items.map((item) => ({
        day: activityDateKey(item),
        transactionId: item.transactionId,
        invoiceId: item.invoiceId,
      }));
    const expected = {
      day: "2026-10-14",
      transactionId: "delayed-debit",
      invoiceId: "invoice-1",
    };

    expect(linked((await searchActivity(db, { q: "範例商店" })).items)).toEqual(
      [expected],
    );
    expect(
      linked(
        (await searchActivity(db, { q: "範例商店", from: "2026-10-01" })).items,
      ),
    ).toEqual([expected]);
    expect(
      (await searchActivity(db, { q: "範例商店", to: "2026-09-30" })).items,
    ).toEqual([]);
    expect(
      linked((await searchActivity(db, { q: "範例扣款" })).items).filter(
        ({ invoiceId }) => invoiceId,
      ),
    ).toEqual([expected]);
  });
});
