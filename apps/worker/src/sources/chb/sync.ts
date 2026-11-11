import { createSyncExecution } from "../../features/sync/execution";
import type { Env } from "../../platform/env";
import { canonicalSyncLockRowId } from "../../features/sync/lock";
import {
  acquireSyncJobLock,
  releaseSyncJobLock,
  type SyncTrigger,
} from "../../db";
import { SYNC_SCOPE_ALL, type SyncOutcome } from "../../features/sync/types";
import {
  ManualCaptchaRequiredError,
  NeedsUserActionError,
  SyncAlreadyRunningError,
} from "../../features/sync/errors";
import {
  requireConnectorSettings,
  encryptConnectorConfig,
  serializePublicConfig,
} from "../../features/sync/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import { configEncryptionKey } from "../../platform/config";
import { parseChbConfig, type ChbConfig } from "./protocol";
import {
  createChbConnector,
  ChbAutoCaptchaFailedError,
  ChbVerificationRequiredError,
  prepareChbCaptcha,
} from "./connector";
import {
  updateConnectorEncryptedConfigIfCurrent,
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
} from "../../features/sync/connector-repository";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../features/sync/connector-state";
import { recognizeNumericCaptcha } from "../../features/ocr/service";
import {
  type SyncWriteRecord,
  persistStagedSyncWrite,
} from "../../features/sync/persistence";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
} from "../../features/sync/record-mapper";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../features/net-worth/service";

export type ChbSyncOverrides = {
  captcha?: string;
};

/** 一次性驗證狀態；同步成功、失敗或逾時後都從加密設定移除。 */
const CHALLENGE_FIELDS = [
  "browserSessionId",
  "browserSessionExpiresAt",
  "captchaDigitCount",
  "captcha",
] as const;

function withoutChallenge<T extends Record<string, unknown>>(value: T) {
  const cleaned: Record<string, unknown> = { ...value };
  for (const key of CHALLENGE_FIELDS) delete cleaned[key];
  return cleaned;
}

const CHB_V1_PREFIX = "chb:deposit:tx:v1:";
const CHB_V2_PREFIX = "chb:deposit:tx:v2:";

export type ChbExistingDeposit = {
  id: string;
  accountId: string;
  sourceId: string;
  postedDate: string | null;
  amount: number;
  currency: string;
  description: string | null;
  rawPayload: string | null;
  createdAt: string;
};

export type ChbIncomingDeposit = {
  accountId: string;
  sourceId: string;
  postedDate?: string | null;
  amount: number;
  currency?: string;
  description?: string | null;
  raw?: unknown;
};

function chbRawMeta(raw: unknown): {
  balanceAfter: string;
  adjustment: string;
} {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object")
        obj = parsed as Record<string, unknown>;
    } catch {
      obj = null;
    }
  } else if (raw && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  }
  const bal = obj?.balanceAfter;
  const balanceAfter =
    typeof bal === "number" && Number.isFinite(bal) ? bal.toFixed(2) : "";
  const adj = Boolean(obj?.adjustment) ? "1" : "0";
  return { balanceAfter, adjustment: adj };
}

function chbMatchKey(row: {
  accountId: string;
  postedDate?: string | null;
  currency?: string;
  amount: number;
  description?: string | null;
  balanceAfter: string;
  adjustment: string;
}) {
  return JSON.stringify([
    row.accountId,
    row.postedDate ?? "",
    row.currency || "TWD",
    row.amount.toFixed(2),
    (row.description ?? "").replace(/\s+/g, " ").trim(),
    row.balanceAfter,
    row.adjustment,
  ]);
}

function compareText(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** 規劃既有 v1 彰化銀行存款列升級為新 v2 sourceId 的寫入清單，保留原列 id 與偏好設定。 */
export function planChbSourceIdUpgrades(
  incoming: readonly ChbIncomingDeposit[],
  existing: readonly ChbExistingDeposit[],
): Array<{ id: string; oldSourceId: string; newSourceId: string }> {
  const bySourceId = new Map<string, ChbExistingDeposit>();
  const byMatchKey = new Map<string, ChbExistingDeposit[]>();
  for (const row of existing) {
    bySourceId.set(`${row.accountId}\u0000${row.sourceId}`, row);
    if (!row.sourceId.startsWith(CHB_V1_PREFIX)) continue;
    const meta = chbRawMeta(row.rawPayload);
    const key = chbMatchKey({ ...row, ...meta });
    const bucket = byMatchKey.get(key) ?? [];
    bucket.push(row);
    byMatchKey.set(key, bucket);
  }
  for (const bucket of byMatchKey.values()) {
    bucket.sort(
      (left, right) =>
        compareText(left.createdAt, right.createdAt) ||
        compareText(left.id, right.id),
    );
  }

  const claimed = new Set<string>();
  const targets = new Set<string>();
  const candidates: ChbIncomingDeposit[] = [];
  for (const row of incoming) {
    if (!row.sourceId.startsWith(CHB_V2_PREFIX)) continue;
    const exact = bySourceId.get(`${row.accountId}\u0000${row.sourceId}`);
    if (exact) claimed.add(exact.id);
    else candidates.push(row);
  }

  candidates.sort(
    (left, right) =>
      compareText(left.postedDate ?? "", right.postedDate ?? "") ||
      compareText(left.sourceId, right.sourceId),
  );

  const upgrades: Array<{
    id: string;
    oldSourceId: string;
    newSourceId: string;
  }> = [];
  for (const row of candidates) {
    if (targets.has(`${row.accountId}\u0000${row.sourceId}`)) continue;
    const meta = chbRawMeta(row.raw ?? row);
    const key = chbMatchKey({ ...row, ...meta });
    const match = byMatchKey
      .get(key)
      ?.find((candidate) => !claimed.has(candidate.id));
    if (!match) continue;
    claimed.add(match.id);
    targets.add(`${row.accountId}\u0000${row.sourceId}`);
    upgrades.push({
      id: match.id,
      oldSourceId: match.sourceId,
      newSourceId: row.sourceId,
    });
  }
  return upgrades;
}

export async function loadChbSourceIdUpgradeStatements(
  db: D1Database,
  incoming: readonly ChbIncomingDeposit[],
): Promise<D1PreparedStatement[]> {
  const dates = incoming
    .filter((row) => row.sourceId.startsWith(CHB_V2_PREFIX))
    .map((row) => row.postedDate)
    .filter((date): date is string => Boolean(date))
    .sort();
  if (dates.length === 0) return [];
  const existing = await db
    .prepare(
      `SELECT t.id AS id,
              a.source_id AS accountId,
              t.source_id AS sourceId,
              t.posted_date AS postedDate,
              t.amount AS amount,
              t.currency AS currency,
              t.description AS description,
              t.raw_payload AS rawPayload,
              t.created_at AS createdAt
         FROM bank_transactions t
         JOIN bank_accounts a ON a.id = t.account_id
        WHERE t.connector_id = 'chb'
          AND (t.source_id LIKE 'chb:deposit:tx:v1:%' OR t.source_id LIKE 'chb:deposit:tx:v2:%')
          AND t.posted_date BETWEEN ? AND ?`,
    )
    .bind(dates[0], dates[dates.length - 1])
    .all<ChbExistingDeposit>();
  const upgrades = planChbSourceIdUpgrades(incoming, existing.results);
  return upgrades.map((u) =>
    db
      .prepare(
        `UPDATE bank_transactions
            SET source_id = ?
          WHERE id = ?
            AND connector_id = 'chb'
            AND source_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM bank_transactions conflict
               WHERE conflict.connector_id = 'chb'
                 AND conflict.account_id = bank_transactions.account_id
                 AND conflict.source_id = ?
            )`,
      )
      .bind(u.newSourceId, u.id, u.oldSourceId, u.newSourceId),
  );
}

/** 人工驗證碼：開啟登入頁取得驗證碼圖片，保留 Browser session 等待使用者輸入。 */
export async function prepareChbCaptchaSession(env: Env) {
  const connectorId = "chb";
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId(connectorId);
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope: SYNC_SCOPE_ALL,
    trigger: "manual",
    runId,
    leaseMs: 3 * 60 * 1000,
  });
  if (!locked) throw new SyncAlreadyRunningError(connectorId);

  const execution = createSyncExecution(
    env,
    { lockRowId, runId },
    { deadline: Date.now() + 3 * 60 * 1000 },
  );
  try {
    return await execution.run(async (env) => {
      const settings = await requireConnectorSettings(env.DB, connectorId);
      const stored = await decryptJson<Record<string, unknown>>(
        settings.encrypted_config,
        configEncryptionKey(env),
      );
      const config = parseChbConfig({
        ...stored,
        ...parsePublicConnectorConfig(connectorId, settings.public_config),
      });
      const prepared = await prepareChbCaptcha(env.BROWSER, config);
      const saved = await updateConnectorEncryptedConfigIfCurrent(
        env.DB,
        connectorId,
        settings.encrypted_config,
        await encryptJson(
          {
            ...withoutChallenge(stored),
            browserSessionId: prepared.browserSessionId,
            browserSessionExpiresAt: prepared.browserSessionExpiresAt,
            captchaDigitCount: prepared.captchaDigitCount,
          },
          configEncryptionKey(env),
        ),
      );
      if (!saved) {
        throw new NeedsUserActionError(
          "彰化銀行設定在驗證期間已變更，請重新取得驗證碼。",
        );
      }
      return {
        captchaImage: prepared.captchaImage,
        expiresAt: prepared.browserSessionExpiresAt,
        digitCount: prepared.captchaDigitCount,
        captchaKind: "numeric" as const,
      };
    });
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

/**
 * 彰化銀行 connector：不復用網銀 session，每次同步重新登入並於結束時登出。
 * 有使用者剛取得的人工驗證碼時優先使用；否則（含排程同步）以 Workers AI 自動辨識，
 * 連續失敗時拋出 ManualCaptchaRequiredError（needs_user_action）。
 */
export async function syncChb(
  env: Env,
  trigger: SyncTrigger,
  overrides: ChbSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "chb";
  const scope = SYNC_SCOPE_ALL;
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  // 排程同步不得接續任何人工驗證狀態。
  const config: ChbConfig = parseChbConfig({
    ...(trigger === "manual" ? stored : withoutChallenge(stored)),
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...(trigger === "manual" ? overrides : {}),
  });
  if (!overrides.captcha) {
    delete config.captcha;
    delete config.browserSessionId;
    delete config.browserSessionExpiresAt;
  }

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  const reusableStored = withoutChallenge(stored);
  let result: Awaited<
    ReturnType<ReturnType<typeof createChbConnector>["sync"]>
  >;
  try {
    result = await createChbConnector(
      env.BROWSER,
      async (imageBytes, contentType, digitCount) =>
        (
          await recognizeNumericCaptcha(
            env.AI,
            imageBytes,
            contentType,
            digitCount,
          )
        ).number,
    ).sync(config, settings.sync_cursor ?? undefined);
  } catch (error) {
    const saved = await updateConnectorEncryptedConfigIfCurrent(
      env.DB,
      connectorId,
      settings.encrypted_config,
      await encryptJson(reusableStored, configEncryptionKey(env)),
    );
    if (!saved) {
      throw new NeedsUserActionError(
        "彰化銀行設定在同步期間已變更，請重新同步。",
      );
    }
    // 自動辨識失敗改走人工驗證碼；排程會停止挑選此 job，直到手動同步成功。
    if (error instanceof ChbAutoCaptchaFailedError) {
      throw new ManualCaptchaRequiredError(error.message);
    }
    if (error instanceof ChbVerificationRequiredError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
  }

  if (result.syncWarning) {
    // 同步結果目前沒有 partial 狀態，以摘要 log 呈現略過的資料。
    console.warn(
      `[sync] ${connectorId}/${scope}: partial ${result.syncWarning}`,
    );
  }
  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  const bankTransactions = result.bankTransactions ?? [];
  const now = new Date().toISOString();
  const records: SyncWriteRecord[] = [
    ...bankAccounts.map((account) =>
      bankAccountRecord(connectorId, account, now),
    ),
    ...bankBalanceSnapshots.map((snapshot) =>
      bankBalanceSnapshotRecord(connectorId, snapshot, now),
    ),
    ...bankTransactions.map((transaction) =>
      bankTransactionRecord(connectorId, transaction, now),
    ),
  ];

  const cursorState = splitConnectorCursorState(
    connectorId,
    result.cursor ?? "{}",
  );
  const persistedCursor = cursorState.safeCursor;
  const reusableConfig = parseChbConfig(withoutChallenge(config));
  const settingsGuard = {
    connectorId,
    encryptedConfig: settings.encrypted_config,
  } as const;
  const finalizeStatements: D1PreparedStatement[] = [
    connectorStateStatement(
      env.DB,
      connectorId,
      await encryptConnectorConfig(env, connectorId, reusableConfig),
      serializePublicConfig(connectorId, reusableConfig),
      persistedCursor,
      now,
      settings.encrypted_config,
    ),
  ];

  // 只有存款：沒有信用卡授權 feed，不接共用授權配對。
  const upgradeStatements = await loadChbSourceIdUpgradeStatements(
    env.DB,
    bankTransactions,
  );
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    settingsGuard,
    beforePromoteStatements: upgradeStatements,
    afterPromoteStatements:
      bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB, settingsGuard)]
        : [],
    finalizeStatements,
  });

  if (bankBalanceSnapshots.length > 0) {
    await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  }

  return {
    success: true,
    connectorId,
    scope,
    records: records.length,
    newRecords,
    cursorUpdated: persistedCursor !== settings.sync_cursor,
  };
}
