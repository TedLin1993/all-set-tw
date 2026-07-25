import { describe, expect, it } from "vitest";
import {
  deduplicateBankTransactions,
  invoiceTransactionCandidates,
  matchInvoicesToTransactions,
} from "./matching";
import type { BankTransactionRow } from "@/data/bank/types";
import type { InvoiceSummaryRow } from "@/data/invoices/types";

function transaction(
  overrides: Partial<BankTransactionRow> = {},
): BankTransactionRow {
  return {
    id: "transaction-1",
    connectorId: "sinopac",
    accountId: "card-1",
    sourceId: "source-1",
    postedDate: "2026-07-10",
    authorizedAt: "2026-07-10T12:00:00.000Z",
    amount: -860,
    currency: "TWD",
    description: "信用卡消費",
    counterparty: "好食餐飲",
    status: "posted",
    excludedFromCalculation: false,
    ...overrides,
  };
}

function invoice(
  overrides: Partial<InvoiceSummaryRow> = {},
): InvoiceSummaryRow {
  return {
    id: "invoice-1",
    connectorId: "einvoice",
    sourceId: "invoice-source-1",
    invoiceDate: "2026-07-10",
    invoiceNumber: "AB12345678",
    sellerName: "好食餐飲有限公司",
    amount: 860,
    ...overrides,
  };
}

describe("invoice transaction matching", () => {
  it("matches an exact amount, same date, and normalized merchant name", () => {
    const result = matchInvoicesToTransactions([transaction()], [invoice()]);

    expect(result.invoiceToTransactionId.get("invoice-1")).toBe(
      "transaction-1",
    );
    expect(result.transactionToInvoice.get("transaction-1")?.id).toBe(
      "invoice-1",
    );
  });

  it("matches a positive pending card amount through a payment processor", () => {
    const result = matchInvoicesToTransactions(
      [
        transaction({
          accountType: "credit",
          postedDate: "2026-07-06T00:00:00.000Z",
          authorizedAt: undefined,
          amount: 134,
          description: "全支付﹘全聯",
          counterparty: "全支付﹘全聯",
        }),
      ],
      [
        invoice({
          invoiceDate: "2026-07-06T14:06:40.000Z",
          sellerName: "全聯實業股份有限公司台中旅順分公司",
          amount: 134,
        }),
      ],
    );

    expect(result.invoiceToTransactionId.get("invoice-1")).toBe(
      "transaction-1",
    );
  });

  it("matches a LINE Pay card charge reduced by redeemed points", () => {
    const result = matchInvoicesToTransactions(
      [
        transaction({
          accountType: "credit",
          postedDate: "2026-07-09T00:00:00.000Z",
          authorizedAt: undefined,
          amount: -125,
          description: "連支×楓康超市",
          counterparty: "連支×楓康超市",
        }),
      ],
      [
        invoice({
          invoiceDate: "2026-07-09T13:20:00.000Z",
          sellerName: "台灣楓康超市股份有限公司大連分公司",
          amount: 168,
        }),
      ],
    );

    expect(result.invoiceToTransactionId.get("invoice-1")).toBe(
      "transaction-1",
    );
  });

  it("prefers an exact amount over a possible LINE Pay points match", () => {
    const result = matchInvoicesToTransactions(
      [
        transaction({
          accountType: "credit",
          amount: -125,
          description: "連支×楓康超市",
          counterparty: "連支×楓康超市",
        }),
      ],
      [
        invoice({
          id: "exact-invoice",
          sellerName: "台灣楓康超市股份有限公司大連分公司",
          amount: 125,
        }),
        invoice({
          id: "points-invoice",
          sellerName: "台灣楓康超市股份有限公司大連分公司",
          amount: 168,
        }),
      ],
    );

    expect(result.invoiceToTransactionId.get("exact-invoice")).toBe(
      "transaction-1",
    );
    expect(result.invoiceToTransactionId.has("points-invoice")).toBe(false);
  });

  it("does not allow amount differences outside LINE Pay point redemption", () => {
    const ordinaryCard = transaction({
      accountType: "credit",
      amount: -125,
      description: "楓康超市",
      counterparty: "楓康超市",
    });
    const linePayOvercharge = transaction({
      accountType: "credit",
      amount: -180,
      description: "連支×楓康超市",
      counterparty: "連支×楓康超市",
    });
    const targetInvoice = invoice({
      sellerName: "台灣楓康超市股份有限公司大連分公司",
      amount: 168,
    });

    expect(
      matchInvoicesToTransactions([ordinaryCard], [targetInvoice])
        .invoiceToTransactionId.size,
    ).toBe(0);
    expect(
      matchInvoicesToTransactions([linePayOvercharge], [targetInvoice])
        .invoiceToTransactionId.size,
    ).toBe(0);
  });

  it("offers same-day expenses for manual mapping without auto-linking unrelated merchants", () => {
    const transactions = [
      transaction({
        id: "pxpay-tea",
        accountType: "credit",
        postedDate: "2026-07-06T00:00:00.000Z",
        authorizedAt: undefined,
        amount: 37,
        description: "全支付﹘樂法 台中漢口店",
        counterparty: "全支付﹘樂法 台中漢口店",
      }),
      transaction({
        id: "linepay-dinner",
        accountType: "credit",
        postedDate: "2026-07-06",
        authorizedAt: undefined,
        amount: -265,
        description: "連支＊萬川雞飯．肉骨茶",
        counterparty: "連支＊萬川雞飯．肉骨茶",
      }),
    ];
    const targetInvoice = invoice({
      invoiceDate: "2026-07-06T04:39:18.000Z",
      sellerName: "菲尖極道商行",
      amount: 50,
    });
    const result = matchInvoicesToTransactions(transactions, [targetInvoice]);

    expect(result.invoiceToTransactionId.size).toBe(0);
    expect(
      invoiceTransactionCandidates(transactions, targetInvoice).map(
        ({ id }) => id,
      ),
    ).toEqual(["pxpay-tea", "linepay-dinner"]);
  });

  it("applies manual links before automatic matching", () => {
    const result = matchInvoicesToTransactions(
      [transaction()],
      [invoice({ sellerName: "不同商家", amount: 999 })],
      [
        {
          invoiceId: "invoice-1",
          transactionId: "transaction-1",
          decision: "linked",
          updatedAt: "2026-07-19T00:00:00.000Z",
        },
      ],
    );

    expect(result.invoiceToTransactionId.get("invoice-1")).toBe(
      "transaction-1",
    );
  });

  it("keeps an automatic match separate after the user unlinks it", () => {
    const result = matchInvoicesToTransactions(
      [transaction()],
      [invoice()],
      [
        {
          invoiceId: "invoice-1",
          transactionId: null,
          decision: "separate",
          updatedAt: "2026-07-19T00:00:00.000Z",
        },
      ],
    );

    expect(result.invoiceToTransactionId.size).toBe(0);
    expect(result.transactionToInvoice.size).toBe(0);
  });

  it("leaves unrelated payment-processor candidates unpaired when the remainder is ambiguous", () => {
    const result = matchInvoicesToTransactions(
      [
        transaction({
          id: "payment-1",
          accountType: "credit",
          amount: -37,
          description: "全支付﹘品牌甲",
          counterparty: "全支付﹘品牌甲",
        }),
        transaction({
          id: "payment-2",
          accountType: "credit",
          amount: -40,
          description: "連支＊品牌乙",
          counterparty: "連支＊品牌乙",
        }),
      ],
      [invoice({ sellerName: "無關登記商號", amount: 50 })],
    );

    expect(result.invoiceToTransactionId.size).toBe(0);
    expect(result.transactionToInvoice.size).toBe(0);
  });

  it("does not treat a positive bank deposit as an expense match", () => {
    const result = matchInvoicesToTransactions(
      [transaction({ accountType: "checking", amount: 860 })],
      [invoice()],
    );

    expect(result.invoiceToTransactionId.size).toBe(0);
  });

  it("uses the authorization day when the posting day differs", () => {
    const result = matchInvoicesToTransactions(
      [
        transaction({
          postedDate: "2026-07-11",
          authorizedAt: "2026-07-10T12:00:00.000Z",
        }),
      ],
      [invoice()],
    );

    expect(result.invoiceToTransactionId.get("invoice-1")).toBe(
      "transaction-1",
    );
  });

  it("uses the Taipei calendar day for ISO timestamps near midnight", () => {
    const nextTaipeiDay = transaction({
      accountType: "credit",
      postedDate: "2026-07-06T16:00:00.000Z",
      authorizedAt: undefined,
      amount: 50,
    });
    const targetInvoice = invoice({
      invoiceDate: "2026-07-06T04:39:18.000Z",
      amount: 50,
    });

    expect(
      matchInvoicesToTransactions([nextTaipeiDay], [targetInvoice])
        .invoiceToTransactionId.size,
    ).toBe(0);
    expect(
      invoiceTransactionCandidates([nextTaipeiDay], targetInvoice),
    ).toEqual([]);
  });

  it("matches highly overlapping CJK merchant names with repeated branding", () => {
    const result = matchInvoicesToTransactions(
      [
        transaction({
          accountType: "credit",
          postedDate: "2026-07-16T00:00:00.000Z",
          authorizedAt: undefined,
          amount: 129,
          description: "全國加油站昌平站",
          counterparty: "全國加油站昌平站",
        }),
      ],
      [
        invoice({
          invoiceDate: "2026-07-16T10:26:00.000Z",
          sellerName: "全國加油站股份有限公司全國昌平站",
          amount: 129,
        }),
      ],
    );

    expect(result.invoiceToTransactionId.get("invoice-1")).toBe(
      "transaction-1",
    );
  });

  it("does not fuzzy-match a different branch", () => {
    const result = matchInvoicesToTransactions(
      [
        transaction({
          accountType: "credit",
          amount: 129,
          description: "全國加油站文心站",
          counterparty: "全國加油站文心站",
        }),
      ],
      [
        invoice({
          sellerName: "全國加油站股份有限公司全國昌平站",
          amount: 129,
        }),
      ],
    );

    expect(result.invoiceToTransactionId.size).toBe(0);
  });

  it("does not match when amount, date, or merchant differs", () => {
    expect(
      matchInvoicesToTransactions([transaction({ amount: -861 })], [invoice()])
        .invoiceToTransactionId.size,
    ).toBe(0);
    expect(
      matchInvoicesToTransactions(
        [transaction({ postedDate: "2026-07-20", authorizedAt: undefined })],
        [invoice()],
      ).invoiceToTransactionId.size,
    ).toBe(0);
    expect(
      matchInvoicesToTransactions(
        [transaction({ counterparty: "另一間商店" })],
        [invoice()],
      ).invoiceToTransactionId.size,
    ).toBe(0);
  });

  it("leaves ambiguous matches unpaired", () => {
    const result = matchInvoicesToTransactions(
      [transaction(), transaction({ id: "transaction-2" })],
      [invoice()],
    );

    expect(result.invoiceToTransactionId.size).toBe(0);
    expect(result.transactionToInvoice.size).toBe(0);
  });
});

describe("bank transaction deduplication", () => {
  it("prefers the posted E.SUN lifecycle copy and lets its invoice match", () => {
    const pending = transaction({
      id: "pending",
      connectorId: "esun",
      sourceId:
        "2026-07-05T00:00:00.000Z:credit:esun:1204:全支付﹘全聯:252:TWD:未入帳:1",
      accountType: "credit",
      postedDate: "2026-07-05T00:00:00.000Z",
      authorizedAt: "2026-07-05T00:00:00.000Z",
      amount: 252,
      description: "全支付﹘全聯",
      counterparty: "全支付﹘全聯",
    });
    const posted = transaction({
      ...pending,
      id: "posted",
      sourceId: pending.sourceId.replace("未入帳", "已入帳"),
    });
    const transactions = deduplicateBankTransactions([pending, posted]);

    expect(transactions.map(({ id }) => id)).toEqual(["posted"]);
    expect(
      matchInvoicesToTransactions(transactions, [
        invoice({
          invoiceDate: "2026-07-05T14:41:11.000Z",
          sellerName: "全聯實業股份有限公司台中旅順分公司",
          amount: 252,
        }),
      ]).invoiceToTransactionId.get("invoice-1"),
    ).toBe("posted");
  });

  it("keeps distinct occurrences and unrelated connectors", () => {
    const first = transaction({
      id: "first",
      connectorId: "esun",
      sourceId: "same:已入帳:1",
    });
    const second = transaction({
      id: "second",
      connectorId: "esun",
      sourceId: "same:已入帳:2",
    });
    const unrelated = transaction({ id: "unrelated", connectorId: "tdcc" });

    expect(
      deduplicateBankTransactions([first, second, unrelated]).map(
        ({ id }) => id,
      ),
    ).toEqual(["first", "second", "unrelated"]);
  });
});
