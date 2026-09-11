import { ctbcTransactionsMatch } from "@taiwan-fin-hub/connectors";
import type { SyncWriteRecord } from "./persistence";

type Row = Record<string, unknown> & {
  id: string;
  source_id: string;
  account_id: string;
  status: string;
  authorized_at: string | null;
  posted_date: string | null;
  amount: number;
  currency: string;
  description: string;
  raw_payload: string;
  matched_transaction_id?: string | null;
};
const raw = (row: Row): Record<string, unknown> =>
  JSON.parse(row.raw_payload || "{}");
const candidate = (row: Row) => ({
  authorizedAt: row.authorized_at ?? undefined,
  postedDate: row.posted_date ?? undefined,
  amount: row.amount,
  currency: row.currency,
  description: row.description,
  raw: raw(row),
});

export async function prepareCtbcAuthorizationWrite(
  db: D1Database,
  records: SyncWriteRecord[],
) {
  const stored = (
    await db
      .prepare(
        "SELECT * FROM bank_transactions WHERE connector_id = 'ctbc' AND source_id LIKE 'ctbc:card:tx:%'",
      )
      .all<Row>()
  ).results;
  const current = records.filter(
    (r) =>
      r.entityType === "bank_transaction" &&
      String(r.payload.source_id).startsWith("ctbc:card:tx:"),
  );
  const incomingPosted = current.filter((r) => r.payload.status === "posted");
  const rewritten = new Map<string, SyncWriteRecord>();
  const claimed = new Set<string>();
  for (const record of current) {
    const row = record.payload as Row;
    const metadata = raw(row);
    let existing =
      stored.find((s) => s.id === row.id) ??
      stored.find(
        (s) =>
          s.account_id === row.account_id &&
          raw(s).syncSourceId === row.source_id,
      );
    if (row.status === "posted" && existing?.matched_transaction_id) {
      existing = stored.find((s) => s.id === existing!.matched_transaction_id);
    }
    if (
      (!existing || existing.status === "pending") &&
      row.status === "posted" &&
      metadata.legacySourceId
    ) {
      const legacy = stored.find(
        (s) =>
          s.source_id === metadata.legacySourceId &&
          s.status === "posted" &&
          !s.authorized_at &&
          !s.posted_date,
      );
      if (legacy) {
        // A date-less legacy identity is only repairable when the current feed
        // supplies exactly one replacement. Never guess among recurring charges.
        const replacements = incomingPosted.filter(
          (r) =>
            raw(r.payload as Row).legacySourceId === metadata.legacySourceId,
        );
        if (
          replacements.length !== 1 ||
          legacy.amount !== row.amount ||
          legacy.currency !== row.currency ||
          legacy.description !== row.description ||
          raw(legacy).cardLast4 !== metadata.cardLast4
        ) {
          throw new Error(
            "中信舊已入帳明細無法唯一對應，保留原資料，未寫入本次同步。",
          );
        }
        existing = legacy;
      }
    }
    if (!existing && row.status === "posted") {
      const matches = stored.filter(
        (s) =>
          s.status === "posted" &&
          s.account_id === row.account_id &&
          ctbcTransactionsMatch(candidate(s), candidate(row)),
      );
      if (
        matches.length === 1 &&
        incomingPosted.filter((r) =>
          ctbcTransactionsMatch(
            candidate(r.payload as Row),
            candidate(matches[0]!),
          ),
        ).length === 1
      )
        existing = matches[0];
    }
    // A late authorization response must never downgrade a posted transaction.
    if (existing?.status === "posted" && row.status === "pending") continue;
    if (existing && claimed.has(existing.id))
      throw new Error("中信交易識別重複，未寫入本次同步。");
    if (existing) claimed.add(existing.id);
    const updated: Row = {
      ...row,
      ...(existing
        ? {
            id: existing.id,
            source_id: existing.source_id,
            account_id: existing.account_id,
          }
        : {}),
      authorized_at: existing?.authorized_at?.includes("T")
        ? existing.authorized_at
        : row.authorized_at,
      raw_payload: JSON.stringify({ ...metadata, syncSourceId: row.source_id }),
    };
    rewritten.set(record.recordKey, {
      ...record,
      recordKey: updated.id,
      payload: updated,
    });
  }
  const all = new Map(stored.map((s) => [s.id, s]));
  for (const record of rewritten.values()) {
    const row = record.payload as Row;
    all.set(row.id, {
      ...row,
      matched_transaction_id: all.get(row.id)?.matched_transaction_id,
    });
  }
  const savedLinks = stored.filter(
    (s) => s.status === "pending" && s.matched_transaction_id,
  );
  const usedPosted = new Set(savedLinks.map((s) => s.matched_transaction_id));
  // The connector can promote an authorization before this persistence pass.
  // CTBC posted feeds contain dates only; a retained time identifies an
  // authorization even in duplicates left by earlier syncs.
  const authorizationIds = new Set(
    [...all.values()]
      .filter(
        (s) =>
          s.status === "pending" ||
          /T\d{2}:\d{2}/.test(s.authorized_at ?? "") ||
          stored.some(
            (previous) => previous.id === s.id && previous.status === "pending",
          ),
      )
      .map((s) => s.id),
  );
  const pending = [...all.values()].filter(
    (s) =>
      authorizationIds.has(s.id) &&
      !s.matched_transaction_id &&
      !usedPosted.has(s.id),
  );
  const posted = [...all.values()].filter(
    (s) =>
      s.status === "posted" &&
      !usedPosted.has(s.id) &&
      !authorizationIds.has(s.id),
  );
  const candidates = pending.map((p) =>
    posted.filter(
      (t) =>
        p.account_id === t.account_id &&
        ctbcTransactionsMatch(candidate(p), candidate(t)),
    ),
  );
  const newLinks = pending.flatMap((p, i) => {
    const matches = candidates[i]!;
    if (
      matches.length !== 1 ||
      candidates.filter((xs) => xs.includes(matches[0]!)).length !== 1
    )
      return [];
    return [{ ...p, matched_transaction_id: matches[0]!.id }];
  });
  const linksJson = JSON.stringify(
    [...savedLinks, ...newLinks].flatMap((pendingRow) => {
      const posted = all.get(pendingRow.matched_transaction_id ?? "");
      return posted && posted.id !== pendingRow.id
        ? [
            {
              id: pendingRow.id,
              posted: posted.id,
              postedName: posted.description,
              postedDate: posted.posted_date,
              postedAmount: posted.amount,
            },
          ]
        : [];
    }),
  );
  return {
    records: records.flatMap((r) =>
      current.includes(r)
        ? rewritten.has(r.recordKey)
          ? [rewritten.get(r.recordKey)!]
          : []
        : [r],
    ),
    afterPromoteStatements: [
      db
        .prepare(
          `UPDATE bank_transactions SET
          status = 'posted',
          description = COALESCE(NULLIF(trim(json_extract(link.value, '$.postedName')), ''), description),
          counterparty = COALESCE(NULLIF(trim(json_extract(link.value, '$.postedName')), ''), counterparty),
          posted_date = COALESCE(json_extract(link.value, '$.postedDate'), posted_date),
          amount = COALESCE(json_extract(link.value, '$.postedAmount'), amount),
          matched_transaction_id = NULL
        FROM json_each(?) link
        WHERE connector_id = 'ctbc' AND bank_transactions.id = json_extract(link.value, '$.id')`,
        )
        .bind(linksJson),
      db
        .prepare(
          `INSERT INTO classification_overrides (id, target_type, target_id, category_id, created_at, updated_at)
        SELECT 'override:bank_transaction:' || json_extract(link.value, '$.id'), 'bank_transaction', json_extract(link.value, '$.id'), posted.category_id, posted.created_at, posted.updated_at
        FROM json_each(?) link JOIN classification_overrides posted ON posted.target_type = 'bank_transaction' AND posted.target_id = json_extract(link.value, '$.posted')
        WHERE posted.category_id <> 'other'
        ON CONFLICT(target_type, target_id) DO UPDATE SET
          category_id = excluded.category_id,
          updated_at = excluded.updated_at
        WHERE classification_overrides.category_id = 'other'`,
        )
        .bind(linksJson),
      db
        .prepare(
          `INSERT INTO bank_transaction_preferences (transaction_id, excluded_from_calculation, created_at, updated_at)
        SELECT json_extract(link.value, '$.id'), posted.excluded_from_calculation, posted.created_at, posted.updated_at
        FROM json_each(?) link JOIN bank_transaction_preferences posted ON posted.transaction_id = json_extract(link.value, '$.posted')
        WHERE true ON CONFLICT(transaction_id) DO NOTHING`,
        )
        .bind(linksJson),
      db
        .prepare(
          `UPDATE invoice_transaction_preferences SET transaction_id = json_extract(link.value, '$.id')
        FROM json_each(?) link WHERE invoice_transaction_preferences.transaction_id = json_extract(link.value, '$.posted')
        AND NOT EXISTS (SELECT 1 FROM invoice_transaction_preferences existing WHERE existing.transaction_id = json_extract(link.value, '$.id') AND existing.decision = 'linked')`,
        )
        .bind(linksJson),
      db
        .prepare(
          `UPDATE bank_transactions SET matched_transaction_id = NULL
        WHERE matched_transaction_id IN (SELECT json_extract(value, '$.posted') FROM json_each(?))`,
        )
        .bind(linksJson),
      db
        .prepare(
          `DELETE FROM invoice_transaction_preferences
        WHERE transaction_id IN (SELECT json_extract(value, '$.posted') FROM json_each(?))`,
        )
        .bind(linksJson),
      db
        .prepare(
          `DELETE FROM classification_overrides
        WHERE target_type = 'bank_transaction'
          AND target_id IN (SELECT json_extract(value, '$.posted') FROM json_each(?))`,
        )
        .bind(linksJson),
      db
        .prepare(
          `DELETE FROM bank_transaction_preferences
        WHERE transaction_id IN (SELECT json_extract(value, '$.posted') FROM json_each(?))`,
        )
        .bind(linksJson),
      db
        .prepare(
          `DELETE FROM bank_transactions
        WHERE connector_id = 'ctbc'
          AND id IN (SELECT json_extract(value, '$.posted') FROM json_each(?))
          AND id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
        )
        .bind(linksJson, linksJson),
    ],
  };
}
