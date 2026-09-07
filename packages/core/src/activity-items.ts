import type { ActivityItem } from "./activity-types";
import { compareActivityItems, isActivityDateTime } from "./activity-list";
import type {
  MatchingTransaction,
  MatchingInvoice,
  InvoiceTransactionMatches,
} from "./activity-matching";
export interface ActivityAccount {
  id: string;
  institutionName?: string | null;
  accountName?: string | null;
  accountType?: string | null;
  accountLast4?: string | null;
}
export interface ActivityTransaction extends MatchingTransaction {
  accountId: string;
  institutionName?: string | null;
  accountName?: string | null;
  accountLast4?: string | null;
  status: string;
  excludedFromCalculation?: boolean;
  classification?: {
    label: string;
    categoryId: string;
    source: ActivityItem["classificationSource"];
    ruleId?: string;
  };
}
export interface ActivityInvoice extends MatchingInvoice {
  sellerName?: string | null;
  invoiceNumber?: string | null;
}
export interface ActivityTrade {
  id: string;
  name?: string | null;
  symbol?: string | null;
  tradeDate?: string | null;
  postedDate?: string | null;
  transactionName?: string | null;
  transactionCode?: string | null;
  quantity?: number | null;
  price?: number | null;
  amount?: number | null;
  currency: string;
}
const formatNumber = (value: number) =>
  new Intl.NumberFormat("zh-TW", { maximumFractionDigits: 0 }).format(value);
function normalizeFinancialDate(value?: string) {
  if (!value) return "";
  const roc = value.match(/^0(\d{3})-(\d{2})-(\d{2})(.*)$/);
  return roc ? `${Number(roc[1]) + 1911}-${roc[2]}-${roc[3]}${roc[4]}` : value;
}
export function buildActivityItems(
  activityBankTransactions: ActivityTransaction[],
  invoices: ActivityInvoice[],
  trades: ActivityTrade[],
  accounts: ReadonlyMap<string, ActivityAccount>,
  invoiceMatches: InvoiceTransactionMatches<ActivityInvoice>,
): ActivityItem[] {
  return [
    ...activityBankTransactions.map((t) => {
      const account = accounts.get(t.accountId);
      const matchedInvoice = invoiceMatches.transactionToInvoice.get(t.id);
      const isCard =
        account?.accountType === "credit" || t.accountType === "credit";
      const institutionName =
        t.institutionName ??
        account?.institutionName ??
        (isCard ? "信用卡" : "銀行");
      const accountLast4 = t.accountLast4 ?? account?.accountLast4;
      const accountName =
        t.accountName ??
        account?.accountName ??
        (accountLast4 ? `末四碼 ${accountLast4}` : "");
      return {
        id: t.id,
        source: isCard ? ("card" as const) : ("bank" as const),
        date: t.authorizedAt ?? t.postedDate ?? "",
        dateHasTime: isActivityDateTime(t.authorizedAt ?? undefined),
        title: t.description ?? t.counterparty ?? "銀行交易",
        searchText: [
          t.counterparty,
          matchedInvoice?.sellerName,
          matchedInvoice ? "電子發票" : undefined,
          accountLast4,
          isCard ? "信用卡" : "銀行",
        ]
          .filter(Boolean)
          .join(" "),
        subtitle: [institutionName, accountName, matchedInvoice?.invoiceNumber]
          .filter(Boolean)
          .join(" · "),
        institutionName,
        accountName,
        amount: t.amount,
        currency: t.currency,
        category: t.classification?.label ?? "未分類",
        categoryId: t.classification?.categoryId ?? "other",
        classificationPattern: t.counterparty ?? t.description ?? undefined,
        classificationSource: t.classification?.source ?? "fallback",
        classificationRuleId: t.classification?.ruleId,
        transactionId: t.id,
        invoiceId: matchedInvoice?.id,
        invoiceAmount: matchedInvoice?.amount,
        excludedFromCalculation: t.excludedFromCalculation,
        status: t.status,
      };
    }),
    ...invoices
      .filter((i) => !invoiceMatches.invoiceToTransactionId.has(i.id))
      .map((i) => ({
        id: i.id,
        source: "invoice" as const,
        date: i.invoiceDate,
        dateHasTime: isActivityDateTime(i.invoiceDate),
        title: i.sellerName ?? "電子發票",
        subtitle: i.invoiceNumber ?? "",
        institutionName: "電子發票",
        accountName: i.invoiceNumber ?? "",
        amount: i.amount,
        currency: "TWD",
        category: "發票",
        invoiceId: i.id,
        invoiceAmount: i.amount,
        status: "已開立",
      })),
    ...trades.map((t) => {
      const accountName = [
        t.transactionName ?? t.transactionCode,
        t.quantity != null ? `${formatNumber(t.quantity)} 股` : undefined,
      ]
        .filter(Boolean)
        .join(" · ");
      return {
        id: t.id,
        source: "investment" as const,
        date: normalizeFinancialDate(t.tradeDate ?? t.postedDate ?? undefined),
        dateHasTime: false,
        title: t.name ?? t.symbol ?? "投資交易",
        searchText: t.symbol ?? undefined,
        subtitle: accountName,
        institutionName: "投資",
        accountName,
        amount: t.price === 1 ? undefined : (t.amount ?? undefined),
        currency: t.currency,
        category: "投資",
        status: "已完成",
      };
    }),
  ].sort(compareActivityItems);
}
