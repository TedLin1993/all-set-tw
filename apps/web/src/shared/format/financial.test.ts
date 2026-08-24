import { describe, expect, it } from "vitest";
import {
  bankAccountLast5,
  formatBankAccountName,
  formatNumber,
  missingExchangeRateCurrencies,
  normalizeFinancialDate,
  parseValidDate,
  rateMap,
  transactionValueTwd,
} from "./financial";

describe("financial formatting helpers", () => {
  it("formats numbers using the Taiwan locale", () => {
    expect(formatNumber(1234567)).toBe("1,234,567");
  });

  it("extracts the last five digits from supported bank source ids", () => {
    expect(bankAccountLast5("settlement:esun:1234567890")).toBe("67890");
    expect(bankAccountLast5("bank:esun:987654321")).toBe("54321");
    expect(bankAccountLast5("bank:skbank:4321:hash")).toBe("4321");
    expect(bankAccountLast5("other:account")).toBeUndefined();
  });

  it("uses account labels when a source id has no account number", () => {
    expect(
      formatBankAccountName({
        accountName: "末五碼 12345",
        sourceId: "unknown",
      }),
    ).toBe("12345");
    expect(
      formatBankAccountName({ accountName: "現金", accountType: "credit" }),
    ).toBe("現金");
  });

  it("accepts ISO dates and date-only fallbacks while rejecting invalid values", () => {
    expect(parseValidDate("2026-07-13")?.getFullYear()).toBe(2026);
    expect(normalizeFinancialDate("0115-07-13T00:00:00.000Z")).toBe(
      "2026-07-13T00:00:00.000Z",
    );
    expect(parseValidDate("0115-07-13T00:00:00.000Z")?.getFullYear()).toBe(
      2026,
    );
    expect(parseValidDate("not-a-date")).toBeUndefined();
  });

  it("maps exchange rates and converts non-TWD transactions", () => {
    const rates = rateMap([
      { currency: "USD", rateTwd: 32, updatedAt: "2026-07-13T00:00:00Z" },
    ]);
    expect(rates).toEqual({ USD: 32 });
    expect(
      transactionValueTwd({ currency: "USD", amount: 10 } as never, rates),
    ).toBe(320);
  });

  it("reports missing rates only for positive foreign-currency amounts", () => {
    expect(
      missingExchangeRateCurrencies(
        [
          { currency: "HKD", amount: 0 },
          { currency: "HKD", amount: 100 },
          { currency: "HKD", amount: 200 },
          { currency: "CNY", amount: -100 },
          { currency: "USD", amount: 100 },
          { currency: "TWD", amount: 100 },
        ],
        { USD: 32 },
      ),
    ).toEqual(["HKD"]);
  });
});
