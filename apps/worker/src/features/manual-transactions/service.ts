import {
  MANUAL_CONNECTOR_ID,
  type ManualTransactionInput,
  type ManualTransactionType,
  type ManualTransactionsRequest,
  type ManualTransactionsResponse,
} from "@taiwan-fin-hub/shared";
import { listClassificationCategories } from "../classification/repository";
import { ClassificationCategoryNotFoundError } from "../classification/service";
import { rebuildBankDepositHistory } from "../net-worth/service";
import {
  deleteManualTransaction,
  findManualTransactionDate,
  listExistingManualTransactionDates,
  writeManualTransactions,
  type ManualTransactionRow,
} from "./repository";

export class ManualTransactionNotFoundError extends Error {}

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 補記較早的日期時，寫入當下往回重算歷史淨值的天數上限；更早的日期由歷史重建 API 處理。 */
const HISTORY_REFRESH_MAX_DAYS = 31;

const taipeiDate = (time: number) =>
  new Date(time + TAIPEI_OFFSET_MS).toISOString().slice(0, 10);

/**
 * 收支明確計入統計，因此不會被自動配成互轉；
 * 現金移動排除統計，並可與同日同額的銀行交易（例如 ATM 提款）配成互轉。
 */
const TYPE_RULES: Record<
  ManualTransactionType,
  { sign: 1 | -1; excludedFromCalculation: boolean }
> = {
  expense: { sign: -1, excludedFromCalculation: false },
  income: { sign: 1, excludedFromCalculation: false },
  transfer_in: { sign: 1, excludedFromCalculation: true },
  transfer_out: { sign: -1, excludedFromCalculation: true },
};

const manualTransactionId = (sourceId: string) =>
  `${MANUAL_CONNECTOR_ID}:${sourceId}`;

function toRow(input: ManualTransactionInput): ManualTransactionRow {
  const rule = TYPE_RULES[input.type];
  const sourceId = input.externalId ?? crypto.randomUUID();
  const isTransfer = rule.excludedFromCalculation;
  return {
    id: manualTransactionId(sourceId),
    sourceId,
    date: input.date,
    amount: rule.sign * input.amount,
    description: input.description,
    type: input.type,
    excludedFromCalculation: rule.excludedFromCalculation,
    // 手動分類會擋下互轉配對，現金移動不保留。
    categoryId: isTransfer ? null : input.categoryId,
    note: input.note === undefined ? undefined : input.note || null,
  };
}

export async function recordManualTransactions(
  db: D1Database,
  input: ManualTransactionsRequest,
): Promise<ManualTransactionsResponse> {
  const rows = (input.transactions ?? []).map(toRow);
  const categoryIds = new Set(
    rows.flatMap((row) => (row.categoryId ? [row.categoryId] : [])),
  );
  const [categories, existingDates] = await Promise.all([
    categoryIds.size > 0 ? listClassificationCategories(db) : [],
    listExistingManualTransactionDates(
      db,
      rows.map((row) => row.id),
    ),
  ]);
  const knownCategoryIds = new Set(categories.map((category) => category.id));
  if ([...categoryIds].some((id) => !knownCategoryIds.has(id)))
    throw new ClassificationCategoryNotFoundError();

  const now = new Date();
  const nowIso = now.toISOString();
  const adjustmentSourceId = `adjustment-${crypto.randomUUID()}`;
  const adjustment =
    input.balance === undefined
      ? undefined
      : {
          id: manualTransactionId(adjustmentSourceId),
          sourceId: adjustmentSourceId,
          date: taipeiDate(now.getTime()),
          target: input.balance,
        };
  const { balance, adjustmentAmount } = await writeManualTransactions(
    db,
    rows,
    adjustment,
    nowIso,
  );
  await refreshDepositHistory(db, now, [
    ...rows.map((row) => row.date),
    ...existingDates.values(),
  ]);
  return {
    transactions: rows.map((row) => ({
      id: row.id,
      externalId: row.sourceId,
      created: !existingDates.has(row.id),
    })),
    balance,
    ...(adjustment && adjustmentAmount !== undefined
      ? { adjustment: { id: adjustment.id, amount: adjustmentAmount } }
      : {}),
  };
}

export async function removeManualTransaction(db: D1Database, id: string) {
  const date = await findManualTransactionDate(db, id);
  if (date === undefined) throw new ManualTransactionNotFoundError();
  const now = new Date();
  const balance = await deleteManualTransaction(db, id, now.toISOString());
  await refreshDepositHistory(db, now, [date]);
  return { balance };
}

/**
 * 重算最早受影響日期到今天的存款歷史，補記過去日期時之後每一天的現金都會改變。
 * 記錄已寫入，更新失敗不讓呼叫端誤以為要重送；下次同步會再重建今天。
 */
async function refreshDepositHistory(
  db: D1Database,
  now: Date,
  affectedDates: string[],
) {
  const today = taipeiDate(now.getTime());
  const earliest = taipeiDate(
    now.getTime() - (HISTORY_REFRESH_MAX_DAYS - 1) * DAY_MS,
  );
  const first = affectedDates.reduce(
    (min, date) => (date < min ? date : min),
    today,
  );
  const dates: string[] = [];
  for (
    let time = Date.parse(first < earliest ? earliest : first);
    dates.length < HISTORY_REFRESH_MAX_DAYS;
    time += DAY_MS
  ) {
    const date = new Date(time).toISOString().slice(0, 10);
    if (date > today) break;
    dates.push(date);
  }
  try {
    await rebuildBankDepositHistory(db, dates);
  } catch (error) {
    console.error(
      "[manual-transactions] rebuild deposit history failed:",
      error,
    );
  }
}
