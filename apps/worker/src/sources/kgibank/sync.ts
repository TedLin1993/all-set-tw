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
  NeedsUserActionError,
} from "../../features/sync/errors";
import {
  requireConnectorSettings,
  encryptConnectorConfig,
  serializePublicConfig,
} from "../../features/sync/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import { configEncryptionKey } from "../../platform/config";
import { parseKgibankConfig } from "./protocol";
import {
  prepareKgibankCaptcha,
  createKgibankConnector,
  KgibankVerificationRequiredError,
} from "./connector";
import {
  updateConnectorEncryptedConfig,
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

export type KgibankSyncOverrides = {
  captcha?: string;
};

export async function prepareKgibankCaptchaSession(env: Env) {
  const connectorId = "kgibank";
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
      const config = parseKgibankConfig({ ...stored, ...publicStored });
      const prepared = await prepareKgibankCaptcha(env.BROWSER, config);
      await updateConnectorEncryptedConfig(
        env.DB,
        connectorId,
        await encryptJson(
          {
            ...stored,
            browserSessionId: prepared.browserSessionId,
            browserSessionExpiresAt: prepared.browserSessionExpiresAt,
            captchaDigitCount: prepared.captchaDigitCount,
          },
          configEncryptionKey(env),
        ),
      );
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

export async function syncKgibank(
  env: Env,
  trigger: SyncTrigger,
  overrides: KgibankSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "kgibank";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseKgibankConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...overrides,
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  // 驗證碼與 Browser session 只能使用一次；無論成敗都從設定移除。
  const {
    browserSessionId: _browserSessionId,
    browserSessionExpiresAt: _browserSessionExpiresAt,
    captchaDigitCount: _captchaDigitCount,
    captcha: _captcha,
    ...reusableStored
  } = stored;

  let result: Awaited<
    ReturnType<ReturnType<typeof createKgibankConnector>["sync"]>
  >;
  try {
    result = await createKgibankConnector(
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
    await updateConnectorEncryptedConfig(
      env.DB,
      connectorId,
      await encryptJson(reusableStored, configEncryptionKey(env)),
    );
    if (error instanceof KgibankVerificationRequiredError) {
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

  const cursorState = splitConnectorCursorState(
    connectorId,
    result.cursor ?? "{}",
  );
  const persistedCursor = cursorState.safeCursor;
  const {
    browserSessionId: _configBrowserSessionId,
    browserSessionExpiresAt: _configBrowserSessionExpiresAt,
    captchaDigitCount: _configCaptchaDigitCount,
    captcha: _configCaptcha,
    ...reusableConfig
  } = config;
  const finalizeStatements: D1PreparedStatement[] = [
    connectorStateStatement(
      env.DB,
      connectorId,
      await encryptConnectorConfig(env, connectorId, reusableConfig),
      serializePublicConfig(connectorId, config),
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
