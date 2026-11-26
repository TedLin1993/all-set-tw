import { describe, expect, it } from "vitest";
import { connectorCatalog } from "@taiwan-fin-hub/shared";
import {
  CHB_CREDIT_ACCOUNT_ID,
  ChbApiError,
  ChbSyncReport,
  chbBalanceMismatches,
  chbDataCheckSum,
  chbDepositsUnavailable,
  chbDepositTransactions,
  chbDepositSourceId,
  chbFcItemAccount,
  chbLoanSourceId,
  chbQueryRange,
  chbRequestBody,
  chbTwItemAccountNo,
  classifyChbLoginMessage,
  detectChbDateStyle,
  parseChbAmount,
  parseChbConfig,
  parseChbData,
  parseChbDate,
  parseChbFcTransactions,
  parseChbRestResponse,
  parseChbTwTransactions,
  pickChbAllAccountItem,
  summarizeChbResult,
  type ChbPayloads,
} from "../../../src/sources/chb/protocol";

// 全部資料為合成值（姓名、帳號、金額、日期皆虛構）。預期值依銀行前端程式的欄位語意判讀
// （台幣第一個金額欄為支出 `expenseBetr`、第二欄為存入 `depositedBetr`；外幣 `expense == 1`
// 時 `txAmt` 放進第一個金額欄），而非由 parser 輸出倒推。

describe("彰化銀行 DataCheckSum", () => {
  // 預期值由獨立實作算出：標準 Base64（Buffer）＋標準 CRC-32 查表（0xEDB88320），
  // 並已與銀行公開前端 `SecCRC32` 的 256 項查表逐項核對相同。
  const vectors: Array<[string, string]> = [
    [
      chbRequestBody({
        url: "TW01001/tw01001_1_View",
        method: "GET",
        taskID: "tw01001",
        data: {},
      }),
      "4290287157",
    ],
    [
      chbRequestBody({
        url: "TW01002/tw01002_1_Action",
        method: "POST",
        taskID: "tw01002",
        data: {
          mgFlag: false,
          accountData: "00001234567890",
          currencyType: "0",
          inqType: "2",
          range: "0",
          queryStartDate: "115/07/31",
          queryEndDate: "115/10/31",
          resultViewType: "DISPLAY_BROWSER",
        },
      }),
      "2262858144",
    ],
    // 非 ASCII：銀行 `utf16to8` 逐 UTF-16 code unit 轉 UTF-8，須與標準 UTF-8 相同（BMP 內）。
    [
      chbRequestBody({
        url: "FC01002/fc01002_1_Action",
        method: "POST",
        taskID: "fc01002",
        data: { accountData: "巧翎", x: "隼翔" },
      }),
      "940119581",
    ],
  ];

  it.each(vectors)("與銀行演算法的已知向量一致：%s", (body, expected) => {
    expect(chbDataCheckSum(body)).toBe(expected);
  });

  it("請求 body 的欄位順序與銀行前端相同（url、method、taskID、data）", () => {
    expect(
      chbRequestBody({ url: "a", method: "GET", taskID: "t", data: {} }),
    ).toBe('{"url":"a","method":"GET","taskID":"t","data":{}}');
  });
});

describe("彰化銀行 REST 回應", () => {
  it("只有 isSuccess 且 S001 才回傳 data", () => {
    expect(
      parseChbRestResponse(
        JSON.stringify({
          isSuccess: true,
          returnCode: "S001",
          data: { a: 1 },
        }),
      ),
    ).toEqual({ a: 1 });
  });

  it("非 S001 拋出只含回覆代碼的錯誤，不洩漏回覆內文", () => {
    const body = JSON.stringify({
      isSuccess: false,
      returnCode: "E005",
      returnMessage: "巧翎的帳號 12345678901234 查無資料",
    });
    try {
      parseChbRestResponse(body);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ChbApiError);
      expect((error as ChbApiError).returnCode).toBe("E005");
      expect((error as Error).message).not.toMatch(/巧翎|1234567890/);
      // 「查無資料」只留下判斷結果，讓沒有貸款的帳號不被當成查詢失敗。
      expect((error as ChbApiError).noData).toBe(true);
    }
    try {
      parseChbRestResponse(
        JSON.stringify({
          isSuccess: false,
          returnCode: "E005",
          returnMessage: "系統忙碌中",
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ChbApiError).noData).toBe(false);
    }
    // 其他回覆代碼就算訊息含「查無資料」也是失敗，不可當成沒有資料。
    try {
      parseChbRestResponse(
        JSON.stringify({
          isSuccess: false,
          returnCode: "E999",
          returnMessage: "系統異常，查無資料",
        }),
      );
      expect.unreachable();
    } catch (error) {
      expect((error as ChbApiError).noData).toBe(false);
    }
    expect(() => parseChbRestResponse("<html>")).toThrow(ChbApiError);
  });
});

describe("彰化銀行日期與查詢區間", () => {
  it("解析西元、民國與 7／8 碼數字日期，拒絕不存在的日期", () => {
    expect(parseChbDate("2026/10/31")).toBe("2026-10-31");
    expect(parseChbDate("2026-10-31 10:11:12")).toBe("2026-10-31");
    expect(parseChbDate("115/10/31")).toBe("2026-10-31");
    expect(parseChbDate("115.01.05")).toBe("2026-01-05");
    expect(parseChbDate("1151031")).toBe("2026-10-31");
    expect(parseChbDate("20261031")).toBe("2026-10-31");
    expect(parseChbDate("115/02/30")).toBeUndefined();
    expect(parseChbDate("")).toBeUndefined();
    expect(parseChbDate("abc")).toBeUndefined();
  });

  it("3 位數年份為民國年，查詢區間沿用迄日的格式與分隔符", () => {
    expect(detectChbDateStyle("115/10/31")).toEqual({
      roc: true,
      separator: "/",
    });
    expect(chbQueryRange("115/10/31")).toEqual({
      start: "115/07/31",
      end: "115/10/31",
    });
    expect(chbQueryRange("2026-10-31")).toEqual({
      start: "2026-07-31",
      end: "2026-10-31",
    });
    expect(chbQueryRange("20261031")).toEqual({
      start: "20260731",
      end: "20261031",
    });
    // 起日月份天數不足時取該月最後一天；跨年。
    expect(chbQueryRange("115.05.31")).toEqual({
      start: "115.02.28",
      end: "115.05.31",
    });
    expect(chbQueryRange("115/01/15")).toEqual({
      start: "114/10/15",
      end: "115/01/15",
    });
  });

  it("View 沒有可解析的迄日時拒絕，不猜日期格式", () => {
    expect(() => chbQueryRange(undefined)).toThrow();
    expect(() => chbQueryRange("not-a-date")).toThrow();
  });
});

describe("彰化銀行金額", () => {
  it("處理千分位、小數、負號、空字串與佔位符", () => {
    expect(parseChbAmount("1,234,567.50")).toBe(1234567.5);
    expect(parseChbAmount("-1,234")).toBe(-1234);
    expect(parseChbAmount("(1,234)")).toBe(-1234);
    expect(parseChbAmount("1,234-")).toBe(-1234);
    expect(parseChbAmount("0.00")).toBe(0);
    expect(parseChbAmount("")).toBeUndefined();
    expect(parseChbAmount("--")).toBeUndefined();
    expect(parseChbAmount(" ")).toBeUndefined();
  });

  it("千分位錯置或非數字一律拒絕，不產生 NaN", () => {
    expect(() => parseChbAmount("12,34")).toThrow();
    expect(() => parseChbAmount("abc")).toThrow();
    expect(() => parseChbAmount("1.2.3")).toThrow();
  });
});

describe("彰化銀行交易方向", () => {
  const tw = (rows: unknown[]) =>
    parseChbTwTransactions({ depositDatas: rows, totalCount: rows.length });

  it("台幣：支出欄為負、存入欄為正，兩欄須恰有一欄有金額", () => {
    const page = tw([
      {
        transactionDate: "115/10/30",
        keepAccountDate: "115/10/30",
        transactionTime: "10:11:12",
        expenseBetr: "1,000",
        depositedBetr: "",
        depositedSurplus: "9,000",
        summary: "轉帳支出",
      },
      {
        transactionDate: "115/10/31",
        keepAccountDate: "115/10/31",
        transactionTime: "101500",
        expenseBetr: "",
        depositedBetr: "2,500.50",
        depositedSurplus: "11,500.50",
        summary: "薪資",
      },
      {
        transactionDate: "115/10/31",
        expenseBetr: "1",
        depositedBetr: "1",
        summary: "兩欄都有",
      },
      { transactionDate: "115/10/31", summary: "兩欄皆空" },
      { transactionDate: "壞日期", expenseBetr: "5" },
    ]);
    expect(page.rows.map((row) => row.amount)).toEqual([-1000, 2500.5]);
    expect(page.rows.map((row) => row.balanceAfter)).toEqual([9000, 11500.5]);
    expect(page.rows[0]).toMatchObject({
      transactionDate: "2026-10-30",
      transactionTime: "10:11:12",
      adjustment: false,
    });
    expect(page.rows[1]).toMatchObject({
      transactionTime: "10:15:00",
      adjustment: false,
    });
    expect(page.rejected).toHaveLength(3);
    expect(page.totalCount).toBe(5);
  });

  it("台幣：更正列（hcode 1）沖回原交易，方向與所在欄位相反", () => {
    // 實機：支出欄的轉提更正讓餘額增加；虛構金額。
    const page = tw([
      {
        transactionDate: "115/10/29",
        expenseBetr: "1,000",
        depositedSurplus: "9,000",
        transKind: "轉提",
        summary: "轉帳給隼翔",
      },
      {
        transactionDate: "115/10/29",
        expenseBetr: "1,000",
        depositedSurplus: "10,000",
        transKind: "轉提",
        summary: "更正",
        hcode: "1",
      },
    ]);
    expect(page.rows.map((row) => row.amount)).toEqual([-1000, 1000]);
    expect(page.rows[1]?.adjustment).toBe(true);
  });

  it("外幣：expense == 1 為支出，其餘為存入；缺旗標或金額的列被拒絕", () => {
    const page = parseChbFcTransactions({
      recordList: [
        {
          txDay: "2026/10/30",
          entDay: "2026/10/30",
          txTime: "09:00:00",
          txAmt: "100.00",
          expense: "1",
          avaibleBalance: "900.00",
        },
        {
          txDay: "2026/10/31",
          entDay: "2026/10/31",
          txAmt: "50.25",
          expense: 0,
          avaibleBalance: "950.25",
        },
        { txDay: "2026/10/31", txAmt: "5", avaibleBalance: "1" },
        { txDay: "2026/10/31", expense: "1", txAmt: "" },
      ],
    });
    expect(page.rows.map((row) => row.amount)).toEqual([-100, 50.25]);
    expect(page.rejected).toHaveLength(2);
  });

  it("餘額勾稽只回傳不一致筆數，兩種排序都能辨識", () => {
    const rows = [
      { amount: -1000, balanceAfter: 9000 },
      { amount: 2500.5, balanceAfter: 11500.5 },
      { amount: -500, balanceAfter: 11000.5 },
    ];
    expect(chbBalanceMismatches(rows)).toEqual({
      checked: 2,
      mismatched: 0,
      order: "oldest_first",
    });
    expect(chbBalanceMismatches([...rows].reverse())).toEqual({
      checked: 2,
      mismatched: 0,
      order: "newest_first",
    });
    // 方向假設錯誤（支出被當成存入）時會被偵測出來。
    const flipped = rows.map((row) => ({ ...row, amount: -row.amount }));
    expect(chbBalanceMismatches(flipped).mismatched).toBeGreaterThan(0);
  });
});

describe("彰化銀行登入結果分類", () => {
  it("只有明確的驗證碼錯誤分類為 captcha；帳密、鎖定、重複登入與未知不可重試", () => {
    expect(classifyChbLoginMessage("圖形驗證碼錯誤，請重新輸入").kind).toBe(
      "captcha",
    );
    expect(classifyChbLoginMessage("使用者代號或密碼錯誤").kind).toBe(
      "credential",
    );
    // 同時提到驗證碼與密碼時以帳密為準，避免重送帳密。
    expect(classifyChbLoginMessage("驗證碼或密碼輸入錯誤").kind).not.toBe(
      "captcha",
    );
    expect(classifyChbLoginMessage("密碼連續錯誤3次，帳號已鎖定").kind).toBe(
      "locked",
    );
    expect(classifyChbLoginMessage("您已重複登入").kind).toBe("duplicate");
    expect(classifyChbLoginMessage("").kind).toBe("unknown");
    expect(classifyChbLoginMessage("發生未預期的狀況").kind).toBe("unknown");
  });
});

describe("彰化銀行帳戶與資料正規化", () => {
  const twAccountNo = "00001234567890";
  const fcAccountNo = "00009876543210";
  const payloads: ChbPayloads = {
    twBalance: {
      depositDatas: [
        {
          accountNo: "0000-12-34567-8-90",
          branceBank: "虛構分行",
          surplus: "11,000.50",
          autoBalance: "11,000.50",
        },
      ],
    },
    twTransactions: [
      {
        accountNo: twAccountNo,
        data: {
          depositDatas: [
            {
              transactionDate: "115/10/30",
              keepAccountDate: "115/10/30",
              transactionTime: "10:00:00",
              expenseBetr: "1,000",
              depositedSurplus: "9,000",
              summary: "轉帳",
              memo: "給隼翔 帳號12345678901234",
            },
            {
              transactionDate: "115/10/31",
              keepAccountDate: "115/10/31",
              transactionTime: "10:00:00",
              depositedBetr: "2,500.50",
              depositedSurplus: "11,500.50",
              summary: "薪資",
            },
            {
              transactionDate: "115/10/31",
              keepAccountDate: "115/10/31",
              transactionTime: "11:00:00",
              expenseBetr: "500",
              depositedSurplus: "11,000.50",
              summary: "ATM",
            },
          ],
          totalCount: 3,
        },
      },
      // 不在餘額回應中的帳號：略過並記入失敗，不產生資料。
      { accountNo: "00005555555555", data: { depositDatas: [] } },
    ],
    fcBalance: {
      recordList: [
        {
          accountNo: "0000-98-76543-2-10",
          currencyId: "USD",
          branchId: "虛構分行",
          blanceAmt: "900.00",
          autoBalanceAmt: "900.00",
        },
      ],
    },
    fcTransactions: [
      {
        accountNo: fcAccountNo,
        currency: "USD",
        data: {
          recordList: [
            {
              txDay: "2026/10/30",
              entDay: "2026/10/30",
              txAmt: "100.00",
              expense: "1",
              avaibleBalance: "900.00",
              trnDesc: "匯出",
            },
          ],
        },
      },
    ],
  };

  it("存款帳戶、餘額與交易寫入正確的 sourceId、金額與方向，且不含完整帳號", () => {
    const report = new ChbSyncReport();
    const data = parseChbData(
      payloads,
      new Date("2026-10-31T04:00:00Z"),
      report,
    );

    const twId = chbDepositSourceId(twAccountNo);
    const fcId = chbDepositSourceId(fcAccountNo, "USD");
    expect(twId).toMatch(/^bank:chb:7890:[0-9a-f]{16}$/);
    expect(fcId).toMatch(/^bank:chb:3210:[0-9a-f]{16}:USD$/);
    expect(data.bankAccounts.map((account) => account.sourceId)).toEqual([
      twId,
      fcId,
    ]);
    expect(data.bankAccounts.map((account) => account.currency)).toEqual([
      "TWD",
      "USD",
    ]);
    expect(
      data.bankBalanceSnapshots.map((snapshot) => snapshot.balance),
    ).toEqual([11000.5, 900]);
    expect(data.bankBalanceSnapshots[0]?.sourceId).toMatch(
      /^snapshot:chb:7890:[0-9a-f]{16}:2026-10-31$/,
    );

    const twTx = data.bankTransactions.filter((tx) => tx.accountId === twId);
    expect(twTx.map((tx) => tx.amount)).toEqual([-1000, 2500.5, -500]);
    expect(twTx[0]).toMatchObject({
      postedDate: "2026-10-30",
      authorizedAt: "2026-10-30T10:00:00+08:00",
      currency: "TWD",
      status: "posted",
    });
    const fcTx = data.bankTransactions.filter((tx) => tx.accountId === fcId);
    expect(fcTx.map((tx) => [tx.amount, tx.currency])).toEqual([[-100, "USD"]]);

    // 一個帳戶內帳號與其他資料列都不會洩漏完整帳號。
    const serialized = JSON.stringify(data);
    for (const full of [twAccountNo, fcAccountNo, "12345678901234"]) {
      expect(serialized).not.toContain(full);
    }

    // 不在餘額回應中的帳號只記一筆失敗；勾稽在假設正確時不一致為 0。
    expect(report.counts.twTransactions.failed).toBe(1);
    const summary = summarizeChbResult(data, report);
    expect(summary).toMatchObject({
      twAccounts: 1,
      fcAccounts: 1,
      transactions: 4,
      twBalanceMismatch: 0,
      fcBalanceMismatch: 0,
      truncationSuspected: 0,
    });
    expect(summary.twBalanceChecked).toBe(2);
  });

  // 貸款與信用卡回應的欄位與格式依實機回應，數值為合成值。
  const loanRow = {
    accTypeName: "信用貸款",
    account: "0000-99-12345-6-0001",
    startDate: "2024/04/30",
    endDate: "2031/04/30",
    moneyType: "TWD",
    apAmt: "400,000.00",
    actBal: "357,738.00",
    fitIrt: "2.19%",
    total: "2,052.00",
    date: "2026/11/25",
    // 扣帳帳號是同一位客戶的彰銀臺幣存款帳號。
    payActno: "0000-12-34567-8-90",
    key: "0000991234560001~~~00~~~",
  };
  const parseLoans = (loans: unknown) => {
    const report = new ChbSyncReport();
    const data = parseChbData(
      { ...payloads, loans },
      new Date("2026-10-31T04:00:00Z"),
      report,
    );
    return {
      data,
      report,
      loans: data.bankAccounts.filter((a) => a.accountType === "loan"),
      snapshots: data.bankBalanceSnapshots.filter((snapshot) =>
        snapshot.accountId.startsWith("loan:"),
      ),
    };
  };

  it("有貸款：負值餘額、分類、利率、應繳資訊與扣款帳戶；清單完整時回報本次的貸款", () => {
    const { data, report, loans, snapshots } = parseLoans({
      generalLoanSuccess: true,
      generalLoanErrorMessage: "",
      generalLoanData: [
        loanRow,
        // 房貸在彰銀顯示為「擔保貸款」；利率有三位小數；頁面沒有顯示扣帳帳號。
        {
          ...loanRow,
          accTypeName: "擔保貸款",
          account: "0000-98-12345-6-0001",
          endDate: "2064/04/25",
          actBal: "10,000,000.00",
          fitIrt: "2.275%",
          total: "14,791.00",
          payActno: "",
          key: "0000981234560001~~~00~~~",
        },
      ],
      trancheLoanData: [],
    });
    const creditId = chbLoanSourceId("0000991234560001");
    const securedId = chbLoanSourceId("0000981234560001");
    expect(loans).toMatchObject([
      {
        sourceId: creditId,
        accountName: "信用貸款 末四碼 0001",
        loanCategory: "personal",
        loanInterestRate: 2.19,
        currency: "TWD",
        openedDate: "2024-04-30",
        maturityDate: "2031-04-30",
        autopayAccount: {
          bankCode: "009",
          last4: "7890",
          depositSourceId: chbDepositSourceId(twAccountNo),
        },
      },
      {
        sourceId: securedId,
        accountName: "房屋貸款 末四碼 0001",
        loanCategory: "housing",
        loanInterestRate: 2.275,
        autopayAccount: null,
      },
    ]);
    expect(snapshots).toMatchObject([
      {
        sourceId: `snapshot:${creditId}:2026-10-31`,
        balance: -357738,
        loanPaymentAmount: 2052,
        paymentDueDate: "2026-11-25",
      },
      { accountId: securedId, balance: -10000000, loanPaymentAmount: 14791 },
    ]);
    // 存款不受影響；清單完整，本次的貸款可用來停用已消失的貸款。
    expect(
      data.bankAccounts.filter((a) => a.accountType === "savings"),
    ).toHaveLength(2);
    expect(data.loanSourceIds).toEqual([creditId, securedId]);
    expect(report.failedCount).toBe(1); // 既有 fixture 的一筆存款明細失敗
    expect(JSON.stringify(data)).not.toContain("0000991234560001");
  });

  it("貸款邊界：同帳號不同序號各自一筆，重複列與格式不符的列拒絕，有拒絕時不停用任何貸款", () => {
    const { data, report, loans, snapshots } = parseLoans({
      generalLoanSuccess: true,
      generalLoanData: [
        { ...loanRow, actBal: "0.00", fitIrt: "999%" },
        // 帳號與序號都相同：拒絕，不覆蓋第一列。
        { ...loanRow, actBal: "100,000.00" },
        // 同帳號、不同序號：另一筆撥款。扣帳帳號不是字串：無法辨識。
        {
          ...loanRow,
          actBal: "5,000.00",
          key: "0000991234560001~~~01~~~",
          payActno: {},
        },
        { ...loanRow, account: "0000-99-12345-6-0002", actBal: "" },
        { ...loanRow, account: "0000-99-12345-6-0003", moneyType: "新臺幣" },
        // 產品名稱帶完整帳號時遮罩。
        {
          ...loanRow,
          account: "0000-99-12345-6-0004",
          accTypeName: "擔保貸款 0000991234560004",
          fitIrt: "２．２７５％",
          payActno: "7000-01-23456-7-89",
        },
      ],
    });
    expect(loans.map((loan) => loan.sourceId)).toEqual([
      chbLoanSourceId("0000991234560001"),
      chbLoanSourceId("0000991234560001", "01"),
      chbLoanSourceId("0000991234560004"),
    ]);
    expect(report.counts.loans).toEqual({ ok: 3, failed: 0, rowsRejected: 3 });
    // 餘額 0 不是 -0；荒謬的利率不寫入，全形照常解析；他行扣帳帳號只留末四碼。
    expect(Object.is(snapshots[0]?.balance, 0)).toBe(true);
    expect(loans.map((loan) => loan.loanInterestRate)).toEqual([
      undefined,
      2.19,
      2.275,
    ]);
    expect(loans[2]?.autopayAccount).toEqual({ last4: "6789" });
    // 無法辨識的扣帳帳號不寫，保留既有資料（不是 null 的「未設定」）。
    expect(loans[1]?.autopayAccount).toBeUndefined();
    // 有被拒絕的列時清單不完整，不能據此停用貸款。
    expect(data.loanSourceIds).toBeUndefined();
    const serialized = JSON.stringify(data);
    for (const full of ["0000991234560004", "70000123456789"]) {
      expect(serialized).not.toContain(full);
    }
  });

  it("沒有貸款：不寫入任何貸款、不算失敗，存款照常；查詢未成功則記為貸款失敗", () => {
    const depositOnly = parseLoans(undefined);
    for (const [loans, completeIds] of [
      // 銀行明確回覆成功且清單為空：可停用全部舊貸款。
      [
        { generalLoanSuccess: true, generalLoanData: [], trancheLoanData: [] },
        [],
      ],
      // E005「查無資料」（connector 轉成空物件）與回應內的查無資料訊息：沒有實機樣本，不停用。
      [{}, undefined],
      [
        { generalLoanSuccess: false, generalLoanErrorMessage: "查無資料" },
        undefined,
      ],
      // 成功旗標但缺少清單、或附帶錯誤訊息：不能當成完整的空清單而停用全部貸款。
      [{ generalLoanSuccess: true }, undefined],
      [{ generalLoanSuccess: true, generalLoanData: null }, undefined],
      [{ generalLoanSuccess: true, generalLoanList: [] }, undefined],
      [
        {
          generalLoanSuccess: true,
          generalLoanErrorMessage: "系統忙碌",
          generalLoanData: [],
        },
        undefined,
      ],
    ] as const) {
      const { data, report, loans: rows } = parseLoans(loans);
      expect(rows).toEqual([]);
      expect(data.bankAccounts).toEqual(depositOnly.data.bankAccounts);
      expect(report.failedCount).toBe(depositOnly.report.failedCount);
      expect(data.loanSourceIds).toEqual(completeIds);
    }
    // 不是查無資料的未成功回應：記一筆貸款失敗，存款仍寫入，不停用貸款。
    const failed = parseLoans({
      generalLoanSuccess: false,
      generalLoanErrorMessage: "系統忙碌",
    });
    expect(failed.data.bankAccounts).toEqual(depositOnly.data.bankAccounts);
    expect(failed.report.counts.loans.failed).toBe(1);
    expect(failed.data.loanSourceIds).toBeUndefined();
  });

  const cardRow = (
    trxnDate: string,
    postDate: string,
    memo: string,
    billAmt: string,
    chNO = "1234",
  ) => ({
    trxnDate,
    postDate,
    memo,
    trxnAmt: billAmt,
    trxnCurr: "TWD",
    billAmt,
    chNO,
  });
  const cardPayload = {
    status: {
      settleAccountDayOfMonth: "2026/10/31",
      payBillDeadLine: "2026/11/18",
      minimumPayAmount: "500",
      stmtBillAmt: "1,200",
      notSendBillBal: "470",
      accuBillAmt: "1,670",
      autoDeductAccount: "0000-12-34567-8-90",
      atm: "98765432109876",
    },
    limit: { creditLine: "20,000", refBalance: "18,330" },
    bills: [
      {
        stmtDate: "2026/10/31",
        dueDate: "2026/11/18",
        begBal: "800",
        pmtBal: "800",
        adjustBal: "0",
        prinBal: "1,500",
        totalCurrentBal: "1,500",
        minRepay: "500",
        // 最近一次繳款，不屬於這一期。
        billAmt: "300",
        postDate: "2026/11/05",
        info: [
          cardRow(
            "2026/10/12",
            "2026/10/15",
            "虛構電信　０９１２３＊＊＊４５",
            "1,500.00",
          ),
          cardRow(
            "2026/10/19",
            "2026/10/20",
            "彰銀自動扣繳",
            "-800.00",
            "****",
          ),
        ],
      },
      {
        stmtDate: "2026/09/30",
        dueDate: "2026/10/19",
        begBal: "0",
        pmtBal: "0",
        adjustBal: "0",
        prinBal: "800",
        totalCurrentBal: "800",
        minRepay: "800",
        info: [cardRow("2026/09/08", "2026/09/10", "虛構商店", "800.00")],
      },
      {
        stmtDate: "2026/08/31",
        dueDate: "2026/09/18",
        begBal: "0",
        pmtBal: "0",
        adjustBal: "0",
        prinBal: "0",
        totalCurrentBal: "0",
        minRepay: "0",
        info: [
          {
            ...cardRow("2026/08/10", "2026/08/13", "FAKE STORE", "320.00"),
            trxnAmt: "10.00",
            trxnCurr: "USD",
          },
          cardRow("2026/08/20", "2026/08/22", "FAKE STORE 退款", "-320.00"),
          // 沒有台幣金額的列只略過這一筆。
          { ...cardRow("2026/08/21", "2026/08/22", "虛構", ""), billAmt: "" },
        ],
      },
    ],
  };
  // 交易 ID 的摘要雜湊不在測試裡寫死，以 `#` 代替。
  const idShape = (id: string) => id.replace(/:[0-9a-f]{8}:(\d+)$/, ":#:$1");
  const parseCard = (card: unknown, base: ChbPayloads = payloads) => {
    const report = new ChbSyncReport();
    const data = parseChbData(
      { ...base, card: card as ChbPayloads["card"] },
      new Date("2026-11-06T04:00:00Z"),
      report,
    );
    return {
      data,
      report,
      cardTx: data.bankTransactions.filter(
        (tx) => tx.accountId === CHB_CREDIT_ACCOUNT_ID,
      ),
      account: data.bankAccounts.find((a) => a.accountType === "credit"),
      snapshot: data.bankBalanceSnapshots.find(
        (snapshot) => snapshot.accountId === CHB_CREDIT_ACCOUNT_ID,
      ),
    };
  };

  it("有信用卡：帳戶、負債快照、近三期帳單與帳單明細，且不影響存款", () => {
    const { data, report, cardTx, account, snapshot } = parseCard(cardPayload);
    expect(account).toEqual({
      sourceId: CHB_CREDIT_ACCOUNT_ID,
      institutionName: "彰化銀行",
      accountName: "彰化銀行信用卡",
      accountType: "credit",
      currency: "TWD",
      creditLimit: 20000,
      autopayAccount: {
        bankCode: "009",
        last4: "7890",
        depositSourceId: chbDepositSourceId(twAccountNo),
      },
    });
    // 負債 = 本期帳單剩餘應繳 1,200 + 未寄帳單 470，以負值保存。
    expect(snapshot).toMatchObject({
      sourceId: "snapshot:chb:credit:2026-11-06",
      balance: -1670,
      statementBalance: 1500,
      statementClosingDate: "2026-10-31",
      paymentDueDate: "2026-11-18",
      noPaymentNeeded: false,
    });
    // 本期看剩餘應繳；上一期由本期的上期帳單金額與上期繳款推得；應繳 0 為已繳。
    expect(
      data.creditCardBills.map((bill) => [
        bill.sourceId,
        bill.statementAmount,
        bill.minimumPayment,
        bill.paymentDueDate,
        bill.isPaid,
        bill.paidAmount,
      ]),
    ).toEqual([
      ["chb:card:bill:2026-10", 1500, 500, "2026-11-18", false, 300],
      ["chb:card:bill:2026-09", 800, 800, "2026-10-19", true, 800],
      ["chb:card:bill:2026-08", 0, 0, "2026-09-18", true, undefined],
    ]);
    // 消費為負、繳款與退款為正，一律已入帳；ID 不含卡號，繳款列沒有 cardLast4。
    expect(
      cardTx.map((tx) => [
        idShape(tx.sourceId),
        tx.amount,
        tx.status,
        tx.cardLast4,
      ]),
    ).toEqual([
      ["chb:card:tx:v1:2026-08-10:2026-08-13:-320:#:1", -320, "posted", "1234"],
      ["chb:card:tx:v1:2026-08-20:2026-08-22:320:#:1", 320, "posted", "1234"],
      ["chb:card:tx:v1:2026-09-08:2026-09-10:-800:#:1", -800, "posted", "1234"],
      [
        "chb:card:tx:v1:2026-10-12:2026-10-15:-1500:#:1",
        -1500,
        "posted",
        "1234",
      ],
      [
        "chb:card:tx:v1:2026-10-19:2026-10-20:800:#:1",
        800,
        "posted",
        undefined,
      ],
    ]);
    expect(cardTx[3]).toMatchObject({
      authorizedAt: "2026-10-12",
      postedDate: "2026-10-15",
      // 摘要裡的電話號碼遮罩為末四碼。
      description: "虛構電信 ****2345",
    });
    expect(cardTx[0]?.raw).toMatchObject({
      foreignCurrency: "USD",
      foreignAmount: 10,
    });
    expect(report.counts.cardTransactions).toEqual({
      ok: 5,
      failed: 0,
      rowsRejected: 1,
    });
    expect(summarizeChbResult(data, report)).toMatchObject({
      twAccounts: 1,
      fcAccounts: 1,
      cardBills: 3,
      cardTransactions: 5,
      transactions: 4,
    });
    expect(JSON.stringify(data)).not.toContain("98765432109876");
  });

  it("沒有信用卡：不建立信用卡帳戶、帳單或明細，也不算失敗；持卡但沒有消費時只有帳戶與 0 元快照", () => {
    const none = parseCard(undefined);
    expect(none.account).toBeUndefined();
    expect(none.data.creditCardBills).toEqual([]);
    // 成功但內容是空的或全為 0 的回應不能證明持卡。
    // 額度回應讀不懂：記一筆失敗，不無聲清空額度。
    expect(
      parseCard({ ...cardPayload, limit: { creditLine: "N/A" } }).report.counts
        .cardLimit.failed,
    ).toBe(1);
    for (const empty of [
      { limit: { creditLine: "0" }, bills: [] },
      { status: { stmtBillAmt: "0", notSendBillBal: "0" }, bills: [] },
    ]) {
      const result = parseCard(empty);
      expect(result.account).toBeUndefined();
      expect(result.report.failedCount).toBe(none.report.failedCount);
    }
    // 持卡但沒有消費：負債 0、不需繳款、不寫繳款期限；扣款帳號空白為未設定。
    const idle = parseCard({
      status: {
        ...cardPayload.status,
        stmtBillAmt: "0",
        notSendBillBal: "0",
        autoDeductAccount: "",
      },
      limit: cardPayload.limit,
      bills: [],
    });
    expect(idle.account).toMatchObject({ autopayAccount: null });
    expect(idle.snapshot).toMatchObject({ balance: 0, noPaymentNeeded: true });
    expect(idle.snapshot?.paymentDueDate).toBeUndefined();
    expect(idle.report.failedCount).toBe(none.report.failedCount);
    // 繳款資訊格式不符：記一筆失敗、不建立負債快照，帳單照常寫入。
    const broken = parseCard({
      status: { settleAccountDayOfMonth: "2026/10/31" },
      bills: [cardPayload.bills[1]],
    });
    expect(broken.report.counts.cardStatus.failed).toBe(1);
    expect(broken.snapshot).toBeUndefined();
    expect(broken.data.creditCardBills).toHaveLength(1);
    // 整體格式不符（connector 不會產生）：只略過信用卡，存款照常。
    for (const hostile of ["abc", 5, [1]]) {
      const result = parseCard(hostile);
      expect(result.account).toBeUndefined();
      expect(result.data.bankAccounts).toEqual(none.data.bankAccounts);
    }
  });

  it("信用卡明細 ID：消費日、入帳日、金額與摘要都相同才用序號區分，順序對調不互換，缺入帳日時以結帳日代替", () => {
    const bill = (info: unknown[]) => ({ ...cardPayload.bills[2], info });
    const txs = (info: unknown[]) =>
      parseCard({ bills: [bill(info)] }).cardTx.map((tx) => [
        idShape(tx.sourceId),
        tx.description,
      ]);
    const ids = (info: unknown[]) =>
      new Map(
        parseCard({ bills: [bill(info)] }).cardTx.map((tx) => [
          tx.description,
          tx.sourceId,
        ]),
      );
    const x = cardRow("2026/08/10", "2026/08/13", "虛構商店", "100.00");
    // 兩張卡、同日同額同入帳日同摘要：兩筆都保留。卡號只供顯示，不在 ID 內。
    expect(txs([x, { ...x, chNO: "5678" }])).toEqual([
      ["chb:card:tx:v1:2026-08-10:2026-08-13:-100:#:1", "虛構商店"],
      ["chb:card:tx:v1:2026-08-10:2026-08-13:-100:#:2", "虛構商店"],
    ]);
    // 摘要不同的兩筆：銀行回應的順序對調時，各自的 ID 不變。
    const y = { ...x, memo: "虛構咖啡" };
    expect(ids([x, y])).toEqual(ids([y, x]));
    expect(ids([x, y]).get("虛構商店")).not.toBe(ids([x, y]).get("虛構咖啡"));
    // 分期：入帳日相同時，摘要帶的期數也能區分，各自是序號 1。
    const installment = (n: number) => ({ ...x, memo: `虛構分期 ${n}/12` });
    expect(
      [...ids([installment(3), installment(4)]).values()].map(idShape),
    ).toEqual([
      "chb:card:tx:v1:2026-08-10:2026-08-13:-100:#:1",
      "chb:card:tx:v1:2026-08-10:2026-08-13:-100:#:1",
    ]);
    expect(txs([{ ...x, postDate: "" }])).toEqual([
      ["chb:card:tx:v1:2026-08-10:2026-08-31:-100:#:1", "虛構商店"],
    ]);
  });

  it("信用卡帳單是否已繳：只用緊接的下一期推算，缺期、金額對不上或算式不成立為未知，已繳金額不超過帳單金額", () => {
    // 每期都符合網銀算式：上期帳單金額 − 上期繳款 − 退款 + 本期新增 = 本期應繳總金額。
    const bill = (
      stmtDate: string,
      total: string,
      rest: Record<string, string | undefined> = {},
    ) => ({
      stmtDate,
      dueDate: "",
      begBal: "0",
      pmtBal: "0",
      adjustBal: "0",
      prinBal: total,
      totalCurrentBal: total,
      minRepay: total,
      info: [],
      ...rest,
    });
    const august = bill("2026/08/31", "800");
    const paid = (card: object) =>
      parseCard({ bills: [], ...card }).data.creditCardBills.map((b) => [
        b.billingPeriod,
        b.isPaid,
        b.paidAmount,
      ]);
    const older = (next: object) => paid({ bills: [next, august] })[1];

    // 本期（結帳日與繳款資訊相同）看剩餘應繳；溢繳時已繳金額只算到帳單金額。
    for (const [remaining, expected] of [
      ["0", [true, 800]],
      ["300", [false, 500]],
      ["900", [false, 0]],
      ["-100", [true, 800]],
    ] as const) {
      expect(
        paid({
          status: {
            settleAccountDayOfMonth: "2026/08/31",
            stmtBillAmt: remaining,
            notSendBillBal: "0",
          },
          bills: [august],
        }),
      ).toEqual([["2026-08", ...expected]]);
    }
    // 較早期別。
    const sept = (rest: Record<string, string | undefined>) =>
      bill("2026/09/30", "0", { begBal: "800", pmtBal: "800", ...rest });
    expect(older(sept({}))).toEqual(["2026-08", true, 800]);
    expect(older(sept({ pmtBal: "500", adjustBal: "300" }))).toEqual([
      "2026-08",
      true,
      800,
    ]);
    expect(
      older(sept({ pmtBal: "1,000", prinBal: "200", totalCurrentBal: "0" })),
    ).toEqual(["2026-08", true, 800]);
    expect(
      older(sept({ pmtBal: "500", totalCurrentBal: "300", prinBal: "0" })),
    ).toEqual(["2026-08", false, 500]);
    // 退款正負號與算式不合、缺本期新增金額、上期金額對不上：未知。
    for (const rest of [
      { pmtBal: "500", adjustBal: "-300" },
      { prinBal: undefined },
      { begBal: "700", pmtBal: "700" },
    ]) {
      expect(older(sept(rest))).toEqual(["2026-08", undefined, undefined]);
    }
    // 中間缺九月：不拿十月推算八月。跨年的相鄰期別可以。
    expect(
      older(bill("2026/10/31", "0", { begBal: "800", pmtBal: "800" })),
    ).toEqual(["2026-08", undefined, undefined]);
    expect(
      paid({
        bills: [
          bill("2027/01/31", "0", { begBal: "800", pmtBal: "800" }),
          bill("2026/12/31", "800"),
        ],
      })[1],
    ).toEqual(["2026-12", true, 800]);
    // 同一個月出現兩期：記一筆帳單失敗，不靜默覆蓋。
    const duplicated = parseCard({
      bills: [bill("2026/10/31", "500"), bill("2026/10/01", "900")],
    });
    expect(duplicated.report.counts.cardBills).toMatchObject({
      ok: 1,
      failed: 1,
    });
    expect(
      duplicated.data.creditCardBills.map((b) => b.statementAmount),
    ).toEqual([500]);
  });

  it("扣款帳號只在對得上本次同步的彰銀臺幣存款時標為彰銀，無法辨識時保留既有資料", () => {
    const autopay = (
      autoDeductAccount: unknown,
      base: ChbPayloads = payloads,
    ) =>
      parseCard(
        { status: { ...cardPayload.status, autoDeductAccount }, bills: [] },
        base,
      ).account?.autopayAccount;
    expect(autopay("0000 1234 5678 90")).toMatchObject({
      bankCode: "009",
      last4: "7890",
    });
    // 他行或非本人帳號只留末四碼。
    expect(autopay("7000-01-23456-7-89")).toEqual({ last4: "6789" });
    // 這次沒有取得臺幣存款（例如臺幣餘額查詢失敗）時無從比對，不寫，避免蓋掉上次正確的扣款帳戶。
    expect(
      autopay("0000-12-34567-8-90", { ...payloads, twBalance: undefined }),
    ).toBeUndefined();
    expect(autopay("")).toBeNull();
    for (const unreadable of [
      "無法取得",
      "****",
      "0000-12-*****-8-90",
      "12345",
    ]) {
      expect(autopay(unreadable)).toBeUndefined();
    }
    // 本次沒有取得存款帳戶時無從比對。
    expect(
      autopay("0000-12-34567-8-90", { twTransactions: [], fcTransactions: [] }),
    ).toBeUndefined();
  });

  it("存款完全沒有取得時，貸款或信用卡成功也不能讓同步算成功", () => {
    const check = (base: ChbPayloads, failDeposits: boolean) => {
      const report = new ChbSyncReport();
      if (failDeposits) report.fail("twBalance", "fetch", new Error("x"));
      const data = parseChbData(
        { ...base, loans: { generalLoanData: [loanRow] }, card: cardPayload },
        undefined,
        report,
      );
      return chbDepositsUnavailable(data, report);
    };
    const noDeposits = { twTransactions: [], fcTransactions: [] };
    expect(check(noDeposits, true)).toBe(true);
    // 客戶沒有存款帳戶但查詢沒有失敗，或失敗但仍取得存款：不算。
    expect(check(noDeposits, false)).toBe(false);
    expect(check(payloads, true)).toBe(false);
  });

  it("同一查詢內完全相同的兩筆以序號區分，不會被當成重複而遺失", () => {
    const row = {
      amount: -500,
      balanceAfter: 11000.5,
      transactionDate: "2026-10-31",
      bookingDate: "2026-10-31",
      transactionTime: "11:00:00",
      summary: "ATM",
      memo: "",
      kind: "",
      adjustment: false,
    };
    const twice = chbDepositTransactions(
      chbDepositSourceId(twAccountNo),
      twAccountNo,
      "TWD",
      [row, row],
    );
    expect(twice).toHaveLength(2);
    expect(new Set(twice.map((tx) => tx.sourceId)).size).toBe(2);
    // 再同步一次得到相同的 ID（冪等）。
    expect(
      chbDepositTransactions(
        chbDepositSourceId(twAccountNo),
        twAccountNo,
        "TWD",
        [row, row],
      ).map((tx) => tx.sourceId),
    ).toEqual(twice.map((tx) => tx.sourceId));
  });

  it("選單項目的帳號與幣別解析：台幣取標籤帳號、外幣取 value 的幣別段", () => {
    expect(
      chbTwItemAccountNo({
        label: "0000-12-34567-8-90 虛構分行",
        value: "opaque",
      }),
    ).toBe(twAccountNo);
    expect(
      chbFcItemAccount({
        label: "0000-98-76543-2-10 虛構分行 (USD)",
        value: "00009876543210$$$USD",
      }),
    ).toEqual({ accountNo: fcAccountNo, currency: "USD" });
    expect(
      pickChbAllAccountItem([
        { label: "0000-12-34567-8-90", value: "a" },
        { label: "全部帳號", value: "ALL1" },
      ])?.value,
    ).toBe("ALL1");
  });
});

describe("彰化銀行設定與憑證", () => {
  it("設定 schema 保留帳密與一次性驗證狀態，catalog 沒有任何公開欄位", () => {
    const parsed = parseChbConfig({
      nationalId: "A123456789",
      userId: "user01",
      password: "pw",
      browserSessionId: "s",
      browserSessionExpiresAt: "2026-10-31T00:00:00.000Z",
      captchaDigitCount: 6,
      captcha: "123456",
    });
    expect(parsed.captcha).toBe("123456");
    expect(parsed.nationalId).toBe("A123456789");

    const entry = connectorCatalog.chb;
    expect(entry.bankCode).toBe("009");
    expect(entry.capabilities).toContain("loan");
    expect(entry.capabilities).toContain("credit_card_bill");
    expect(entry.connectionMode).toBe("browser_captcha_session");
    expect(entry.publicFields).toEqual([]);
    expect(entry.credentialFields.map((field) => field.key)).toEqual([
      "nationalId",
      "userId",
      "password",
    ]);
    // 帳密變更時清除一次性驗證狀態，驗證狀態屬於 secret state。
    for (const key of ["browserSessionId", "captcha"]) {
      expect(entry.secretStateFields).toContain(key);
      expect(entry.resetOnCredentialChangeFields).toContain(key);
    }
  });
});
