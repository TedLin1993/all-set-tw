import type { SyncWriteRecord } from "../../features/sync/persistence";
import {
  cardAuthorizationLinkStatements,
  mergeCardTransactionRows,
  reuseMatchedCardTargets,
  type CardTransactionRow,
} from "../../features/sync/card-authorization-write";
import {
  matchCardAuthorizations,
  type CardAuthorizationLink,
} from "../../features/sync/card-authorization-matching";

export type EsunCardRow = CardTransactionRow;

export type EsunAuthorizationLink = CardAuthorizationLink;

const CARD_SOURCE_PATTERN = "%:credit:esun:%";

function isRealtimeAuthorization(row: EsunCardRow) {
  let feed: unknown;
  try {
    feed = (JSON.parse(row.raw_payload || "{}") as { esunFeed?: unknown })
      .esunFeed;
  } catch {
    feed = undefined;
  }
  if (feed === "realtime") return true;
  if (feed === "history") return false;
  // Rows written before the feed marker existed: only realtime records carry
  // an authorization clock while still unposted.
  return (
    row.status === "pending" && /T\d{2}:\d{2}/.test(row.authorized_at ?? "")
  );
}

// Realtime and statement feeds name the same purchase differently (payment
// channel vs. merchant), so pairing relies on card, day, currency and amount.
export function matchEsunAuthorizations(
  rows: EsunCardRow[],
): EsunAuthorizationLink[] {
  const targeted = new Set(
    rows.map((row) => row.matched_transaction_id).filter(Boolean),
  );
  const candidate = (row: EsunCardRow) => ({
    id: row.id,
    sourceId: row.source_id,
    accountId: row.account_id,
    cardId: row.account_id.match(/:credit:esun:(\d{4})$/)?.[1],
    authorizedAt: row.authorized_at,
    amount: row.amount,
    currency: row.currency,
  });
  const realtime = rows.filter(
    (row) =>
      row.status === "pending" &&
      !row.matched_transaction_id &&
      isRealtimeAuthorization(row),
  );
  const history = rows.filter((row) => !isRealtimeAuthorization(row));
  // The history feed can still be pending. Attach realtime to those rows first
  // so a later posted name cannot leave a second pending copy visible.
  const pendingLinks = matchCardAuthorizations(
    realtime.map(candidate),
    history
      .filter((row) => row.status === "pending" && !targeted.has(row.id))
      .map(candidate),
  );
  const usedRealtime = new Set(pendingLinks.map((link) => link.id));
  const realtimeLinks = [
    ...pendingLinks,
    ...matchCardAuthorizations(
      realtime.filter((row) => !usedRealtime.has(row.id)).map(candidate),
      history
        .filter((row) => row.status === "posted" && !targeted.has(row.id))
        .map(candidate),
    ),
  ];
  const byTarget = new Map(realtimeLinks.map((link) => [link.posted, link]));
  const historicalPending = history
    .filter((row) => row.status === "pending")
    .map((row) => ({
      ...row,
      authorized_at: byTarget.get(row.id)?.authorizedAt ?? row.authorized_at,
    }));
  const newTargets = new Set(realtimeLinks.map((link) => link.posted));
  const historyLinks = matchCardAuthorizations(
    historicalPending
      .filter((row) => !row.matched_transaction_id)
      .map(candidate),
    history
      .filter(
        (row) =>
          row.status === "posted" &&
          !targeted.has(row.id) &&
          !newTargets.has(row.id),
      )
      .map(candidate),
  );
  return [
    ...realtimeLinks,
    ...historyLinks,
    // A newly arrived realtime clock/preference must reach an established
    // history→posted link as well, without changing that relationship.
    ...historicalPending
      .filter((row) => row.matched_transaction_id && byTarget.has(row.id))
      .map((row) => ({
        id: row.id,
        posted: row.matched_transaction_id!,
        authorizedAt: row.authorized_at,
      })),
  ];
}

export async function prepareEsunAuthorizationWrite(
  db: D1Database,
  records: SyncWriteRecord[],
) {
  const stored = (
    await db
      .prepare(
        `SELECT * FROM bank_transactions WHERE connector_id = 'esun' AND source_id LIKE ?`,
      )
      .bind(CARD_SOURCE_PATTERN)
      .all<EsunCardRow>()
  ).results;
  const preparedRecords = reuseMatchedCardTargets(stored, records);
  const incoming = preparedRecords.filter(
    (record) =>
      record.entityType === "bank_transaction" &&
      record.payload.connector_id === "esun" &&
      String(record.payload.source_id).includes(":credit:esun:"),
  );
  const rows = mergeCardTransactionRows(stored, incoming);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const links = matchEsunAuthorizations(rows);
  const realtimeLinks = links.filter((link) =>
    isRealtimeAuthorization(byId.get(link.id)!),
  );
  const historyLinks = links.filter(
    (link) => !isRealtimeAuthorization(byId.get(link.id)!),
  );
  return {
    records: preparedRecords,
    afterPromoteStatements: [
      ...cardAuthorizationLinkStatements(db, "esun", realtimeLinks),
      ...cardAuthorizationLinkStatements(db, "esun", historyLinks),
    ],
  };
}
