import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import {
  extractCathayLoanOverviewDom,
  isCathayLoanOverviewQuerySettled,
  parseCathayLoanOverview,
} from "../../../src/sources/cathaybk/loan-overview";

function readFixture(name: string) {
  return readFileSync(
    new URL(`../../fixtures/${name}`, import.meta.url),
    "utf8",
  );
}

const fullLayoutHtml = readFixture("cathay-loan-overview-layout.html");
const optionalMissingLayoutHtml = readFixture(
  "cathay-loan-overview-layout-optional-missing.html",
);
const compactFixtureHtml = readFixture("cathay-loan-overview.html");
const tableLayoutHtml = readFixture("cathay-loan-overview-table.html");

function extractHtml(html: string) {
  const dom = new JSDOM(html, {
    url: "https://www.cathaybk.com.tw/OnlineBanking/LoanInq/L0101_LoanInq",
  });
  return extractCathayLoanOverviewDom(dom.window.document);
}

function sensitiveLoanValues(extraction: ReturnType<typeof extractHtml>) {
  return extraction.loanAccounts
    .flatMap((loanAccount) => [
      loanAccount.accountNumber,
      loanAccount.interestRate,
      loanAccount.paymentAmount,
      loanAccount.paymentDueOrStatus,
      loanAccount.balance,
      loanAccount.installments,
    ])
    .filter((value): value is string => Boolean(value));
}

describe("Cathay loan overview table layout", () => {
  it("extracts five overview-only records and does not click account links", () => {
    const dom = new JSDOM(tableLayoutHtml, {
      url: "https://www.cathaybk.com.tw/OnlineBanking/LoanInq/L0101_LoanInq",
    });
    let clickedLinks = 0;
    for (const anchor of dom.window.document.querySelectorAll("tbody a")) {
      anchor.addEventListener("click", () => clickedLinks++);
    }

    const extraction = extractCathayLoanOverviewDom(dom.window.document);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loans = parseCathayLoanOverview(extraction);
      expect(extraction.overviewRecognized).toBe(true);
      expect(extraction.diagnostics.recognizedLoanCardCount).toBe(5);
      expect(extraction.loanAccounts).toHaveLength(5);
      expect(loans).toEqual([
        {
          accountNumber: "0000000000000001",
          loanCategory: "housing",
          interestRate: 1.37,
          currentPaymentAmount: 123456,
          paymentDueDate: "2026-11-05",
          paymentStatus: "scheduled",
          balance: 9876543,
          installmentsPaid: 17,
          installmentsTotal: 180,
          currency: "TWD",
        },
        {
          accountNumber: "0000000000000002",
          loanCategory: "housing",
          currentPaymentAmount: 234567,
          paymentDueDate: "2026-11-06",
          paymentStatus: "scheduled",
          balance: 8765432,
          currency: "TWD",
        },
        {
          accountNumber: "0000000000000003",
          loanCategory: "housing",
          interestRate: 2.64,
          currentPaymentAmount: 345678,
          paymentDueDate: "2026-11-07",
          paymentStatus: "scheduled",
          balance: 7654321,
          installmentsPaid: 25,
          installmentsTotal: 240,
          currency: "TWD",
        },
        {
          accountNumber: "0000000000000004",
          loanCategory: "other",
          interestRate: 2.91,
          currentPaymentAmount: 456789,
          paymentDueDate: "2026-11-08",
          paymentStatus: "scheduled",
          balance: 6543210,
          currency: "TWD",
        },
        {
          accountNumber: "0000000000000005",
          loanCategory: "other",
          interestRate: 3.18,
          currentPaymentAmount: 567890,
          paymentDueDate: "2026-11-09",
          paymentStatus: "scheduled",
          balance: 5432109,
          installmentsPaid: 8,
          installmentsTotal: 60,
          currency: "TWD",
        },
      ]);
      expect(clickedLinks).toBe(0);

      const serializedLogs = JSON.stringify(log.mock.calls);
      for (const privateFixtureValue of sensitiveLoanValues(extraction)) {
        expect(serializedLogs).not.toContain(privateFixtureValue);
      }
      expect(serializedLogs).not.toContain("L0101_LoanInqDetail");
    } finally {
      log.mockRestore();
    }
  });

  it("retains core records without assigning a category when table context has none", () => {
    const dom = new JSDOM(tableLayoutHtml);
    dom.window.document
      .querySelectorAll("h2")
      .forEach((heading) => heading.remove());
    const extraction = extractCathayLoanOverviewDom(dom.window.document);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const loans = parseCathayLoanOverview(extraction);
      expect(loans).toHaveLength(5);
      expect(
        loans.every(
          (loan) =>
            Number.isFinite(loan.balance) &&
            Number.isFinite(loan.currentPaymentAmount) &&
            !Object.hasOwn(loan, "loanCategory"),
        ),
      ).toBe(true);
    } finally {
      log.mockRestore();
    }
  });
});

const syntheticAccount = (index: number) =>
  `000000000000${String(index).padStart(4, "0")}`;

describe("Cathay loan overview query completion", () => {
  it("does not treat a heading-only page or a visible loader as completed", () => {
    const headingOnly = extractHtml(
      "<h1>貸款帳戶總覽</h1><h2>貸款總餘額：$0</h2>",
    );
    expect(headingOnly.pageState).toBe("incomplete");
    expect(
      isCathayLoanOverviewQuerySettled(
        new JSDOM("<h1>貸款帳戶總覽</h1><h2>貸款總餘額：$0</h2>").window
          .document,
      ),
    ).toBe(false);
    expect(() => parseCathayLoanOverview(headingOnly)).toThrow(
      "Cathay loan overview query did not complete.",
    );

    const loadingDocument = new JSDOM(
      '<h1>貸款帳戶總覽</h1><div aria-busy="true">載入中</div>',
    ).window.document;
    const loading = extractCathayLoanOverviewDom(loadingDocument);
    expect(loading.pageState).toBe("loading");
    expect(isCathayLoanOverviewQuerySettled(loadingDocument)).toBe(false);
    expect(() => parseCathayLoanOverview(loading)).toThrow(
      "Cathay loan overview query is still loading.",
    );
  });

  it("distinguishes maintenance and only accepts an explicitly confirmed empty overview", () => {
    const maintenanceDocument = new JSDOM("<p>系統維護中，暫停服務</p>").window
      .document;
    const maintenance = extractCathayLoanOverviewDom(maintenanceDocument);
    expect(maintenance.pageState).toBe("maintenance");
    expect(isCathayLoanOverviewQuerySettled(maintenanceDocument)).toBe(true);
    expect(() => parseCathayLoanOverview(maintenance)).toThrow(
      "Cathay loan overview is under maintenance.",
    );

    const emptyDocument = new JSDOM(
      "<h1>貸款帳戶總覽</h1><h2>貸款總餘額：$0</h2><p>目前無貸款資料</p>",
    ).window.document;
    const empty = extractCathayLoanOverviewDom(emptyDocument);
    expect(empty.pageState).toBe("empty");
    expect(isCathayLoanOverviewQuerySettled(emptyDocument)).toBe(true);
    expect(parseCathayLoanOverview(empty)).toEqual([]);

    const unconfirmedEmpty = extractHtml(
      "<h1>貸款帳戶總覽</h1><h2>貸款總餘額：$0</h2>",
    );
    expect(unconfirmedEmpty.pageState).toBe("incomplete");
  });
});

describe("Cathay loan overview DOM extraction", () => {
  it.each([
    { name: "first sanitized owner layout", html: fullLayoutHtml },
    {
      name: "second sanitized owner layout with optional fields omitted",
      html: optionalMissingLayoutHtml,
    },
  ])(
    "discovers and parses all loan accounts in the $name",
    ({ html, name }) => {
      const extraction = extractHtml(html);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        const loans = parseCathayLoanOverview(extraction);
        expect(extraction.overviewRecognized).toBe(true);
        expect(extraction.currency).toBe("TWD");
        expect(extraction.diagnostics.recognizedLoanCardCount).toBe(5);
        expect(extraction.diagnostics.totalSectionFound).toBe(true);
        expect(extraction.diagnostics.loanTotalAmountDigitCount).toBe(7);
        expect(extraction.diagnostics.loanTotalAmountLast3).toBe("000");
        expect(extraction.loanAccounts).toHaveLength(5);
        expect(loans).toHaveLength(5);
        expect(
          extraction.loanAccounts.map(
            (loanAccount) => loanAccount.accountNumber,
          ),
        ).toEqual(
          Array.from({ length: 5 }, (_, index) => syntheticAccount(index + 1)),
        );
        expect(
          extraction.loanAccounts.every(
            (loanAccount) =>
              loanAccount.hasPaymentAmountLabel &&
              loanAccount.hasPaymentDueLabel &&
              loanAccount.hasBalanceLabel &&
              loanAccount.paymentAmount === "$12,345" &&
              loanAccount.balance === "$500,000" &&
              Boolean(loanAccount.paymentDueOrStatus),
          ),
        ).toBe(true);
        expect(
          loans.every(
            (loan) =>
              Number.isFinite(loan.currentPaymentAmount) &&
              loan.currentPaymentAmount === 12345 &&
              loan.balance === 500000 &&
              loan.currency === "TWD",
          ),
        ).toBe(true);

        if (name.includes("optional fields omitted")) {
          expect(
            extraction.loanAccounts.every(
              (loanAccount) =>
                loanAccount.category === null &&
                loanAccount.interestRate === null &&
                loanAccount.installments === null,
            ),
          ).toBe(true);
          expect(
            loans.every(
              (loan) =>
                !Object.hasOwn(loan, "loanCategory") &&
                !Object.hasOwn(loan, "interestRate") &&
                !Object.hasOwn(loan, "installmentsPaid") &&
                !Object.hasOwn(loan, "installmentsTotal"),
            ),
          ).toBe(true);
        } else {
          expect(extraction.loanAccounts[0]).toMatchObject({
            category: "房屋貸款",
            accountNumber: syntheticAccount(1),
            interestRate: "1.25%",
            paymentAmount: "$12,345",
            paymentDueOrStatus: "未完成扣款",
            balance: "$500,000",
            installments: "已繳 7 期，共 240 期",
          });
          expect(loans[0]).toMatchObject({
            loanCategory: "housing",
            interestRate: 1.25,
            currentPaymentAmount: 12345,
            paymentStatus: "collection_incomplete",
            balance: 500000,
            installmentsPaid: 7,
            installmentsTotal: 240,
          });
          expect(loans[1]).toMatchObject({
            paymentDueDate: "2026-11-06",
            paymentStatus: "scheduled",
          });
        }
      } finally {
        log.mockRestore();
      }
    },
  );

  it("does not emit loan diagnostics by default", () => {
    const extraction = extractHtml(fullLayoutHtml);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      expect(parseCathayLoanOverview(extraction)).toHaveLength(5);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("reports missing optional fields safely while retaining the core loan records", () => {
    const extraction = extractHtml(optionalMissingLayoutHtml);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const loans = parseCathayLoanOverview(extraction);

      expect(loans).toHaveLength(5);
      expect(
        loans.every(
          (loan) =>
            !Object.hasOwn(loan, "loanCategory") &&
            !Object.hasOwn(loan, "interestRate") &&
            !Object.hasOwn(loan, "installmentsPaid") &&
            !Object.hasOwn(loan, "installmentsTotal"),
        ),
      ).toBe(true);
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it("does not fail or invent values for malformed optional fields", () => {
    const extraction = extractHtml(fullLayoutHtml);
    extraction.loanAccounts[0]!.category = "信用貸款";
    extraction.loanAccounts[0]!.interestRate = "not-a-rate";
    extraction.loanAccounts[0]!.installments = "not-an-installment-count";
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      const loans = parseCathayLoanOverview(extraction);

      expect(loans).toHaveLength(5);
      expect(loans[0]).not.toHaveProperty("loanCategory");
      expect(loans[0]).not.toHaveProperty("interestRate");
      expect(loans[0]).not.toHaveProperty("installmentsPaid");
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });

  it.each([
    { field: "paymentAmount" as const },
    { field: "paymentDueOrStatus" as const },
    { field: "balance" as const },
  ])(
    "rejects a missing core $field without emitting diagnostics",
    ({ field }) => {
      const extraction = extractHtml(fullLayoutHtml);
      extraction.loanAccounts[0]![field] = null;
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      try {
        expect(() => parseCathayLoanOverview(extraction)).toThrow(
          "Cathay loan overview card could not be parsed.",
        );
        expect(log).not.toHaveBeenCalled();
      } finally {
        log.mockRestore();
      }
    },
  );

  it("keeps compatibility with a compact labeled synthetic overview", () => {
    const extraction = extractHtml(compactFixtureHtml);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      expect(extraction.loanAccounts).toHaveLength(2);
      expect(parseCathayLoanOverview(extraction)).toHaveLength(2);
    } finally {
      log.mockRestore();
    }
  });

  it("reports an unrecognized page without logging its page text", () => {
    const document = new JSDOM(
      "<!doctype html><html><body><p>PRIVATE_PAGE_SENTINEL</p></body></html>",
    ).window.document;
    const extraction = extractCathayLoanOverviewDom(document);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    try {
      expect(() => parseCathayLoanOverview(extraction)).toThrow(
        "Cathay loan overview page was not recognized.",
      );
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        "PRIVATE_PAGE_SENTINEL",
      );
    } finally {
      log.mockRestore();
    }
  });
});
