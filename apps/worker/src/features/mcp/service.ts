import {
  EMPTY_INVESTMENT_SOURCE_ID,
  activityAmountTwd,
  activityCategoryTotalsTwd,
  activityDateKey,
  activityDisplayAmount,
  activityFlowTotalTwd,
  taipeiDateKey,
  connectorCatalog,
  type ActivityItem,
  type PaymentReminder,
} from "@taiwan-fin-hub/shared";
import { getActivityItemsInRange } from "../activity/service";
import {
  activitySearchCursorSchema,
  searchActivity,
} from "../activity/search-service";
import { getBankAccounts } from "../bank/service";
import { getExchangeRates } from "../exchange-rates/service";
import { getInvestmentPage } from "../investments/service";
import { getManualAssets } from "../manual-assets/service";
import { loadPaymentReminders } from "../notifications/service";
import { calculateCurrentFinancialSnapshot } from "../sync/reports/repository";
import { getSyncJobs } from "../sync/scheduling/service";
import { parseKeysetPagination } from "../../platform/http";
import { resolveMonthDateRange } from "../../platform/month-range";

// MCP 回傳內容會送到使用者選用的 AI 服務：只保留回答問題所需的欄位，
// 帳號只留末四碼，不回傳內部 ID、raw_payload 與來源設定。活動標題與 App
// 畫面相同，可能是銀行交易備註；帳號遮蔽由各來源正規化時負責。

const HOLDINGS_LIMIT = 500;

/** 呼叫端可以自行修正的輸入錯誤；訊息會原樣回給 AI 助理。 */
export class McpToolInputError extends Error {}

export async function getFinancialOverview(db: D1Database) {
  const snapshot = await calculateCurrentFinancialSnapshot(db);
  return {
    currency: "TWD",
    assets: snapshot.assetsTwd,
    creditCardDebt: snapshot.creditCardDebtTwd,
    loanDebt: snapshot.loanDebtTwd,
    netWorth:
      snapshot.assetsTwd - snapshot.creditCardDebtTwd - snapshot.loanDebtTwd,
    missingExchangeRateCurrencies: snapshot.missingCurrencies,
  };
}

export async function listAccounts(db: D1Database) {
  const [accounts, manualAssets] = await Promise.all([
    getBankAccounts(db),
    getManualAssets(db),
  ]);
  return {
    accounts: accounts.map((account) => ({
      institution: account.institutionName ?? null,
      name: account.accountName ?? null,
      type: account.accountType ?? null,
      last4: account.accountLast4 ?? null,
      currency: account.currency,
      balance: account.balance ?? null,
      availableBalance: account.availableBalance ?? null,
      paymentDueDate: account.paymentDueDate ?? null,
      maturityDate: account.maturityDate ?? null,
      loanInterestRate: account.loanInterestRate ?? null,
      asOf: account.asOfAt ?? null,
    })),
    manualAssets: manualAssets.map((asset) => ({
      name: asset.name,
      category: asset.category,
      currency: asset.currency,
      value: asset.value ?? null,
      asOf: asset.date ?? null,
    })),
  };
}

export async function listInvestmentHoldings(db: D1Database) {
  const page = await getInvestmentPage(db, HOLDINGS_LIMIT);
  return {
    // 來源沒有持倉時寫入的零值佔位列不是部位，與前端一樣不列出。
    holdings: page.positions.filter(isHolding).map((position) => ({
      assetType: position.assetType,
      symbol: position.symbol ?? null,
      name: position.name,
      quantity: position.quantity ?? null,
      marketValue: position.marketValue ?? null,
      cashBalance: position.cashBalance ?? null,
      currency: position.currency,
      asOf: position.asOfDate,
    })),
    truncated: page.hasMore,
  };
}

function isHolding({ sourceId }: { sourceId: string }) {
  return (
    sourceId !== EMPTY_INVESTMENT_SOURCE_ID &&
    !sourceId.startsWith(`${EMPTY_INVESTMENT_SOURCE_ID}:`)
  );
}

function shiftMonth(month: string, offset: number) {
  const [year, monthNumber] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year!, monthNumber! - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}

function isCashFlowItem(item: ActivityItem) {
  return (
    item.source === "bank" ||
    item.source === "card" ||
    item.source === "invoice"
  );
}

export interface McpCashFlowInput {
  month?: string;
  from?: string;
  to?: string;
}

/** 與活動頁相同的月收支與分類計算；月份預設為台北時間本月。 */
export async function getMonthlyCashFlow(db: D1Database, month?: string) {
  const selectedMonth = month ?? taipeiDateKey(new Date()).slice(0, 7);
  const [result] = await loadCashFlowMonths(db, selectedMonth, selectedMonth);
  return { currency: "TWD", ...result! };
}

/** 帶 from、to 時回傳區間內每個月的收支，供跨月比較；否則回傳單月。 */
export async function getCashFlow(db: D1Database, input: McpCashFlowInput) {
  if (!input.from || !input.to) return getMonthlyCashFlow(db, input.month);
  return {
    currency: "TWD",
    months: await loadCashFlowMonths(db, input.from, input.to),
  };
}

async function loadCashFlowMonths(db: D1Database, from: string, to: string) {
  // 活動頁一次載入多個月份；前後各多讀一個月，讓跨月的發票與刷卡仍能配對，
  // 避免同一筆消費被重複計入支出。
  const range = resolveMonthDateRange({
    from: shiftMonth(from, -1),
    to: shiftMonth(to, 1),
  })!;
  const [allItems, rateRows] = await Promise.all([
    getActivityItemsInRange(db, range),
    getExchangeRates(db),
  ]);
  const rates = Object.fromEntries(
    rateRows.map((rate) => [rate.currency, rate.rateTwd]),
  );
  const cashFlowItems = allItems.filter(isCashFlowItem);
  const round = (value: number) => Math.round(value);
  const months = [];
  for (let month = from; month <= to; month = shiftMonth(month, 1)) {
    const items = cashFlowItems.filter((item) =>
      activityDateKey(item).startsWith(month),
    );
    months.push({
      month,
      income: round(activityFlowTotalTwd(items, "income", rates)),
      expense: round(activityFlowTotalTwd(items, "expense", rates)),
      expenseByCategory: activityCategoryTotalsTwd(items, "expense", rates).map(
        ({ category, amount }) => ({ category, amount: round(amount) }),
      ),
      incomeByCategory: activityCategoryTotalsTwd(items, "income", rates).map(
        ({ category, amount }) => ({ category, amount: round(amount) }),
      ),
      missingExchangeRateCurrencies: [
        ...new Set(
          items
            .filter(
              (item) =>
                !item.excludedFromCalculation &&
                item.amount != null &&
                activityAmountTwd(item, rates) == null,
            )
            .map((item) => item.currency),
        ),
      ].sort(),
    });
  }
  return months;
}

export interface McpActivitySearchInput {
  query?: string;
  category?: string;
  from?: string;
  to?: string;
  source?: "all" | "bank" | "card" | "invoice";
  flow?: "all" | "income" | "expense";
  cursor?: string;
}

function parseSearchCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  try {
    return parseKeysetPagination({ cursor }, activitySearchCursorSchema).cursor;
  } catch {
    throw new McpToolInputError(
      "cursor 無效，請使用上一次 search_activity 回傳的 nextCursor。",
    );
  }
}

export async function searchActivities(
  db: D1Database,
  input: McpActivitySearchInput,
) {
  const result = await searchActivity(
    db,
    {
      q: input.query ?? "",
      categoryLabel: input.category,
      from: input.from,
      to: input.to,
      source: input.source,
      flow: input.flow,
    },
    parseSearchCursor(input.cursor),
  );
  return {
    items: result.items.map((item) => ({
      date: activityDateKey(item),
      source: item.source,
      title: item.title,
      detail: item.subtitle || null,
      institution: item.institutionName ?? null,
      account: item.accountName ?? null,
      amount: activityDisplayAmount(item) ?? null,
      currency: item.currency,
      category: item.category,
      note: item.note ?? null,
      excludedFromCalculation: item.excludedFromCalculation ?? false,
      status: item.status,
    })),
    truncated: Boolean(result.nextCursor),
    nextCursor: result.nextCursor,
  };
}

/**
 * 近期要付的款項：需要處理的提醒在前，扣款帳戶餘額足夠、預計自動扣款的款項
 * 以 `covered` 排在最後。已繳清的帳單不是即將要付的款項，不列入。
 * `balanceCheck` 與資料來源 ID 讓 AI 助理分辨「未設定扣款帳戶」與「餘額過舊未比對」，
 * 並可同步對應來源後重查。
 */
export async function getUpcomingPayments(db: D1Database) {
  const { reminders, covered } = await loadPaymentReminders(db);
  const toPayment = (
    reminder: PaymentReminder,
    state: PaymentReminder["state"] | "covered",
  ) => ({
    kind: reminder.kind,
    name: reminder.name,
    connectorId: reminder.connectorId,
    state,
    amount: reminder.amount ?? null,
    currency: reminder.currency,
    dueDate: reminder.dueDate ?? null,
    daysUntilDue: reminder.daysUntilDue ?? null,
    asOf: reminder.asOfAt ?? null,
    stale: reminder.stale,
    balanceCheck: reminder.balanceCheck,
    paymentAccount: reminder.paymentAccount
      ? {
          name: reminder.paymentAccount.name,
          connectorId: reminder.paymentAccount.connectorId,
          asOf: reminder.paymentAccount.asOfAt ?? null,
        }
      : null,
    shortfall: reminder.shortfall ?? null,
  });
  return {
    payments: [
      ...reminders.map((reminder) => toPayment(reminder, reminder.state)),
      ...covered.map((reminder) => toPayment(reminder, "covered")),
    ],
  };
}

/** 已設定資料來源的同步狀態；`manualRun` 是最近一次由網頁或 MCP 觸發的背景同步。 */
export async function getSyncStatus(db: D1Database) {
  const jobs = await getSyncJobs(db);
  return jobs
    .filter((job) => job.configured && job.scope === "all")
    .map((job) => ({
      connectorId: job.connectorId,
      title: connectorCatalog[job.connectorId].title,
      running: job.running,
      phase: job.phase,
      lastSuccessAt: job.lastSuccessAt,
      lastRunAt: job.lastRunAt,
      lastStatus: job.lastStatus,
      lastErrorCode: job.lastErrorCode,
      lastError: job.lastError,
      manualRun: job.manualRun && {
        status: job.manualRun.status,
        errorCode: job.manualRun.errorCode,
        lastError: job.manualRun.lastError,
        createdAt: job.manualRun.createdAt,
        completedAt: job.manualRun.completedAt,
      },
    }));
}
