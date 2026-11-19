export {
  deduplicateBankTransactions,
  matchInvoicesToTransactions,
  invoiceTransactionCandidates,
  invoiceTransactionDayGap,
  MANUAL_INVOICE_MATCH_MAX_DAYS,
  MANUAL_INVOICE_MATCH_MAX_EARLY_DAYS,
  type InvoiceTransactionMatches,
} from "@taiwan-fin-hub/shared";
import type { InvoiceTransactionPreference } from "@taiwan-fin-hub/shared";

/**
 * 本批發票已手動連結、但交易不在本批資料中的交易 ID，例如刷卡早於讀取區間的第一天。
 * 頁面須補讀這些交易才能配對，否則發票會被當成未配對而重複計入支出。
 * transactions 須是去重前的原始交易，避免把被去重隱藏的交易當成缺漏。
 */
export function missingLinkedTransactionIds(
  transactions: ReadonlyArray<{ id: string }>,
  invoices: ReadonlyArray<{ id: string }>,
  preferences: ReadonlyArray<InvoiceTransactionPreference>,
) {
  const transactionIds = new Set(transactions.map(({ id }) => id));
  const invoiceIds = new Set(invoices.map(({ id }) => id));
  const missing = new Set<string>();
  for (const { invoiceId, transactionId, decision } of preferences)
    if (
      decision === "linked" &&
      transactionId &&
      invoiceIds.has(invoiceId) &&
      !transactionIds.has(transactionId)
    )
      missing.add(transactionId);
  return [...missing].sort();
}
