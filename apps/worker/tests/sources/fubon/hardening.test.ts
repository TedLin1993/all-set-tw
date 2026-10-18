import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FUBON_CREDIT_ACCOUNT_ID,
  FubonSyncReport,
  deriveFubonPaymentState,
  deriveFubonPreviousBillPayment,
  describeFubonError,
  fubonCurrency,
  fubonPaymentStateToIsPaid,
  isFubonBlankCell,
  parseFubonAmount,
  parseFubonData,
  parseFubonDate,
  parseFubonDepositTransactionRow,
  parseFubonMonth,
  parseFubonTimestamp,
  type FubonPayloads,
} from "../../../src/sources/fubon/protocol";
import {
  FUBON_MAX_CONSECUTIVE_STEP_FAILURES,
  FubonSessionEndedError,
  FubonStepRunner,
  clickFubonOverviewTransactionLink,
  isFubonFatalFetchError,
} from "../../../src/sources/fubon/connector";

// 合成資料：以去識別 fixture 為底，只替換個別儲存格製造格式錯誤；不含真實帳號或金額。
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const overviewHtml = fixture("deposit-overview.html");
const transactionsHtml = fixture("deposit-transactions.html");
const statusHtml = fixture("card-payment-status.html");
const billHtml = fixture("card-bill.html");
const unbilledHtml = fixture("card-unbilled.html");
const NOW = new Date("2026-10-13T16:00:00.000Z"); // 台灣時間 2026-10-14 00:00
const ACCOUNT_NO = "01234500004321";

function payloads(overrides: Partial<FubonPayloads> = {}): FubonPayloads {
  return {
    depositOverviewHtml: overviewHtml,
    depositTransactions: [
      { accountNo: ACCOUNT_NO, currency: "TWD", pages: [transactionsHtml] },
    ],
    card: {
      hasCreditCard: true,
      statusHtml,
      billHtmls: [billHtml],
      unbilledHtml,
    },
    ...overrides,
  };
}

describe("台北富邦數字解析", () => {
  it("接受千分位、小數、正負號、括號負數、後置負號與全形數字", () => {
    expect(parseFubonAmount("18,400.00")).toBe(18400);
    expect(parseFubonAmount("-1,234.5")).toBe(-1234.5);
    expect(parseFubonAmount("+15")).toBe(15);
    expect(parseFubonAmount("(1,234)")).toBe(-1234);
    expect(parseFubonAmount("1,234-")).toBe(-1234);
    expect(parseFubonAmount("１，２３４．５６")).toBe(1234.56);
    expect(parseFubonAmount("－６４０")).toBe(-640);
    expect(parseFubonAmount("NT$ 1,340")).toBe(1340);
    expect(parseFubonAmount("1340元")).toBe(1340);
    expect(parseFubonAmount("USD 3.15")).toBe(3.15);
    expect(parseFubonAmount("0.99")).toBe(0.99);
    expect(parseFubonAmount("-0")).toBe(0);
  });

  it("空白、佔位符與格式錯誤回傳 undefined，不產生 NaN", () => {
    for (const value of [
      undefined,
      "",
      " ",
      "-",
      "--",
      "－",
      "N/A",
      "abc",
      "1,23,4",
      "12,34",
      "1.2.3",
      "(-5)",
      "1e5",
      "12345678901234",
    ]) {
      expect(parseFubonAmount(value)).toBeUndefined();
    }
    expect(isFubonBlankCell(" - ")).toBe(true);
    expect(isFubonBlankCell("0")).toBe(false);
  });

  it("幣別名稱與代碼轉為大寫 ISO 代碼，未知名稱不猜測", () => {
    expect(fubonCurrency("臺幣")).toBe("TWD");
    expect(fubonCurrency(" 美金 ")).toBe("USD");
    expect(fubonCurrency("usd")).toBe("USD");
    expect(fubonCurrency("人民幣")).toBe("CNY");
    expect(fubonCurrency("火星幣")).toBeUndefined();
  });
});

describe("台北富邦日期解析", () => {
  it("民國與西元日期都轉為 ISO 日期，並拒絕不存在的日期", () => {
    expect(parseFubonDate("115/09/26")).toBe("2026-09-26");
    expect(parseFubonDate("115.9.6")).toBe("2026-09-06");
    expect(parseFubonDate("民國115年9月26日")).toBe("2026-09-26");
    expect(parseFubonDate("2026/09/26")).toBe("2026-09-26");
    expect(parseFubonDate("２０２６／０９／２６".replace(/／/g, "/"))).toBe(
      "2026-09-26",
    );
    expect(parseFubonDate("115/02/29")).toBeUndefined(); // 2026 非閏年
    expect(parseFubonDate("113/02/29")).toBe("2024-02-29");
    expect(parseFubonDate("2026/13/01")).toBeUndefined();
    expect(parseFubonDate("2026/04/31")).toBeUndefined();
    expect(parseFubonDate("1899/01/01")).toBeUndefined();
    expect(parseFubonDate("-")).toBeUndefined();
    expect(parseFubonDate("")).toBeUndefined();
    expect(parseFubonMonth("115/09")).toBe("2026-09");
    expect(parseFubonMonth("2026/00")).toBeUndefined();
  });

  it("交易時間以台灣時區（+08:00）保存，時間超出範圍時拒絕", () => {
    expect(parseFubonTimestamp("2026/08/10 10:12:30")).toBe(
      "2026-08-10T10:12:30+08:00",
    );
    expect(parseFubonTimestamp("115/08/10 9:05")).toBe(
      "2026-08-10T09:05:00+08:00",
    );
    expect(parseFubonTimestamp("2026/08/10 24:00:00")).toBeUndefined();
    expect(parseFubonTimestamp("2026/08/10 12:60")).toBeUndefined();
    expect(parseFubonTimestamp("2026/02/30 10:00:00")).toBeUndefined();
    expect(parseFubonTimestamp("2026/08/10")).toBeUndefined();
  });
});

describe("台北富邦交易明細單列驗證", () => {
  const row = (overrides: Partial<Record<number, string>> = {}) => {
    const base = [
      "2026/08/10",
      "2026/08/10 10:12:30",
      "測試摘要",
      "",
      "1,000.00",
      "2,000.00",
      "測試附註",
    ];
    return base.map((value, index) => overrides[index] ?? value);
  };

  it("支出／存入只有一欄有值；`-` 視為空白", () => {
    expect(parseFubonDepositTransactionRow(row()).amount).toBe(1000);
    expect(
      parseFubonDepositTransactionRow(row({ 3: "250", 4: "-" })).amount,
    ).toBe(-250);
  });

  it("格式錯誤的列拋出 FubonRowRejectedError", () => {
    const cases: Array<[Partial<Record<number, string>>, RegExp]> = [
      [{ 0: "2026/02/30" }, /日期/],
      [{ 4: "1,0x0" }, /金額無法解析/],
      [{ 3: "", 4: "" }, /缺少支出或存入/],
      [{ 3: "5", 4: "5" }, /同時有支出與存入/],
      [{ 4: "(5)" }, /方向/],
      [{ 1: "2026/08/10 25:00" }, /交易時間/],
      [{ 5: "abc" }, /即時餘額/],
    ];
    for (const [overrides, message] of cases) {
      expect(() => parseFubonDepositTransactionRow(row(overrides))).toThrow(
        message,
      );
      try {
        parseFubonDepositTransactionRow(row(overrides));
      } catch (error) {
        expect((error as Error).name).toBe("FubonRowRejectedError");
      }
    }
    // 交易時間空白時仍接受（只以日期識別）。
    expect(
      parseFubonDepositTransactionRow(row({ 1: "" })).transactedAt,
    ).toBeUndefined();
  });
});

describe("台北富邦繳款狀態", () => {
  const base = {
    statementAmount: 1340,
    minimumPayment: 1000,
    paymentDueDate: "2026-10-12",
  };
  const before = new Date("2026-10-01T04:00:00Z");
  const after = new Date("2026-10-13T04:00:00Z");

  it("依狀態文字、金額與繳款截止日（台灣日期）推得細分狀態並對應 isPaid", () => {
    const cases: Array<
      [Parameters<typeof deriveFubonPaymentState>[0], Date, string]
    > = [
      [
        { ...base, paymentStatus: "已繳款", remainingAmount: 0 },
        before,
        "paid",
      ],
      [{ ...base, paymentStatus: "未繳款", remainingAmount: 0 }, after, "paid"],
      [
        {
          ...base,
          paymentStatus: "未繳款",
          paidAmount: 1340,
          remainingAmount: 1340,
        },
        before,
        "payment_processing",
      ],
      [
        {
          ...base,
          paymentStatus: "未繳款",
          paidAmount: 0,
          remainingAmount: 1340,
        },
        before,
        "unpaid",
      ],
      [
        {
          ...base,
          paymentStatus: "未繳款",
          paidAmount: 0,
          remainingAmount: 1340,
          autopay: true,
        },
        before,
        "autopay_pending",
      ],
      [
        {
          ...base,
          paymentStatus: "未繳款",
          paidAmount: 0,
          remainingAmount: 1340,
        },
        after,
        "overdue",
      ],
      [
        {
          ...base,
          paymentStatus: "未繳款",
          paidAmount: 1280,
          remainingAmount: 60,
        },
        before,
        "partial",
      ],
      [
        {
          ...base,
          paymentStatus: "未繳款",
          paidAmount: 100,
          remainingAmount: 1240,
        },
        before,
        "below_minimum",
      ],
      [
        { ...base, paymentStatus: "逾期未繳", remainingAmount: 1340 },
        before,
        "overdue",
      ],
      [
        { ...base, statementAmount: 0, remainingAmount: 0 },
        after,
        "no_payment_needed",
      ],
      [
        { ...base, statementAmount: -120, remainingAmount: -120 },
        after,
        "credit_balance",
      ],
      [{ ...base, paymentStatus: "未繳款" }, before, "unknown"],
    ];
    for (const [input, now, expected] of cases) {
      expect(deriveFubonPaymentState(input, now)).toBe(expected);
    }
    expect(fubonPaymentStateToIsPaid("payment_processing")).toBe(true);
    expect(fubonPaymentStateToIsPaid("credit_balance")).toBe(true);
    expect(fubonPaymentStateToIsPaid("autopay_pending")).toBe(false);
    expect(fubonPaymentStateToIsPaid("overdue")).toBe(false);
    expect(fubonPaymentStateToIsPaid("unknown")).toBeUndefined();
  });

  it("繳款截止日當天（台灣時間深夜）仍未逾期", () => {
    // UTC 15:59 = 台灣 23:59（截止日當天）；UTC 16:00 = 台灣隔日 00:00。
    const input = { ...base, paidAmount: 0, remainingAmount: 1340 };
    expect(
      deriveFubonPaymentState(input, new Date("2026-10-12T15:59:00Z")),
    ).toBe("unpaid");
    expect(
      deriveFubonPaymentState(input, new Date("2026-10-12T16:00:00Z")),
    ).toBe("overdue");
  });

  it("較早期別以下一期的前期應繳與繳(退)金額推得", () => {
    const bill = { statementAmount: 3480, paymentDueDate: "2026-09-12" };
    expect(
      deriveFubonPreviousBillPayment(
        bill,
        { previousBalance: 3480, paymentsAndRefunds: 3480 },
        after,
      ),
    ).toEqual({ state: "paid", paidAmount: 3480 });
    expect(
      deriveFubonPreviousBillPayment(
        bill,
        { previousBalance: 3480, paymentsAndRefunds: -500 },
        after,
      ),
    ).toEqual({ state: "overdue", paidAmount: 500 });
    // 前期應繳與本期金額對不上時不推測。
    expect(
      deriveFubonPreviousBillPayment(
        bill,
        { previousBalance: 3470, paymentsAndRefunds: 3480 },
        after,
      ),
    ).toEqual({ state: "unknown" });
    expect(deriveFubonPreviousBillPayment(bill, undefined, after)).toEqual({
      state: "unknown",
    });
  });
});

describe("台北富邦部分失敗容錯", () => {
  it("總覽單列格式錯誤只略過該帳戶，其餘帳戶與資料照常輸出", () => {
    const gridStart = overviewHtml.indexOf("form1:resultGrid_DataGridBody");
    const broken =
      overviewHtml.slice(0, gridStart) +
      overviewHtml
        .slice(gridStart)
        .replace(
          /(<td class="ct">美金<\/td>\s*)<td class="rt">3\.15<\/td>/,
          '$1<td class="rt">3..15</td>',
        );
    expect(broken).not.toBe(overviewHtml);
    const report = new FubonSyncReport();
    const data = parseFubonData(
      payloads({ depositOverviewHtml: broken }),
      NOW,
      report,
    );
    const currencies = data.bankAccounts
      .filter((account) => account.accountType !== "credit")
      .map((account) => account.currency)
      .sort();
    expect(currencies).toEqual(["CNY", "TWD"]);
    expect(report.counts.foreignDeposits).toEqual({
      ok: 1,
      failed: 0,
      rowsRejected: 1,
    });
    expect(report.counts.twdDeposits.ok).toBe(1);
    expect(report.summary()).toMatchObject({
      status: "partial",
      failureCount: 1,
      failures: [
        {
          category: "foreignDeposits",
          stage: "row",
          errorClass: "FubonRowRejectedError",
          message: "台北富邦存款總覽的即時餘額無法解析。",
        },
      ],
    });
    expect(report.userMessage()).toBe(
      "部分資料未能取得，已略過：外幣存款 1 筆。",
    );
  });

  it("交易明細頁面格式錯誤只略過該帳戶；單列錯誤只略過該列", () => {
    const report = new FubonSyncReport();
    const data = parseFubonData(
      payloads({
        depositTransactions: [
          {
            accountNo: ACCOUNT_NO,
            currency: "TWD",
            pages: ["<html><body>系統維護中</body></html>"],
          },
        ],
      }),
      NOW,
      report,
    );
    expect(report.counts.twdTransactions).toEqual({
      ok: 0,
      failed: 1,
      rowsRejected: 0,
    });
    expect(
      data.bankTransactions.some((tx) =>
        tx.sourceId.startsWith("fubon:deposit:tx:"),
      ),
    ).toBe(false);
    // 信用卡與存款帳戶不受影響。
    expect(data.creditCardBills).toHaveLength(1);
    expect(data.bankAccounts.length).toBeGreaterThan(3);

    const rowBroken = transactionsHtml.replace(
      '<td class="rt">18,400.00</td>',
      '<td class="rt">18,4O0.00</td>',
    );
    expect(rowBroken).not.toBe(transactionsHtml);
    const rowReport = new FubonSyncReport();
    const rowData = parseFubonData(
      payloads({
        depositTransactions: [
          { accountNo: ACCOUNT_NO, currency: "TWD", pages: [rowBroken] },
        ],
      }),
      NOW,
      rowReport,
    );
    expect(
      rowData.bankTransactions.filter((tx) =>
        tx.sourceId.startsWith("fubon:deposit:tx:"),
      ),
    ).toHaveLength(7);
    expect(rowReport.counts.twdTransactions).toEqual({
      ok: 1,
      failed: 0,
      rowsRejected: 1,
    });
    // 其餘列的 sourceId 不受略過的列影響。
    const full = parseFubonData(payloads(), NOW).bankTransactions.map(
      (tx) => tx.sourceId,
    );
    for (const tx of rowData.bankTransactions) {
      expect(full).toContain(tx.sourceId);
    }
  });

  it("帳單頁或未出帳頁失敗時保留其他信用卡資料，缺未出帳時不建立負債快照", () => {
    const report = new FubonSyncReport();
    const data = parseFubonData(
      payloads({
        card: {
          hasCreditCard: true,
          statusHtml,
          billHtmls: ["<html><body>系統忙碌</body></html>", billHtml],
          unbilledHtml: undefined,
        },
      }),
      NOW,
      report,
    );
    expect(report.counts.cardBills).toEqual({
      ok: 1,
      failed: 1,
      rowsRejected: 0,
    });
    expect(data.creditCardBills.map((bill) => bill.billingPeriod)).toEqual([
      "2026-09",
    ]);
    expect(
      data.bankAccounts.some((account) => account.accountType === "credit"),
    ).toBe(true);
    expect(
      data.bankBalanceSnapshots.some(
        (snapshot) => snapshot.accountId === FUBON_CREDIT_ACCOUNT_ID,
      ),
    ).toBe(false);
    expect(data.hasCreditCard).toBe(true);
  });

  it("繳款頁失敗時仍保留帳單與明細，但不建立快照、繳款狀態由下一期推得或未知", () => {
    const report = new FubonSyncReport();
    const data = parseFubonData(
      payloads({
        card: {
          hasCreditCard: true,
          statusHtml: "<html><body>系統忙碌</body></html>",
          billHtmls: [billHtml],
          unbilledHtml,
        },
      }),
      NOW,
      report,
    );
    expect(report.counts.cardStatus.failed).toBe(1);
    expect(data.creditCardBills[0]).toMatchObject({
      billingPeriod: "2026-09",
      isPaid: undefined,
      raw: expect.objectContaining({ paymentState: "unknown" }),
    });
    expect(
      data.bankBalanceSnapshots.some(
        (snapshot) => snapshot.accountId === FUBON_CREDIT_ACCOUNT_ID,
      ),
    ).toBe(false);
    expect(
      data.bankTransactions.filter((tx) => tx.status === "pending"),
    ).toHaveLength(1);
  });

  it("帳單明細單列錯誤只略過該列並計入信用卡明細", () => {
    const broken = billHtml.replace(
      '<td class="rt">1,050</td>',
      '<td class="rt">1,O50</td>',
    );
    expect(broken).not.toBe(billHtml);
    const report = new FubonSyncReport();
    const data = parseFubonData(
      payloads({
        card: {
          hasCreditCard: true,
          statusHtml,
          billHtmls: [broken],
          unbilledHtml,
        },
      }),
      NOW,
      report,
    );
    expect(report.counts.cardTransactions).toEqual({
      ok: 3,
      failed: 0,
      rowsRejected: 1,
    });
    expect(
      data.bankTransactions.filter(
        (tx) =>
          tx.status === "posted" && tx.accountId === FUBON_CREDIT_ACCOUNT_ID,
      ),
    ).toHaveLength(2);
  });

  it("總覽擷取失敗時不建立存款資料，信用卡照常", () => {
    const report = new FubonSyncReport();
    const data = parseFubonData(
      payloads({ depositOverviewHtml: undefined, depositTransactions: [] }),
      NOW,
      report,
    );
    expect(
      data.bankAccounts.every((account) => account.accountType === "credit"),
    ).toBe(true);
    expect(data.creditCardBills).toHaveLength(1);
  });

  it("錯誤原因去識別化：遮罩帳號、卡號與身分證字號，網址去除 query", () => {
    const described = describeFubonError(
      new Error(
        "帳號 01234500004321 卡號 5555551234569876 A123456789 https://ebank.taipeifubon.com.tw/B2C/x.faces?token=abc",
      ),
    );
    expect(described.errorClass).toBe("Error");
    expect(described.message).not.toMatch(
      /0123450000|555555123456|A123456789|token/,
    );
    expect(described.message).toContain("ebank.taipeifubon.com.tw/B2C/x.faces");
    const report = new FubonSyncReport();
    for (let index = 0; index < 20; index += 1)
      report.fail("cardBills", "fetch", new Error("x"));
    expect(report.summary()).toMatchObject({
      failureCount: 20,
      failuresTruncated: true,
    });
    expect(report.summary().failures).toHaveLength(12);
  });
});

describe("台北富邦逐項擷取", () => {
  afterEach(() => vi.restoreAllMocks());

  it("一般失敗略過並記錄；工作階段結束或瀏覽器斷線仍中止", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const report = new FubonSyncReport();
    const runner = new FubonStepRunner(report, async () => undefined);
    expect(
      await runner.run("cardBills", "fetch", async () => {
        throw new Error("page timeout");
      }),
    ).toBeUndefined();
    expect(await runner.run("cardUnbilled", "fetch", async () => "ok")).toBe(
      "ok",
    );
    await expect(
      runner.run("cardStatus", "fetch", async () => {
        throw new FubonSessionEndedError();
      }),
    ).rejects.toThrow("工作階段已結束");
    await expect(
      runner.run("cardStatus", "fetch", async () => {
        throw new Error("Protocol error: Target closed.");
      }),
    ).rejects.toThrow("Target closed");
    expect(report.counts.cardBills.failed).toBe(1);
    expect(isFubonFatalFetchError(new Error("Session closed."))).toBe(true);
    expect(isFubonFatalFetchError(new Error("timeout"))).toBe(false);
  });

  it("失敗後檢查登入狀態；已被登出時改為致命錯誤", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const runner = new FubonStepRunner(new FubonSyncReport(), async () => {
      throw new FubonSessionEndedError();
    });
    await expect(
      runner.run("twdTransactions", "fetch", async () => {
        throw new Error("frame not found");
      }),
    ).rejects.toThrow("工作階段已結束");
  });

  it("連續失敗達上限後停止其餘項目並記為略過", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const report = new FubonSyncReport();
    const runner = new FubonStepRunner(report, async () => undefined);
    for (
      let index = 0;
      index < FUBON_MAX_CONSECUTIVE_STEP_FAILURES;
      index += 1
    ) {
      await runner.run("cardBills", "fetch", async () => {
        throw new Error("timeout");
      });
    }
    const action = vi.fn(async () => "never");
    expect(await runner.run("cardUnbilled", "fetch", action)).toBeUndefined();
    expect(action).not.toHaveBeenCalled();
    expect(report.failures.at(-1)).toMatchObject({
      category: "cardUnbilled",
      stage: "skipped",
    });
  });
});

describe("存款總覽的交易明細查詢連結", () => {
  const withDocument = <T>(html: string, run: () => T): T => {
    const dom = new JSDOM(html);
    const globals = globalThis as Record<string, unknown>;
    const saved = globals.document;
    globals.document = dom.window.document;
    try {
      return run();
    } finally {
      globals.document = saved;
    }
  };

  it("依帳號（去除前置零）與幣別找到該列的連結，不同幣別或帳號不誤點", () => {
    expect(
      withDocument(overviewHtml, () =>
        clickFubonOverviewTransactionLink("1234500004321", ["臺幣"], false),
      ),
    ).toBe("clicked");
    expect(
      withDocument(overviewHtml, () =>
        clickFubonOverviewTransactionLink("1234500004321", ["日圓"], false),
      ),
    ).toBe("no_row");
    expect(
      withDocument(overviewHtml, () =>
        clickFubonOverviewTransactionLink("99999", ["臺幣"], false),
      ),
    ).toBe("no_row");
    expect(
      withDocument("<html><body></body></html>", () =>
        clickFubonOverviewTransactionLink("1234500004321", ["臺幣"], false),
      ),
    ).toBe("no_table");
  });
});
