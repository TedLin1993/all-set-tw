import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import {
  bankAccountRecord,
  creditCardBillRecord,
} from "../../../src/features/sync/record-mapper";
import { persistStagedSyncWrite } from "../../../src/features/sync/persistence";
import { reconcileCathayUnpaidCurrentBillStatements } from "../../../src/sources/cathaybk/repository";

let harness: Awaited<ReturnType<typeof createTestD1>>;

async function insertBill(
  id: string,
  connectorId: string,
  isPaid: number,
  billingPeriod: string,
  rawPayload: string,
) {
  await harness.binding
    .prepare(
      `INSERT INTO credit_card_bills
       (id, connector_id, account_id, source_id, billing_period, is_paid, currency, created_at, updated_at, raw_payload)
       VALUES (?, ?, ?, ?, ?, ?, 'TWD', ?, ?, ?)`,
    )
    .bind(
      id,
      connectorId,
      "account-1",
      `card:bill:${id}`,
      billingPeriod,
      isPaid,
      "2026-10-01",
      "2026-10-01",
      rawPayload,
    )
    .run();
}

beforeEach(async () => {
  harness = await createTestD1();
  await harness.binding
    .prepare(
      `INSERT INTO bank_accounts
       (id, connector_id, source_id, currency, created_at, updated_at)
       VALUES ('account-1', 'cathaybk', 'card:1', 'TWD', '2026-10-01', '2026-10-01')`,
    )
    .run();
});

afterEach(async () => {
  await harness?.mf.dispose();
});

describe("Cathay unpaid current bill reconciliation", () => {
  it("repairs only explicitly selected paid Cathay statements", async () => {
    await insertBill(
      "current",
      "cathaybk",
      1,
      "2026-09",
      '{"source":"C_BILL_Q_RecentBillInfo"}',
    );
    await insertBill(
      "already-unpaid",
      "cathaybk",
      0,
      "2026-08",
      '{"source":"C_BILL_Q_RecentBillInfo"}',
    );
    await insertBill(
      "history",
      "cathaybk",
      1,
      "2026-07",
      '{"source":"history"}',
    );
    await insertBill(
      "other-connector",
      "esun",
      1,
      "2026-06",
      '{"source":"C_BILL_Q_RecentBillInfo"}',
    );
    await insertBill(
      "not-listed",
      "cathaybk",
      1,
      "2026-05",
      '{"source":"C_BILL_Q_RecentBillInfo"}',
    );

    const statements = reconcileCathayUnpaidCurrentBillStatements(
      harness.binding,
      ["current", "already-unpaid", "other-connector"],
    );
    await harness.binding.batch(statements);

    const rows = await harness.binding
      .prepare(
        "SELECT id, connector_id, is_paid FROM credit_card_bills ORDER BY id",
      )
      .all<{ id: string; connector_id: string; is_paid: number }>();
    expect(rows.results).toEqual([
      { id: "already-unpaid", connector_id: "cathaybk", is_paid: 0 },
      { id: "current", connector_id: "cathaybk", is_paid: 0 },
      { id: "history", connector_id: "cathaybk", is_paid: 1 },
      { id: "not-listed", connector_id: "cathaybk", is_paid: 1 },
      { id: "other-connector", connector_id: "esun", is_paid: 1 },
    ]);
  });

  it("does not issue an update for an empty bill list", async () => {
    await insertBill(
      "paid",
      "cathaybk",
      1,
      "2026-09",
      '{"source":"C_BILL_Q_RecentBillInfo"}',
    );
    expect(
      reconcileCathayUnpaidCurrentBillStatements(harness.binding, []),
    ).toEqual([]);
    expect(
      await harness.binding
        .prepare("SELECT is_paid FROM credit_card_bills WHERE id = 'paid'")
        .first("is_paid"),
    ).toBe(1);
  });

  it("preserves missing fields after recording explicit zero and false values", async () => {
    const accountRecord = bankAccountRecord(
      "cathaybk",
      {
        sourceId: "card:2",
        institutionName: "國泰世華銀行",
        accountName: "信用卡",
        accountType: "credit",
        currency: "TWD",
        raw: {},
      },
      "2026-10-01",
    );
    await persistStagedSyncWrite(harness.binding, { records: [accountRecord] });

    const first = creditCardBillRecord(
      "cathaybk",
      {
        accountId: "card:2",
        sourceId: "card:1:bill:2026-09",
        billingPeriod: "2026-09",
        statementAmount: 0,
        minimumPayment: 0,
        paidAmount: 0,
        isPaid: false,
        currency: "TWD",
      },
      "2026-10-01",
    );
    await persistStagedSyncWrite(harness.binding, { records: [first] });

    const second = creditCardBillRecord(
      "cathaybk",
      {
        accountId: "card:2",
        sourceId: "card:1:bill:2026-09",
        billingPeriod: "2026-09",
        currency: "TWD",
      },
      "2026-10-02",
    );
    await persistStagedSyncWrite(harness.binding, { records: [second] });

    expect(
      await harness.binding
        .prepare(
          "SELECT statement_amount, minimum_payment, paid_amount, is_paid FROM credit_card_bills",
        )
        .first(),
    ).toEqual({
      statement_amount: 0,
      minimum_payment: 0,
      paid_amount: 0,
      is_paid: 0,
    });
  });
});
