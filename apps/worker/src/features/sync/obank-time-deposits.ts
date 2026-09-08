import type {
  BankAccount,
  BankTransaction,
  SyncResult,
} from "@taiwan-fin-hub/core";
import {
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
} from "./record-mapper";
import type { SyncWriteRecord } from "./persistence";

type Account = Omit<BankAccount, "id" | "connectorId">;
type Transaction = Omit<BankTransaction, "id" | "connectorId">;
type PreviousDeposit = {
  sourceId: string;
  currency: string;
  balance: number;
  asOfAt: string;
};

/** Only a successful, completely parsed account selector may retire deposits. */
export async function prepareObankTimeDepositWrite(
  db: D1Database,
  result: SyncResult<never> & { timeDepositsComplete: true },
  now: string,
) {
  const accounts = result.bankAccounts ?? [];
  const deposits = accounts.filter(
    (account) => account.accountType === "time_deposit",
  );
  const currentIds = new Set(deposits.map((account) => account.sourceId));
  const previous = await db
    .prepare(
      `SELECT a.source_id AS sourceId, a.currency,
    b.balance, b.as_of_at AS asOfAt FROM bank_accounts a
    JOIN bank_balance_snapshots b ON b.id = (
      SELECT id FROM bank_balance_snapshots WHERE account_id = a.id
      ORDER BY as_of_at DESC, updated_at DESC LIMIT 1
    ) WHERE a.connector_id = 'obank' AND a.account_type = 'time_deposit'
      AND a.inactive_at IS NULL`,
    )
    .all<PreviousDeposit>();
  const missing = previous.results.filter(
    (account) => !currentIds.has(account.sourceId),
  );
  const transactions = result.bankTransactions ?? [];
  const events = matchObankDepositEvents(
    accounts,
    deposits.map((account) => ({
      sourceId: account.sourceId,
      currency: account.currency,
      balance:
        result.bankBalanceSnapshots?.find(
          (snapshot) => snapshot.accountId === account.sourceId,
        )?.balance ?? 0,
      openedDate: account.openedDate,
    })),
    missing,
    transactions,
    now,
  );
  const records: SyncWriteRecord[] = events.map((transaction) =>
    bankTransactionRecord("obank", transaction, now),
  );
  for (const account of missing) {
    // Zero from the observation time onward; earlier snapshots remain untouched.
    records.push(
      bankBalanceSnapshotRecord(
        "obank",
        {
          accountId: account.sourceId,
          sourceId: `${account.sourceId}:${now}`,
          balance: 0,
          currency: account.currency,
          asOfAt: now,
          raw: { reason: "absent_from_complete_time_deposit_list" },
        },
        now,
      ),
    );
  }
  return {
    records,
    afterPromoteStatements: [
      db
        .prepare(
          `UPDATE bank_accounts SET inactive_at = ?, updated_at = ?
      WHERE connector_id = 'obank' AND account_type = 'time_deposit'
        AND inactive_at IS NULL
        AND source_id NOT IN (SELECT value FROM json_each(?))`,
        )
        .bind(now, now, JSON.stringify([...currentIds])),
    ],
  };
}

/** Match only a unique principal leg in the sole demand account for that currency.
 * Opening has a bank-supplied contract date. Withdrawal additionally requires a
 * disappearance between two successful snapshots; its date is the demand leg's
 * posting date, not a claimed bank settlement date. Ambiguities stay unpaired.
 */
export function matchObankDepositEvents(
  accounts: Account[],
  deposits: Array<{
    sourceId: string;
    currency: string;
    balance: number;
    openedDate?: string;
  }>,
  missing: PreviousDeposit[],
  transactions: Transaction[],
  now: string,
): Transaction[] {
  const candidates: Array<{
    deposit: string;
    kind: "opened" | "withdrawn";
    transaction: Transaction;
  }> = [];
  const today = new Date(Date.parse(now) + 8 * 3600_000)
    .toISOString()
    .slice(0, 10);
  const findDemand = (currency: string) => {
    const matches = accounts.filter(
      (account) =>
        account.accountType === "savings" && account.currency === currency,
    );
    return matches.length === 1 ? matches[0].sourceId : undefined;
  };
  for (const deposit of [
    ...deposits.map((d) => ({
      ...d,
      kind: "opened" as const,
      asOfAt: undefined,
    })),
    ...missing.map((d) => ({
      ...d,
      kind: "withdrawn" as const,
      openedDate: undefined,
    })),
  ]) {
    if (!(deposit.balance > 0)) continue;
    const demandId = findDemand(deposit.currency);
    if (!demandId) continue;
    const lastSeenDay = deposit.asOfAt
      ? new Date(Date.parse(deposit.asOfAt) + 8 * 3600_000)
          .toISOString()
          .slice(0, 10)
      : undefined;
    const matches = transactions.filter(
      (transaction) =>
        transaction.accountId === demandId &&
        transaction.currency === deposit.currency &&
        transaction.status === "posted" &&
        transaction.amount ===
          (deposit.kind === "opened" ? -deposit.balance : deposit.balance) &&
        !!transaction.postedDate &&
        transaction.postedDate <= today &&
        (deposit.kind === "opened"
          ? !!deposit.openedDate &&
            transaction.postedDate === deposit.openedDate
          : // Day-only postings cannot establish ordering within the last-seen day.
            !!lastSeenDay && transaction.postedDate > lastSeenDay),
    );
    if (matches.length === 1)
      candidates.push({
        deposit: deposit.sourceId,
        kind: deposit.kind,
        transaction: matches[0],
      });
  }
  return candidates
    .filter(
      (candidate) =>
        candidates.filter(
          (other) =>
            other.transaction.sourceId === candidate.transaction.sourceId,
        ).length === 1,
    )
    .map(({ deposit, kind, transaction }) => ({
      accountId: deposit,
      sourceId: `${deposit}:${kind}:${transaction.postedDate}`,
      postedDate: transaction.postedDate,
      amount: -transaction.amount,
      currency: transaction.currency,
      description: kind === "opened" ? "定存成立（本金轉入）" : "定存本金轉回",
      status: "posted" as const,
      transferPeer: {
        accountId: transaction.accountId,
        sourceId: transaction.sourceId,
      },
      raw: { derivedFrom: "time_deposit_and_demand_transaction", event: kind },
    }));
}
