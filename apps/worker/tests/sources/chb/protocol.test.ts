import { describe, expect, it } from "vitest";
import { connectorCatalog } from "@taiwan-fin-hub/shared";
import {
  ChbApiError,
  ChbSyncReport,
  chbBalanceMismatches,
  chbDataCheckSum,
  chbDepositTransactions,
  chbDepositSourceId,
  chbFcItemAccount,
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
