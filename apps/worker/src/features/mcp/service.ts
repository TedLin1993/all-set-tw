import {
  activityAmountTwd,
  activityCategoryTotalsTwd,
  activityDateKey,
  activityDisplayAmount,
  activityFlowTotalTwd,
  taipeiDateKey,
  type ActivityItem,
} from "@taiwan-fin-hub/shared";
import { getActivityItemsInRange } from "../activity/service";
import { searchActivity } from "../activity/search-service";
import { getBankAccounts } from "../bank/service";
import { getExchangeRates } from "../exchange-rates/service";
import { getInvestmentPage } from "../investments/service";
import { getManualAssets } from "../manual-assets/service";
import { loadPaymentReminders } from "../notifications/service";
import { calculateCurrentFinancialSnapshot } from "../sync/reports/repository";
import { resolveMonthDateRange } from "../../platform/month-range";

// MCP 回傳內容會送到使用者選用的 AI 服務：只保留回答問題所需的欄位，
// 帳號只留末四碼，不回傳內部 ID、raw_payload 與來源設定。活動標題與 App
// 畫面相同，可能是銀行交易備註；帳號遮蔽由各來源正規化時負責。

const HOLDINGS_LIMIT = 500;

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
    holdings: page.positions.map((position) => ({
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

/** 與活動頁相同的月收支與分類計算；月份預設為台北時間本月。 */
export async function getMonthlyCashFlow(db: D1Database, month?: string) {
  const selectedMonth = month ?? taipeiDateKey(new Date()).slice(0, 7);
  // 活動頁一次載入多個月份；前後各多讀一個月，讓跨月的發票與刷卡仍能配對，
  // 避免同一筆消費被重複計入支出。
  const range = resolveMonthDateRange({
    from: shiftMonth(selectedMonth, -1),
    to: shiftMonth(selectedMonth, 1),
  })!;
  const [allItems, rateRows] = await Promise.all([
    getActivityItemsInRange(db, range),
    getExchangeRates(db),
  ]);
  const rates = Object.fromEntries(
    rateRows.map((rate) => [rate.currency, rate.rateTwd]),
  );
  const items = allItems.filter(
    (item) =>
      isCashFlowItem(item) && activityDateKey(item).startsWith(selectedMonth),
  );
  const round = (value: number) => Math.round(value);
  return {
    month: selectedMonth,
    currency: "TWD",
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
  };
}

export interface McpActivitySearchInput {
  query: string;
  from?: string;
  to?: string;
  source?: "all" | "bank" | "card" | "invoice";
  flow?: "all" | "income" | "expense";
}

export async function searchActivities(
  db: D1Database,
  input: McpActivitySearchInput,
) {
  const result = await searchActivity(db, {
    q: input.query,
    from: input.from,
    to: input.to,
    source: input.source,
    flow: input.flow,
  });
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
      excludedFromCalculation: item.excludedFromCalculation ?? false,
      status: item.status,
    })),
    truncated: Boolean(result.nextCursor),
  };
}

export async function getUpcomingPayments(db: D1Database) {
  const reminders = await loadPaymentReminders(db);
  return {
    reminders: reminders.map((reminder) => ({
      kind: reminder.kind,
      name: reminder.name,
      state: reminder.state,
      amount: reminder.amount ?? null,
      currency: reminder.currency,
      dueDate: reminder.dueDate ?? null,
      daysUntilDue: reminder.daysUntilDue ?? null,
      paymentAccount: reminder.paymentAccount?.name ?? null,
      shortfall: reminder.shortfall ?? null,
      asOf: reminder.asOfAt ?? null,
    })),
  };
}
