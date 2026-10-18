import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FEIB_CREDIT_ACCOUNT_ID,
  FeibSyncReport,
  classifyFeibLoginMessage,
  deriveFeibPaymentState,
  feibDepositSourceId,
  feibDepositTransactions,
  feibEarliestQueryStart,
  feibTransactionRange,
  inferFeibStatementDate,
  maskFeibText,
  parseFeibAmount,
  parseFeibCardStatus,
  parseFeibData,
  parseFeibDate,
  parseFeibDepositOverview,
  parseFeibDepositTransactionsPage,
  parseFeibStatement,
  parseFeibStatementOptions,
  parseFeibTransactionAccountOptions,
  splitFeibRange,
  summarizeFeibResult,
  type FeibPayloads,
} from "../../../src/sources/feib/protocol";

// 去識別化 fixture 依遠東商銀網銀實際頁面結構（2026-10 HAR）重建：帳號、卡號、分行、
// 商店名稱、金額與日期皆為合成值。預期值依銀行畫面欄位語意判讀，而非由 parser 輸出倒推。
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

const overviewHtml = fixture("deposit-overview.html");
const transactionsHtml = fixture("deposit-transactions.html");
const emptyTransactionsHtml = fixture("deposit-transactions-empty.html");
const cardLimitHtml = fixture("card-limit.html");
const noCardHtml = fixture("card-limit-no-card.html");
const octStatementHtml = fixture("card-statement-202610.html");
const sepStatementHtml = fixture("card-statement-202609.html");

const NOW = new Date("2026-10-17T04:00:00Z"); // 台灣時間 2026-10-17 12:00
const ACCOUNT_A = "09990000001111";
const ACCOUNT_B = "09990000002222";
const QUERY_B = {
  accountNo: ACCOUNT_B,
  start: "2026/08/17",
  end: "2026/10/17",
};
const QUERY_A = {
  accountNo: ACCOUNT_A,
  start: "2026/08/17",
  end: "2026/10/17",
};

function payloads(overrides: Partial<FeibPayloads> = {}): FeibPayloads {
  return {
    depositOverviewHtml: overviewHtml,
    depositTransactions: [
      {
        accountNo: ACCOUNT_B,
        currency: "TWD",
        pages: [{ html: transactionsHtml, query: QUERY_B }],
      },
      {
        accountNo: ACCOUNT_A,
        currency: "TWD",
        pages: [{ html: emptyTransactionsHtml, query: QUERY_A }],
      },
    ],
    card: {
      hasCreditCard: true,
      statusHtml: cardLimitHtml,
      statementHtmls: [octStatementHtml, sepStatementHtml],
    },
    ...overrides,
  };
}

describe("遠東商銀數字與日期", () => {
  it("解析網銀金額格式，空白與非數字不產生 NaN", () => {
    expect(parseFeibAmount("新臺幣 NTD$5,000元")).toBe(5000);
    expect(parseFeibAmount("NTD$12,345.67元")).toBe(12345.67);
    expect(parseFeibAmount("-4,000")).toBe(-4000);
    expect(parseFeibAmount("（1,200）")).toBe(-1200);
    expect(parseFeibAmount("")).toBeUndefined();
    expect(parseFeibAmount("&nbsp;")).toBeUndefined();
    expect(parseFeibAmount("12,34")).toBeUndefined();
    expect(parseFeibAmount("abc")).toBeUndefined();
  });

  it("西元與民國日期轉為 ISO，拒絕不存在的日期", () => {
    expect(parseFeibDate("2026/08/18")).toBe("2026-08-18");
    expect(parseFeibDate("115/10/03")).toBe("2026-10-03");
    expect(parseFeibDate("115/02/30")).toBeUndefined();
    expect(parseFeibDate("")).toBeUndefined();
  });

  it("帳單明細 mm/dd 依結帳日推得年份，跨年與分期原始消費日落在前一年", () => {
    expect(inferFeibStatementDate("09/05", "2026-10-03")).toBe("2026-09-05");
    expect(inferFeibStatementDate("10/03", "2026-10-03")).toBe("2026-10-03");
    expect(inferFeibStatementDate("12/28", "2027-01-03")).toBe("2026-12-28");
    expect(inferFeibStatementDate("11/20", "2026-10-03")).toBe("2025-11-20");
    expect(inferFeibStatementDate("13/01", "2026-10-03")).toBeUndefined();
  });

  it("文字中的帳號與身分證字號遮罩為末四碼", () => {
    expect(maskFeibText("轉入0123456789012")).toBe("轉入****9012");
    expect(maskFeibText("A123456789 轉帳")).toBe("********** 轉帳");
  });
});

describe("遠東商銀存款", () => {
  it("存款總覽只取活期性存款，帳號以末四碼與雜湊識別", () => {
    const overview = parseFeibDepositOverview(overviewHtml);
    expect(overview.accounts).toEqual([
      expect.objectContaining({
        accountNo: ACCOUNT_A,
        currency: "TWD",
        currencyCode: "00",
        balance: 12345.67,
        typeName: "活期儲蓄存款",
      }),
      expect.objectContaining({
        accountNo: ACCOUNT_B,
        currency: "TWD",
        balance: 100,
      }),
    ]);
    expect(overview.timeDepositRows).toBe(0);
    const sourceId = feibDepositSourceId(ACCOUNT_A, "TWD");
    expect(sourceId).toMatch(/^bank:feib:1111:[0-9a-f]{16}:TWD$/);
    expect(sourceId).not.toContain(ACCOUNT_A);
  });

  it("非存款總覽頁面不當成沒有帳戶", () => {
    expect(() => parseFeibDepositOverview(cardLimitHtml)).toThrow(
      /存款總覽頁面格式不符/,
    );
  });

  it("交易明細：支出為負、存入為正，交易日期與帳務日期分開保存", () => {
    const page = parseFeibDepositTransactionsPage(transactionsHtml, QUERY_B);
    expect(page.empty).toBe(false);
    expect(page.rejected).toEqual([]);
    expect(page.rows).toHaveLength(6);
    expect(page.rows[0]).toEqual({
      transactionDate: "2026-08-18",
      bookingDate: "2026-08-19",
      summary: "跨行轉",
      amount: 5000,
      balanceAfter: 5100,
      memo: "自有帳戶轉帳",
    });
    expect(page.rows[1]).toMatchObject({ amount: -4321, balanceAfter: 779 });
    expect(page.rows[4]).toMatchObject({ amount: 1.25, balanceAfter: 580.25 });
  });

  it("查無交易時頁面沒有結果表格，視為 0 筆而非失敗", () => {
    const page = parseFeibDepositTransactionsPage(
      emptyTransactionsHtml,
      QUERY_A,
    );
    expect(page).toEqual({ rows: [], rejected: [], empty: true });
  });

  it("頁面回顯的帳號或期間與查詢不符時拒絕（避免把其他帳戶或空白表單當成結果）", () => {
    expect(() =>
      parseFeibDepositTransactionsPage(transactionsHtml, QUERY_A),
    ).toThrow(/帳號與查詢不符/);
    expect(() =>
      parseFeibDepositTransactionsPage(emptyTransactionsHtml, {
        ...QUERY_A,
        start: "2026/09/17",
      }),
    ).toThrow(/查詢期間與查詢不符/);
  });

  it("帳號選單列出可查詢的帳號", () => {
    expect(parseFeibTransactionAccountOptions(transactionsHtml)).toEqual([
      ACCOUNT_A,
      ACCOUNT_B,
    ]);
  });

  it("交易 ID 在同一期間內以序號區分完全相同的交易，備註中的帳號遮罩", () => {
    const row = {
      transactionDate: "2026-09-30",
      bookingDate: "2026-09-30",
      summary: "ＡＴＭ提款",
      amount: -100,
      balanceAfter: undefined,
      memo: "轉入0123456789012",
    };
    const records = feibDepositTransactions(
      feibDepositSourceId(ACCOUNT_B, "TWD"),
      ACCOUNT_B,
      "TWD",
      [row, row],
    );
    expect(records.map((record) => record.sourceId.split(":").pop())).toEqual([
      "1",
      "2",
    ]);
    expect(records[0]!.sourceId.slice(0, -2)).toBe(
      records[1]!.sourceId.slice(0, -2),
    );
    expect(records[0]!.counterparty).toBe("轉入****9012");
    expect(JSON.stringify(records)).not.toContain(ACCOUNT_B);
  });
});

describe("遠東商銀查詢期間", () => {
  it("同步近三個月，依官方 checkDate2 切成不超過二個月的不重疊期間", () => {
    const range = feibTransactionRange(NOW);
    expect(range).toEqual({ start: "2026/07/17", end: "2026/10/17" });
    expect(splitFeibRange(range)).toEqual([
      { start: "2026/08/17", end: "2026/10/17" },
      { start: "2026/07/17", end: "2026/08/16" },
    ]);
  });

  it("往前二個月的同一日不存在時，從下個月一日開始", () => {
    expect(feibEarliestQueryStart("2026/06/30")).toBe("2026/04/30");
    expect(feibEarliestQueryStart("2026/04/30")).toBe("2026/03/01");
    expect(feibEarliestQueryStart("2026/02/15")).toBe("2025/12/15");
  });

  it("長期間切割後首尾相接、沒有重疊或遺漏", () => {
    const chunks = splitFeibRange({ start: "2025/01/01", end: "2026/10/17" });
    expect(chunks.at(-1)?.start).toBe("2025/01/01");
    for (let index = 1; index < chunks.length; index += 1) {
      const previousStart = Date.parse(
        chunks[index - 1]!.start.replace(/\//g, "-"),
      );
      const end = Date.parse(chunks[index]!.end.replace(/\//g, "-"));
      expect(previousStart - end).toBe(86_400_000);
      expect(
        chunks[index]!.start >= feibEarliestQueryStart(chunks[index]!.end),
      ).toBe(true);
    }
  });
});

describe("遠東商銀信用卡", () => {
  it("額度頁解析本期帳單、已繳金額與額度；註解中的無卡文字不影響判斷", () => {
    expect(parseFeibCardStatus(cardLimitHtml)).toEqual({
      hasCreditCard: true,
      statementClosingDate: "2026-10-03",
      statementAmount: 6000,
      minimumPayment: 1200,
      paidAmount: 0,
      paymentDueDate: "2026-10-20",
      lastPaymentDate: "2026-09-21",
      creditLimit: 100000,
      usedCredit: 7500,
      availableCredit: 92500,
    });
  });

  it("只有明確的無卡提示才略過信用卡；其他未知頁面不視為無卡", () => {
    expect(parseFeibCardStatus(noCardHtml)).toEqual({ hasCreditCard: false });
    expect(() => parseFeibCardStatus(overviewHtml)).toThrow(
      /信用卡額度頁面格式不符/,
    );
  });

  it("帳單年月選單的顯示值為帳單月份", () => {
    expect(parseFeibStatementOptions(octStatementHtml)[0]).toEqual({
      value: "202609",
      label: "202610",
      selected: true,
    });
    expect(parseFeibStatementOptions(octStatementHtml)).toHaveLength(5);
  });

  it("帳單明細：民國日期、卡片列切換卡號、略過沒有消費日的摘要列", () => {
    const bill = parseFeibStatement(octStatementHtml);
    expect(bill).toMatchObject({
      period: "2026-10",
      statementClosingDate: "2026-10-03",
      paymentDueDate: "2026-10-20",
      autopay: true,
      previousBalance: 4000,
      paymentsAndRefunds: 4000,
      newCharges: 6000,
      statementAmount: 6000,
      minimumPayment: 1200,
      rejected: [],
    });
    expect(bill.transactions).toHaveLength(8);
    // 卡片列之前的繳款與帳戶層級手續費不帶卡號。
    expect(bill.transactions[0]).toMatchObject({
      cardLast4: undefined,
      transactionDate: "2026-09-21",
      bankAmount: -4000,
    });
    expect(bill.transactions[1]).toMatchObject({
      cardLast4: undefined,
      bankAmount: 15,
      description: "國外交易清算手續費-ＴＥＳＴ ＳＴＯＲＥ",
    });
    // 分期第 6 期的原始消費日在 4 月。
    expect(bill.transactions[2]).toMatchObject({
      cardLast4: "5678",
      transactionDate: "2026-04-19",
      postedDate: "2026-10-03",
      bankAmount: 1500,
    });
    expect(bill.transactions[3]).toMatchObject({
      foreignAmount: 30,
      foreignCurrency: "USD",
      bankAmount: 985,
    });
    expect(bill.transactions.at(-1)).toMatchObject({ bankAmount: -2 });
  });

  it("本期依額度頁已繳金額判定；前一期依下一期的上期應繳與已繳款判定", () => {
    const data = parseFeibData(payloads(), NOW);
    const bills = data.creditCardBills;
    expect(bills.map((bill) => bill.billingPeriod)).toEqual([
      "2026-10",
      "2026-09",
    ]);
    // 未過繳款截止日、已設定自動轉帳、尚未扣款：未繳。
    expect(bills[0]).toMatchObject({
      accountId: FEIB_CREDIT_ACCOUNT_ID,
      statementAmount: 6000,
      paidAmount: 0,
      isPaid: false,
      raw: expect.objectContaining({ paymentState: "autopay_pending" }),
    });
    expect(bills[1]).toMatchObject({
      statementAmount: 4000,
      paidAmount: 4000,
      isPaid: true,
      raw: expect.objectContaining({ paymentState: "paid" }),
    });
  });

  it("繳款狀態：溢繳、無需繳款、逾期與部分繳款", () => {
    expect(deriveFeibPaymentState({ statementAmount: -10 })).toBe(
      "credit_balance",
    );
    expect(deriveFeibPaymentState({ statementAmount: 0 })).toBe(
      "no_payment_needed",
    );
    expect(
      deriveFeibPaymentState(
        { statementAmount: 100, paidAmount: 0, paymentDueDate: "2026-10-16" },
        NOW,
      ),
    ).toBe("overdue");
    expect(
      deriveFeibPaymentState(
        {
          statementAmount: 100,
          minimumPayment: 20,
          paidAmount: 50,
          paymentDueDate: "2026-10-20",
        },
        NOW,
      ),
    ).toBe("partial");
    expect(deriveFeibPaymentState({ statementAmount: 100 })).toBe("unknown");
  });

  it("消費為負、繳款與回饋為正；分期各期以帳單期別區分 ID", () => {
    const data = parseFeibData(payloads(), NOW);
    const card = data.bankTransactions.filter(
      (txn) => txn.accountId === FEIB_CREDIT_ACCOUNT_ID,
    );
    // 10 月 8 筆 + 9 月 3 筆（繳款、分期第 5 期、消費）。
    expect(card).toHaveLength(11);
    expect(card.every((txn) => txn.status === "posted")).toBe(true);
    const payment = card.find((txn) => txn.authorizedAt === "2026-09-21");
    expect(payment).toMatchObject({ amount: 4000 });
    const installments = card.filter(
      (txn) => txn.authorizedAt === "2026-04-19",
    );
    expect(installments.map((txn) => txn.amount)).toEqual([-1500, -1500]);
    expect(new Set(installments.map((txn) => txn.sourceId)).size).toBe(2);
    // 同日同額的兩筆消費以序號保留，不合併。
    const telecom = card.filter((txn) => txn.authorizedAt === "2026-09-08");
    expect(telecom.map((txn) => txn.sourceId.split(":").pop())).toEqual([
      "1",
      "2",
    ]);
    expect(JSON.stringify(card)).not.toMatch(/411122/);
  });

  it("帳單窗口位移時，同一期帳單的交易 ID（含分期）維持不變", () => {
    const cardIds = (statementHtmls: string[]) =>
      parseFeibData(
        payloads({
          card: {
            hasCreditCard: true,
            statusHtml: cardLimitHtml,
            statementHtmls,
          },
        }),
        NOW,
      )
        .bankTransactions.filter(
          (txn) =>
            txn.accountId === FEIB_CREDIT_ACCOUNT_ID &&
            txn.sourceId.includes(":2026-10:"),
        )
        .map((txn) => txn.sourceId)
        .sort();
    const withPrevious = cardIds([octStatementHtml, sepStatementHtml]);
    const octOnly = cardIds([octStatementHtml]);
    expect(withPrevious).toHaveLength(8);
    expect(withPrevious).toEqual(octOnly);
    const installment = withPrevious.filter((id) =>
      id.includes(":2026-04-19:"),
    );
    expect(installment).toHaveLength(1);
    expect(installment[0]).toMatch(/:1$/);
  });

  it("負債快照採已使用額度，本期未繳清時標記需繳款", () => {
    const data = parseFeibData(payloads(), NOW);
    const snapshot = data.bankBalanceSnapshots.find(
      (item) => item.accountId === FEIB_CREDIT_ACCOUNT_ID,
    );
    expect(snapshot).toMatchObject({
      balance: -7500,
      statementBalance: 6000,
      noPaymentNeeded: false,
      paymentDueDate: "2026-10-20",
    });
    const account = data.bankAccounts.find(
      (item) => item.sourceId === FEIB_CREDIT_ACCOUNT_ID,
    );
    expect(account).toMatchObject({
      accountType: "credit",
      creditLimit: 100000,
    });
  });

  it("無卡時只回傳存款，不建立信用卡帳戶或零餘額", () => {
    const data = parseFeibData(
      payloads({ card: { hasCreditCard: false } }),
      NOW,
    );
    expect(data.hasCreditCard).toBe(false);
    expect(data.creditCardBills).toEqual([]);
    expect(
      data.bankAccounts.some((account) => account.accountType === "credit"),
    ).toBe(false);
    expect(data.bankAccounts).toHaveLength(2);
  });
});

describe("遠東商銀同步彙整", () => {
  it("完整資料：存款帳戶、快照與交易，raw 不含完整帳號", () => {
    const report = new FeibSyncReport();
    const data = parseFeibData(payloads(), NOW, report);
    expect(report.failedCount).toBe(0);
    const deposits = data.bankAccounts.filter(
      (account) => account.accountType !== "credit",
    );
    expect(deposits).toHaveLength(2);
    expect(
      data.bankBalanceSnapshots.find(
        (snapshot) =>
          snapshot.accountId === feibDepositSourceId(ACCOUNT_A, "TWD"),
      ),
    ).toMatchObject({ balance: 12345.67, currency: "TWD" });
    const depositTxns = data.bankTransactions.filter(
      (txn) => txn.accountId !== FEIB_CREDIT_ACCOUNT_ID,
    );
    expect(depositTxns).toHaveLength(6);
    expect(depositTxns.every((txn) => txn.status === "posted")).toBe(true);
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(ACCOUNT_A);
    expect(serialized).not.toContain(ACCOUNT_B);
    expect(summarizeFeibResult(data, report)).toMatchObject({
      status: "complete",
      depositAccounts: 2,
      creditCards: 1,
      cardBills: 2,
      depositTransactions: 6,
      cardTransactions: 11,
    });
  });

  it("單一期間或帳單解析失敗只略過該項，其餘照常回傳", () => {
    const report = new FeibSyncReport();
    const data = parseFeibData(
      payloads({
        depositTransactions: [
          {
            accountNo: ACCOUNT_B,
            currency: "TWD",
            pages: [{ html: transactionsHtml, query: QUERY_A }],
          },
        ],
        card: {
          hasCreditCard: true,
          statusHtml: cardLimitHtml,
          statementHtmls: [octStatementHtml, overviewHtml],
        },
      }),
      NOW,
      report,
    );
    expect(report.counts.depositTransactions.failed).toBe(1);
    expect(report.counts.cardBills).toMatchObject({ ok: 1, failed: 1 });
    expect(data.bankAccounts).toHaveLength(3);
    expect(data.creditCardBills).toHaveLength(1);
    expect(report.userMessage()).toMatch(/存款交易明細 1 筆/);
    expect(JSON.stringify(report.summary())).not.toContain(ACCOUNT_B);
  });
});

describe("遠東商銀登入結果分類", () => {
  it("帳密錯誤、鎖定優先於驗證碼錯誤，不明訊息不重試", () => {
    expect(classifyFeibLoginMessage("密碼輸入錯誤，請重新輸入").kind).toBe(
      "credential",
    );
    expect(
      classifyFeibLoginMessage("密碼錯誤次數連續達三次，已停用網路銀行").kind,
    ).toBe("locked");
    expect(classifyFeibLoginMessage("驗證碼輸入錯誤").kind).toBe("captcha");
    expect(classifyFeibLoginMessage("您已在其他裝置登入").kind).toBe(
      "duplicate",
    );
    expect(classifyFeibLoginMessage("").kind).toBe("unknown");
    expect(classifyFeibLoginMessage("歡迎使用").kind).toBe("unknown");
  });
});
