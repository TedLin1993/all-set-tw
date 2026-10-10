import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const puppeteerMock = vi.hoisted(() => ({
  connect: vi.fn(),
  launch: vi.fn(),
  limits: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock("@cloudflare/puppeteer", () => ({ default: puppeteerMock }));

import {
  createRakutenConnector,
  RakutenCredentialRejectedError,
} from "../../../src/sources/rakuten/connector";

const LOGIN_URL = "https://www.rakuten-bank.com.tw/ebank/cgn/cgnot0001/010";
const HOME_URL = "https://www.rakuten-bank.com.tw/ebank/chm/chmqu0001/010";
const TWD_DEPOSIT_URL =
  "https://www.rakuten-bank.com.tw/ebank/ctw/ctwqu0001/010";
const LOAN_URL = "https://www.rakuten-bank.com.tw/ebank/cln/clnqu0001/010";

const credentials = {
  userId: "A123456789",
  account: "rakuten-user",
  password: "testpass12",
};

const depositPageText = `
臺幣存款
活存

活存總額 0081200000001234
$52,345
`;

const loanPageText = `
貸款總覽

樂天測試信貸
剩餘貸款金額
$456,789
下次將於 2026/10/09 扣款 $6,543 自動扣款
初始貸款金額 $500,000
剩餘／初始期數 88／96
當期年利率 3.3300%
每月繳款日 9 日
`;

/** 網頁自己解密後的首頁（CHMQU0001）回應內容。 */
const DEFAULT_DASHBOARD_RS_DATA = {
  depositInfo: {
    depAccounts: [
      {
        acctNo: "0081200000001234",
        showAcctNo: "008-***-1234",
        ntdCurrBal: 52345,
      },
    ],
  },
};

/**
 * 網頁自己解密後的貸款頁（CLNQU0001 完整版）回應內容。欄位名稱與格式同正式
 * 環境（數字皆為字串、日期為 YYYY/MM/DD），值為假資料。
 */
const DEFAULT_LOAN_RS_DATA = {
  loanProjects: [
    {
      marketingName: "樂天測試信貸",
      acctNo: "9990001",
      transLoanCode: "1",
      remainLoanAmount: "456789",
      initLoanAmount: "500000",
      initPeriod: "96",
      remainPeriod: "88",
      currentRate: "3.3300000",
      monthlyPayDay: "09",
      monthlyRepayDay: "09",
      nextRepaymentDate: "2026/10/09",
      nextRepaymentAmount: "6543",
      currentPeriodAmount: "6543",
    },
  ],
};

const DEPOSIT_ACCOUNT_NO = "0081200000001234";

/** 臺幣活存明細（CTWQU0001）回應：欄位形狀同正式環境，值為合成資料。 */
function depositTxnRsData(
  txDetails: Array<{
    sysDate: string;
    sysTime: string;
    credit: boolean;
    amt: string;
    balance: string;
    txDesc: string;
    pk: string;
  }>,
  display: Record<string, boolean> = {},
) {
  return {
    display: { dataEnd: true, dataLimit: false, noData: false, ...display },
    accounts: [{ acctNo: DEPOSIT_ACCOUNT_NO, balance: "52,345" }],
    queryAccountNo: DEPOSIT_ACCOUNT_NO,
    // 新的在前；amtSign true 代表收入（測試假設，解析器由餘額差確認）
    txDetails: txDetails.map((row) => ({
      sysDate: row.sysDate,
      sysTime: row.sysTime,
      amtSign: row.credit,
      amt: row.amt,
      memo: "",
      txDesc: row.txDesc,
      nickNameOrAcct: "",
      acctNo: "",
      bankId: "",
      balance: row.balance,
      pk: row.pk,
    })),
  };
}

function monthRows(month: string, opening: number, pkSeed: number) {
  const repay = {
    sysDate: `${month}/17`,
    sysTime: "08:30",
    credit: false,
    amt: "6,543",
    balance: (opening - 6_543).toLocaleString("en-US"),
    txDesc: "放款還款",
    pk: `${pkSeed}0000000000002`,
  };
  const transfer = {
    sysDate: `${month}/03`,
    sysTime: "10:00",
    credit: true,
    amt: "10,000",
    balance: opening.toLocaleString("en-US"),
    txDesc: "他行轉入",
    pk: `${pkSeed}0000000000001`,
  };
  return [repay, transfer];
}

const DEFAULT_DEPOSIT_TXN_CURRENT = depositTxnRsData(
  monthRows("2026/09", 58_888, 9),
);
const DEFAULT_DEPOSIT_TXN_MONTHS: Record<string, unknown> = {
  "2026/08 活存明細": depositTxnRsData(monthRows("2026/08", 35_431, 8)),
  "2026/07 活存明細": depositTxnRsData(monthRows("2026/07", 21_974, 7)),
};

type PageState = {
  navClicks?: Array<{ exact?: string; within?: string }>;
  navToLogin?: boolean;
  sessionExpired?: boolean;
  currentUrl: string;
  captchaDataUri?: string;
  modalText?: string;
  modalTexts?: string[];
  depositText?: string;
  loanText?: string;
  loginClicked: number;
  onLoginClick?: (attempt: number) => void;
  /** 解密後的首頁資料；null 表示網頁沒有送出／攔截不到。 */
  tapDashboard?: unknown;
  /** 解密後的貸款資料（點選單「我的貸款」後才有）；null 表示攔截不到。 */
  tapLoan?: unknown;
  /** 首頁登入時就先送出的精簡版貸款回應（只有名稱與剩餘金額）。 */
  tapLoanPreview?: unknown;
  tapReadsAfterLoanClick?: number;
  logoutClicked?: boolean;
  logoutConfirmed?: boolean;
  /** 臺幣存款頁當月明細（CTWQU0001/010）；null 表示網頁沒有送出。 */
  tapDepositCurrent?: unknown;
  /** 月份下拉選單的選項（「YYYY/MM 活存明細」→ CTWQU0001/011 回應）。 */
  tapDepositMonths?: Record<string, unknown>;
  /** 下拉按鈕目前顯示的月份文字。 */
  depositMonthLabel?: string;
  /** 已送出的活存明細回應（依送出順序）。 */
  depositResponses?: Array<{ path: string; rsData: unknown }>;
  monthClicks?: Array<{ action: string; label?: string }>;
  /** 頁面內執行的月份下拉函式（測試用假 DOM 直接執行它）。 */
  monthSelectFn?: (spec: unknown) => unknown;
  /** 月份下拉按鈕前 N 次 toggle 還沒渲染（模擬 Angular 延遲渲染）。 */
  monthToggleMisses?: number;
  /** 點下「臺幣存款」之後呼叫（測試用來推進時間）。 */
  onDepositOpened?: () => void;
  /** 點下「我的貸款」之後呼叫（測試用來推進時間）。 */
  onLoanOpened?: () => void;
};

function makePage(overrides?: Partial<PageState>) {
  const state: PageState = {
    currentUrl: LOGIN_URL,
    captchaDataUri: "data:image/png;base64,AQID",
    loginClicked: 0,
    tapDashboard: DEFAULT_DASHBOARD_RS_DATA,
    tapLoan: DEFAULT_LOAN_RS_DATA,
    // 貸款頁畫面上的條件文字（API 沒有利率、期數，靠畫面補）
    loanText: loanPageText,
    tapDepositCurrent: DEFAULT_DEPOSIT_TXN_CURRENT,
    tapDepositMonths: DEFAULT_DEPOSIT_TXN_MONTHS,
    depositMonthLabel: "2026/09 活存明細",
    depositResponses: [],
    monthClicks: [],
    ...overrides,
  };

  const bodyTextForCurrentUrl = () => {
    if (state.currentUrl.includes("ctwqu0001")) return state.depositText ?? "";
    if (state.currentUrl.includes("clnqu0001")) return state.loanText ?? "";
    return "";
  };

  const evaluate = vi
    .fn()
    .mockImplementation(
      async (fn: (...args: never[]) => unknown, arg?: unknown) => {
        const source = String(fn);
        if (source.includes("__tfhRakutenTap")) {
          // 讀取頁面內攔截到的解密後回應（依網頁送出順序排列）
          if (state.sessionExpired && state.currentUrl !== LOGIN_URL) {
            state.currentUrl = LOGIN_URL;
          }
          if (state.currentUrl === LOGIN_URL) return { count: 0, rsData: null };
          const input = (arg ?? {}) as {
            suffix?: string;
            afterIndex?: number;
            requireLoanTerms?: boolean;
          };
          const opened = (state.navClicks ?? []).some(
            (click) => click.exact === "我的貸款",
          );
          const entries: Array<{ path: string; rsData: unknown }> = [];
          if (state.tapDashboard != null) {
            entries.push({ path: "CHMQU0001", rsData: state.tapDashboard });
          }
          // 首頁登入時呼叫的精簡版貸款回應
          if (state.tapLoanPreview != null) {
            entries.push({ path: "CLNQU0001", rsData: state.tapLoanPreview });
          }
          if (opened)
            state.tapReadsAfterLoanClick =
              (state.tapReadsAfterLoanClick ?? 0) + 1;
          // 切頁時首頁元件會再送一次精簡版，比貸款頁的完整版先到
          if (opened && state.tapLoanPreview != null) {
            entries.push({ path: "CLNQU0001", rsData: state.tapLoanPreview });
          }
          // 點「我的貸款」後貸款頁送出的完整版：回應比點擊晚到，第二次讀取才出現
          if (
            opened &&
            state.tapLoan != null &&
            (state.tapLoanPreview == null ||
              (state.tapReadsAfterLoanClick ?? 0) >= 2)
          ) {
            entries.push({ path: "CLNQU0001", rsData: state.tapLoan });
          }
          const hasLoanTerms = (rsData: unknown) => {
            const projects = (rsData as { loanProjects?: unknown })
              ?.loanProjects;
            return (
              Array.isArray(projects) &&
              projects.some(
                (project) =>
                  typeof project === "object" &&
                  project !== null &&
                  "initPeriod" in project,
              )
            );
          };
          // 臺幣存款頁的活存明細回應：依點擊順序附在最後
          entries.push(...(state.depositResponses ?? []));
          const suffix = String(input.suffix ?? "");
          const afterIndex = input.afterIndex ?? 0;
          for (let i = entries.length - 1; i >= afterIndex; i -= 1) {
            if (!suffix.includes(entries[i]!.path)) continue;
            if (input.requireLoanTerms && !hasLoanTerms(entries[i]!.rsData)) {
              continue;
            }
            return { count: entries.length, rsData: entries[i]!.rsData };
          }
          return { count: entries.length, rsData: null };
        }
        if (source.includes("確認登出")) {
          if (!state.logoutClicked) return "no_modal";
          state.logoutConfirmed = true;
          state.currentUrl = LOGIN_URL;
          return "clicked";
        }
        if (source.includes("captcha-image")) {
          return state.captchaDataUri ?? "";
        }
        if (source.includes("modal-title")) {
          if (state.loginClicked === 0) {
            return /維護/.test(state.modalText ?? "")
              ? (state.modalText ?? "")
              : "";
          }
          if (state.modalTexts && state.modalTexts.length > 0) {
            return state.modalTexts.shift() ?? "";
          }
          return state.modalText ?? "";
        }
        if (source.includes("btn-primary")) {
          state.loginClicked += 1;
          state.onLoginClick?.(state.loginClicked);
          return undefined;
        }
        if (source.includes("rakuten-month-select")) {
          // 月份下拉選單：toggle 點開按鈕，choose 點選項（送出 CTWQU0001/011）
          state.monthSelectFn = fn as (spec: unknown) => unknown;
          const spec = (arg ?? {}) as { action: string; label?: string };
          state.monthClicks = [...(state.monthClicks ?? []), spec];
          const onDepositPage = state.currentUrl === TWD_DEPOSIT_URL;
          if (spec.action === "toggle") {
            if ((state.monthToggleMisses ?? 0) > 0) {
              state.monthToggleMisses = (state.monthToggleMisses ?? 0) - 1;
              return { label: "", clicked: false, labelShapedCount: 0 };
            }
            return {
              label: onDepositPage
                ? (/\d{4}\/\d{2}/.exec(state.depositMonthLabel ?? "")?.[0] ??
                  "")
                : "",
              clicked: onDepositPage,
              labelShapedCount: onDepositPage ? 4 : 0,
            };
          }
          const options = state.tapDepositMonths ?? {};
          const label = String(spec.label ?? "");
          if (!onDepositPage || !(label in options)) {
            return { label: "", clicked: false, labelShapedCount: 4 };
          }
          state.depositMonthLabel = label;
          if (options[label] != null) {
            state.depositResponses = [
              ...(state.depositResponses ?? []),
              { path: "CTWQU0001/011", rsData: options[label] },
            ];
          }
          return { label: "", clicked: true, labelShapedCount: 4 };
        }
        if (source.includes("rakuten-nav-click")) {
          // SPA 選單點擊：依使用者操作路徑切頁，不整頁重載。
          const spec = (arg ?? {}) as { exact?: string; within?: string };
          state.navClicks = [...(state.navClicks ?? []), spec];
          // 已被導回登入頁時，選單連結都不存在
          if (state.currentUrl === LOGIN_URL) return false;
          if (spec.exact === "登出") {
            state.logoutClicked = true;
            return true;
          }
          if (spec.exact === "臺幣存款" || spec.exact === "存款") {
            state.currentUrl = TWD_DEPOSIT_URL;
            if (spec.exact === "臺幣存款") state.onDepositOpened?.();
            if (spec.exact === "臺幣存款" && state.tapDepositCurrent != null) {
              state.depositResponses = [
                ...(state.depositResponses ?? []),
                { path: "CTWQU0001/010", rsData: state.tapDepositCurrent },
              ];
            }
            return true;
          }
          if (
            spec.exact === "我的貸款" ||
            spec.exact === "貸款" ||
            spec.within
          ) {
            if (state.navToLogin) {
              state.currentUrl = LOGIN_URL;
              return true;
            }
            state.currentUrl = LOAN_URL;
            if (spec.exact === "我的貸款") state.onLoanOpened?.();
            return true;
          }
          return false;
        }
        if (source.includes("innerText")) {
          return bodyTextForCurrentUrl();
        }
        if (source.includes("focus")) {
          return undefined;
        }
        return undefined;
      },
    );

  return {
    state,
    evaluate,
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    goto: vi.fn().mockImplementation(async (url: string) => {
      state.currentUrl = url;
      state.loginClicked = 0;
      return { status: () => 200 };
    }),
    on: vi.fn(),
    off: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    setUserAgent: vi.fn().mockResolvedValue(undefined),
    setViewport: vi.fn().mockResolvedValue(undefined),
    type: vi.fn().mockResolvedValue(undefined),
    url: vi.fn().mockImplementation(() => state.currentUrl),
    waitForFunction: vi
      .fn()
      .mockImplementation(async (fn: (...args: never[]) => unknown) => {
        const source = String(fn);
        if (source.includes("custNo")) return undefined;
        if (source.includes("captcha-image")) {
          if (!state.captchaDataUri) {
            throw new Error(
              "waiting for function failed: timeout 10000ms exceeded",
            );
          }
          return undefined;
        }
        return undefined;
      }),
    waitForSelector: vi.fn().mockResolvedValue(undefined),
  };
}

// 假的 Browser Run binding：browser.ts 的 scoped binding 會 bind 它的 fetch，
// 且關閉 session 時會以 fetch 送出 DELETE，因此必須提供可用的 fetch。
function fakeBrowserBinding() {
  return {
    fetch: vi.fn().mockResolvedValue(new Response(null, { status: 200 })),
  } as unknown as Fetcher & { fetch: ReturnType<typeof vi.fn> };
}

// 自動流程結束時 session 必須被關掉、不得保留：close() 一次，並且經 binding
// 送出遠端 DELETE。closeBrowserSession（#231）會在 close 之後才對本機連線
// disconnect()，所以不再斷言 disconnect 從未被呼叫，而是斷言它只能發生在 close 之後。
function expectBrowserClosedNotPreserved(
  browser: {
    close: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
  },
  binding: { fetch: ReturnType<typeof vi.fn> },
  sessionId: string,
) {
  expect(browser.close).toHaveBeenCalledOnce();
  expect(binding.fetch).toHaveBeenCalledWith(
    `https://fake.host/v1/devtools/browser/${sessionId}`,
    expect.objectContaining({ method: "DELETE" }),
  );
  for (const order of browser.disconnect.mock.invocationCallOrder) {
    expect(order).toBeGreaterThan(browser.close.mock.invocationCallOrder[0]);
  }
}

function browser(browserPage: ReturnType<typeof makePage>) {
  return {
    close: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    once: vi.fn(),
    pages: vi.fn().mockResolvedValue([browserPage]),
    newPage: vi.fn().mockResolvedValue(browserPage),
    sessionId: vi.fn().mockReturnValue("rakuten-session"),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  // 預設靜音 console；需要檢查 log 的測試會自己再 spyOn 同一個 spy
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  puppeteerMock.sessions.mockResolvedValue([]);
  puppeteerMock.limits.mockResolvedValue({
    activeSessions: [],
    maxConcurrentSessions: 3,
    allowedBrowserAcquisitions: 1,
    timeUntilNextAllowedBrowserAcquisition: 0,
  });
});

describe("Rakuten log levels and sync summary", () => {
  function parsedEvents(spy: { mock: { calls: unknown[][] } }) {
    return spy.mock.calls.flatMap(([value]) => {
      try {
        const parsed: unknown = JSON.parse(String(value));
        return parsed && typeof parsed === "object"
          ? [parsed as Record<string, unknown>]
          : [];
      } catch {
        return [];
      }
    });
  }

  it("logs one info-level summary for a successful sync and no warnings", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const browserPage = makePage({
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await createRakutenConnector(
      fakeBrowserBinding(),
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);

    expect(warn).not.toHaveBeenCalled();
    const summaries = parsedEvents(log).filter(
      (event) => event.event === "rakuten_sync_summary",
    );
    expect(summaries).toHaveLength(1);
    expect(summaries[0]).toEqual({
      event: "rakuten_sync_summary",
      outcome: "success",
      loginMode: "ocr",
      ocrAttempts: 1,
      depositSource: "tap",
      loanSource: "tap",
      depositAccountCount: 1,
      loanAccountCount: 1,
      loanTermCount: 1,
      depositTxnMonthsFetched: 3,
      depositTxnCount: 6,
      durationMs: expect.any(Number),
      loginMs: expect.any(Number),
      dashboardMs: expect.any(Number),
      loanMs: expect.any(Number),
      depositTxnMs: expect.any(Number),
      logoutMs: expect.any(Number),
    });
    for (const key of [
      "loginMs",
      "dashboardMs",
      "loanMs",
      "depositTxnMs",
      "logoutMs",
    ]) {
      const value = summaries[0][key];
      expect(Number.isInteger(value)).toBe(true);
      expect(value as number).toBeGreaterThanOrEqual(0);
    }
  });

  it("summarizes a failed sync with the error name, stage and OCR attempts", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    let clicks = 0;
    const browserPage = makePage({
      modalTexts: ["驗證碼錯誤", "使用者代號或密碼錯誤"],
      onLoginClick: () => {
        clicks += 1;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await expect(
      createRakutenConnector(
        fakeBrowserBinding(),
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toBeInstanceOf(RakutenCredentialRejectedError);

    expect(clicks).toBe(2);
    const summary = parsedEvents(log).find(
      (event) => event.event === "rakuten_sync_summary",
    );
    expect(summary).toMatchObject({
      outcome: "RakutenCredentialRejectedError",
      stage: "login",
      loginMode: "ocr",
      ocrAttempts: 2,
      depositSource: "none",
      loanSource: "none",
      // 沒走到的階段維持 0；沒登入成功就不登出
      dashboardMs: 0,
      loanMs: 0,
      depositTxnMs: 0,
      logoutMs: 0,
    });
    expect(summary?.loginMs).toEqual(expect.any(Number));
    // 只有 OCR 驗證碼錯誤那一次是 warn
    expect(parsedEvents(warn).map((event) => event.event)).toEqual([
      "rakuten_ocr_attempt_failed",
    ]);
  });
});

describe("Rakuten loan terms from the rendered loan page", () => {
  it("fills rate, periods and next payment from the page text when the API only has name and balance", async () => {
    const browserPage = makePage({
      tapLoan: {
        loanProjects: [
          { marketingName: "樂天測試信貸", remainLoanAmount: "456789" },
        ],
      },
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    const result = await createRakutenConnector(
      fakeBrowserBinding(),
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);

    const loan = result.bankAccounts?.find(
      (account) => account.accountType === "loan",
    );
    expect(loan?.raw).toMatchObject({
      initialAmount: 500000,
      remainingPeriods: 88,
      totalPeriods: 96,
      annualRatePct: 3.33,
      paymentDay: 9,
      nextPaymentDate: "2026-10-09",
      nextPaymentAmount: 6543,
    });
    expect(
      result.bankBalanceSnapshots?.find((snapshot) =>
        snapshot.accountId.startsWith("loan:"),
      )?.balance,
    ).toBe(-456_789);
  }, 15_000);
});

describe("Rakuten loan overview response after clicking", () => {
  const preview = {
    loanProjects: [
      { marketingName: "樂天測試信貸", remainLoanAmount: "456789" },
    ],
  };
  const full = {
    loanProjects: [
      {
        marketingName: "樂天測試信貸",
        remainLoanAmount: "456789",
        initLoanAmount: "500000",
        initPeriod: "96",
        remainPeriod: "88",
        currentRate: "3.33",
        monthlyPayDay: "9",
        currentPeriodAmount: "6543",
      },
    ],
  };

  it("waits for the full loan response sent after opening the loan overview", async () => {
    const browserPage = makePage({
      tapLoanPreview: preview,
      tapLoan: full,
      loanText: "貸款總覽",
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    const result = await createRakutenConnector(
      fakeBrowserBinding(),
      vi.fn().mockResolvedValue("36CY"),
    ).sync(credentials);

    const loan = result.bankAccounts?.find(
      (account) => account.accountType === "loan",
    );
    expect(loan?.raw).toMatchObject({
      initialAmount: 500000,
      totalPeriods: 96,
      remainingPeriods: 88,
      annualRatePct: 3.33,
      paymentDay: 9,
      nextPaymentAmount: 6543,
    });
  }, 15_000);
});

describe("Rakuten deposit and loan sources are independent", () => {
  it("fails instead of reporting success when only loans are parsed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const browserPage = makePage({
      depositText: "臺幣存款\n載入中",
      tapDashboard: {},
      onLoginClick: () => {
        browserPage.state.currentUrl = HOME_URL;
      },
    });
    puppeteerMock.launch.mockResolvedValue(browser(browserPage));

    await expect(
      createRakutenConnector(
        fakeBrowserBinding(),
        vi.fn().mockResolvedValue("36CY"),
      ).sync(credentials),
    ).rejects.toThrow("解析不到臺幣存款資料");

    const logged = warn.mock.calls.map(([value]) => String(value)).join("\n");
    expect(logged).toContain('"accountCount":1');
  }, 15_000);
});
