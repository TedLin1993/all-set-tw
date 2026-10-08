import { ctbcTransactionsMatch } from "./protocol";
import { matchCardAuthorizations } from "../../features/sync/card-authorization-matching";
import { cardTransactionPreferenceStatements } from "../../features/sync/card-authorization-write";
import type { SyncWriteRecord } from "../../features/sync/persistence";

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
      raw_payload: JSON.stringify({
        ...metadata,
        syncSourceId: row.source_id,
        ...(existing &&
        (raw(existing).authorizationMatched ||
          (existing.status === "pending" &&
            row.status === "posted" &&
            existing.source_id === row.source_id))
          ? { authorizationMatched: true }
          : {}),
      }),
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
          (!raw(s).authorizationMatched &&
            (/T\d{2}:\d{2}/.test(s.authorized_at ?? "") ||
              stored.some(
                (previous) =>
                  previous.id === s.id && previous.status === "pending",
              ))),
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
  const matchCandidate = (row: Row) => {
    const metadata = raw(row);
    return {
      id: row.id,
      sourceId: row.source_id,
      accountId: row.account_id,
      cardId:
        typeof metadata.cardLast4 === "string" &&
        /^\d{4}$/.test(metadata.cardLast4)
          ? metadata.cardLast4
          : undefined,
      authorizedAt: row.authorized_at,
      amount: row.amount,
      currency: row.currency,
      authorizationId:
        typeof metadata.authorizationHash === "string"
          ? metadata.authorizationHash
          : undefined,
      row,
    };
  };
  const newLinks = matchCardAuthorizations(
    pending.map(matchCandidate),
    posted.map(matchCandidate),
    {
      matchesReference: (left, right) =>
        left.accountId === right.accountId &&
        (!left.cardId || !right.cardId || left.cardId === right.cardId) &&
        ctbcTransactionsMatch(candidate(left.row), candidate(right.row)),
    },
  ).map((link) => ({
    ...all.get(link.id)!,
    matched_transaction_id: link.posted,
  }));
  // CTBC retains the authorization ID and removes the formal duplicate. Two
  // existing linked invoices cannot be merged without discarding a decision.
  const invoices = new Set(
    (
      await db
        .prepare(
          `SELECT transaction_id FROM invoice_transaction_preferences
    WHERE decision = 'linked' AND transaction_id IN (SELECT id FROM bank_transactions WHERE connector_id = 'ctbc')`,
        )
        .all<{ transaction_id: string }>()
    ).results.map((row) => row.transaction_id),
  );
  const links = [...savedLinks, ...newLinks].flatMap((pendingRow) => {
    const posted = all.get(pendingRow.matched_transaction_id ?? "");
    return posted &&
      posted.id !== pendingRow.id &&
      !(invoices.has(posted.id) && invoices.has(pendingRow.id))
      ? [
          {
            id: pendingRow.id,
            posted: posted.id,
            postedName: posted.description,
            postedDate: posted.posted_date,
            postedAmount: posted.amount,
            postedSourceId: posted.source_id,
          },
        ]
      : [];
  });
  const linksJson = JSON.stringify(links);
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
          raw_payload = json_set(raw_payload, '$.authorizationMatched', json('true'), '$.syncSourceId', json_extract(link.value, '$.postedSourceId')),
          matched_transaction_id = NULL
        FROM json_each(?) link
        WHERE connector_id = 'ctbc' AND bank_transactions.id = json_extract(link.value, '$.id')`,
        )
        .bind(linksJson),
      ...cardTransactionPreferenceStatements(
        db,
        links.map((link) => ({ id: link.posted, posted: link.id })),
        {
          connectorId: "ctbc",
          fillUncategorized: true,
        },
      ),
      db
        .prepare(
          `UPDATE bank_transactions SET matched_transaction_id = NULL
        WHERE matched_transaction_id IN (SELECT json_extract(value, '$.posted') FROM json_each(?))`,
        )
        .bind(linksJson),
      db
        .prepare(
          `DELETE FROM invoice_transaction_preferences
        WHERE transaction_id IN (SELECT json_extract(value, '$.posted') FROM json_each(?))
          AND decision <> 'linked'`,
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
