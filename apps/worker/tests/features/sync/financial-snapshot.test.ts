import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { calculateCurrentFinancialSnapshot } from "../../../src/features/sync/reports/repository";

describe("scheduled financial snapshot loan debt", () => {
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
      db.prepare("DELETE FROM bank_balance_snapshots"),
      db.prepare("DELETE FROM bank_accounts"),
    ]);
  });

  it("separates deposit assets, card debt, and loan debt", async () => {
    const accounts = [
      { id: "deposit", type: "checking", balance: 100_000 },
      { id: "card", type: "credit", balance: -10_000 },
      { id: "loan", type: "loan", balance: -40_000 },
    ];

    for (const account of accounts) {
      await db
        .prepare(
          `INSERT INTO bank_accounts (
             id, connector_id, source_id, account_type, currency,
             created_at, updated_at
           ) VALUES (?, 'cathaybk', ?, ?, 'TWD', '2026-10-07', '2026-10-07')`,
        )
        .bind(account.id, account.id, account.type)
        .run();
      await db
        .prepare(
          `INSERT INTO bank_balance_snapshots (
             id, connector_id, account_id, source_id, balance, currency,
             as_of_at, created_at, updated_at
           ) VALUES (?, 'cathaybk', ?, ?, ?, 'TWD', '2026-10-07T00:00:00.000Z', '2026-10-07', '2026-10-07')`,
        )
        .bind(`${account.id}:snapshot`, account.id, "current", account.balance)
        .run();
    }

    await expect(calculateCurrentFinancialSnapshot(db)).resolves.toEqual({
      assetsTwd: 100_000,
      creditCardDebtTwd: 10_000,
      loanDebtTwd: 40_000,
      missingCurrencies: [],
    });
  });
});
