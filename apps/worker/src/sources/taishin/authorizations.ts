import type { SyncWriteRecord } from "../../features/sync/persistence";
import { cardAuthorizationLinkStatements } from "../../features/sync/card-authorization-write";
import {
  cardAuthorizationMatchKey,
  matchCardAuthorizations,
} from "../../features/sync/card-authorization-matching";
import { normalizeMerchantName } from "./protocol";

type CardRow = {
  id: string;
  account_id: string;
  source_id: string;
  status: string;
  authorized_at: string | null;
  amount: number;
  currency: string;
  description: string | null;
  raw_payload: string;
  matched_transaction_id: string | null;
};

function cardLast4(row: CardRow) {
  try {
    const raw = JSON.parse(row.raw_payload || "{}") as Record<string, unknown>;
    return typeof raw.cardLast4 === "string" && /^\d{4}$/.test(raw.cardLast4)
      ? raw.cardLast4
      : undefined;
  } catch {
    return undefined;
  }
}

function candidate(row: CardRow) {
  return {
    id: row.id,
    sourceId: row.source_id,
    accountId: row.account_id,
    cardId: cardLast4(row),
    authorizedAt: row.authorized_at,
    amount: row.amount,
    currency: row.currency,
  };
}

function samePurchase(left: CardRow, right: CardRow) {
  const key = cardAuthorizationMatchKey(candidate(left));
  return (
    key !== undefined && key === cardAuthorizationMatchKey(candidate(right))
  );
}

export async function prepareTaishinAuthorizationWrite(
  db: D1Database,
  records: SyncWriteRecord[],
  encryptedConfig?: string,
) {
  const stored = (
    await db
      .prepare(
        `SELECT id, account_id, source_id, status, authorized_at, amount, currency,
      description, raw_payload, matched_transaction_id FROM bank_transactions
    WHERE connector_id = 'taishin' AND source_id LIKE 'taishin:card:tx:v2:%'`,
      )
      .all<CardRow>()
  ).results;
  const rows = new Map(stored.map((row) => [row.id, row]));
  const incoming = records.filter(
    (record) =>
      record.entityType === "bank_transaction" &&
      String(record.payload.source_id).startsWith("taishin:card:tx:v2:") &&
      record.payload.status === "posted",
  );
  const presentIds = new Set(incoming.map((record) => record.recordKey));
  const unmatchedIncoming = incoming.filter(
    (record) => !rows.has(record.recordKey),
  );
  const unmatchedStored = stored.filter(
    (row) =>
      row.status === "posted" &&
      !presentIds.has(row.id) &&
      row.source_id.split(":").slice(8, -1).join(":") !==
        normalizeMerchantName(row.description ?? undefined),
  );
  const replacements = new Map<string, CardRow>();
  for (const record of incoming) {
    const previous = rows.get(record.recordKey);
    // An authorization already linked to a different posted ID stays pending.
    if (previous?.matched_transaction_id) {
      const target = rows.get(previous.matched_transaction_id);
      if (target?.status === "posted")
        replacements.set(record.recordKey, target);
    }
  }
  for (const record of unmatchedIncoming) {
    const row = record.payload as unknown as CardRow;
    const candidates = unmatchedStored.filter((previous) =>
      samePurchase(row, previous),
    );
    if (candidates.length !== 1) continue;
    const target = candidates[0]!;
    if (
      unmatchedIncoming.filter((other) =>
        samePurchase(other.payload as unknown as CardRow, target),
      ).length !== 1
    )
      continue;
    // Before this connector queried unbilled details, the in-memory lifecycle
    // merger could borrow a pending merchant's ID. Reuse that saved posted ID
    // when the official posted feed later names the purchase differently.
    replacements.set(record.recordKey, target);
  }
  const updated = new Map<string, SyncWriteRecord>();
  for (const original of records) {
    const target = replacements.get(original.recordKey);
    const record = target
      ? {
          ...original,
          recordKey: target.id,
          payload: {
            ...original.payload,
            id: target.id,
            source_id: target.source_id,
          },
        }
      : original;
    const alreadyPrepared = updated.get(record.recordKey);
    if (
      alreadyPrepared?.payload.status === "posted" &&
      record.payload.status === "pending"
    )
      continue;
    updated.set(record.recordKey, record);
    if (
      record.entityType !== "bank_transaction" ||
      !String(record.payload.source_id).startsWith("taishin:card:tx:v2:")
    )
      continue;
    const row = record.payload as unknown as CardRow;
    const previous = rows.get(row.id);
    rows.set(row.id, {
      ...row,
      status: previous?.status === "posted" ? "posted" : row.status,
      authorized_at:
        (previous?.authorized_at?.length ?? 0) > 10
          ? previous!.authorized_at
          : row.authorized_at,
      matched_transaction_id: previous?.matched_transaction_id ?? null,
    });
  }
  const targeted = new Set(
    [...rows.values()].map((row) => row.matched_transaction_id).filter(Boolean),
  );
  const pending = [...rows.values()].filter(
    (row) => row.status === "pending" && !row.matched_transaction_id,
  );
  const posted = [...rows.values()].filter(
    (row) => row.status === "posted" && !targeted.has(row.id),
  );
  const links = matchCardAuthorizations(
    pending.map(candidate),
    posted.map(candidate),
  );
  return {
    records: [...updated.values()],
    afterPromoteStatements: cardAuthorizationLinkStatements(
      db,
      "taishin",
      links,
      encryptedConfig,
    ),
  };
}
