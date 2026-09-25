import { type Browser, type Page } from "@cloudflare/puppeteer";
import { BANK_SYNC_MONTHS } from "@taiwan-fin-hub/connectors";
import { type EsunTimelinePage, type EsunTimelineTransaction } from "./esun.js";

const IESC_ORIGIN = "https://iesc.esunbank.com";
const CARD_OVERVIEW_INIT_PATH = "mib-ccm-portal/ccmB1/ccmB1001/home/init";
const CARD_OVERVIEW_PATH = "mib-ccm-portal/ccmB1/ccmB1001/home/getCardOverview";
const DEPOSIT_TASK_INIT_PATH = "mib-ctw-portal/ctw01/ctw01002/home/init";
const NO_FOREIGN_ACCOUNT_RESULT_CODE = "S001";
const TW_DEPOSIT_PREQUERY_PATH =
  "mib-ctw-portal/ctw01/ctw01002/home/preQueryTWTransactionDetail";
const FR_DEPOSIT_PREQUERY_PATH =
  "mib-ctw-portal/ctw01/ctw01002/home/preQueryFRTransactionDetail";
const TW_DEPOSIT_SEARCH_PATH =
  "mib-ctw-portal/ctw01/ctw01002/search/queryTWTransactionDetail";
const FR_DEPOSIT_SEARCH_PATH =
  "mib-ctw-portal/ctw01/ctw01002/search/queryFRTransactionDetail";

export interface EsunBrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
}

export interface EsunBrowserSession {
  cookies: EsunBrowserCookie[];
  portalUuid: string;
  iescAccessToken: string;
  iescRealtimeBody: string;
}

export interface EsunDepositDetail {
  detailTitle?: string;
  txDate?: string;
  txTime?: string;
  currency?: string;
  amount?: number | string;
  debitCredit?: string;
  passbookRemark?: string;
  balance?: number | string;
}

export interface EsunDepositSnapshot {
  accountNo: string;
  alias: string;
  currency: string;
  balance: number;
  transactions: EsunDepositDetail[];
}

export interface EsunSnapshot {
  hasCreditCard: boolean;
  cardOverview: unknown;
  realtime: unknown;
  creditHistory: unknown[];
  billSummary: unknown;
  billPeriod: string | null;
  twDeposits: EsunDepositSnapshot[];
  frDeposits: EsunDepositSnapshot[];
}

export interface EsunPortalApi {
  postPortal(
    path: string,
    body: Record<string, unknown>,
    resetFlow?: boolean,
  ): Promise<unknown>;
  postIesc(path: string, body: Record<string, unknown>): Promise<unknown>;
  readRealtime(): Promise<{ body: string; payload: unknown }>;
}

interface PortalEnvelope<T> {
  resultCode?: string;
  resultBody?: T;
  txnFlowToken?: string;
}

interface IescEnvelope<T> {
  status?: number;
  body?: T;
}

interface IescDetail {
  merchantName?: string;
  cardNo?: string;
  transMonthDay?: string;
  postingMonthDay?: string;
  transTime?: string;
  paymentAmount?: number | string;
  transAmount?: number | string;
  amount?: number | string;
  paymentCurrency?: string;
  transCurrency?: string;
  currency?: string;
  status?: string;
  statusName?: string;
  positiveTrans?: boolean;
}

interface IescMonth {
  year?: string;
  month?: string;
  transDetailList?: IescDetail[];
}

interface IescCardBody {
  rtnCode?: string;
  credit?: boolean;
  cursor?: number;
  transList?: IescMonth[];
  cardInfoList?: Array<{ cardNo?: string }>;
  lastBillYearMonth?: string | number;
}

interface DepositAccountRef {
  accountNo?: string;
  accountAlias?: string;
}

interface DepositDetailGroup {
  detailInfo?: EsunDepositDetail[];
}

interface DepositQueryBody {
  demandDeptAcc?: string;
  accountAlias?: string;
  twAccountList?: DepositAccountRef[];
  frAccountList?: DepositAccountRef[];
  twCurrInfo?: { realBalance?: number | string };
  totalTWBalance?: number | string;
  currInfoList?: Array<{ currency?: string; totalAmount?: number | string }>;
  queryDeptTxDtlResult?: { detailListData?: DepositDetailGroup[] };
}

interface CardOverviewBody {
  creditCardFeePaid?: boolean;
  currentStatement?: Array<{
    currency?: string;
    totalAmountDue?: number | string;
    minimumAmountDue?: number | string;
  }>;
  currentStatementPaymentDueDate?: string;
  nextStatement?: Array<{
    currency?: string;
    unpostedAmount?: number | string;
  }>;
  nextStatementBillingDate?: string;
}

interface BillSummaryBody {
  rtnCode?: string;
  billInfo?: {
    billDate?: string;
    paymentDueDate?: string;
    billTotalInfoList?: Array<{
      billTotalCurrency?: string;
      billTotalAmount?: number | string;
    }>;
    minimumPaymentInfoList?: Array<{
      minimumPaymentAmount?: number | string;
    }>;
  };
}

export async function collectEsunBrowserSnapshot(
  browser: Browser,
  portalPage: Page,
): Promise<{ snapshot: EsunSnapshot; session: EsunBrowserSession }> {
  const iescPage = await openIescCardPage(browser, portalPage);
  let realtimeBody = "{}";
  const snapshot = await collectEsunSnapshot({
    postPortal: (path, body, resetFlow) =>
      postPortalFromPage(portalPage, path, body, Boolean(resetFlow)),
    postIesc: (path, body) => postIescFromPage(iescPage, path, body),
    readRealtime: async () => {
      const result = await readIescRealtime(iescPage);
      realtimeBody = result.body;
      return result;
    },
  });
  const portalUuid = await portalPage.evaluate(() => {
    const state = (window as Window & { mibApiService?: { uuid?: string } })
      .mibApiService;
    return state?.uuid ?? "";
  });
  const iescAccessToken = await iescPage.evaluate(
    () => sessionStorage.getItem("accessToken") ?? "",
  );
  const cookies = [
    ...(await portalPage.cookies()),
    ...(await iescPage.cookies()),
  ].map((cookie) => ({
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain || "ebank.esunbank.com.tw",
    path: cookie.path || "/",
  }));
  if (!portalUuid || !iescAccessToken) {
    throw new Error("E.SUN login did not establish a reusable portal session.");
  }
  return {
    snapshot,
    session: {
      cookies,
      portalUuid,
      iescAccessToken,
      iescRealtimeBody: realtimeBody,
    },
  };
}

export async function collectEsunSnapshot(
  api: EsunPortalApi,
): Promise<EsunSnapshot> {
  const hasCreditCard = await loadCreditCardholder(api);
  if (!hasCreditCard) {
    logEsunStep("credit-card-not-held");
    return {
      hasCreditCard,
      cardOverview: null,
      realtime: null,
      creditHistory: [],
      billSummary: null,
      billPeriod: null,
      ...(await loadAllDeposits(api)),
    };
  }
  const realtime = (await api.readRealtime()).payload;
  assertIescOk(realtime, "realtime");
  const creditHistory = await loadCreditHistory(api);
  logEsunStep("credit-history-loaded");
  const billPeriod = await loadBillPeriod(api);
  const billSummary = billPeriod
    ? await api.postIesc("creditBill/getSummaryResult", { billPeriod })
    : null;
  if (billSummary) assertIescOk(billSummary, "bill");

  let cardOverview: unknown = null;
  try {
    await api.postPortal(CARD_OVERVIEW_INIT_PATH, {}, true);
    cardOverview = await api.postPortal(CARD_OVERVIEW_PATH, {});
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "esun_card_overview_unavailable",
        errorType: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      }),
    );
  }

  logEsunStep("card-bill-loaded");

  return {
    hasCreditCard,
    cardOverview,
    realtime,
    creditHistory,
    billSummary,
    billPeriod,
    ...(await loadAllDeposits(api)),
  };
}

/** Only an explicit `credit: false` skips cards; anything else keeps the card flow. */
async function loadCreditCardholder(api: EsunPortalApi) {
  try {
    const body = iescData(await api.postIesc("common/isCardholder", {}));
    return !(body?.rtnCode === "S" && body.credit === false);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "esun_cardholder_check_failed",
        errorType: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      }),
    );
    return true;
  }
}

async function loadAllDeposits(api: EsunPortalApi) {
  const range = depositSearchRange();
  const twDeposits = await loadDeposits(api, {
    prequeryPath: TW_DEPOSIT_PREQUERY_PATH,
    searchPath: TW_DEPOSIT_SEARCH_PATH,
    kind: "tw",
    ...range,
  });
  const frDeposits = await loadDeposits(api, {
    prequeryPath: FR_DEPOSIT_PREQUERY_PATH,
    searchPath: FR_DEPOSIT_SEARCH_PATH,
    kind: "fr",
    ...range,
  });
  logEsunStep("deposits-loaded");
  return { twDeposits, frDeposits };
}

export function buildEsunCreditTimelinePages(
  snapshot: Pick<EsunSnapshot, "realtime" | "creditHistory">,
): EsunTimelinePage[] {
  const months = new Map<
    string,
    { year: string; month: string; txnList: EsunTimelineTransaction[] }
  >();
  const add = (
    year: string,
    month: string,
    transaction: EsunTimelineTransaction,
  ) => {
    const key = `${year}-${month}`;
    const group = months.get(key) ?? { year, month, txnList: [] };
    group.txnList.push(transaction);
    months.set(key, group);
  };
  for (const page of snapshot.creditHistory)
    addIescMonths(page, add, "history");
  addIescMonths(snapshot.realtime, add, "realtime");
  return [{ timelineList: [...months.values()] }];
}

export function esunCardNumbers(snapshot: EsunSnapshot) {
  const numbers = new Set<string>();
  const collect = (payload: unknown) => {
    const body = iescData(payload);
    for (const card of body?.cardInfoList ?? []) {
      if (card.cardNo) numbers.add(card.cardNo);
    }
    for (const month of body?.transList ?? []) {
      for (const detail of month.transDetailList ?? []) {
        if (detail.cardNo) numbers.add(detail.cardNo);
      }
    }
  };
  collect(snapshot.realtime);
  for (const page of snapshot.creditHistory) collect(page);
  return [...numbers];
}

export function readEsunCardBalances(snapshot: EsunSnapshot) {
  const overview = portalData<CardOverviewBody>(snapshot.cardOverview);
  const statement =
    overview?.currentStatement?.find((item) => item.currency === "TWD") ??
    overview?.currentStatement?.[0];
  const unpostedEntry =
    overview?.nextStatement?.find((item) => item.currency === "TWD") ??
    overview?.nextStatement?.[0];
  const bill = iescData<BillSummaryBody>(snapshot.billSummary)?.billInfo;
  const billTotal = bill?.billTotalInfoList?.[0];
  const statementBalance = numberOrUndefined(
    statement?.totalAmountDue ?? billTotal?.billTotalAmount,
  );
  const unposted = numberOrUndefined(unpostedEntry?.unpostedAmount) ?? 0;
  return {
    statementBalance,
    minimumPayment: numberOrUndefined(
      statement?.minimumAmountDue ??
        bill?.minimumPaymentInfoList?.[0]?.minimumPaymentAmount,
    ),
    paymentDueDate: parseFlexibleDate(
      overview?.currentStatementPaymentDueDate ?? bill?.paymentDueDate,
    ),
    statementClosingDate: parseFlexibleDate(
      overview?.nextStatementBillingDate ?? bill?.billDate,
    ),
    outstanding: (statementBalance ?? 0) + unposted,
    currency: statement?.currency || billTotal?.billTotalCurrency || "TWD",
    isPaid: overview?.creditCardFeePaid === true ? true : undefined,
    billingPeriod:
      parseBillPeriod(snapshot.billPeriod) ??
      parseFlexibleDate(bill?.billDate)?.slice(0, 7),
  };
}

async function openIescCardPage(browser: Browser, portalPage: Page) {
  await clickVisibleControl(portalPage, "刷卡明細");
  const deadline = Date.now() + 15000;
  let iescPage: Page | undefined;
  while (Date.now() < deadline) {
    iescPage = (await browser.pages()).find((candidate) =>
      candidate.url().startsWith(`${IESC_ORIGIN}/`),
    );
    if (iescPage) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!iescPage) throw new Error("E.SUN credit card page did not open.");
  logEsunStep("iesc-page-opened");
  // Wait until the page finished its own start-up requests, which rotate the
  // IESC token: cardholders see the unposted menu, others a no-card notice.
  await iescPage.waitForFunction(
    () =>
      Boolean(sessionStorage.getItem("accessToken")) &&
      (Boolean(document.querySelector('input[placeholder*="未入帳"]')) ||
        document.body.innerText.includes("未入帳") ||
        document.body.innerText.includes("尚未持有本行信用卡")),
    { timeout: 20000 },
  );
  logEsunStep("iesc-page-ready");
  return iescPage;
}

async function clickVisibleControl(page: Page, label: string) {
  await page.waitForFunction(
    (expected) =>
      Array.from(document.querySelectorAll("button, a")).some((element) => {
        const box = element.getBoundingClientRect();
        return (
          element.textContent?.trim() === expected &&
          box.width > 0 &&
          box.height > 0
        );
      }),
    { timeout: 15000 },
    label,
  );
  await page.evaluate((expected) => {
    const item = Array.from(document.querySelectorAll("button, a")).find(
      (element) => {
        const box = element.getBoundingClientRect();
        return (
          element.textContent?.trim() === expected &&
          box.width > 0 &&
          box.height > 0
        );
      },
    );
    (item as HTMLElement | undefined)?.click();
  }, label);
}

async function readIescRealtime(page: Page) {
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector('input[placeholder*="未入帳"]')) ||
      document.body.innerText.includes("未入帳"),
    { timeout: 20000 },
  );
  logEsunStep("iesc-card-ui-ready");
  const opened = await page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>(
      'input[placeholder*="未入帳"]',
    );
    if (input) {
      input.click();
      return true;
    }
    const element = Array.from(document.querySelectorAll<HTMLElement>("*"))
      .filter(
        (item) =>
          /^未入帳/.test(item.textContent?.trim() ?? "") &&
          (item.textContent?.length ?? 0) < 15,
      )
      .sort(
        (left, right) =>
          left.querySelectorAll("*").length -
          right.querySelectorAll("*").length,
      )[0];
    element?.click();
    return Boolean(element);
  });
  if (!opened) throw new Error("E.SUN unposted card menu did not open.");
  logEsunStep("realtime-menu-opened");
  await page.waitForFunction(
    () =>
      Array.from(document.querySelectorAll("li")).some(
        (item) => item.textContent?.trim() === "即時消費紀錄",
      ),
    { timeout: 10000 },
  );
  logEsunStep("realtime-option-visible");
  const realtimeResponse = page.waitForResponse(
    (response) => response.url().includes("/GW/realTime/getDetailResult"),
    { timeout: 20000 },
  );
  const clicked = await page.evaluate(() => {
    const element = Array.from(document.querySelectorAll("li")).find(
      (item) => item.textContent?.trim() === "即時消費紀錄",
    );
    (element as HTMLElement | undefined)?.click();
    return Boolean(element);
  });
  if (!clicked) throw new Error("E.SUN realtime card menu item was not found.");
  const response = await realtimeResponse;
  logEsunStep("realtime-loaded");
  return {
    body: response.request().postData() || "{}",
    payload: await response.json(),
  };
}

async function postPortalFromPage(
  page: Page,
  path: string,
  requestBody: Record<string, unknown>,
  resetFlow: boolean,
) {
  return page.evaluate(
    async (requestPath, body, reset) => {
      const state = (
        window as Window & {
          mibApiService?: { uuid?: string; txnFlowToken?: string };
        }
      ).mibApiService;
      if (!state?.uuid) throw new Error("E.SUN portal session is missing.");
      if (reset) state.txnFlowToken = "";
      const txnTime = new Date(Date.now() + 28800000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
      const response = await fetch(`/esb/${requestPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          uniqueKey: state.uuid,
        },
        body: JSON.stringify({
          header: {
            txnTime,
            txnFlowToken: reset ? "" : (state.txnFlowToken ?? ""),
          },
          requestBody: body,
        }),
      });
      const text = await response.text();
      let data: { resultCode?: string; txnFlowToken?: string };
      try {
        data = JSON.parse(text) as typeof data;
      } catch {
        return { resultCode: `HTTP_${response.status}` };
      }
      if (data.txnFlowToken) state.txnFlowToken = data.txnFlowToken;
      return data;
    },
    path,
    requestBody,
    resetFlow,
  );
}

async function postIescFromPage(
  page: Page,
  path: string,
  body: Record<string, unknown>,
) {
  return page.evaluate(
    async (requestPath, requestBody) => {
      const response = await fetch(`/GW/${requestPath}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionStorage.getItem("accessToken") ?? ""}`,
        },
        body: JSON.stringify(requestBody),
      });
      const authorization = response.headers.get("authorization");
      if (authorization) {
        sessionStorage.setItem(
          "accessToken",
          authorization.replace(/^Bearer\s+/i, ""),
        );
      }
      return response.json();
    },
    path,
    body,
  );
}

async function loadCreditHistory(api: EsunPortalApi) {
  const pages: unknown[] = [];
  const seen = new Set<number>();
  let cursor = 1;
  while (pages.length < 8 && !seen.has(cursor)) {
    seen.add(cursor);
    const raw = await api.postIesc("creditLastYear/getFilterResult", {
      cursor,
    });
    assertIescOk(raw, "history");
    pages.push(raw);
    const next = iescData(raw)?.cursor;
    if (typeof next !== "number" || next === cursor || next <= 0) break;
    cursor = next;
  }
  return pages;
}

async function loadBillPeriod(api: EsunPortalApi) {
  const raw = await api.postIesc("cardBill/getLastBillYearMonth", {
    cardType: "C",
  });
  assertIescOk(raw, "bill-period");
  const period = iescData(raw)?.lastBillYearMonth;
  return typeof period === "string" || typeof period === "number"
    ? String(period)
    : null;
}

async function loadDeposits(
  api: EsunPortalApi,
  options: {
    prequeryPath: string;
    searchPath: string;
    kind: "tw" | "fr";
    startDate: string;
    endDate: string;
  },
) {
  assertPortalOk(
    await api.postPortal(DEPOSIT_TASK_INIT_PATH, {}, true),
    "deposit-init",
  );
  const firstRaw = await api.postPortal(options.prequeryPath, {
    account: null,
  });
  if (options.kind === "fr" && isNoForeignAccount(firstRaw)) {
    logEsunStep("foreign-deposit-not-held");
    return [];
  }
  assertPortalOk(firstRaw, "deposit-prequery");
  const first = portalData<DepositQueryBody>(firstRaw) ?? {};
  const snapshots: EsunDepositSnapshot[] = [];
  for (const accountNo of depositAccounts(first, options.kind)) {
    const body =
      !accountNo || accountNo === first.demandDeptAcc
        ? first
        : await reloadDepositAccount(api, options.prequeryPath, accountNo);
    const transactions = await searchDepositTransactions(
      api,
      options.searchPath,
      body.demandDeptAcc || accountNo,
      body,
      options.startDate,
      options.endDate,
    );
    snapshots.push(...depositSnapshots(body, options.kind, transactions));
  }
  return snapshots.filter((item) => item.accountNo);
}

/**
 * E.SUN uses S001 for several notice pages, so only its "no foreign account"
 * wording counts; other S001 notices still fail the sync.
 */
function isNoForeignAccount(value: unknown) {
  const envelope = value as PortalEnvelope<unknown> & {
    resultDescription?: string;
  };
  return (
    envelope?.resultCode === NO_FOREIGN_ACCOUNT_RESULT_CODE &&
    /查無外幣帳號|尚未開立外幣帳戶/.test(envelope.resultDescription ?? "")
  );
}

async function reloadDepositAccount(
  api: EsunPortalApi,
  path: string,
  accountNo: string,
) {
  assertPortalOk(
    await api.postPortal(DEPOSIT_TASK_INIT_PATH, {}, true),
    "deposit-init",
  );
  const raw = await api.postPortal(path, { account: accountNo });
  assertPortalOk(raw, "deposit-prequery");
  return portalData<DepositQueryBody>(raw) ?? {};
}

async function searchDepositTransactions(
  api: EsunPortalApi,
  path: string,
  account: string,
  fallback: DepositQueryBody,
  startDate: string,
  endDate: string,
) {
  const groups: DepositDetailGroup[] = [];
  let startIndex = 1;
  for (let pageIndex = 0; pageIndex < 6; pageIndex += 1) {
    const raw = await api.postPortal(path, {
      account,
      startDate,
      endDate,
      startIndex,
      count: 100,
      customerInputHashtag: [],
    });
    const envelope = raw as PortalEnvelope<DepositQueryBody>;
    if (envelope.resultCode !== "0000") {
      console.log(
        JSON.stringify({
          event: "esun_deposit_search_fallback",
          resultCode: envelope.resultCode ?? "unknown",
        }),
      );
      return flattenDepositDetails(
        fallback.queryDeptTxDtlResult?.detailListData ?? [],
      );
    }
    const pageGroups =
      envelope.resultBody?.queryDeptTxDtlResult?.detailListData ?? [];
    const count = pageGroups.reduce(
      (sum, group) => sum + (group.detailInfo?.length ?? 0),
      0,
    );
    if (pageIndex === 0 && count === 0) {
      return flattenDepositDetails(
        fallback.queryDeptTxDtlResult?.detailListData ?? [],
      );
    }
    groups.push(...pageGroups);
    if (count < 100) break;
    startIndex += 100;
  }
  return flattenDepositDetails(groups);
}

function depositAccounts(body: DepositQueryBody, kind: "tw" | "fr") {
  const listed = (
    (kind === "tw" ? body.twAccountList : body.frAccountList) ?? []
  )
    .map((item) => item.accountNo?.trim() ?? "")
    .filter(Boolean);
  const current = body.demandDeptAcc?.trim();
  const values = current
    ? [current, ...listed.filter((item) => item !== current)]
    : listed;
  return [...new Set(values.length ? values : [""])];
}

function depositSnapshots(
  body: DepositQueryBody,
  kind: "tw" | "fr",
  transactions: EsunDepositDetail[],
): EsunDepositSnapshot[] {
  const accountNo = body.demandDeptAcc?.trim() ?? "";
  const alias = body.accountAlias?.trim() ?? "";
  if (kind === "tw") {
    return [
      {
        accountNo,
        alias,
        currency: "TWD",
        balance: numberOrUndefined(body.twCurrInfo?.realBalance) ?? 0,
        transactions,
      },
    ];
  }
  const currencies = body.currInfoList ?? [];
  if (currencies.length === 0) {
    return [
      {
        accountNo,
        alias,
        currency: "TWD",
        balance: numberOrUndefined(body.totalTWBalance) ?? 0,
        transactions,
      },
    ];
  }
  return currencies.map((entry, index) => ({
    accountNo,
    alias,
    currency: entry.currency?.trim() || "TWD",
    balance: numberOrUndefined(entry.totalAmount) ?? 0,
    transactions: transactions.filter((item) =>
      item.currency ? item.currency === entry.currency : index === 0,
    ),
  }));
}

function flattenDepositDetails(groups: DepositDetailGroup[]) {
  return groups.flatMap((group) => group.detailInfo ?? []);
}

function addIescMonths(
  payload: unknown,
  add: (
    year: string,
    month: string,
    transaction: EsunTimelineTransaction,
  ) => void,
  source: "history" | "realtime",
) {
  for (const month of iescData(payload)?.transList ?? []) {
    const year = normalizeTimelineYear(month.year);
    const monthNumber = String(month.month ?? "").padStart(2, "0");
    for (const detail of month.transDetailList ?? []) {
      add(year, monthNumber, toTimelineTransaction(detail, source));
    }
  }
}

function toTimelineTransaction(
  detail: IescDetail,
  source: "history" | "realtime",
): EsunTimelineTransaction {
  const amount = signedCardAmount(detail);
  return {
    payCur:
      detail.paymentCurrency ||
      detail.currency ||
      detail.transCurrency ||
      "TWD",
    payAmt: String(amount),
    storeName: detail.merchantName?.trim() || "玉山信用卡交易",
    consumerDt: consumerMonthDay(detail),
    postingDt: compactMonthDay(detail.postingMonthDay),
    cardNo: detail.cardNo,
    acfg: source === "realtime" ? "未入帳" : lifecycleFromStatus(detail),
    consumerTime: consumerClock(detail.transTime),
    esunFeed: source,
  };
}

function signedCardAmount(detail: IescDetail) {
  const value =
    numberOrUndefined(
      detail.paymentAmount ?? detail.transAmount ?? detail.amount,
    ) ?? 0;
  // 近一年消費與帳單明細 API 以負數表示退款且不帶 positiveTrans，
  // 取絕對值會把退款誤判成消費，因此保留原始負號。
  return detail.positiveTrans === false || value < 0
    ? -Math.abs(value)
    : Math.abs(value);
}

function lifecycleFromStatus(detail: IescDetail) {
  if (detail.statusName === "未入帳" || detail.statusName === "已入帳") {
    return detail.statusName;
  }
  return detail.status === "N" ? "未入帳" : "已入帳";
}

function consumerMonthDay(detail: IescDetail) {
  const timed = detail.transTime?.match(/^(\d{1,2}\/\d{1,2})/);
  if (timed) return timed[1];
  return compactMonthDay(detail.transMonthDay);
}

function compactMonthDay(value: string | undefined) {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (digits.length !== 4) return value;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

function consumerClock(value: string | undefined) {
  return value?.match(/(\d{1,2}:\d{2}:\d{2})/)?.[1];
}

function normalizeTimelineYear(value: string | undefined) {
  const year = value?.trim() ?? "";
  if (/^\d{3}$/.test(year)) return String(Number(year) + 1911);
  if (/^\d{4}$/.test(year)) return year;
  return String(new Date(Date.now() + 28800000).getUTCFullYear());
}

function depositSearchRange() {
  const end = new Date();
  const start = new Date();
  start.setMonth(start.getMonth() - BANK_SYNC_MONTHS);
  return { startDate: formatSlashDate(start), endDate: formatSlashDate(end) };
}

function formatSlashDate(value: Date) {
  const shifted = new Date(value.getTime() + 28800000);
  const year = shifted.getUTCFullYear();
  const month = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const day = String(shifted.getUTCDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function logEsunStep(step: string) {
  console.log(JSON.stringify({ event: "esun_sync_step", step }));
}

function assertPortalOk(value: unknown, label: string) {
  const code = (value as PortalEnvelope<unknown>).resultCode;
  if (code !== "0000") {
    throw new Error(`E.SUN portal ${label} failed (${code ?? "unknown"}).`);
  }
}

function assertIescOk(value: unknown, label: string) {
  const code = iescData(value)?.rtnCode;
  if (code !== "S") {
    throw new Error(`E.SUN card ${label} failed (${code ?? "unknown"}).`);
  }
}

function portalData<T>(value: unknown) {
  const envelope = value as PortalEnvelope<T>;
  return envelope.resultCode === "0000" ? envelope.resultBody : undefined;
}

function iescData<T extends IescCardBody = IescCardBody>(value: unknown) {
  return (value as IescEnvelope<T>).body;
}

function numberOrUndefined(value: number | string | null | undefined) {
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const parsed = Number(value.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseFlexibleDate(value: string | undefined) {
  if (!value) return undefined;
  const iso = value.trim().match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const roc = value.trim().match(/^0?(\d{3})(\d{2})(\d{2})$/);
  if (!roc) return undefined;
  return `${Number(roc[1]) + 1911}-${roc[2]}-${roc[3]}`;
}

function parseBillPeriod(value: string | null) {
  const digits = value?.replace(/\D/g, "") ?? "";
  if (digits.length === 6 && Number(digits.slice(0, 4)) > 1911) {
    return `${digits.slice(0, 4)}-${digits.slice(4)}`;
  }
  if (digits.length === 5) {
    return `${Number(digits.slice(0, 3)) + 1911}-${digits.slice(3)}`;
  }
  return undefined;
}
