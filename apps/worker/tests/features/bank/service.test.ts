import { describe, expect, it } from "vitest";
import type { BankTransactionPageRow } from "../../../src/features/bank/repository";
import { getBankRange } from "../../../src/features/bank/service";

function transaction(
  input: Partial<BankTransactionPageRow> &
    Pick<BankTransactionPageRow, "id" | "accountId" | "amount">,
): BankTransactionPageRow {
  return {
    connectorId: "tdcc",
    accountSourceId: `account:${input.accountId}`,
    accountName: null,
    institutionName: null,
    accountType: "savings",
    bankCode: null,
    accountLast4: null,
    sourceId: input.id,
    postedDate: "2026-08-22",
    authorizedAt: null,
    currency: "TWD",
    description: null,
    counterparty: null,
    status: "posted",
    effectiveDate: "2026-08-22",
    updatedAt: "2026-08-22T12:00:00.000Z",
    calculationPreference: null,
    ...input,
  };
}

function createDb(
  visibleTransactions: BankTransactionPageRow[],
  candidateTransactions: BankTransactionPageRow[],
  classificationOverrides: Array<{
    target_id: string;
    category_id: string;
    label: string;
  }> = [],
) {
  const db = {
    prepare(sql: string) {
      let values: unknown[] = [];
      const statement = {
        bind(...nextValues: unknown[]) {
          values = nextValues;
          return statement;
        },
        async all() {
          if (sql.includes("ABS(txn.amount)"))
            return { results: candidateTransactions };
          if (sql.includes("COALESCE(txn.authorized_at"))
            return { results: visibleTransactions };
          if (sql.includes("classification_overrides"))
            return { results: classificationOverrides };
          if (sql.includes("classification_rules")) return { results: [] };
          if (sql.includes("FROM bank_accounts")) return { results: [] };
          throw new Error(`Unexpected query: ${sql} (${values.join(",")})`);
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return db;
}

describe("bank transaction presentation", () => {
  it("auto-classifies a same-day opposite transaction from another account", async () => {
    const outgoing = transaction({
      id: "outgoing",
      accountId: "account-a",
      amount: -20_000,
      description: "808979118353",
    });
    const incoming = transaction({
      id: "incoming",
      accountId: "account-b",
      amount: 20_000,
      description: "812015117579",
    });

    const result = await getBankRange(
      createDb([outgoing], [outgoing, incoming]),
      { from: "2026-08-01", to: "2026-09-01" },
    );

    expect(result.transactions).toHaveLength(1);
    expect(result.transactions[0]).toMatchObject({
      id: "outgoing",
      excludedFromCalculation: true,
      classification: {
        categoryId: "transfer",
        label: "轉帳",
        source: "auto_transfer",
        excludedFromCalculation: true,
      },
    });
  });

  it("auto-excludes a same-card annual-fee reduction", async () => {
    const fee = transaction({
      id: "fee",
      accountId: "card-a",
      accountType: "credit",
      amount: -4_500,
      description: "鈦金商務卡年費",
    });
    const reduction = transaction({
      id: "reduction",
      accountId: "card-a",
      accountType: "credit",
      amount: 4_500,
      description: "鈦金商務卡年費減免",
    });

    const result = await getBankRange(
      createDb([fee, reduction], [fee, reduction]),
      {
        from: "2026-08-01",
        to: "2026-09-01",
      },
    );

    expect(result.transactions).toHaveLength(2);
    for (const transaction of result.transactions) {
      expect(transaction).toMatchObject({
        excludedFromCalculation: true,
        classification: {
          categoryId: "fee",
          label: "手續費",
          source: "auto_offset",
          excludedFromCalculation: true,
        },
      });
    }
  });

  it("does not override an explicit classification override", async () => {
    const outgoing = transaction({
      id: "outgoing",
      accountId: "account-a",
      amount: -20_000,
    });
    const incoming = transaction({
      id: "incoming",
      accountId: "account-b",
      amount: 20_000,
    });

    const db = createDb(
      [outgoing],
      [outgoing, incoming],
      [
        {
          target_id: "outgoing",
          category_id: "housing",
          label: "居住",
        },
      ],
    );

    const result = await getBankRange(db, {
      from: "2026-08-01",
      to: "2026-09-01",
    });

    expect(result.transactions[0]).toMatchObject({
      excludedFromCalculation: false,
      classification: {
        categoryId: "housing",
        source: "override",
      },
    });
  });

  it("does not exclude a transaction with an explicit include preference", async () => {
    const outgoing = transaction({
      id: "outgoing",
      accountId: "account-a",
      amount: -20_000,
      calculationPreference: 0,
    });
    const incoming = transaction({
      id: "incoming",
      accountId: "account-b",
      amount: 20_000,
    });

    const result = await getBankRange(
      createDb([outgoing], [outgoing, incoming]),
      { from: "2026-08-01", to: "2026-09-01" },
    );

    expect(result.transactions[0]).toMatchObject({
      excludedFromCalculation: false,
      classification: { source: "fallback" },
    });
  });
});
