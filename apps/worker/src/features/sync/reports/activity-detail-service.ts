import { sanitizeDatabaseError } from "../../../db";
import {
  activityDisplayAmount,
  activityDateKey,
  buildActivityItems,
  deduplicateBankTransactions,
  isActivityDateTime,
  matchInvoicesToTransactions,
  type ActivityTransaction,
  type ActivityInvoice,
  type ActivityTrade,
  type SyncActivityDetail,
} from "@taiwan-fin-hub/shared";
import {
  listBankAccounts,
  listBankTransactionsInRange,
} from "../../bank/repository";
import {
  normalizeBankAccountDisplay,
  normalizeBankTransactionDisplay,
} from "../../bank/display";
import { getInvoicesRange } from "../../invoices/service";
import { listInvoiceTransactionPreferences } from "../../activity/repository";
import {
  listActivityReportRuns,
  listActivityChanges,
  saveActivityDetails,
} from "./activity-detail-repository";
export { getReportActivityDetails } from "./activity-detail-repository";

type Change = Awaited<ReturnType<typeof listActivityChanges>>[number];
type BankSnapshot = ActivityTransaction & {
  canonicalAccountId?: string | null;
};

/** Freeze presentation at report completion, reusing the activity page's matching rules. */
export async function materializeActivityReport(
  db: D1Database,
  batchId: string,
) {
  const runs = await listActivityReportRuns(db, batchId);
  if (!runs.some((r) => !r.materialized)) return;
  const changesByRun = new Map<string, Change[]>();
  const newBankIds = new Set<string>();
  for (const run of runs) {
    const changes = await listActivityChanges(db, run.id);
    changesByRun.set(run.id, changes);
    for (const change of changes) {
      if (
        change.entityType === "bank_transaction" &&
        change.changeKind === "added"
      ) {
        newBankIds.add((JSON.parse(change.snapshot) as BankSnapshot).id);
      }
    }
  }
  for (const changes of changesByRun.values()) {
    for (const change of changes)
      if (
        change.entityType === "bank_transaction" &&
        change.changeKind === "posted"
      )
        newBankIds.delete((JSON.parse(change.snapshot) as BankSnapshot).id);
  }
  const accountRows = await listBankAccounts(db);
  const accountMap = new Map(
    accountRows
      .map(normalizeBankAccountDisplay)
      .map((a) => [String(a.id), { ...a, id: String(a.id) }]),
  );
  const preferences = await listInvoiceTransactionPreferences(db);
  for (const run of runs.filter((r) => !r.materialized)) {
    const changes = changesByRun.get(run.id)!;
    const bankSnapshots = changes
      .filter((c) => c.entityType === "bank_transaction")
      .map((c) => ({
        change: c,
        item: JSON.parse(c.snapshot) as BankSnapshot,
      }));
    const invoiceSnapshots = changes
      .filter((c) => c.entityType === "invoice")
      .map((c) => JSON.parse(c.snapshot) as ActivityInvoice);
    const trades = changes
      .filter((c) => c.entityType === "investment_transaction")
      .map((c) => JSON.parse(c.snapshot) as ActivityTrade);
    const dates = new Set<string>();
    for (const { item } of bankSnapshots)
      dates.add(
        activityDateKey({
          date: item.authorizedAt ?? item.postedDate ?? "",
          dateHasTime: isActivityDateTime(item.authorizedAt ?? undefined),
          source: "bank",
        }),
      );
    for (const item of invoiceSnapshots)
      dates.add(activityDateKey({ date: item.invoiceDate, source: "invoice" }));
    const bank = new Map<string, ActivityTransaction>();
    const invoices = new Map<string, ActivityInvoice>();
    // Bounded day groups preserve full matching context, including older transactions.
    const days = [...dates].filter(Boolean).sort();
    for (let offset = 0; offset < days.length; offset += 16) {
      const slice = days.slice(offset, offset + 16);
      const range = { from: slice[0]!, to: slice.at(-1)! };
      const [txns, invs] = await Promise.all([
        listBankTransactionsInRange(db, range, slice),
        getInvoicesRange(db, range, slice),
      ]);
      for (const t of txns) {
        const normalized = normalizeBankTransactionDisplay(t);
        bank.set(normalized.id, normalized);
      }
      for (const i of invs) invoices.set(i.id, i);
    }
    for (const { item } of bankSnapshots)
      if (!item.canonicalAccountId) bank.set(item.id, item);
    for (const item of invoiceSnapshots) invoices.set(item.id, item);
    const transactions = deduplicateBankTransactions([...bank.values()]);
    const matches = matchInvoicesToTransactions(
      transactions,
      [...invoices.values()],
      preferences,
    );
    const activities = buildActivityItems(
      transactions,
      [...invoices.values()],
      trades,
      accountMap,
      matches,
    );
    const relevantBank = new Map<string, Set<"added" | "posted">>();
    for (const { change, item } of bankSnapshots) {
      if (item.canonicalAccountId) continue;
      const kinds = relevantBank.get(item.id) ?? new Set<"added" | "posted">();
      kinds.add(change.changeKind === "posted" ? "posted" : "added");
      relevantBank.set(item.id, kinds);
    }
    const invoiceIds = new Set(invoiceSnapshots.map((i) => i.id));
    const tradeIds = new Set(trades.map((t) => t.id));
    const details: SyncActivityDetail[] = [];
    for (const item of activities) {
      const bankKinds = relevantBank.get(item.id);
      const invoiceAdded = Boolean(
        item.invoiceId && invoiceIds.has(item.invoiceId),
      );
      // 成交併入交割款時，活動是銀行那筆；成交仍算這次同步的新增。
      const tradeAdded = Boolean(item.trade && tradeIds.has(item.trade.id));
      if (
        !bankKinds &&
        !invoiceAdded &&
        !tradeAdded &&
        !(item.source === "investment" && tradeIds.has(item.id))
      )
        continue;
      const kinds: SyncActivityDetail["changes"] = [];
      if (bankKinds?.has("posted")) kinds.push("posted");
      else if (
        bankKinds?.has("added") ||
        item.source === "investment" ||
        item.source === "invoice" ||
        tradeAdded ||
        newBankIds.has(item.id)
      )
        kinds.push("added");
      if (invoiceAdded && item.source !== "invoice")
        kinds.push("invoice_linked");
      details.push({
        id: `${item.source}:${item.id}`,
        date: item.date,
        title: item.title,
        subtitle: item.subtitle,
        amount: activityDisplayAmount(item),
        currency: item.currency,
        status: item.status,
        changes: kinds,
        invoiceId: item.invoiceId,
        syncedAt: run.capturedAt ?? run.createdAt,
      });
    }
    await saveActivityDetails(db, run.id, details);
  }
}

/** A projection failure must not turn a committed financial sync into a failure. */
export async function safelyMaterializeActivityReport(
  db: D1Database,
  batchId: string,
) {
  try {
    await materializeActivityReport(db, batchId);
  } catch (error) {
    console.error(
      "[sync] activity report projection pending",
      sanitizeDatabaseError(error),
    );
  }
}
