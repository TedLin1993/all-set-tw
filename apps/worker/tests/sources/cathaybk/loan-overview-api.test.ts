import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import type { Page } from "@cloudflare/puppeteer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { scrapeLoans } from "../../../src/sources/cathaybk/connector";
import {
  getCathayApiSession,
  queryCathayLoanAutopayApi,
} from "../../../src/sources/cathaybk/loan-detail";
import {
  parseCathayLoanOverviewApi,
  queryCathayLoanOverviewApi,
  type CathayLoanOverviewApiItem,
  type CathayLoanOverviewApiResponse,
} from "../../../src/sources/cathaybk/loan-overview-api";

const overviewUrl =
  "https://www.cathaybk.com.tw/OnlineBanking/LoanInq/L0101_LoanInq";
const cardUrl =
  "https://www.cathaybk.com.tw/OnlineBanking/CQuery/C0102_BillInq";
const depositUrl =
  "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0101_DepInq";
const overviewHtml = readFileSync(
  new URL("../../fixtures/cathay-loan-overview-table.html", import.meta.url),
  "utf8",
);

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const item = (
  overrides: Partial<CathayLoanOverviewApiItem> = {},
): CathayLoanOverviewApiItem => ({
  account: "0000000000000001",
  loanType: "HouseLoan",
  interestRate: 1.37,
  nextDeductionDate: "2026-11-05T00:00:00",
  loanBalance: 9876543,
  loanTerm: 180,
  alreadyPayPeriod: 17,
  overTimePeriod: 0,
  isBadDebt: false,
  amountPayable: 123456,
  ...overrides,
});

const response = (
  accountList: CathayLoanOverviewApiItem[] | null,
  overrides: Partial<CathayLoanOverviewApiResponse> = {},
): CathayLoanOverviewApiResponse => ({
  httpStatus: 200,
  returnCode: "0000",
  success: true,
  status: "Normal",
  accountList,
  attempts: 1,
  ...overrides,
});

/** 與 cathay-loan-overview-table.html 相同的五筆貸款（合成資料）。 */
const fixtureItems = (): CathayLoanOverviewApiItem[] => [
  item(),
  item({
    account: "0000000000000002",
    loanType: "CycleHouseLoan",
    interestRate: null,
    nextDeductionDate: "2026-11-06T00:00:00",
    loanBalance: 8765432,
    loanTerm: 0,
    alreadyPayPeriod: 0,
    amountPayable: 234567,
  }),
  item({
    account: "0000000000000003",
    interestRate: 2.64,
    nextDeductionDate: "2026-11-07T00:00:00",
    loanBalance: 7654321,
    loanTerm: 240,
    alreadyPayPeriod: 25,
    amountPayable: 345678,
  }),
  item({
    account: "0000000000000004",
    loanType: "CycleFinancialLoan",
    interestRate: 2.91,
    nextDeductionDate: "2026-11-08T00:00:00",
    loanBalance: 6543210,
    loanTerm: 12,
    alreadyPayPeriod: 3,
    amountPayable: 456789,
  }),
  item({
    account: "0000000000000005",
    loanType: "OtherLoan",
    interestRate: 3.18,
    nextDeductionDate: "2026-11-09T00:00:00",
    loanBalance: 5432109,
    loanTerm: 60,
    alreadyPayPeriod: 8,
    amountPayable: 567890,
  }),
];

describe("國泰世華貸款總覽 API 對應", () => {
  it("對應所有欄位：類別、利率、應繳、扣款日、餘額、期數與幣別", () => {
    const result = parseCathayLoanOverviewApi(
      response([
        item(),
        item({
          account: "0000000000000004",
          loanType: "OtherLoan",
          interestRate: 2.915,
          nextDeductionDate: "2026-12-31T00:00:00",
          loanBalance: 0,
          loanTerm: 84,
          alreadyPayPeriod: 84,
          amountPayable: 0,
        }),
      ]),
    );

    expect(result).toEqual({
      ok: true,
      complete: true,
      loanRecords: [
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
          accountNumber: "0000000000000004",
          loanCategory: "other",
          interestRate: 2.915,
          currentPaymentAmount: 0,
          paymentDueDate: "2026-12-31",
          paymentStatus: "scheduled",
          balance: 0,
          installmentsPaid: 84,
          installmentsTotal: 84,
          currency: "TWD",
        },
      ],
    });
  });

  it("依官方分組對應類別；理財型不設類別，循環／理財型不帶期數", () => {
    const types = {
      SecondPlaceLoan: "housing",
      NetValueLoan: "housing",
      CycleHouseLoan: "housing",
      CarLoan: "other",
      CashCardLoan: "other",
      TurnOverLoan: "other",
      CapitalExpenditureLoan: "other",
      ConstructionFinancingLoan: "other",
      CycleFinancialLoan: "other",
      TrustLoan: undefined,
      ElasticityLoanMonthly: undefined,
      ElasticityLoanAmortized: undefined,
    } as const;
    const entries = Object.entries(types);
    const result = parseCathayLoanOverviewApi(
      response(
        entries.map(([loanType], index) =>
          item({
            loanType,
            account: String(index + 1).padStart(16, "0"),
          }),
        ),
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    entries.forEach(([loanType, category], index) => {
      const record = result.loanRecords[index]!;
      expect(record.loanCategory).toBe(category);
      const hasInstallments = ![
        "CycleHouseLoan",
        "CycleFinancialLoan",
        "ElasticityLoanMonthly",
        "ElasticityLoanAmortized",
      ].includes(loanType);
      expect("installmentsPaid" in record).toBe(hasInstallments);
      expect("installmentsTotal" in record).toBe(hasInstallments);
    });
  });

  it("逾期未完成扣款不帶扣款日；利率 null 時不帶利率", () => {
    const result = parseCathayLoanOverviewApi(
      response([
        item({
          overTimePeriod: 2,
          interestRate: null,
          nextDeductionDate: "2026-10-05T00:00:00",
        }),
      ]),
    );

    expect(result).toEqual({
      ok: true,
      complete: true,
      loanRecords: [
        {
          accountNumber: "0000000000000001",
          loanCategory: "housing",
          currentPaymentAmount: 123456,
          paymentStatus: "collection_incomplete",
          balance: 9876543,
          installmentsPaid: 17,
          installmentsTotal: 180,
          currency: "TWD",
        },
      ],
    });
  });

  it("扣款日只取日期部分，接受沒有時間的日期", () => {
    const parsed = parseCathayLoanOverviewApi(
      response([
        item({ nextDeductionDate: "2027-01-02" }),
        item({
          account: "0000000000000002",
          nextDeductionDate: "2027-02-03T23:59:59",
        }),
      ]),
    );
    expect(
      parsed.ok && parsed.loanRecords.map((loan) => loan.paymentDueDate),
    ).toEqual(["2027-01-02", "2027-02-03"]);
  });

  it("呆帳與 DOM 相同略過並標記不完整", () => {
    const result = parseCathayLoanOverviewApi(
      response([
        item(),
        item({
          account: "0000000000000002",
          isBadDebt: true,
          amountPayable: null,
          loanBalance: null,
        }),
      ]),
    );

    expect(result.ok && result.complete).toBe(false);
    expect(
      result.ok && result.loanRecords.map((loan) => loan.accountNumber),
    ).toEqual(["0000000000000001"]);
  });

  it("status Normal 的空清單為沒有貸款且完整", () => {
    expect(parseCathayLoanOverviewApi(response([]))).toEqual({
      ok: true,
      loanRecords: [],
      complete: true,
    });
    expect(
      parseCathayLoanOverviewApi(response([], { status: "Other" })),
    ).toEqual({ ok: false, reason: "schema_mismatch" });
  });

  it.each([
    ["no_response", response(null, { returnCode: "no_response" })],
    ["non_0000", response(null, { returnCode: "E999", success: false })],
    ["non_0000", response([item()], { success: false })],
    ["maintenance", response([], { status: "MaintainTime" })],
    ["schema_mismatch", response(null)],
    ["schema_mismatch", response([item()], { status: null })],
    ["schema_mismatch", response([item({ loanType: "NewLoan" })])],
    ["schema_mismatch", response([item({ loanType: "toString" })])],
    ["schema_mismatch", response([item({ account: "1234" })])],
    ["schema_mismatch", response([item({ account: 1234567890 })])],
    ["schema_mismatch", response([item(), item()])],
    ["schema_mismatch", response([item({ amountPayable: "123,456" })])],
    ["schema_mismatch", response([item({ loanBalance: -1 })])],
    ["schema_mismatch", response([item({ loanBalance: Number.NaN })])],
    ["schema_mismatch", response([item({ interestRate: "1.37" })])],
    ["schema_mismatch", response([item({ nextDeductionDate: null })])],
    ["schema_mismatch", response([item({ nextDeductionDate: "1151105" })])],
    ["schema_mismatch", response([item({ isBadDebt: "N" })])],
    ["schema_mismatch", response([item({ overTimePeriod: undefined })])],
  ])("失敗回應：%s", (reason, input) => {
    expect(parseCathayLoanOverviewApi(input)).toEqual({ ok: false, reason });
  });

  it("期數不是非負整數時與 DOM 相同不帶期數", () => {
    const result = parseCathayLoanOverviewApi(
      response([item({ loanTerm: null, alreadyPayPeriod: 1.5 })]),
    );
    expect(result.ok && "installmentsPaid" in result.loanRecords[0]!).toBe(
      false,
    );
  });
});

type Reply = Record<string, unknown> | null;

function stubXhr(handlers: {
  jwt?: Reply;
  overview?: (attempt: number) => Reply;
  detail?: (account: string) => Reply;
}) {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  let overviewAttempts = 0;
  class FakeXhr {
    url = "";
    responseText = "";
    status = 0;
    withCredentials = false;
    timeout = 0;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    ontimeout: (() => void) | null = null;
    open(_method: string, url: string) {
      this.url = url;
    }
    setRequestHeader() {}
    send(body: string | null) {
      const parsed = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      requests.push({ url: this.url, body: parsed });
      let reply: Reply = null;
      if (this.url === "/MyBank/Customized/GetJWT") {
        reply =
          handlers.jwt === undefined
            ? {
                Data: {
                  JwtToken: "SECRET_TOKEN",
                  CustomerId: "A000000000",
                  IdType: "11",
                },
              }
            : handlers.jwt;
      } else if (this.url.endsWith("/L_ACCT_Q_OverView")) {
        overviewAttempts++;
        reply = handlers.overview?.(overviewAttempts) ?? null;
      } else if (this.url.endsWith("/L_ACCT_Q_OverViewDetail")) {
        const content = parsed.content as { account: string };
        reply = handlers.detail?.(content.account) ?? null;
      }
      setTimeout(() => {
        if (reply === null) {
          this.onerror?.();
          return;
        }
        this.status = 200;
        this.responseText = JSON.stringify(reply);
        this.onload?.();
      }, 1);
    }
  }
  vi.stubGlobal("XMLHttpRequest", FakeXhr);
  return requests;
}

const okReply = (content: Record<string, unknown>) => ({
  success: true,
  returnCode: "0000",
  content,
});

function apiPage(startUrl: string) {
  const overview = new JSDOM(overviewHtml, { url: overviewUrl }).window
    .document;
  const gotoCalls: Array<{ url: string; waitUntil?: string }> = [];
  let currentUrl = startUrl;
  const page = {
    goto: vi.fn(async (url: string, options?: { waitUntil?: string }) => {
      gotoCalls.push({ url, waitUntil: options?.waitUntil });
      currentUrl = url;
    }),
    url: vi.fn(() => currentUrl),
    waitForFunction: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn(
      async (callback: (input: unknown) => unknown, input?: unknown) =>
        callback === (getCathayApiSession as unknown) ||
        callback === (queryCathayLoanOverviewApi as unknown) ||
        callback === (queryCathayLoanAutopayApi as unknown)
          ? callback(input)
          : callback(overview),
    ),
  } as unknown as Page;
  return { page, gotoCalls };
}

const logsOf = (log: { mock: { calls: unknown[][] } }) =>
  log.mock.calls.map(([message]) => String(message)).join("\n");

const overviewLog = (logs: string) =>
  logs
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .find((entry) => entry?.event === "cathaybk_loan_overview");

/** 去除每次同步時間戳，比較兩條路徑的輸出。 */
const withoutTimestamps = (
  result: Awaited<ReturnType<typeof scrapeLoans>>,
) => ({
  ...result,
  bankBalanceSnapshots: result.bankBalanceSnapshots.map(
    ({ asOfAt: _asOfAt, sourceId, ...snapshot }) => ({
      ...snapshot,
      sourceId: sourceId.replace(/:[^:]+$/, ""),
    }),
  ),
});

describe("國泰世華 scrapeLoans 以 API 讀取貸款總覽", () => {
  it("頁面內查詢 L_ACCT_Q_OverView，不開總覽頁，輸出與 DOM 路徑完全相同", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // DOM 路徑（沒有 XMLHttpRequest，取不到 session）作為對照組。
    const domPage = apiPage(overviewUrl).page;
    const domResult = await scrapeLoans(domPage);

    const requests = stubXhr({
      overview: () =>
        okReply({ status: "Normal", accountList: fixtureItems() }),
      detail: () => okReply({ deductionAccount: "" }),
    });
    const { page, gotoCalls } = apiPage(cardUrl);
    log.mockClear();
    const apiResult = await scrapeLoans(page);

    expect(gotoCalls).toEqual([]);
    for (const account of apiResult.bankAccounts) {
      expect(account.autopayAccount).toBe(null);
    }
    const strip = (result: typeof apiResult) =>
      withoutTimestamps({
        ...result,
        bankAccounts: result.bankAccounts.map(
          ({ autopayAccount: _autopay, ...account }) => account,
        ),
      });
    expect(strip(apiResult)).toEqual(strip(domResult));
    expect(apiResult.loanOverviewComplete).toBe(true);
    expect(
      apiResult.bankAccounts.map((account) => account.accountName),
    ).toEqual(domResult.bankAccounts.map((account) => account.accountName));

    const overviewRequest = requests.find((request) =>
      request.url.endsWith("/L_ACCT_Q_OverView"),
    );
    expect(overviewRequest?.url).toBe(
      "/OnlineBankingApi/ClientLoan/Api/ClientLoan/L_ACCT_Q_OverView",
    );
    expect(overviewRequest?.body.content).toEqual({
      customerId: "A000000000",
      idType: "11",
    });
    // 同一個 session 沿用到扣款帳戶 API，只呼叫一次 GetJWT。
    expect(
      requests.filter((request) => request.url.endsWith("/GetJWT")),
    ).toHaveLength(1);
    expect(
      requests.filter((request) => request.url.endsWith("OverViewDetail")),
    ).toHaveLength(5);

    const logs = logsOf(log);
    expect(overviewLog(logs)).toMatchObject({
      method: "api",
      count: 5,
      complete: true,
      returnCode: "0000",
      status: "Normal",
      fallbackReason: null,
    });
    expect(logs).not.toMatch(/\d{8,}/);
    expect(logs).not.toContain("SECRET_TOKEN");
    expect(logs).not.toContain("A000000000");
    expect(logs).not.toContain("9876543");
    expect(logs).not.toContain("2026-11-05");
  });

  it("目前頁面不是 OnlineBanking 時以 domcontentloaded 開輕量頁面取得 session", async () => {
    stubXhr({
      overview: () =>
        okReply({ status: "Normal", accountList: fixtureItems() }),
      detail: () => okReply({ deductionAccount: "" }),
    });
    const { page, gotoCalls } = apiPage("https://www.cathaybk.com.tw/MyBank/");
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scrapeLoans(page);

    expect(gotoCalls).toEqual([
      { url: depositUrl, waitUntil: "domcontentloaded" },
    ]);
    expect(result.bankAccounts).toHaveLength(5);
  });

  it("API 回傳空清單時為沒有貸款且完整，不開總覽頁", async () => {
    const requests = stubXhr({
      overview: () => okReply({ status: "Normal", accountList: [] }),
    });
    const { page, gotoCalls } = apiPage(cardUrl);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scrapeLoans(page);

    expect(result.loanOverviewComplete).toBe(true);
    expect(result.bankAccounts).toEqual([]);
    expect(result.bankBalanceSnapshots).toEqual([]);
    expect(gotoCalls).toEqual([]);
    expect(
      requests.some((request) => request.url.endsWith("OverViewDetail")),
    ).toBe(false);
    expect(overviewLog(logsOf(log))).toMatchObject({
      method: "api",
      count: 0,
    });
  });

  it("無回應時重試一次，第二次成功即採用", async () => {
    const requests = stubXhr({
      overview: (attempt) =>
        attempt === 1
          ? null
          : okReply({ status: "Normal", accountList: fixtureItems() }),
      detail: () => okReply({ deductionAccount: "" }),
    });
    const { page, gotoCalls } = apiPage(cardUrl);
    vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scrapeLoans(page);

    expect(result.bankAccounts).toHaveLength(5);
    expect(gotoCalls).toEqual([]);
    const seqNos = requests
      .filter((request) => request.url.endsWith("/L_ACCT_Q_OverView"))
      .map((request) => request.body.functionSeqNo);
    expect(seqNos).toHaveLength(2);
    expect(new Set(seqNos).size).toBe(2);
  });

  it.each([
    [
      "non_0000",
      "E999",
      () => ({ success: false, returnCode: "E999", content: null }),
    ],
    ["no_response", "no_response", () => null],
    [
      "schema_mismatch",
      "0000",
      () =>
        okReply({
          status: "Normal",
          accountList: [item({ loanType: "UnknownLoan" })],
        }),
    ],
    [
      "maintenance",
      "0000",
      () => okReply({ status: "MaintainTime", accountList: [] }),
    ],
  ])(
    "API 失敗（%s）時改走總覽頁 DOM，結果不退化",
    async (reason, returnCode, overview) => {
      stubXhr({
        overview,
        detail: () => okReply({ deductionAccount: "" }),
      });
      const { page, gotoCalls } = apiPage(cardUrl);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      const result = await scrapeLoans(page);

      expect(gotoCalls.map((call) => call.url)).toEqual([overviewUrl]);
      expect(result.bankAccounts).toHaveLength(5);
      expect(result.loanOverviewComplete).toBe(true);
      const logs = logsOf(log);
      expect(overviewLog(logs)).toMatchObject({
        method: "page",
        count: 5,
        returnCode,
        fallbackReason: reason,
      });
      expect(logs).not.toMatch(/\d{8,}/);
      expect(logs).not.toContain("SECRET_TOKEN");
      expect(logs).not.toContain("A000000000");
    },
  );

  it("取不到 session 時改走總覽頁 DOM", async () => {
    stubXhr({ jwt: null });
    const { page, gotoCalls } = apiPage(cardUrl);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await scrapeLoans(page);

    expect(gotoCalls.map((call) => call.url)).toContain(overviewUrl);
    expect(result.bankAccounts).toHaveLength(5);
    expect(overviewLog(logsOf(log))).toMatchObject({
      method: "page",
      returnCode: "not_called",
      fallbackReason: "no_session",
      apiJwtAvailable: false,
    });
  });

  it("頁面內函式只回傳對應需要的欄位", async () => {
    stubXhr({
      overview: () =>
        okReply({
          status: "Normal",
          accountList: [
            { ...item(), customerName: "PRIVATE_NAME", contractAmount: 1 },
          ],
        }),
    });
    const { session } = await getCathayApiSession();
    const result = await queryCathayLoanOverviewApi({ session });

    expect(result).toMatchObject({
      httpStatus: 200,
      returnCode: "0000",
      status: "Normal",
      attempts: 1,
    });
    expect(Object.keys(result.accountList![0]!).sort()).toEqual(
      Object.keys(item()).sort(),
    );
    expect(JSON.stringify(result)).not.toContain("PRIVATE_NAME");
  });
});
