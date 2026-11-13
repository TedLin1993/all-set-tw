import { taiwanDate } from "./protocol";
import { mergeLegacyTransactionStatements } from "../../features/sync/transaction-merge";
import type { SyncWriteRecord } from "../../features/sync/persistence";

type Row = {
  id: string;
  account_id: string;
  authorized_at: string | null;
  posted_date: string | null;
  amount: number;
  created_at?: string;
};

const MAX_MERGE_ROUNDS = 5;
const hasTime = (value: string | null | undefined) => (value?.length ?? 0) > 10;
const dayKey = (row: Row) =>
  JSON.stringify([
    row.account_id,
    row.authorized_at ? taiwanDate(row.authorized_at) : row.posted_date,
    row.amount,
  ]);

/** The complete response is the truth for every account, day and amount it
 * lists. Stored rows it no longer identifies are the same trades under an
 * earlier identity (tradeID-based, or a renumbered duplicate): fold them into
 * the returned rows so user settings survive and duplicates disappear. Days the
 * response does not cover are left alone.
 */
export async function prepareNextbankTransactionWrite(
  db: D1Database,
  records: SyncWriteRecord[],
) {
  const incoming = records.filter(
    (record) =>
      record.entityType === "bank_transaction" &&
      String(record.payload.source_id).startsWith("nextbank:tx:"),
  );
  if (!incoming.length) return { records, afterPromoteStatements: [] };
  const stored = (
    await db
      .prepare(
        `SELECT id, account_id, authorized_at, posted_date, amount, created_at
         FROM bank_transactions
         WHERE connector_id = 'nextbank' AND source_id LIKE 'nextbank:tx:%'
         ORDER BY created_at, id`,
      )
      .all<Row>()
  ).results;
  const storedById = new Map(stored.map((row) => [row.id, row]));
  const returned = new Map<string, Row[]>();
  for (const record of incoming) {
    const row = record.payload as Row;
    returned.set(dayKey(row), [...(returned.get(dayKey(row)) ?? []), row]);
  }
  const returnedIds = new Set(incoming.map((record) => record.recordKey));
  const unreturned = new Map<string, Row[]>();
  for (const row of stored) {
    const key = dayKey(row);
    if (returnedIds.has(row.id) || !returned.has(key)) continue;
    unreturned.set(key, [...(unreturned.get(key) ?? []), row]);
  }
  // One stored row per returned row and round keeps every merge one-to-one.
  const rounds: Array<Array<{ old: string; new: string }>> = [];
  const earlier = new Map<string, Row>();
  for (const [key, rows] of unreturned) {
    const targets = returned.get(key)!;
    rows.forEach((row, index) => {
      const target = targets[index % targets.length]!;
      const round = Math.floor(index / targets.length);
      if (round >= MAX_MERGE_ROUNDS) return;
      (rounds[round] ??= []).push({ old: row.id, new: target.id });
      if (hasTime(row.authorized_at) && !earlier.has(target.id))
        earlier.set(target.id, row);
    });
  }
  return {
    // Posted trades can lose the time of day; keep the one already known.
    records: records.map((record) => {
      if (!incoming.includes(record)) return record;
      const row = record.payload as Row;
      if (hasTime(row.authorized_at)) return record;
      const known = [storedById.get(row.id), earlier.get(row.id)].find((s) =>
        hasTime(s?.authorized_at),
      );
      return known
        ? {
            ...record,
            payload: { ...record.payload, authorized_at: known.authorized_at },
          }
        : record;
    }),
    afterPromoteStatements: rounds.flatMap((pairs) =>
      mergeLegacyTransactionStatements(
        db,
        `SELECT json_extract(value, '$.old') AS old_id, json_extract(value, '$.new') AS new_id
         FROM json_each('${JSON.stringify(pairs).replaceAll("'", "''")}')`,
      ),
    ),
  };
}
