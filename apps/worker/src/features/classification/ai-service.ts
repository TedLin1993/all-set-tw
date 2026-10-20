import {
  deduplicateBankTransactions,
  matchInvoicesToTransactions,
  type AiClassificationStatusResponse,
} from "@taiwan-fin-hub/shared";
import type { Env } from "../../platform/env";
import { sanitizeDatabaseError } from "../../db/errors";
import { getBankRange } from "../bank/service";
import { getInvoicesRange } from "../invoices/service";
import { listInvoiceItems } from "../invoices/repository";
import { listInvoiceTransactionPreferences } from "../activity/repository";
import { getClassificationCategories } from "./service";
import {
  AI_CLASSIFICATION_MODEL,
  aiClassificationInputHash,
  buildAiClassificationRequest,
  hasClassifiableText,
  isAiQuotaExceededError,
  isTransientAiError,
  readAiClassificationAnswer,
  type AiCategory,
  type AiClassificationInput,
} from "./ai-classifier";
import {
  addAiClassificationQuotaUse,
  countAiClassifications,
  deleteAllAiClassifications,
  findEarliestBankTransactionMonth,
  getAiClassificationSettings,
  listAiClassifications,
  listBankTransactionIdsCreatedSince,
  readAiClassificationWatermark,
  updateAiClassificationSettings,
  updateAiClassificationScan,
  upsertAiClassification,
  type AiClassificationSettingsRow,
} from "./ai-repository";

/**
 * Leaves about half of the 10,000-neuron daily free allocation for CAPTCHA
 * recognition: a Clef call over one transaction costs roughly 2.5 neurons.
 */
export const AI_CLASSIFICATION_DAILY_CALL_LIMIT = 2_000;
/** Keeps each Queue invocation well inside the subrequest limits. */
export const AI_CLASSIFICATION_CALLS_PER_INVOCATION = 25;
const MONTHS_PER_INVOCATION = 6;
/** Months scanned after a sync: invoices can arrive weeks after the charge. */
const RECENT_SCAN_MONTHS = 3;
const STALLED_SCAN_MS = 5 * 60 * 1000;
export const AI_CLASSIFICATION_CHAIN_DELAY_SECONDS = 1;

export class AiClassificationDisabledError extends Error {}

const TAIPEI_OFFSET_MS = 8 * 60 * 60 * 1000;

function taipeiMonth(now: Date) {
  return new Date(now.getTime() + TAIPEI_OFFSET_MS).toISOString().slice(0, 7);
}

function shiftMonth(month: string, months: number) {
  const [year, value] = month.split("-").map(Number);
  const date = new Date(Date.UTC(year, value - 1 + months, 1));
  return date.toISOString().slice(0, 7);
}

function utcDay(now: Date) {
  return now.toISOString().slice(0, 10);
}

function nextUtcMidnight(now: Date) {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  ).toISOString();
}

function presentStatus(
  row: AiClassificationSettingsRow,
  counts: { classified: number; undetermined: number },
): AiClassificationStatusResponse {
  return {
    enabled: row.enabled === 1,
    scanning: row.scanMode !== null,
    pausedUntil: row.pausedUntil,
    backfill: {
      status: row.backfillStatus,
      classifiedCount: row.backfillClassifiedCount,
      undeterminedCount: row.backfillUndeterminedCount,
      startedAt: row.backfillStartedAt,
      completedAt: row.backfillCompletedAt,
    },
    classifiedCount: counts.classified,
    undeterminedCount: counts.undetermined,
  };
}

export async function getAiClassificationStatus(db: D1Database) {
  const [row, counts] = await Promise.all([
    getAiClassificationSettings(db),
    countAiClassifications(db),
  ]);
  return presentStatus(row, counts);
}

/**
 * Turning it on starts no scan: only activity synced afterwards is classified
 * automatically, and older records wait for the user to start a backfill.
 * Turning it off stops new work; results already stored stay applied.
 */
export async function setAiClassificationEnabled(
  env: Env,
  enabled: boolean,
  now = new Date(),
) {
  const row = await getAiClassificationSettings(env.DB);
  if (enabled && row.enabled !== 1)
    await updateAiClassificationSettings(env.DB, {
      enabled: 1,
      enabledAt: now.toISOString(),
      // The data as it is now is the baseline; only later syncs start a scan.
      scannedWatermark: await readAiClassificationWatermark(env.DB),
    });
  if (!enabled && row.enabled === 1)
    await updateAiClassificationSettings(env.DB, {
      enabled: 0,
      scanMode: null,
      scanId: null,
      pausedUntil: null,
      backfillStatus:
        row.backfillStatus === "running" ? "idle" : row.backfillStatus,
    });
  return getAiClassificationStatus(env.DB);
}

export async function startAiClassificationBackfill(
  env: Env,
  now = new Date(),
) {
  const row = await getAiClassificationSettings(env.DB);
  if (row.enabled !== 1) throw new AiClassificationDisabledError();
  const earliest = await findEarliestBankTransactionMonth(env.DB);
  const startedAt = now.toISOString();
  if (!earliest) {
    await updateAiClassificationSettings(env.DB, {
      scanMode: null,
      scanId: null,
      backfillStatus: "completed",
      backfillClassifiedCount: 0,
      backfillUndeterminedCount: 0,
      backfillStartedAt: startedAt,
      backfillCompletedAt: startedAt,
    });
    return getAiClassificationStatus(env.DB);
  }
  await updateAiClassificationSettings(env.DB, {
    scanMode: "backfill",
    // Replaces any running scan; its later writes no longer match.
    scanId: crypto.randomUUID(),
    scanMonth: taipeiMonth(now),
    // A timestamped first transaction may fall on the previous Taipei month.
    scanStopMonth: shiftMonth(earliest, -1),
    pausedUntil: null,
    backfillStatus: "running",
    backfillClassifiedCount: 0,
    backfillUndeterminedCount: 0,
    backfillStartedAt: startedAt,
    backfillCompletedAt: null,
  });
  await enqueueAiClassification(env);
  return getAiClassificationStatus(env.DB);
}

export async function clearAiClassificationResults(db: D1Database) {
  // Stop the running scan first, so it cannot write results after the delete.
  await updateAiClassificationSettings(db, {
    scanMode: null,
    scanId: null,
    scannedWatermark: null,
    pausedUntil: null,
    backfillStatus: "idle",
    backfillClassifiedCount: 0,
    backfillUndeterminedCount: 0,
    backfillStartedAt: null,
    backfillCompletedAt: null,
  });
  await deleteAllAiClassifications(db);
  return getAiClassificationStatus(db);
}

export async function enqueueAiClassification(env: Env, delaySeconds = 0) {
  const message = { type: "run-ai-classification" } as const;
  if (delaySeconds > 0) await env.SYNC_QUEUE.send(message, { delaySeconds });
  else await env.SYNC_QUEUE.send(message);
}

/**
 * Called by every Cron tick: resumes a paused or stalled scan, or starts a
 * recent scan once a sync has written new transactions or invoices.
 */
export async function kickAiClassification(env: Env, now = new Date()) {
  const row = await getAiClassificationSettings(env.DB);
  if (row.enabled !== 1) return;
  if (row.scanMode) {
    if (row.pausedUntil && row.pausedUntil > now.toISOString()) return;
    const stalled = now.getTime() - Date.parse(row.updatedAt) > STALLED_SCAN_MS;
    if (!row.pausedUntil && !stalled) return;
    await updateAiClassificationSettings(env.DB, { pausedUntil: null });
    await enqueueAiClassification(env);
    return;
  }
  const watermark = await readAiClassificationWatermark(env.DB);
  if (watermark === row.scannedWatermark) return;
  const month = taipeiMonth(now);
  await updateAiClassificationSettings(env.DB, {
    scanMode: "recent",
    scanId: crypto.randomUUID(),
    scanMonth: month,
    scanStopMonth: shiftMonth(month, -(RECENT_SCAN_MONTHS - 1)),
    scanWatermark: watermark,
  });
  await enqueueAiClassification(env);
}

export async function safelyKickAiClassification(env: Env) {
  try {
    await kickAiClassification(env);
  } catch (error) {
    const safeError = sanitizeDatabaseError(error);
    console.error(
      JSON.stringify({
        event: "ai_classification_kick_failed",
        message:
          safeError instanceof Error ? safeError.message : String(safeError),
      }),
    );
  }
}

type MonthResult = {
  calls: number;
  classified: number;
  undetermined: number;
  complete: boolean;
  quotaExceeded: boolean;
  transientFailure: boolean;
  /** The scan was replaced or its results cleared while it ran. */
  stale: boolean;
};

async function classifyMonth(
  env: Env,
  scanId: string,
  month: string,
  callLimit: number,
  categories: AiCategory[],
  /** Recent scans skip records that existed before AI was enabled. */
  newSince: string | null,
): Promise<MonthResult> {
  const result: MonthResult = {
    calls: 0,
    classified: 0,
    undetermined: 0,
    complete: true,
    quotaExceeded: false,
    transientFailure: false,
    stale: false,
  };
  const range = { from: `${month}-01`, to: `${shiftMonth(month, 1)}-01` };
  const bank = await getBankRange(env.DB, range);
  const transactions = deduplicateBankTransactions(bank.transactions);
  // Only what every deterministic step left unclassified. An AI answer is
  // never revisited until the user clears the results; an undetermined one
  // is retried when its input (for example a late invoice) changes.
  // Pending rows are included so they show a category before posting; one
  // already linked to another row is hidden by getBankRange, and its posted
  // row is classified on its own merchant name.
  const candidates = transactions.filter(
    (transaction) => transaction.classification?.source === "fallback",
  );
  if (candidates.length === 0) return result;

  const candidateIds = candidates.map((transaction) => transaction.id);
  const [invoices, preferences, stored, createdSince] = await Promise.all([
    getInvoicesRange(env.DB, range),
    listInvoiceTransactionPreferences(env.DB, range),
    listAiClassifications(env.DB, candidateIds),
    newSince
      ? listBankTransactionIdsCreatedSince(env.DB, candidateIds, newSince)
      : Promise.resolve(null),
  ]);
  const matches = matchInvoicesToTransactions(
    transactions,
    invoices,
    preferences,
  );
  const items = await listInvoiceItems(
    env.DB,
    candidates.flatMap((transaction) => {
      const invoice = matches.transactionToInvoice.get(transaction.id);
      return invoice ? [invoice.id] : [];
    }),
  );
  const storedHashes = new Map(
    stored.map((row) => [row.transactionId, row.inputHash]),
  );

  const pending: Array<{
    id: string;
    input: AiClassificationInput;
    hash: string;
  }> = [];
  for (const transaction of candidates) {
    // A record from before enabling is only sent once the user ran a
    // backfill over it; after that an undetermined answer may be retried.
    if (
      createdSince &&
      !createdSince.has(transaction.id) &&
      !storedHashes.has(transaction.id)
    )
      continue;
    const invoice = matches.transactionToInvoice.get(transaction.id);
    const input: AiClassificationInput = {
      date: transaction.authorizedAt ?? transaction.postedDate ?? month,
      accountType: transaction.accountType ?? null,
      amount: transaction.amount,
      currency: transaction.currency,
      description: transaction.description ?? null,
      counterparty: transaction.counterparty ?? null,
      invoice: invoice
        ? {
            sellerName: invoice.sellerName ?? null,
            items: items
              .filter((item) => item.invoiceId === invoice.id)
              .map((item) => item.description),
          }
        : undefined,
    };
    if (!hasClassifiableText(input)) continue;
    const hash = await aiClassificationInputHash(input);
    if (storedHashes.get(transaction.id) === hash) continue;
    pending.push({ id: transaction.id, input, hash });
  }

  for (const { id, input, hash } of pending) {
    if (result.calls >= callLimit) {
      result.complete = false;
      break;
    }
    result.calls += 1;
    let answer;
    try {
      const request = buildAiClassificationRequest(input, categories);
      answer = readAiClassificationAnswer(
        await env.AI.run(
          AI_CLASSIFICATION_MODEL as Parameters<Ai["run"]>[0],
          request as never,
        ),
        Object.keys(request.questions.category.criteria),
      );
    } catch (error) {
      if (isAiQuotaExceededError(error)) {
        result.quotaExceeded = true;
        result.complete = false;
        break;
      }
      if (isTransientAiError(error)) {
        result.transientFailure = true;
        result.complete = false;
        break;
      }
      // A request the model rejects would fail again; record it as
      // undetermined so the scan does not retry it forever.
      console.error(
        JSON.stringify({
          event: "ai_classification_failed",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      answer = { categoryId: null, probability: 0 };
    }
    const saved = await upsertAiClassification(env.DB, scanId, {
      transactionId: id,
      categoryId: answer.categoryId,
      probability: answer.probability,
      inputHash: hash,
      model: AI_CLASSIFICATION_MODEL,
    });
    if (!saved) {
      result.stale = true;
      result.complete = false;
      break;
    }
    if (answer.categoryId) result.classified += 1;
    else result.undetermined += 1;
  }
  return result;
}

export type AiClassificationRunResult = {
  status: "continue" | "done" | "paused";
};

/** Processes one Queue message's share of the active scan. */
export async function processAiClassification(
  env: Env,
  now = new Date(),
): Promise<AiClassificationRunResult> {
  const row = await getAiClassificationSettings(env.DB);
  if (
    row.enabled !== 1 ||
    !row.scanMode ||
    !row.scanId ||
    !row.scanMonth ||
    !row.scanStopMonth
  )
    return { status: "done" };
  if (row.pausedUntil && row.pausedUntil > now.toISOString())
    return { status: "paused" };

  const today = utcDay(now);
  let quotaUsed = row.quotaDay === today ? row.quotaUsed : 0;
  const categories = await getClassificationCategories(env.DB);
  let month = row.scanMonth;
  let classified = 0;
  let undetermined = 0;
  let pausedUntil: string | null = null;
  let finished = false;
  let retryLater = false;
  let stale = false;
  let invocationCalls = 0;

  for (let scanned = 0; scanned < MONTHS_PER_INVOCATION; scanned++) {
    const dailyCallsLeft = AI_CLASSIFICATION_DAILY_CALL_LIMIT - quotaUsed;
    if (dailyCallsLeft <= 0) {
      pausedUntil = nextUtcMidnight(now);
      break;
    }
    const callLimit = Math.min(
      AI_CLASSIFICATION_CALLS_PER_INVOCATION - invocationCalls,
      dailyCallsLeft,
    );
    if (callLimit <= 0) break;
    const monthResult = await classifyMonth(
      env,
      row.scanId,
      month,
      callLimit,
      categories,
      row.scanMode === "recent" ? (row.enabledAt ?? now.toISOString()) : null,
    );
    invocationCalls += monthResult.calls;
    quotaUsed += monthResult.calls;
    classified += monthResult.classified;
    undetermined += monthResult.undetermined;
    if (monthResult.stale) {
      stale = true;
      break;
    }
    if (monthResult.quotaExceeded) {
      pausedUntil = nextUtcMidnight(now);
      break;
    }
    if (monthResult.transientFailure) {
      // Left for the Cron tick, which resumes a scan idle for 5 minutes.
      retryLater = true;
      break;
    }
    if (!monthResult.complete) break;
    const previous = shiftMonth(month, -1);
    if (previous < row.scanStopMonth) {
      finished = true;
      break;
    }
    month = previous;
  }

  if (invocationCalls > 0)
    await addAiClassificationQuotaUse(env.DB, today, invocationCalls);
  // A replaced scan stops here; the newer scan owns the progress fields.
  if (stale) return { status: "done" };
  const completedAt = now.toISOString();
  const current = await updateAiClassificationScan(env.DB, row.scanId, {
    pausedUntil,
    scanMonth: month,
    ...(row.scanMode === "backfill"
      ? {
          backfillClassifiedCount: row.backfillClassifiedCount + classified,
          backfillUndeterminedCount:
            row.backfillUndeterminedCount + undetermined,
        }
      : {}),
    ...(finished
      ? {
          scanMode: null,
          scanId: null,
          ...(row.scanMode === "backfill"
            ? {
                backfillStatus: "completed" as const,
                backfillCompletedAt: completedAt,
              }
            : { scannedWatermark: row.scanWatermark }),
        }
      : {}),
  });
  if (!current || finished) return { status: "done" };
  if (pausedUntil || retryLater) return { status: "paused" };
  return { status: "continue" };
}
