import { describe, expect, it, vi } from "vitest";
import {
  createSinopacConnector,
  parseAmount,
  parseDate,
  parseSinopacCardData,
  SinopacVerificationRequiredError,
} from "../../src/connectors/sinopac";

const summaryPayload = [
  {
    Header: "SUCCESS",
    Message: null,
    CreditSum: [
      { DataText: "卡號", DataValue: "****1234" },
      { DataText: "永久信用額度", DataValue: "200,000" },
      { DataText: "剩餘可用額度", DataValue: "168,500" },
      { DataText: "本期應繳金額", DataValue: "12,345" },
      { DataText: "最低應繳金額", DataValue: "1,234" },
      { DataText: "繳款截止日", DataValue: "115/08/05" },
      { DataText: "結帳日", DataValue: "115/07/15" },
    ],
  },
];

const billPayload = [
  {
    Header: "SUCCESS",
    Message: null,
    CreditDetail: [
      {
        DataText1: "帳單月份",
        DataValue1: "115/07",
        DataText2: "帳單金額",
        DataValue2: "12,345",
        DataText3: "最低應繳",
        DataValue3: "1,234",
        DataText4: "繳款截止日",
        DataValue4: "115/08/05",
        DataText5: "幣別",
        DataValue5: "TWD",
      },
    ],
  },
];

const unbilledPayload = [
  {
    Header: "SUCCESS",
    Message: null,
    CreditUnsettledBill: [
      {
        DataText1: "消費日",
        DataValue1: "115/07/16",
        DataText2: "消費明細",
        DataValue2: "全聯福利中心",
        DataText3: "新臺幣金額",
        DataValue3: "1,280",
        DataText4: "幣別",
        DataValue4: "TWD",
      },
      {
        DataText1: "消費日",
        DataValue1: "115/07/16",
        DataText2: "消費明細",
        DataValue2: "網購退貨退款",
        DataText3: "新臺幣金額",
        DataValue3: "500",
        DataText4: "幣別",
        DataValue4: "TWD",
      },
    ],
  },
];

const mobileSummaryPayload = [
  {
    Header: "SUCCESS",
    Message: "",
    SubInfo: [
      [
        { DataText: "本期應繳", DataValue: "5,541" },
        { DataText: "本期最低應繳", DataValue: "554" },
        { DataText: "最近繳款金額", DataValue: "5,541" },
        { DataText: "最近繳款日期", DataValue: "2026/07/08" },
        { DataText: "繳款截止日", DataValue: "2026/07/08" },
        { DataText: "結帳日", DataValue: "2026/06/23" },
        { DataText: "信用額度(臺幣)", DataValue: "200,000" },
        { DataText: "可用額度(臺幣)", DataValue: "188,864" },
      ],
    ],
  },
];

const mobileBillPayload = [
  {
    Header: "SUCCESS",
    Message: "",
    Last1Mon: "202606",
    Last2Mon: "202605",
    Last3Mon: "202604",
    SubInfo: [
      [
        { DataText: "結帳日", DataValue: "2026/06/23" },
        { DataText: "繳款截止日", DataValue: "2026/07/08" },
        { DataText: "上期應繳", DataValue: "4,838" },
        { DataText: "已繳款金額", DataValue: "4,838" },
        { DataText: "本期新增", DataValue: "5,541" },
        { DataText: "循環利息", DataValue: "0" },
        { DataText: "違約金", DataValue: "0" },
        { DataText: "本期應繳", DataValue: "5,541" },
        { DataText: "最低應繳", DataValue: "554" },
        { DataText: "幣別", DataValue: "000" },
        { DataText: "適用截止年月", DataValue: "202608" },
      ],
    ],
  },
];

const mobileUnbilledPayload = [
  {
    Header: "SUCCESS",
    Message: "",
    HeadInfo: [
      { HeadText: "交易日期", FieldKey: "DataValue1" },
      { HeadText: "消費說明", FieldKey: "DataValue2" },
      { HeadText: "金額", FieldKey: "DataValue3" },
    ],
    SubInfo: [
      {
        DataValue1: "20260709",
        DataValue2: "超市",
        DataValue3: "148",
        DataValue4: "000",
      },
      {
        DataValue1: "20260708",
        DataValue2: "永豐自扣已入帳，謝謝！",
        DataValue3: "-5,541",
        DataValue4: "000",
      },
    ],
  },
];

const sinoCardSsoPayload = {
  Result: { ID: "A123456789" },
  Header: {},
  ResultCode: "00",
  ResultMessage: "",
  Error: null,
};
const sinoCardAuthPayload = {
  Result: {},
  Header: {},
  ResultCode: "00",
  ResultMessage: "",
  Error: null,
};
const sinoCardLatestPayload = {
  Result: {
    IsCompanyUser: false,
    Items: [
      {
        CardFlag: "P",
        CardNo: "************8000",
        IsMobileCard: false,
        AuthDate: "2026/07/19",
        AuthTime: "18:35:13",
        Memo: "餐廳/LINE Pay",
        AuthAmt: 260,
        AuthAmtDesc: "260",
        CountryCode: "TW",
        AuthResult: "Y",
      },
      {
        CardFlag: "P",
        CardNo: "************1234",
        IsMobileCard: false,
        AuthDate: "2026/07/19",
        AuthTime: "20:10:00",
        Memo: "另一張卡的同額消費",
        AuthAmt: 260,
        AuthAmtDesc: "260",
        CountryCode: "TW",
        AuthResult: "Y",
      },
    ],
  },
  Header: {},
  ResultCode: "00",
  ResultMessage: "",
  Error: null,
};
const sinoCardOutstandingPayload = {
  Result: {
    IsExcludePaidUp: false,
    Detail: [
      {
        CurrencyCode: "TWD",
        CurrencyName: "臺幣",
        PID: "",
        CARD_TYPE: "正卡",
        CardLast4: "8000",
        TXDATE: "2026/07/19",
        DEDATE: "2026/07/22",
        TXCODE: "",
        MEMO: "連支＊餐廳",
        TXCUR: "TWD",
        TXAMT: "260",
        AMT: "260",
        PROD: "",
        EMBOSSING_TYPE: "",
        CardNoLast4: "8000",
        CARDNAME: "測試信用卡",
      },
    ],
    SubTotal: [
      {
        CurrencyCode: "TWD",
        CurrencyName: "臺幣",
        Count: 1,
        SubTotalAmt: "260",
      },
    ],
    IsCompanyUser: false,
  },
  Header: {},
  ResultCode: "00",
  ResultMessage: "",
  Error: null,
};

const sessionCookies = JSON.stringify([
  {
    name: "ASP.NET_SessionId",
    value: "test-session",
    domain: "m.sinopac.com",
  },
]);

function payloadForUrl(url: string) {
  if (url.includes("ws_cardsum")) return summaryPayload;
  if (url.includes("ws_cardbilling_sp")) return billPayload;
  if (url.endsWith("/security/sso")) return sinoCardSsoPayload;
  if (url.endsWith("/security/auth")) return sinoCardAuthPayload;
  if (url.endsWith("/Accounting/LatestTx")) return sinoCardLatestPayload;
  if (url.endsWith("/Accounting/OutstandingDetail"))
    return sinoCardOutstandingPayload;
  throw new Error(`Unexpected URL: ${url}`);
}

describe("sinopac App JSON parser", () => {
  it("parses Taiwan amounts and ROC dates", () => {
    expect(parseAmount("NT$ 1,234.50")).toBe(1234.5);
    expect(parseAmount("(2,000)")).toBe(-2000);
    expect(parseDate("115/07/15")).toBe("2026-07-15");
    expect(parseDate("1150715")).toBe("2026-07-15");
  });

  it("maps summary, recent bills, purchases and refunds", () => {
    const result = parseSinopacCardData(
      {
        summary: summaryPayload,
        bills: billPayload,
        unbilled: unbilledPayload,
      },
      new Date("2026-07-16T12:00:00.000Z"),
    );

    expect(result.bankAccounts).toEqual([
      expect.objectContaining({
        sourceId: "credit:sinopac:main",
        accountName: "永豐信用卡 末四碼 1234",
        accountType: "credit",
        creditLimit: 200000,
      }),
    ]);
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      balance: -12345,
      availableBalance: 168500,
      statementBalance: 12345,
      paymentDueDate: "2026-08-05",
      statementClosingDate: "2026-07-15",
    });
    expect(result.creditCardBills[0]).toMatchObject({
      billingPeriod: "2026-07",
      statementAmount: 12345,
      minimumPayment: 1234,
      paymentDueDate: "2026-08-05",
      currency: "TWD",
    });
    expect(result.bankTransactions).toEqual([
      expect.objectContaining({
        postedDate: "2026-07-16",
        amount: -1280,
        description: "全聯福利中心",
        status: "posted",
      }),
      expect.objectContaining({
        postedDate: "2026-07-16",
        amount: 500,
        description: "網購退貨退款",
        status: "posted",
      }),
    ]);
  });

  it("maps the real mobile HeadInfo/SubInfo response shape and payment direction", () => {
    const result = parseSinopacCardData(
      {
        summary: mobileSummaryPayload,
        bills: mobileBillPayload,
        unbilled: mobileUnbilledPayload,
      },
      new Date("2026-07-16T12:00:00.000Z"),
    );

    expect(result.bankAccounts[0]).toMatchObject({
      sourceId: "credit:sinopac:main",
      creditLimit: 200000,
    });
    expect(result.creditCardBills[0]).toMatchObject({
      billingPeriod: "2026-06",
      statementAmount: 5541,
      minimumPayment: 554,
      paidAmount: 5541,
      isPaid: true,
      currency: "TWD",
    });
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      balance: 0,
      statementBalance: 5541,
      noPaymentNeeded: true,
    });
    expect(result.bankTransactions).toEqual([
      expect.objectContaining({
        postedDate: "2026-07-09",
        description: "超市",
        amount: -148,
        currency: "TWD",
      }),
      expect.objectContaining({
        postedDate: "2026-07-08",
        description: "永豐自扣已入帳，謝謝！",
        amount: 5541,
        currency: "TWD",
      }),
    ]);
  });

  it("does not clear a newer statement when only the previous bill is paid", () => {
    const newerSummaryPayload = structuredClone(mobileSummaryPayload);
    newerSummaryPayload[0]!.SubInfo[0] = [
      ...newerSummaryPayload[0]!.SubInfo[0]!.filter(
        (item) => !["本期應繳", "繳款截止日", "結帳日"].includes(item.DataText),
      ),
      { DataText: "本期應繳", DataValue: "7,000" },
      { DataText: "繳款截止日", DataValue: "2026/08/07" },
      { DataText: "結帳日", DataValue: "2026/07/23" },
    ];

    const result = parseSinopacCardData(
      {
        summary: newerSummaryPayload,
        bills: mobileBillPayload,
        unbilled: mobileUnbilledPayload,
      },
      new Date("2026-07-24T12:00:00.000Z"),
    );

    expect(result.creditCardBills[0]).toMatchObject({
      statementAmount: 5541,
      isPaid: true,
    });
    expect(result.bankBalanceSnapshots[0]).toMatchObject({
      balance: -7000,
      statementBalance: 7000,
      noPaymentNeeded: false,
    });
  });

  it("maps latest authorizations to pending and upgrades matching card transactions to posted", () => {
    const result = parseSinopacCardData(
      {
        summary: mobileSummaryPayload,
        bills: mobileBillPayload,
        latest: sinoCardLatestPayload,
        outstanding: sinoCardOutstandingPayload,
      },
      new Date("2026-07-22T12:00:00.000Z"),
    );

    expect(result.bankTransactions).toHaveLength(2);
    expect(result.bankTransactions).toEqual([
      expect.objectContaining({
        sourceId: "sinopac:card:tx:v2:TWD:2026-07-19:-260:8000:1",
        authorizedAt: "2026-07-19",
        postedDate: "2026-07-22",
        description: "連支＊餐廳",
        amount: -260,
        status: "posted",
      }),
      expect.objectContaining({
        sourceId: "sinopac:card:tx:v2:TWD:2026-07-19:-260:1234:1",
        authorizedAt: "2026-07-19T20:10:00+08:00",
        description: "另一張卡的同額消費",
        amount: -260,
        status: "pending",
      }),
    ]);
    expect(result.bankTransactions[0]?.raw).toMatchObject({
      CardNoLast4: "8000",
    });
    expect(result.bankTransactions[1]?.raw).toMatchObject({
      CardNo: "************1234",
    });
  });

  it("uses the App and SinoCard endpoints without acquiring a browser when session cookies exist", async () => {
    const fetchMock = vi.fn(async function (
      this: unknown,
      input: RequestInfo | URL,
      _init?: RequestInit,
    ) {
      expect(this).toBe(globalThis);
      const url = String(input);
      return new Response(JSON.stringify(payloadForUrl(url)), { status: 200 });
    });

    const result = await createSinopacConnector(
      undefined,
      fetchMock as typeof fetch,
    ).sync({
      userId: "A123456789",
      sessionCookies,
      protocol: "sinopac-mobile-app-json-v1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://m.sinopac.com/ws/card/cardqry/ws_cardsum.ashx",
      "https://m.sinopac.com/ws/card/cardqry/ws_cardbilling_sp.ashx?TxDate=default&TxType=01",
      "https://m.sinopac.com/m/SinoCard/api/security/sso",
      "https://m.sinopac.com/m/SinoCard/api/security/auth",
      "https://m.sinopac.com/m/SinoCard/api/Accounting/LatestTx",
      "https://m.sinopac.com/m/SinoCard/api/Accounting/OutstandingDetail",
    ]);
    expect(
      JSON.parse(String(fetchMock.mock.calls[4]?.[1]?.body)),
    ).toMatchObject({
      Content: { ID: "A123456789" },
      Header: { ApplicationName: "MWEB", UserID: "A123456789" },
    });
    expect(
      JSON.parse(String(fetchMock.mock.calls[5]?.[1]?.body)),
    ).toMatchObject({
      Content: { IsExcludePaidUp: false, ID: "A123456789", DateYYYYMMDD: "" },
    });
    expect(result.records).toEqual([]);
    expect(result.bankTransactions).toHaveLength(2);
    expect(JSON.parse(result.cursor ?? "{}")).toMatchObject({
      sessionCookies,
      protocol: "sinopac-mobile-app-json-v1",
    });
  });

  it("treats no purchase records from the summary as a successful response", async () => {
    const noPurchaseRecordsPayload = [
      { Header: "FAIL", Message: "查無消費紀錄" },
    ];
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes("ws_cardsum")
        ? noPurchaseRecordsPayload
        : payloadForUrl(url);
      return new Response(JSON.stringify(payload), { status: 200 });
    });

    const result = await createSinopacConnector(
      undefined,
      fetchMock as typeof fetch,
    ).sync({
      userId: "A123456789",
      sessionCookies,
      protocol: "sinopac-mobile-app-json-v1",
    });

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(result.bankBalanceSnapshots).toHaveLength(1);
    expect(result.creditCardBills).toHaveLength(1);
    expect(result.bankTransactions).toHaveLength(2);
  });

  it("isolates App cookies and follows SinoCard cookie rotation", async () => {
    const authCookies = JSON.stringify([
      ...JSON.parse(sessionCookies),
      {
        name: "sinopac_cookie",
        value: "browser-cookie",
        domain: "m.sinopac.com",
        path: "/",
      },
    ]);
    const requestCookies: string[] = [];
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        requestCookies.push(new Headers(init?.headers).get("cookie") ?? "");
        const call = requestCookies.length;
        return new Response(JSON.stringify(payloadForUrl(String(input))), {
          status: 200,
          headers: {
            "Set-Cookie": `sinopac_cookie=api-cookie-${call}; Path=/; HttpOnly; Secure`,
          },
        });
      },
    );

    const result = await createSinopacConnector(
      undefined,
      fetchMock as typeof fetch,
    ).sync({
      userId: "A123456789",
      sessionCookies: authCookies,
      protocol: "sinopac-mobile-app-json-v1",
    });

    expect(requestCookies).toHaveLength(6);
    expect(
      requestCookies
        .slice(0, 3)
        .every((cookie) => cookie.includes("sinopac_cookie=browser-cookie")),
    ).toBe(true);
    expect(requestCookies[3]).toContain("sinopac_cookie=api-cookie-3");
    expect(requestCookies[4]).toContain("sinopac_cookie=api-cookie-4");
    expect(requestCookies[5]).toContain("sinopac_cookie=api-cookie-5");
    expect(JSON.parse(result.cursor ?? "{}")).toMatchObject({
      sessionCookies: authCookies,
      protocol: "sinopac-mobile-app-json-v1",
    });
  });

  it("fetches the remaining statement months advertised by the default response", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const payload = url.includes("ws_cardsum")
        ? mobileSummaryPayload
        : url.includes("ws_cardbilling_sp")
          ? mobileBillPayload
          : payloadForUrl(url);
      return new Response(JSON.stringify(payload), { status: 200 });
    });

    await createSinopacConnector(undefined, fetchMock as typeof fetch).sync({
      userId: "A123456789",
      sessionCookies,
      protocol: "sinopac-mobile-app-json-v1",
    });

    expect(fetchMock.mock.calls.map(([input]) => String(input))).toEqual([
      "https://m.sinopac.com/ws/card/cardqry/ws_cardsum.ashx",
      "https://m.sinopac.com/ws/card/cardqry/ws_cardbilling_sp.ashx?TxDate=default&TxType=01",
      "https://m.sinopac.com/ws/card/cardqry/ws_cardbilling_sp.ashx?TxDate=202605&TxType=01",
      "https://m.sinopac.com/ws/card/cardqry/ws_cardbilling_sp.ashx?TxDate=202604&TxType=01",
      "https://m.sinopac.com/m/SinoCard/api/security/sso",
      "https://m.sinopac.com/m/SinoCard/api/security/auth",
      "https://m.sinopac.com/m/SinoCard/api/Accounting/LatestTx",
      "https://m.sinopac.com/m/SinoCard/api/Accounting/OutstandingDetail",
    ]);
  });

  it("requests a new verification when the App API returns TIMEOUT", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              Header: "TIMEOUT",
              Message: "您尚未登入網銀",
            },
          ]),
        ),
    );

    await expect(
      createSinopacConnector(undefined, fetchMock as typeof fetch).sync({
        userId: "A123456789",
        sessionCookies,
        protocol: "sinopac-mobile-app-json-v1",
      }),
    ).rejects.toBeInstanceOf(SinopacVerificationRequiredError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not reuse a legacy MMA session after switching protocols", async () => {
    const fetchMock = vi.fn();
    await expect(
      createSinopacConnector(undefined, fetchMock as typeof fetch).sync({
        sessionCookies,
      }),
    ).rejects.toThrow("已改用行動銀行 App JSON API");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
