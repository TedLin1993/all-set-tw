import {
  activityDateKey,
  buildActivityItems,
  compareActivityItems,
  deduplicateBankTransactions,
  filterActivities,
  isActivityDateTime,
  matchInvoicesToTransactions,
  type ActivityItem,
  type ActivityOrderKey,
} from "@taiwan-fin-hub/core";
import { listBankAccounts } from "../bank/repository";
import { normalizeBankAccountDisplay } from "../bank/display";
import { getBankRange } from "../bank/service";
import { getInvoicesRange } from "../invoices/service";
import { getInvestmentTransactionsRange } from "../investments/service";
import { encodePageCursor } from "../../platform/http";
import { listInvoiceTransactionPreferences } from "./repository";
import {
  findActivitySearchDays,
  type ActivitySearchInput,
} from "./search-repository";

const PAGE_SIZE = 30;
const DAY_BATCH_SIZE = 32;
export async function searchActivity(
  db: D1Database,
  input: ActivitySearchInput,
  cursor?: ActivityOrderKey,
) {
  const [accountRows, preferences] = await Promise.all([
    listBankAccounts(db),
    listInvoiceTransactionPreferences(db),
  ]);
  const accounts = accountRows.map(normalizeBankAccountDisplay);
  const accountMap = new Map(
    accounts.map((account) => [
      String(account.id),
      { ...account, id: String(account.id) },
    ]),
  );
  const matchingAccountIds = accounts
    .filter((account) =>
      [account.institutionName, account.accountName, account.accountLast4]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(input.q.toLowerCase()),
    )
    .map((account) => String(account.id));
  const bankTransactions: Awaited<
    ReturnType<typeof getBankRange>
  >["transactions"] = [];
  const invoices: Awaited<ReturnType<typeof getInvoicesRange>> = [];
  const trades: Awaited<ReturnType<typeof getInvestmentTransactionsRange>> = [];
  const matches: ActivityItem[] = [];
  let beforeDay = cursor ? activityDateKey(cursor) : undefined;
  let inclusive = Boolean(cursor);
  while (matches.length <= PAGE_SIZE) {
    const candidates = await findActivitySearchDays(
      db,
      input,
      matchingAccountIds,
      beforeDay,
      inclusive,
    );
    const days = candidates.slice(0, DAY_BATCH_SIZE);
    if (!days.length) break;
    const range = { from: days.at(-1)!, to: days[0] }; // Exact day selection is used below.
    const [bank, invoiceBatch, tradeBatch] = await Promise.all([
      getBankRange(db, range, days, accountRows),
      getInvoicesRange(db, range, days),
      getInvestmentTransactionsRange(db, range, days),
    ]);
    const transactions = deduplicateBankTransactions(bank.transactions);
    const invoiceMatches = matchInvoicesToTransactions(
      transactions,
      invoiceBatch,
      preferences,
    );
    const items = buildActivityItems(
      transactions,
      invoiceBatch,
      tradeBatch,
      accountMap,
      invoiceMatches,
    );
    matches.push(
      ...filterActivities(items, {
        month: "",
        search: input.q,
        from: input.from,
        to: input.to,
        source: input.source ?? "all",
        flow: input.flow ?? "all",
        categoryId: input.category,
        category: null,
      }).filter((item) => !cursor || compareActivityItems(item, cursor) > 0),
    );
    bankTransactions.push(...transactions);
    invoices.push(...invoiceBatch);
    trades.push(...tradeBatch);
    if (candidates.length <= DAY_BATCH_SIZE) break;
    beforeDay = days.at(-1);
    inclusive = false;
  }
  matches.sort(compareActivityItems);
  const items = matches.slice(0, PAGE_SIZE);
  const last = items.at(-1);
  const selectedDays = new Set(items.map(activityDateKey));
  return {
    items,
    bank: {
      accounts,
      transactions: bankTransactions.filter((t) =>
        selectedDays.has(
          activityDateKey({
            date: t.authorizedAt ?? t.postedDate ?? "",
            dateHasTime: isActivityDateTime(t.authorizedAt ?? undefined),
            source: "bank",
          }),
        ),
      ),
    },
    invoices: invoices.filter((i) =>
      selectedDays.has(
        activityDateKey({ date: i.invoiceDate, source: "invoice" }),
      ),
    ),
    trades: trades.filter((t) =>
      selectedDays.has(
        activityDateKey({
          date: t.tradeDate ?? t.postedDate ?? "",
          source: "investment",
        }),
      ),
    ),
    nextCursor:
      matches.length > PAGE_SIZE && last
        ? encodePageCursor({
            id: last.id,
            source: last.source,
            date: last.date,
            dateHasTime: last.dateHasTime,
          })
        : null,
  };
}
