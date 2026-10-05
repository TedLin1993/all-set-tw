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
  SyncAlreadyRunningError,
  ManualCaptchaRequiredError,
  NeedsUserActionError,
} from "../../features/sync/errors";
import {
  requireConnectorSettings,
  encryptConnectorConfig,
  serializePublicConfig,
} from "../../features/sync/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import { configEncryptionKey } from "../../platform/config";
import { parseRakutenConfig } from "./protocol";
import {
  prepareRakutenCaptcha,
  createRakutenConnector,
  RakutenVerificationRequiredError,
  RakutenAutoCaptchaFailedError,
} from "./connector";
import {
  updateConnectorEncryptedConfig,
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
} from "../../features/sync/connector-repository";
import { parsePublicConnectorConfig } from "../../features/sync/connector-state";
import { recognizeAlphanumericCaptcha } from "../../features/ocr/service";
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

export type RakutenSyncOverrides = {
  captcha?: string;
};

export async function prepareRakutenCaptchaSession(env: Env) {
  const connectorId = "rakuten";
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
      const publicStored = settings.public_config
        ? JSON.parse(settings.public_config)
        : {};
      const config = parseRakutenConfig({ ...stored, ...publicStored });
      const prepared = await prepareRakutenCaptcha(env.BROWSER, config);
      await updateConnectorEncryptedConfig(
        env.DB,
        connectorId,
        await encryptJson(
          {
            ...stored,
            browserSessionId: prepared.browserSessionId,
            browserSessionExpiresAt: prepared.browserSessionExpiresAt,
          },
          configEncryptionKey(env),
        ),
      );
      return {
        captchaImage: prepared.captchaImage,
        expiresAt: prepared.browserSessionExpiresAt,
        captchaLength: prepared.captchaLength,
        captchaKind: "alphanumeric" as const,
      };
    });
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

/**
 * 樂天國銀 connector：不復用 session／cookie，每次同步都重新登入。
 * 有使用者剛取得的人工驗證碼時優先使用；否則（含排程同步）以 Workers AI
 * 自動辨識，失敗時拋出 ManualCaptchaRequiredError（needs_user_action），
 * 排程會停止挑選這個 job，直到使用者以人工驗證碼同步成功。成功或失敗後都
 * 要清除 `browserSessionId`／`browserSessionExpiresAt`／`captcha`。
 */
export async function syncRakuten(
  env: Env,
  trigger: SyncTrigger,
  overrides: RakutenSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "rakuten";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseRakutenConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...overrides,
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<
    ReturnType<ReturnType<typeof createRakutenConnector>["sync"]>
  >;
  try {
    const connector = createRakutenConnector(
      env.BROWSER,
      overrides.captcha
        ? undefined
        : async (imageBytes, characterCount, contentType = "image/png") => {
            try {
              return (
                await recognizeAlphanumericCaptcha(
                  env.AI,
                  imageBytes,
                  contentType,
                  characterCount,
                )
              ).code;
            } catch {
              throw new RakutenVerificationRequiredError(
                "樂天圖形驗證碼無法自動辨識，請改用人工輸入。",
              );
            }
          },
    );
    result = await connector.sync(config);
  } catch (error) {
    const cleaned = rakutenStoredConfigAfterSync(stored);
    await updateConnectorEncryptedConfig(
      env.DB,
      connectorId,
      await encryptJson(cleaned, configEncryptionKey(env)),
    );
    // 自動辨識失敗一樣是 needs_user_action：排程會停止挑選這個 job，直到
    // 使用者以人工驗證碼同步成功為止，避免反覆自動登入觸發帳號鎖定。
    if (error instanceof RakutenAutoCaptchaFailedError) {
      throw new ManualCaptchaRequiredError(error.message);
    }
    if (error instanceof RakutenVerificationRequiredError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
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

  // 沒有 session／cookie 可以復用，challenge 一律一次性消耗：無論成不成功都
  // 要清掉 browserSessionId／captcha，只保留一個不含機密資料的稽核用 cursor。
  const cleanedConfig = rakutenStoredConfigAfterSync(config);
  const persistedCursor = JSON.stringify({ lastSyncedAt: now });
  const finalizeStatements: D1PreparedStatement[] = [
    connectorStateStatement(
      env.DB,
      connectorId,
      await encryptConnectorConfig(env, connectorId, cleanedConfig),
      serializePublicConfig(connectorId, cleanedConfig),
      persistedCursor,
      now,
    ),
  ];

  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    afterPromoteStatements:
      bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB)]
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
    records:
      bankAccounts.length +
      bankBalanceSnapshots.length +
      bankTransactions.length,
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}

export function rakutenStoredConfigAfterSync(stored: Record<string, unknown>) {
  const cleaned = { ...stored };
  delete cleaned.browserSessionId;
  delete cleaned.browserSessionExpiresAt;
  delete cleaned.captcha;
  return cleaned;
}
