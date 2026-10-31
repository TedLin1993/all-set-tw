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
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    settingsGuard,
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
