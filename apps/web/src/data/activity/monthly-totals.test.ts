import { describe, expect, it } from "vitest";
import type { BankData, BankTransactionRow } from "@/data/bank/types";
import type {
  InvoiceSummaryRow,
  InvoiceTransactionPreference,
} from "@/data/invoices/types";
import { calculateMonthlyActivityTotals } from "./monthly-totals";

function transaction(
  input: Partial<BankTransactionRow> &
    Pick<BankTransactionRow, "id" | "amount">,
): BankTransactionRow {
  return {
    connectorId: "sinopac",
    accountId: "account-1",
    sourceId: input.id,
    postedDate: "2026-07-02",
    currency: "TWD",
    status: "posted",
    excludedFromCalculation: false,
    ...input,
  };
}

function invoice(
  input: Partial<InvoiceSummaryRow> & Pick<InvoiceSummaryRow, "id" | "amount">,
): InvoiceSummaryRow {
  return {
    connectorId: "einvoice",
    sourceId: input.id,
    invoiceNumber: input.id,
    invoiceDate: "2026-07-02",
    sellerName: "測試商家",
    ...input,
  };
}

describe("calculateMonthlyActivityTotals", () => {
  it("統計銀行、信用卡與未配對發票，並略過已排除活動", () => {
    const bank: BankData = {
      accounts: [
        {
          id: "account-1",
          connectorId: "sinopac",
          sourceId: "account-1",
          accountType: "deposit",
          currency: "TWD",
        },
        {
          id: "card-1",
          connectorId: "sinopac",
          sourceId: "card-1",
          accountType: "credit",
          currency: "TWD",
        },
      ],
      transactions: [
        transaction({ id: "salary", amount: 10_000 }),
        transaction({
          id: "card-expense",
          accountId: "card-1",
          amount: -1_200,
        }),
        transaction({
          id: "excluded",
          amount: -500,
          excludedFromCalculation: true,
        }),
      ],
    };

    expect(
      calculateMonthlyActivityTotals(
        bank,
        [invoice({ id: "unmatched", amount: 300 })],
        [],
        {},
      ),
    ).toEqual({ income: 10_000, expense: 1_500 });
  });

  it("已配對發票不會重複列入支出", () => {
    const cardExpense = transaction({
      id: "card-expense",
      accountId: "card-1",
      amount: -1_200,
    });
    const matchedInvoice = invoice({ id: "matched", amount: 1_200 });
    const mappings: InvoiceTransactionPreference[] = [
      {
        invoiceId: matchedInvoice.id,
        decision: "linked",
        transactionId: cardExpense.id,
        updatedAt: "2026-07-02T00:00:00.000Z",
      },
    ];

    expect(
      calculateMonthlyActivityTotals(
        {
          accounts: [
            {
              id: "card-1",
              connectorId: "sinopac",
              sourceId: "card-1",
              accountType: "credit",
              currency: "TWD",
            },
          ],
          transactions: [cardExpense],
        },
        [matchedInvoice],
        mappings,
        {},
      ),
    ).toEqual({ income: 0, expense: 1_200 });
  });
});
