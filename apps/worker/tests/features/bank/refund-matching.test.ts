import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestD1 } from "../../helpers/d1";
import { matchRefundsToPurchases } from "../../../src/features/bank/refund-matching";
import { getBankRange } from "../../../src/features/bank/service";

type CardEntry = {
  id: string;
  amount: number;
  day: string;
  description: string;
  accountId?: string;
};

function card({
  id,
  amount,
  day,
  description,
  accountId = "card-1",
}: CardEntry) {
  return {
    id,
    accountId,
    accountType: "credit",
    amount,
    currency: "TWD",
    postedDate: day,
    status: "posted",
    description,
    counterparty: description,
  };
}

describe("退費配對", () => {
  it("部分與分次退費對到同商家最近一筆足額扣款，不跨卡、不超過 90 天", () => {
    const purchases = [
      card({
        id: "ticket-old",
        amount: -1_000,
        day: "2026-10-01",
        description: "範例客運購票",
      }),
      card({
        id: "ticket",
        amount: -1_000,
        day: "2026-10-03",
        description: "範例客運購票",
      }),
      card({
        id: "ticket-small",
        amount: -500,
        day: "2026-10-02",
        description: "範例客運購票",
      }),
      card({
        id: "order",
        amount: -600,
        day: "2026-09-10",
        description: "範例網購－生活館",
      }),
      card({
        id: "order-later",
        amount: -600,
        day: "2026-09-18",
        description: "範例網購－生活館",
      }),
      card({
        id: "overseas",
        amount: -2_000,
        day: "2026-10-05",
        description: "百貨公司/EXAMPLESHOP",
      }),
      card({
        id: "other-card",
        amount: -300,
        day: "2026-10-01",
        description: "範例書店",
        accountId: "card-2",
      }),
      card({
        id: "too-old",
        amount: -500,
        day: "2026-06-01",
        description: "範例文具店",
      }),
    ];
    const refunds = [
      card({
        id: "ticket-refund",
        amount: 900,
        day: "2026-10-04",
        description: "範例客運購票",
      }),
      card({
        id: "order-refund-1",
        amount: 300,
        day: "2026-09-15",
        description: "範例網購－生活館",
      }),
      card({
        id: "order-refund-2",
        amount: 300,
        day: "2026-09-15",
        description: "範例網購－生活館",
      }),
      card({
        id: "overseas-refund",
        amount: 100,
        day: "2026-10-08",
        description: "EXAMPLESHOP 123 LONDON GB",
      }),
      card({
        id: "other-card-refund",
        amount: 300,
        day: "2026-10-02",
        description: "範例書店",
      }),
      card({
        id: "too-old-refund",
        amount: 500,
        day: "2026-10-01",
        description: "範例文具店",
      }),
    ];

    expect(
      Object.fromEntries(matchRefundsToPurchases(refunds, purchases)),
    ).toEqual({
      "ticket-refund": "ticket",
      "order-refund-1": "order",
      "order-refund-2": "order",
      "overseas-refund": "overseas",
    });
  });

  it("同一電子支付付給不同店家不配對；消費折抵、回饋與繳款入帳不視為退費", () => {
    const purchases = [
      card({
        id: "wallet-cafe",
        amount: -200,
        day: "2026-10-01",
        description: "全支付﹘範例咖啡",
      }),
      card({
        id: "subscription",
        amount: -90,
        day: "2026-10-01",
        description: "EXAMPLE.COM/BILL",
      }),
      card({
        id: "fee",
        amount: -1_800,
        day: "2026-10-01",
        description: "範例卡年費",
      }),
    ];
    const credits = [
      card({
        id: "wallet-books",
        amount: 200,
        day: "2026-10-02",
        description: "全支付﹘範例書店",
      }),
      card({
        id: "discount",
        amount: 20,
        day: "2026-10-02",
        description: "信用卡消費折抵_EXAMPLE.COM/BILL",
      }),
      card({
        id: "waiver",
        amount: 1_800,
        day: "2026-10-01",
        description: "範例卡年費減免",
      }),
      card({
        id: "payment",
        amount: 1_000,
        day: "2026-10-05",
        description: "信用卡繳款入帳",
      }),
    ];

    expect(matchRefundsToPurchases(credits, purchases).size).toBe(0);
  });
});

describe("退費分類（隔離 D1）", () => {
  let harness: Awaited<ReturnType<typeof createTestD1>>;
  let db: D1Database;

  beforeAll(async () => {
    harness = await createTestD1();
    db = harness.binding;
    const now = "2026-10-15T00:00:00Z";
    await db.batch([
      db
        .prepare(
          `INSERT INTO bank_accounts (id, connector_id, source_id, account_type, currency, created_at, updated_at)
           VALUES ('card-1', 'taishin', 'card-1', 'credit', 'TWD', ?, ?)`,
        )
        .bind(now, now),
      ...[
        ["bakery", "2026-09-30", -300, "範例烘焙坊"],
        ["bakery-refund", "2026-10-02", 60, "範例烘焙坊"],
        ["order", "2026-09-28", -400, "範例網購股份有限公司"],
        ["order-refund", "2026-10-01", 400, "範例網購股份有限公司"],
        ["verify", "2026-10-12", -40, "GOOGLE PAYMENT CORP"],
        ["verify-refund", "2026-10-12", 40, "GOOGLE PAYMENT CORP"],
        ["snack", "2026-10-12", -100, "範例點心鋪"],
        ["snack-refund", "2026-10-12", 30, "範例點心鋪"],
      ].map(([id, day, amount, description]) =>
        db
          .prepare(
            `INSERT INTO bank_transactions (id, connector_id, account_id, source_id, posted_date, amount, currency, description, counterparty, created_at, updated_at)
             VALUES (?, 'taishin', 'card-1', ?, ?, ?, 'TWD', ?, ?, ?, ?)`,
          )
          .bind(id, id, day, amount, description, description, now, now),
      ),
      ...[
        ["bakery", "food"],
        ["order", "shopping"],
        ["order-refund", "other-income"],
      ].map(([targetId, categoryId]) =>
        db
          .prepare(
            `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
             VALUES (?, 'bank_transaction', ?, ?, ?, ?)`,
          )
          .bind(`override-${targetId}`, targetId, categoryId, now, now),
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await harness?.mf.dispose();
  });

  it("未分類退費沿用上個月扣款的分類；手動分到其他類別時維持收入", async () => {
    const { transactions } = await getBankRange(db, {
      from: "2026-10-01",
      to: "2026-11-01",
    });
    const byId = new Map(
      transactions.map((transaction) => [transaction.id, transaction]),
    );

    expect(byId.get("bakery-refund")?.classification).toEqual({
      categoryId: "food",
      label: "餐飲",
      source: "auto_refund",
      refund: true,
    });
    expect(byId.get("order-refund")?.classification).toMatchObject({
      categoryId: "other-income",
      source: "override",
    });
    expect(byId.get("order-refund")?.classification?.refund).toBeUndefined();
  });

  it("同日同店全額退款兩筆都排除計算，部分退款仍扣減支出", async () => {
    const { transactions } = await getBankRange(db, {
      from: "2026-10-01",
      to: "2026-11-01",
    });
    const byId = new Map(
      transactions.map((transaction) => [transaction.id, transaction]),
    );

    expect(byId.get("verify")?.excludedFromCalculation).toBe(true);
    expect(byId.get("verify-refund")?.excludedFromCalculation).toBe(true);
    expect(byId.get("snack")?.excludedFromCalculation).toBe(false);
    expect(byId.get("snack-refund")).toMatchObject({
      excludedFromCalculation: false,
      classification: { refund: true },
    });
    expect(byId.get("bakery-refund")?.excludedFromCalculation).toBe(false);
  });
});
