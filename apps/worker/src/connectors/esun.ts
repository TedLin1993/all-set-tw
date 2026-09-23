import { launchBrowserWithRetry } from "./browser.js";
import {
  buildEsunCreditTimelinePages,
  collectEsunBrowserSnapshot,
  collectEsunSnapshot,
  esunCardNumbers,
  readEsunCardBalances,
  type EsunBrowserSession,
  type EsunDepositDetail,
  type EsunPortalApi,
  type EsunSnapshot,
} from "./esun-portal.js";
import { type Page } from "@cloudflare/puppeteer";
import type {
  BankAccount,
  BankBalanceSnapshot,
  BankTransaction,
  CreditCardBill,
  SyncResult,
} from "@taiwan-fin-hub/core";
import { BANK_SYNC_MONTHS, type EsunConfig } from "@taiwan-fin-hub/connectors";

const HOME_URL = "https://ebank.esunbank.com.tw/indexMobile.jsp";
const PORTAL_URL = "https://ebank.esunbank.com.tw/esb/";

function maskAccountNumber(value: string) {
  const suffix = value.slice(-4);
  return suffix ? `***${suffix}` : "***";
}

function endpointPath(value: string) {
  try {
    return new URL(value).pathname;
  } catch {
    return "unknown";
  }
}

export function createEsunConnector(browser?: Fetcher) {
  return {
    id: "esun" as const,
    name: "E.SUN Bank 玉山銀行",

    async sync(
      config: EsunConfig,
      cursor?: string,
    ): Promise<SyncResult<never>> {
      if (!config.userId || !config.account || !config.password) {
        throw new Error(
          "E.SUN Bank requires userId (身分證字號), account (使用者名稱), and password.",
        );
      }

      const client = new EsunHttpClient();

      if (
        config.sessionCookies &&
        config.sessionExpiresAt &&
        new Date(config.sessionExpiresAt) > new Date()
      ) {
        client.importCookies(config.sessionCookies);
      }

      if (!(await client.hasAuthenticatedSession())) {
        if (!browser) {
          throw new Error(
            "E.SUN Bank requires the BROWSER binding for interactive login.",
          );
        }
        await loginWithBrowser(browser, client, config);
      }

      const cursorState = readCursor(cursor);
      const depositWatermarks: Record<string, string> = {};

      console.log("[esun debug] scraping credit cards");
      const creditCards = await scrapeCreditCards(client);
      console.log("[esun debug] scraping deposit accounts");
      const deposits = await scrapeDepositAccounts(client, depositWatermarks);
      const freshCookies = client.exportCookies();
      const expiresAt = new Date(Date.now() + 25 * 60 * 1000).toISOString();

      return {
        records: [],
        bankAccounts: [...creditCards.bankAccounts, ...deposits.bankAccounts],
        bankBalanceSnapshots: [
          ...creditCards.bankBalanceSnapshots,
          ...deposits.bankBalanceSnapshots,
        ],
        bankTransactions: [
          ...creditCards.bankTransactions,
          ...deposits.bankTransactions,
        ],
        creditCardBills: creditCards.creditCardBills,
        cursor: JSON.stringify({
          ...cursorState,
          sessionCookies: freshCookies,
          sessionExpiresAt: expiresAt,
          depositWatermarks: undefined,
          syncedAt: new Date().toISOString(),
        }),
      };
    },
  };
}

async function loginWithBrowser(
  browserBinding: Fetcher,
  client: EsunHttpClient,
  config: EsunConfig,
) {
  console.log("[esun debug] launching browser");
  const browser = await launchBrowserWithRetry(browserBinding);
  const page = await browser.newPage();
  let txnDupToken: string | undefined;

  try {
    page.on("response", (response) => {
      const token = response.headers().txnduptoken;
      if (token) txnDupToken = token;
    });
    await page.setViewport({ width: 390, height: 844, isMobile: true });
    await page.setUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/147.0.0.0 Mobile/15E148 Safari/604.1",
    );
    console.log(`[esun debug] navigating to ${PORTAL_URL}`);
    await page.goto(PORTAL_URL, { waitUntil: "networkidle0", timeout: 30000 });
    console.log("[esun debug] login page opened");
    await loginMobilePage(page, config);
    console.log("[esun debug] login succeeded, collecting account data");
    const collected = await collectEsunBrowserSnapshot(browser, page);
    client.snapshot = collected.snapshot;
    client.rememberBrowserSession(collected.session);
    if (txnDupToken) {
      client.setTxnDupToken(txnDupToken);
    }
    console.log("[esun debug] browser login complete");
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "esun_browser_login_failed",
        errorType: error instanceof Error ? error.name : "UNKNOWN_ERROR",
      }),
    );
    throw error;
  } finally {
    await browser.close();
  }
}

async function loginMobilePage(page: Page, config: EsunConfig) {
  await page.waitForSelector('input[name="id"]', { timeout: 30000 });
  await page.type('input[name="id"]', config.userId!.toUpperCase());
  await page.type('input[name="userName"]', config.account!);
  await page.type('input[name="pxssword"]', config.password!);

  const loginResponse = page.waitForResponse(
    (response) => response.url().includes("/cpo08/cpo08001/home/doAction"),
    { timeout: 30000 },
  );
  await page.click("button.btn-main-fill");
  await page
    .waitForFunction(
      () => document.querySelectorAll(".input-error-message").length > 0,
      { timeout: 1000 },
    )
    .catch(() => undefined);
  const validationErrors = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".input-error-message"))
      .map((element) => element.textContent?.trim())
      .filter(Boolean),
  );
  if (validationErrors.length > 0) {
    throw new Error(`E.SUN portal login form: ${validationErrors.join(" ")}`);
  }
  const response = await loginResponse;
  let result = (await response.json()) as { resultCode?: string };
  if (result.resultCode === "9005") {
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll("button")).some(
          (button) => button.textContent?.trim() === "確定登入",
        ),
      { timeout: 5000 },
    );
    const retryResponse = page.waitForResponse(
      (response) => response.url().includes("/cpo08/cpo08001/home/doAction"),
      { timeout: 30000 },
    );
    await page.evaluate(() => {
      const button = Array.from(document.querySelectorAll("button")).find(
        (button) => button.textContent?.trim() === "確定登入",
      );
      button?.click();
    });
    result = (await (await retryResponse).json()) as { resultCode?: string };
  }
  console.log(
    `[esun debug] portal login result=${result.resultCode ?? "missing"}`,
  );
  if (result.resultCode !== "0000") {
    throw new Error(
      `E.SUN portal login failed (${result.resultCode ?? "unknown"}).`,
    );
  }
}

type Scraped = {
  bankAccounts: Array<Omit<BankAccount, "id" | "connectorId">>;
  bankBalanceSnapshots: Array<Omit<BankBalanceSnapshot, "id" | "connectorId">>;
  bankTransactions: Array<Omit<BankTransaction, "id" | "connectorId">>;
  creditCardBills: Array<Omit<CreditCardBill, "id" | "connectorId">>;
};

interface EsunApiResponse<T> {
  rsStatus?: {
    code?: string | null;
    message?: string | null;
  } | null;
  rsData?: T | null;
}

interface EsunApiStatus {
  code?: string | null;
  message?: string | null;
}

interface EsunMobileAesData {
  publickey?: string | null;
  iv?: string | null;
  factory?: string | null;
}

interface EsunMobileE2EData {
  enable?: boolean | null;
  publickey?: string | null;
  timefactor?: string | null;
}

interface EsunMobileLoginInitData {
  txn?: string | null;
  params?: unknown;
}

interface EsunMobileLoginData {
  targetTaskId?: string | null;
  releaseNo?: string | null;
  keepCust?: string | null;
  custCode?: string | null;
}

export interface EsunTimelineTransaction {
  payCur?: string | null;
  payAmt?: string | null;
  storeName?: string | null;
  consumerDt?: string | null;
  consumerCur?: string | null;
  consumerAmt?: string | null;
  postingDt?: string | null;
  cardNo?: string | null;
  cardNoDesc?: string | null;
  cardType?: string | null;
  acfg?: string | null;
  consumerTime?: string | null;
  esunFeed?: "realtime" | "history";
}

export interface EsunTimelineMonth {
  year?: string | null;
  month?: string | null;
  txnList?: EsunTimelineTransaction[] | null;
}

export interface EsunTimelinePage {
  timelineList: EsunTimelineMonth[];
  startDate?: string;
  endDate?: string;
}

type EsunTimelineCandidate = {
  transaction: EsunTimelineTransaction;
  timelinePage: EsunTimelinePage;
  timelineMonth: EsunTimelineMonth;
  accountId: string;
  authorizedAt: string;
  postedDate?: string;
  amount: number;
  currency: string;
  description: string;
  sourceKey: string;
  lifecycle: string;
  status: "pending" | "posted";
  order: number;
};

function withPendingConsumerTime(
  posted: EsunTimelineCandidate,
  pending: EsunTimelineCandidate | undefined,
): EsunTimelineCandidate {
  const consumerTime =
    posted.transaction.consumerTime ?? pending?.transaction.consumerTime;
  if (!consumerTime || posted.transaction.consumerTime) return posted;
  return {
    ...posted,
    transaction: { ...posted.transaction, consumerTime },
  };
}

function esunTimelineAuthorizedAt(candidate: EsunTimelineCandidate) {
  const clock = candidate.transaction.consumerTime?.trim();
  if (!clock) return candidate.authorizedAt;
  return (
    normalizeEsunAuthorizedAt(candidate.authorizedAt, clock) ??
    candidate.authorizedAt
  );
}

function mergeEsunLifecycleGroup(group: EsunTimelineCandidate[]) {
  const posted = group.filter(({ lifecycle }) => lifecycle === "已入帳");
  const pending = group.filter(({ lifecycle }) => lifecycle === "未入帳");
  const other = group.filter(
    ({ lifecycle }) => lifecycle !== "已入帳" && lifecycle !== "未入帳",
  );
  if (posted.length === 0 || pending.length === 0) return group;
  return [
    ...posted.map((item, index) =>
      withPendingConsumerTime(item, pending[index]),
    ),
    ...pending.slice(posted.length),
    ...other,
  ];
}

export function normalizeEsunTimelineTransactions(
  pages: EsunTimelinePage[],
): Array<Omit<BankTransaction, "id" | "connectorId">> {
  const candidates: EsunTimelineCandidate[] = [];

  for (const timelinePage of pages) {
    for (const month of timelinePage.timelineList) {
      const year = month.year?.trim();
      if (!year) continue;

      for (const txn of month.txnList ?? []) {
        const lifecycle = txn.acfg?.trim() ?? "";
        // Keep the legacy normalized value in the identity key.  The public
        // authorizedAt value may now be date-only, but changing this key
        // would turn every existing card transaction into a new row.
        const identityAuthorizedAt = normalizeEsunMonthDay(
          year,
          txn.consumerDt ?? txn.postingDt ?? "",
        );
        const authorizedAt = identityAuthorizedAt.slice(0, 10);
        const postedDate =
          lifecycle === "未入帳"
            ? undefined
            : normalizeEsunMonthDay(
                year,
                txn.postingDt ?? txn.consumerDt ?? "",
              );
        const rawAmount = parseTwd(txn.payAmt ?? txn.consumerAmt ?? "0");
        const currency = txn.payCur?.trim() || txn.consumerCur?.trim() || "TWD";
        const description = txn.storeName?.trim() || "玉山信用卡交易";
        const amount = signedCreditCardAmount(rawAmount, description);
        const accountId = creditCardSourceId(txn.cardNo);
        const sourceKey = [
          identityAuthorizedAt,
          accountId,
          description,
          rawAmount,
          currency,
        ].join(":");
        candidates.push({
          transaction: txn,
          timelinePage,
          timelineMonth: month,
          accountId,
          authorizedAt,
          postedDate,
          amount,
          currency,
          description,
          sourceKey,
          lifecycle,
          status: lifecycle === "未入帳" ? "pending" : "posted",
          order: candidates.length,
        });
      }
    }
  }

  const candidatesBySourceKey = new Map<string, EsunTimelineCandidate[]>();
  for (const candidate of candidates) {
    const group = candidatesBySourceKey.get(candidate.sourceKey) ?? [];
    group.push(candidate);
    candidatesBySourceKey.set(candidate.sourceKey, group);
  }

  const selected = Array.from(candidatesBySourceKey.values()).flatMap(
    (group) => {
      const realtime = group.filter(
        ({ transaction }) => transaction.esunFeed === "realtime",
      );
      const history = mergeEsunLifecycleGroup(
        group.filter(({ transaction }) => transaction.esunFeed !== "realtime"),
      );
      return [
        ...history.map((item, index) =>
          withPendingConsumerTime(item, realtime[index]),
        ),
        ...realtime.slice(history.length),
      ];
    },
  );
  selected.sort((left, right) => left.order - right.order);

  const sourceIdOccurrences = new Map<string, number>();
  return selected.map((candidate) => {
    const occurrence = (sourceIdOccurrences.get(candidate.sourceKey) ?? 0) + 1;
    sourceIdOccurrences.set(candidate.sourceKey, occurrence);
    return {
      accountId: candidate.accountId,
      sourceId: `${candidate.sourceKey}:${occurrence}`,
      postedDate: candidate.postedDate,
      authorizedAt: esunTimelineAuthorizedAt(candidate),
      amount: candidate.amount,
      currency: candidate.currency,
      description: candidate.description,
      counterparty: candidate.description,
      status: candidate.status,
      raw: {
        ...candidate.transaction,
        timelineYear: candidate.timelineMonth.year,
        timelineMonth: candidate.timelineMonth.month,
        timelineStartDate: candidate.timelinePage.startDate,
        timelineEndDate: candidate.timelinePage.endDate,
        duplicateOccurrence: occurrence,
      },
    };
  });
}

async function scrapeCreditCards(client: EsunHttpClient): Promise<Scraped> {
  const snapshot = requiredSnapshot(client);
  const asOfAt = new Date().toISOString();
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - BANK_SYNC_MONTHS);
  const scrapedTransactions = normalizeEsunTimelineTransactions(
    buildEsunCreditTimelinePages(snapshot),
  ).filter((transaction) => {
    const timestamp = transaction.authorizedAt ?? transaction.postedDate;
    if (!timestamp) return true;
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) || date >= cutoffDate;
  });
  const mainSourceId = "credit:esun:main";
  const physicalCardSourceIds = new Set([
    ...esunCardNumbers(snapshot).map((cardNo) => creditCardSourceId(cardNo)),
    ...scrapedTransactions
      .map((transaction) => transaction.accountId)
      .filter((accountId) => accountId !== mainSourceId),
  ]);
  const balanceAccountId = esunCreditBalanceAccountId(physicalCardSourceIds);
  const bankTransactions = scrapedTransactions.map((transaction) =>
    transaction.accountId === mainSourceId && balanceAccountId !== mainSourceId
      ? { ...transaction, accountId: balanceAccountId }
      : transaction,
  );
  const accountIds = new Set<string>([
    ...physicalCardSourceIds,
    ...bankTransactions.map((transaction) => transaction.accountId),
  ]);
  accountIds.delete("");
  accountIds.add(balanceAccountId);

  const balances = readEsunCardBalances(snapshot);
  const bankAccounts: Scraped["bankAccounts"] = Array.from(accountIds).map(
    (sourceId) => ({
      sourceId,
      institutionName: "玉山銀行",
      accountName:
        sourceId === mainSourceId
          ? "玉山信用卡"
          : `玉山信用卡 ${sourceId.slice(-4)}`,
      accountType: "credit",
      currency: balances.currency || "TWD",
    }),
  );
  const bankBalanceSnapshots: Scraped["bankBalanceSnapshots"] = [
    {
      accountId: balanceAccountId,
      sourceId: `${balanceAccountId}:${asOfAt}`,
      balance: -balances.outstanding,
      statementBalance: balances.statementBalance,
      paymentDueDate: balances.paymentDueDate,
      statementClosingDate: balances.statementClosingDate,
      noPaymentNeeded: balances.outstanding === 0,
      currency: balances.currency || "TWD",
      asOfAt,
    },
  ];
  const creditCardBills: Scraped["creditCardBills"] = balances.billingPeriod
    ? [
        {
          accountId: balanceAccountId,
          sourceId: `${balanceAccountId}:bill:${balances.billingPeriod}`,
          billingPeriod: balances.billingPeriod,
          statementAmount: balances.statementBalance,
          minimumPayment: balances.minimumPayment,
          isPaid: balances.isPaid,
          paymentDueDate: balances.paymentDueDate,
          statementClosingDate: balances.statementClosingDate,
          currency: balances.currency || "TWD",
        },
      ]
    : [];

  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions,
    creditCardBills,
  };
}

function requiredSnapshot(client: EsunHttpClient) {
  if (!client.snapshot) {
    throw new Error("E.SUN sync did not collect account data.");
  }
  return client.snapshot;
}

async function scrapeDepositAccounts(
  client: EsunHttpClient,
  watermarks: Record<string, string>,
): Promise<Scraped & { watermarks: Record<string, string> }> {
  const snapshot = requiredSnapshot(client);
  const cutoffDate = new Date();
  cutoffDate.setMonth(cutoffDate.getMonth() - BANK_SYNC_MONTHS);
  const cutoffDateStr = cutoffDate
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "/");
  const asOfAt = new Date().toISOString();
  const bankAccounts: Scraped["bankAccounts"] = [];
  const bankBalanceSnapshots: Scraped["bankBalanceSnapshots"] = [];
  const bankTransactions: Scraped["bankTransactions"] = [];
  const newWatermarks: Record<string, string> = {};

  const addAccount = (
    account: EsunSnapshot["twDeposits"][number],
    foreign: boolean,
  ) => {
    const accountId = foreign
      ? depositSourceId(account.accountNo, account.currency)
      : depositSourceId(account.accountNo);
    bankAccounts.push({
      sourceId: accountId,
      institutionName: "玉山銀行",
      accountName:
        account.alias ||
        (foreign ? `玉山外幣帳戶 (${account.currency})` : "玉山臺幣帳戶"),
      accountType: "savings",
      currency: account.currency,
    });
    bankBalanceSnapshots.push({
      accountId,
      sourceId: `${accountId}:${asOfAt}`,
      balance: account.balance,
      currency: account.currency,
      asOfAt,
    });
    const rows = toEsunTxDetailRows(account.transactions).filter((detail) => {
      const dateStr = detail.txDate?.trim().replace(/-/g, "/") ?? "";
      if (dateStr && dateStr < cutoffDateStr) return false;
      const watermark = watermarks[account.accountNo];
      return !watermark || txDateTimeKey(detail) > watermark;
    });
    console.log(
      `[esun debug] deposit ${maskAccountNumber(account.accountNo)} ${account.currency}: ${rows.length} rows`,
    );
    appendEsunDepositTransactions(
      bankTransactions,
      rows,
      accountId,
      account.currency,
    );
    newWatermarks[account.accountNo] = watermarks[account.accountNo];
  };

  for (const account of snapshot.twDeposits) addAccount(account, false);
  for (const account of snapshot.frDeposits) addAccount(account, true);

  return {
    bankAccounts,
    bankBalanceSnapshots,
    bankTransactions,
    creditCardBills: [],
    watermarks: newWatermarks,
  };
}

interface EsunTxDetailRow {
  txDate?: string | null;
  txTime?: string | null;
  chc?: string | null;
  amt?: string | null;
  balance?: string | null;
  memo1?: string | null;
  memo2?: string | null;
  showDbFlag?: string | null;
  showCrFlag?: string | null;
  displayCurrency?: string | null;
}

function toEsunTxDetailRows(details: EsunDepositDetail[]): EsunTxDetailRow[] {
  return details.map((detail) => {
    const credit = detail.debitCredit?.toUpperCase() === "CR";
    const amount = String(detail.amount ?? "0").replace(/^-/, "");
    return {
      txDate: detail.txDate,
      txTime: detail.txTime,
      chc: detail.detailTitle,
      amt: amount,
      balance: detail.balance == null ? undefined : String(detail.balance),
      memo1: detail.passbookRemark,
      showCrFlag: credit ? "show" : "hide",
      showDbFlag: credit ? "hide" : "show",
      displayCurrency: detail.currency,
    };
  });
}

export function appendEsunDepositTransactions(
  target: Scraped["bankTransactions"],
  rows: EsunTxDetailRow[],
  accountId: string,
  defaultCurrency: string,
) {
  const occurrences = new Map<string, number>();

  for (const detail of rows) {
    const postedDate = normalizeEsunTxDateTime(detail.txDate, detail.txTime);
    const authorizedAt = normalizeEsunAuthorizedAt(
      detail.txDate,
      detail.txTime,
    );
    const isCredit = detail.showCrFlag !== "hide";
    const amount = parseTwd(detail.amt ?? "0") * (isCredit ? 1 : -1);
    const description = detail.chc?.trim() || "玉山銀行交易";
    const counterparty = detail.memo1?.trim() || description;
    const sourceKey = [
      postedDate,
      accountId,
      description,
      amount,
      detail.balance?.trim() ?? "",
      detail.memo1?.trim() ?? "",
      detail.memo2?.trim() ?? "",
    ].join(":");
    const occurrence = (occurrences.get(sourceKey) ?? 0) + 1;
    occurrences.set(sourceKey, occurrence);

    target.push({
      accountId,
      sourceId: `${sourceKey}:${occurrence}`,
      postedDate,
      authorizedAt,
      amount,
      currency: detail.displayCurrency?.trim() || defaultCurrency,
      description,
      counterparty,
      raw: { ...detail, duplicateOccurrence: occurrence },
    });
  }
}

function depositSourceId(account: string, currency?: string) {
  return currency ? `bank:esun:${account}:${currency}` : `bank:esun:${account}`;
}

function txDateTimeKey(detail: EsunTxDetailRow) {
  return `${detail.txDate ?? ""} ${detail.txTime ?? ""}`;
}

function normalizeEsunTxDateTime(
  txDate: string | null | undefined,
  txTime: string | null | undefined,
) {
  const date = txDate?.trim().replace(/\//g, "-") || "";
  const time = txTime?.trim() || "00:00:00";
  return `${date}T${time}.000Z`;
}

/**
 * Normalizes the source's local Taiwan transaction time for display.
 *
 * `postedDate` and its source key intentionally keep the legacy `.000Z`
 * representation above so a parser precision upgrade cannot create rows.
 * A missing or malformed time therefore remains a date-only authorizedAt.
 */
export function normalizeEsunAuthorizedAt(
  txDate: string | null | undefined,
  txTime: string | null | undefined,
): string | undefined {
  const date = normalizeEsunDate(txDate);
  if (!date) return undefined;

  const time = txTime?.trim();
  if (!time) return date;

  const match = time.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/);
  if (!match) return date;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3] ?? "0");
  if (hours > 23 || minutes > 59 || seconds > 59) {
    return date;
  }

  const fraction = match[4] ? `.${match[4].padEnd(3, "0")}` : "";
  return `${date}T${String(hours).padStart(2, "0")}:${match[2]}:${String(seconds).padStart(2, "0")}${fraction}+08:00`;
}

function normalizeEsunDate(
  value: string | null | undefined,
): string | undefined {
  const date = value?.trim().replace(/\//g, "-") ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().startsWith(date)
    ? date
    : undefined;
}

function parseTwd(text: string): number {
  const n = Number(text.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function signedCreditCardAmount(rawAmount: number, description: string) {
  const isCredit =
    rawAmount < 0 ||
    /退款|退貨|折抵|折讓|回饋|沖銷|貸方|繳款|自動轉帳扣繳|refund|credit|payment/i.test(
      description,
    );
  return isCredit ? Math.abs(rawAmount) : -Math.abs(rawAmount);
}

function creditCardSourceId(cardNo: string | null | undefined) {
  const last4 = cardNo?.match(/(\d{4})$/)?.[1];
  return last4 ? `credit:esun:${last4}` : "credit:esun:main";
}

export function esunCreditBalanceAccountId(
  physicalCardSourceIds: Iterable<string>,
) {
  const accountIds = [
    ...new Set(
      [...physicalCardSourceIds].filter(
        (accountId) => accountId !== "credit:esun:main",
      ),
    ),
  ];
  return accountIds.length === 1 ? accountIds[0]! : "credit:esun:main";
}

function normalizeEsunMonthDay(year: string, monthDay: string) {
  const match = monthDay
    .trim()
    .replace(/\./g, "/")
    .match(/^(\d{1,2})\/(\d{1,2})$/);
  if (!match) return monthDay;

  const fullYear = year.length === 3 ? Number(year) + 1911 : Number(year);
  const month = match[1].padStart(2, "0");
  const day = match[2].padStart(2, "0");
  return `${fullYear}-${month}-${day}T00:00:00.000Z`;
}

function readCursor(cursor: string | undefined): Record<string, unknown> {
  if (!cursor) return {};
  try {
    return JSON.parse(cursor) as Record<string, unknown>;
  } catch {
    return {};
  }
}

class EsunHttpClient implements EsunPortalApi {
  snapshot: EsunSnapshot | null = null;
  private readonly cookies = new Map<
    string,
    EsunBrowserSession["cookies"][number]
  >();
  private txnDupToken: string | undefined;
  private portalUuid: string | undefined;
  private iescAccessToken: string | undefined;
  private iescRealtimeBody = "{}";
  private portalFlowToken = "";

  rememberBrowserSession(session: EsunBrowserSession) {
    this.cookies.clear();
    for (const cookie of session.cookies) this.storeCookie(cookie);
    this.portalUuid = session.portalUuid;
    this.iescAccessToken = session.iescAccessToken;
    this.iescRealtimeBody = session.iescRealtimeBody || "{}";
    this.portalFlowToken = "";
  }

  importCookies(serialized: string) {
    try {
      const parsed = JSON.parse(serialized) as unknown;
      if (Array.isArray(parsed)) {
        for (const cookie of parsed) {
          const record = readStoredCookie(cookie);
          if (record) this.storeCookie(record);
        }
        return;
      }

      if (!parsed || typeof parsed !== "object") return;
      const session = parsed as Partial<EsunBrowserSession> & {
        version?: number;
      };
      if (Array.isArray(session.cookies)) {
        for (const cookie of session.cookies) {
          const record = readStoredCookie(cookie);
          if (record) this.storeCookie(record);
        }
        if (typeof session.portalUuid === "string") {
          this.portalUuid = session.portalUuid;
        }
        if (typeof session.iescAccessToken === "string") {
          this.iescAccessToken = session.iescAccessToken;
        }
        if (typeof session.iescRealtimeBody === "string") {
          this.iescRealtimeBody = session.iescRealtimeBody;
        }
        return;
      }

      for (const [name, value] of Object.entries(parsed)) {
        if (typeof value === "string") {
          this.storeCookie({
            name,
            value,
            domain: "ebank.esunbank.com.tw",
            path: "/",
          });
        }
      }
    } catch {
      // Ignore stale or malformed stored cookies; login will refresh them.
    }
  }

  exportCookies() {
    return JSON.stringify({
      version: 2,
      cookies: Array.from(this.cookies.values()),
      portalUuid: this.portalUuid,
      iescAccessToken: this.iescAccessToken,
      iescRealtimeBody: this.iescRealtimeBody,
    });
  }

  setTxnDupToken(token: string) {
    this.txnDupToken = token;
  }

  async hasAuthenticatedSession() {
    if (!this.portalUuid || !this.iescAccessToken || this.cookies.size === 0) {
      console.log(
        "[esun debug] hasAuthenticatedSession: no stored portal session, will log in",
      );
      return false;
    }
    try {
      this.snapshot = await collectEsunSnapshot(this);
      console.log(
        "[esun debug] hasAuthenticatedSession: stored session still valid",
      );
      return true;
    } catch (error) {
      this.snapshot = null;
      console.log(
        `[esun debug] hasAuthenticatedSession: stored session invalid (${error instanceof Error ? error.name : "UNKNOWN_ERROR"}), will log in`,
      );
      return false;
    }
  }

  async postPortal(
    path: string,
    requestBody: Record<string, unknown>,
    resetFlow = false,
  ) {
    if (resetFlow) this.portalFlowToken = "";
    const txnTime = new Date(Date.now() + 28800000)
      .toISOString()
      .replace("T", " ")
      .slice(0, 19);
    const response = await this.requestJson<{
      resultCode?: string;
      resultBody?: unknown;
      txnFlowToken?: string;
    }>(new URL(path, PORTAL_URL).toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        referer: PORTAL_URL,
        uniqueKey: this.portalUuid ?? "",
      },
      body: JSON.stringify({
        header: {
          txnTime,
          txnFlowToken: resetFlow ? "" : this.portalFlowToken,
        },
        requestBody,
      }),
    });
    if (response.txnFlowToken) this.portalFlowToken = response.txnFlowToken;
    return response;
  }

  async postIesc(path: string, body: Record<string, unknown>) {
    const response = await this.request(
      `https://iesc.esunbank.com/GW/${path}`,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          referer: "https://iesc.esunbank.com/IESC/cardTrans?tab=credit",
          authorization: `Bearer ${this.iescAccessToken ?? ""}`,
        },
        body: JSON.stringify(body),
      },
    );
    const authorization = response.headers.get("authorization");
    if (authorization) {
      this.iescAccessToken = authorization.replace(/^Bearer\s+/i, "");
    }
    return response.json();
  }

  async readRealtime() {
    let body: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(this.iescRealtimeBody) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>;
      }
    } catch {
      body = {};
    }
    return {
      body: this.iescRealtimeBody,
      payload: await this.postIesc("realTime/getDetailResult", body),
    };
  }

  private storeCookie(cookie: EsunBrowserSession["cookies"][number]) {
    this.cookies.set(`${cookie.domain}|${cookie.name}`, cookie);
  }

  async login(config: EsunConfig) {
    await this.requestText(HOME_URL);
    const initData = await this.postMobileJson<EsunMobileLoginInitData>(
      "fco08/fco08001/home/initData.json",
      {},
    );
    const aesData =
      await this.getMobileJson<EsunMobileAesData>("sys/loadAesData.do");
    const e2eData =
      await this.getMobileJson<EsunMobileE2EData>("sys/loadE2EData.do");

    if (
      !aesData.publickey ||
      !aesData.iv ||
      !aesData.factory ||
      !e2eData.publickey ||
      !e2eData.timefactor
    ) {
      throw new Error(
        "E.SUN mobile login did not return expected encryption fields.",
      );
    }

    const payload = {
      custid: config.userId!.toUpperCase(),
      name: await encryptEsunUsername(
        config.account!,
        aesData.publickey,
        aesData.iv,
        aesData.factory,
      ),
      pxsswd: encryptEsunPassword(
        config.password!,
        e2eData.timefactor,
        e2eData.publickey,
      ),
      magicNumber: "",
      loginType: "GENERAL",
      srcChannel: "MB",
      targetTaskId: initData.txn ?? undefined,
    };

    let loginResponse = await this.postMobileEnvelope<EsunMobileLoginData>(
      "fco08/fco08001/home/FCO08001_LoginCheck.do",
      payload,
    );
    if (loginResponse.rsStatus?.code === "9017") {
      loginResponse = await this.postMobileEnvelope<EsunMobileLoginData>(
        "fco08/fco08001/home/FCO08001_LoginCheck.do",
        {
          ...payload,
          duplicateLogin: "Y",
        },
      );
    }

    this.assertOkStatus(loginResponse.rsStatus, "E.SUN mobile API");
    const loginData = (loginResponse.rsData ?? {}) as EsunMobileLoginData;

    if (!loginData.targetTaskId && this.cookies.size === 0) {
      throw new Error("E.SUN mobile login did not establish a session.");
    }
  }

  async postJson<T>(
    url: string,
    rqData: Record<string, unknown> | null,
  ): Promise<T> {
    const response = await this.requestJson<EsunApiResponse<T>>(url, {
      method: "POST",
      headers: {
        accept: "application/json, text/javascript, */*; q=0.01",
        "content-type": "application/json",
        referer: "https://ebank.esunbank.com.tw/indexMobile.jsp",
        txnduptoken: this.txnDupToken ?? "",
        "x-requested-with": "XMLHttpRequest",
      },
      body: JSON.stringify({
        clientTime: Date.now(),
        rqData,
      }),
    });

    if (response.rsStatus?.code === "3018") {
      console.log(
        `[esun debug] ${endpointPath(url)} returned 3018 (no data), treating as empty result`,
      );
      return {} as T;
    }

    if (response.rsStatus?.code && response.rsStatus.code !== "0000") {
      console.error(
        JSON.stringify({
          event: "esun_api_error",
          endpoint: endpointPath(url),
          code: response.rsStatus.code,
        }),
      );
      throw new Error(`E.SUN API error ${response.rsStatus.code}.`);
    }

    return (response.rsData ?? {}) as T;
  }

  async getMobileJson<T>(path: string): Promise<T> {
    return this.mobileRequest<T>(path, { method: "GET" });
  }

  async postMobileJson<T>(
    path: string,
    rqData: Record<string, unknown>,
  ): Promise<T> {
    const response = await this.postMobileEnvelope<T>(path, rqData);
    this.assertOkStatus(response.rsStatus, "E.SUN mobile API");
    return (response.rsData ?? {}) as T;
  }

  async postMobileEnvelope<T>(
    path: string,
    rqData: Record<string, unknown>,
  ): Promise<EsunApiResponse<T>> {
    return this.mobileEnvelope<T>(path, {
      method: "POST",
      body: JSON.stringify({
        clientTime: Date.now(),
        rqData,
      }),
    });
  }

  private async mobileRequest<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.mobileEnvelope<T>(path, init);
    this.assertOkStatus(response.rsStatus, "E.SUN mobile API");

    return (response.rsData ?? {}) as T;
  }

  private async mobileEnvelope<T>(
    path: string,
    init: RequestInit,
  ): Promise<EsunApiResponse<T>> {
    return this.requestJson<EsunApiResponse<T>>(
      new URL(path, HOME_URL).toString(),
      {
        ...init,
        headers: {
          accept: "application/json, text/javascript, */*; q=0.01",
          "content-type": "application/json",
          referer: "https://ebank.esunbank.com.tw/indexMobile.jsp",
          txnduptoken: this.txnDupToken ?? "",
          "x-requested-with": "XMLHttpRequest",
          ...init.headers,
        },
      },
    );
  }

  private async requestJson<T>(url: string, init: RequestInit = {}) {
    const response = await this.request(url, init);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("json")) {
      throw new Error(
        `E.SUN expected JSON from ${endpointPath(url)}, got ${contentType || "unknown content type"}.`,
      );
    }
    return (await response.json()) as T;
  }

  private async requestText(url: string, init: RequestInit = {}) {
    const response = await this.request(url, init);
    return response.text();
  }

  private async request(
    url: string,
    init: RequestInit = {},
    redirectCount = 0,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set(
      "user-agent",
      "Mozilla/5.0 AppleWebKit/537.36 Chrome/147 Safari/537.36",
    );
    headers.set("accept-language", "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7");
    if (this.cookies.size > 0) {
      headers.set("cookie", this.cookieHeader(url));
    }

    const response = await fetch(url, {
      ...init,
      headers,
      redirect: "manual",
    });
    this.storeSetCookies(response.headers, url);
    const txnDupToken = response.headers.get("txnduptoken");
    if (txnDupToken) {
      this.txnDupToken = txnDupToken;
    }

    if (isRedirect(response.status)) {
      if (redirectCount >= 5) {
        throw new Error("E.SUN login redirected too many times.");
      }
      const location = response.headers.get("location");
      if (!location) return response;
      return this.request(
        new URL(location, url).toString(),
        { method: "GET" },
        redirectCount + 1,
      );
    }

    if (!response.ok) {
      throw new Error(`E.SUN request failed with HTTP ${response.status}`);
    }

    return response;
  }

  private cookieHeader(url: string) {
    const host = new URL(url).hostname;
    return Array.from(this.cookies.values())
      .filter((cookie) => host.endsWith(cookie.domain.replace(/^\./, "")))
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  private storeSetCookies(headers: Headers, url: string) {
    const host = new URL(url).hostname;
    const values = getSetCookieValues(headers);
    for (const value of values) {
      const [pair] = value.split(";");
      const separator = pair.indexOf("=");
      if (separator <= 0) continue;
      const name = pair.slice(0, separator).trim();
      const cookieValue = pair.slice(separator + 1).trim();
      const existing = Array.from(this.cookies.values()).find(
        (cookie) =>
          cookie.name === name &&
          host.endsWith(cookie.domain.replace(/^\./, "")),
      );
      const key = `${existing?.domain || host}|${name}`;
      if (cookieValue) {
        this.cookies.set(key, {
          name,
          value: cookieValue,
          domain: existing?.domain || host,
          path: existing?.path || "/",
        });
      } else {
        this.cookies.delete(key);
      }
    }
  }

  private assertOkStatus(
    status: EsunApiStatus | null | undefined,
    label: string,
  ) {
    if (status?.code && status.code !== "0000") {
      throw new Error(
        `${label} error ${status.code}: ${status.message ?? ""}`.trim(),
      );
    }
  }
}

async function encryptEsunUsername(
  username: string,
  base64Key: string,
  base64Iv: string,
  factory: string,
) {
  const key = base64ToBytes(base64Key);
  const iv = base64ToBytes(base64Iv);
  const encrypted = Buffer.from(
    await aesCbcPkcs7Encrypt(username, key, iv),
  ).toString("base64");
  return `${encrypted}__${factory}`;
}

function encryptEsunPassword(
  password: string,
  serverTime: string,
  publicKey: string,
) {
  const payload = `${password}${serverTime}`;
  const encrypted = rsaPkcs1v15Encrypt(
    publicKey,
    new TextEncoder().encode(payload),
  );
  return `${password.length},${encrypted.toString("base64")}`;
}

async function aesCbcPkcs7Encrypt(
  value: string,
  key: Uint8Array<ArrayBuffer>,
  iv: Uint8Array<ArrayBuffer>,
) {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    key.buffer,
    "AES-CBC",
    false,
    ["encrypt"],
  );
  return crypto.subtle.encrypt(
    {
      name: "AES-CBC",
      iv,
    },
    cryptoKey,
    new TextEncoder().encode(value),
  );
}

function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const buffer = Buffer.from(value, "base64");
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return copy;
}

function rsaPkcs1v15Encrypt(publicKeyPem: string, message: Uint8Array) {
  const key = parseRsaPublicKey(publicKeyPem);
  const keyLength = Math.ceil(byteLength(key.modulus) / 8);
  if (message.byteLength > keyLength - 11) {
    throw new Error("E.SUN RSA login payload is too long.");
  }

  const paddingLength = keyLength - message.byteLength - 3;
  const encoded = new Uint8Array(keyLength);
  encoded[0] = 0;
  encoded[1] = 2;
  encoded.set(nonZeroRandomBytes(paddingLength), 2);
  encoded[2 + paddingLength] = 0;
  encoded.set(message, 3 + paddingLength);

  const encrypted = modPow(bytesToBigInt(encoded), key.exponent, key.modulus);
  return bigIntToFixedLengthBuffer(encrypted, keyLength);
}

function parseRsaPublicKey(publicKeyPem: string) {
  const der = base64ToBytes(
    publicKeyPem
      .replace(/-----BEGIN RSA PUBLIC KEY-----/g, "")
      .replace(/-----END RSA PUBLIC KEY-----/g, "")
      .replace(/\s+/g, ""),
  );
  const root = readDerNode(der, 0);
  const rootChildren = readDerChildren(root.value);

  // E.SUN currently serves a PKCS#1 "RSA PUBLIC KEY" PEM: SEQUENCE(INTEGER n, INTEGER e).
  // Accept SPKI too in case the header and body change later.
  const rsaSequence =
    rootChildren.length >= 2 && rootChildren[0].tag === 0x02
      ? root
      : readDerNode(rootChildren[1].value.slice(1), 0);
  const [modulusNode, exponentNode] = readDerChildren(rsaSequence.value);

  return {
    modulus: bytesToBigInt(stripLeadingZero(modulusNode.value)),
    exponent: bytesToBigInt(stripLeadingZero(exponentNode.value)),
  };
}

function readDerChildren(bytes: Uint8Array) {
  const children: DerNode[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const child = readDerNode(bytes, offset);
    children.push(child);
    offset = child.nextOffset;
  }
  return children;
}

interface DerNode {
  tag: number;
  value: Uint8Array;
  nextOffset: number;
}

function readDerNode(bytes: Uint8Array, offset: number): DerNode {
  const tag = bytes[offset];
  let lengthByte = bytes[offset + 1];
  let length = lengthByte;
  let cursor = offset + 2;

  if (lengthByte & 0x80) {
    const lengthBytes = lengthByte & 0x7f;
    length = 0;
    for (let index = 0; index < lengthBytes; index += 1) {
      length = (length << 8) + bytes[cursor + index];
    }
    cursor += lengthBytes;
  }

  return {
    tag,
    value: bytes.slice(cursor, cursor + length),
    nextOffset: cursor + length,
  };
}

function stripLeadingZero(bytes: Uint8Array) {
  return bytes[0] === 0 ? bytes.slice(1) : bytes;
}

function bytesToBigInt(bytes: Uint8Array) {
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return BigInt(`0x${hex || "0"}`);
}

function bigIntToFixedLengthBuffer(value: bigint, length: number) {
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const bytes = Buffer.from(hex, "hex");
  if (bytes.byteLength > length) {
    return bytes.subarray(bytes.byteLength - length);
  }
  if (bytes.byteLength === length) {
    return bytes;
  }
  return Buffer.concat([Buffer.alloc(length - bytes.byteLength), bytes]);
}

function byteLength(value: bigint) {
  return value.toString(2).length;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint) {
  if (modulus === 1n) return 0n;
  let result = 1n;
  let currentBase = base % modulus;
  let currentExponent = exponent;

  while (currentExponent > 0n) {
    if (currentExponent % 2n === 1n) {
      result = (result * currentBase) % modulus;
    }
    currentExponent /= 2n;
    currentBase = (currentBase * currentBase) % modulus;
  }

  return result;
}

function nonZeroRandomBytes(length: number) {
  const bytes = new Uint8Array(length);
  let index = 0;
  while (index < length) {
    const chunk = new Uint8Array(length - index);
    crypto.getRandomValues(chunk);
    for (const byte of chunk) {
      if (byte === 0) continue;
      bytes[index] = byte;
      index += 1;
      if (index === length) break;
    }
  }
  return bytes;
}

function isRedirect(status: number) {
  return (
    status === 301 ||
    status === 302 ||
    status === 303 ||
    status === 307 ||
    status === 308
  );
}

function getSetCookieValues(headers: Headers) {
  const withGetter = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetter.getSetCookie === "function") {
    return withGetter.getSetCookie();
  }

  const combined = headers.get("set-cookie");
  return combined ? splitCombinedSetCookie(combined) : [];
}

function splitCombinedSetCookie(value: string) {
  return value
    .split(/,(?=\s*[^;,=]+=[^;,]+)/g)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function readStoredCookie(
  value: unknown,
): EsunBrowserSession["cookies"][number] | null {
  if (!isCookieRecord(value)) return null;
  const record = value as {
    name: string;
    value: string;
    domain?: unknown;
    path?: unknown;
  };
  return {
    name: record.name,
    value: record.value,
    domain:
      typeof record.domain === "string"
        ? record.domain
        : "ebank.esunbank.com.tw",
    path: typeof record.path === "string" ? record.path : "/",
  };
}

function isCookieRecord(
  value: unknown,
): value is { name: string; value: string } {
  return Boolean(
    value &&
    typeof value === "object" &&
    "name" in value &&
    "value" in value &&
    typeof value.name === "string" &&
    typeof value.value === "string",
  );
}
