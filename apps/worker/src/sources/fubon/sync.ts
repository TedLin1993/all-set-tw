import { createSyncExecution } from "../../features/sync/execution";
import { prepareCardAuthorizationWrite } from "../../features/sync/card-authorization-write";
import type { Env } from "../../platform/env";
import { createFubonEgressFetcher } from "../../platform/fubon-egress";
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
import { parseFubonConfig, type FubonConfig } from "./protocol";
import {
  prepareFubonCaptcha,
  createFubonConnector,
  FubonOtpInvalidError,
  FubonOtpRequiredError,
  FubonVerificationRequiredError,
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
  creditCardBillRecord,
} from "../../features/sync/record-mapper";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../features/net-worth/service";

export type FubonSyncOverrides = {
  captcha?: string;
  otp?: string;
};

/** 一次性驗證狀態；同步成功、失敗或逾時後都從加密設定移除。 */
const CHALLENGE_FIELDS = [
  "browserSessionId",
  "browserSessionExpiresAt",
  "captchaDigitCount",
  "captcha",
  "otpBrowserSessionId",
  "otpExpiresAt",
  "otp",
] as const;

function withoutChallenge<T extends Record<string, unknown>>(value: T) {
  const cleaned: Record<string, unknown> = { ...value };
  for (const key of CHALLENGE_FIELDS) delete cleaned[key];
  return cleaned;
}

export async function prepareFubonCaptchaSession(env: Env) {
  const connectorId = "fubon";
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
      const config = parseFubonConfig({
        ...stored,
        ...parsePublicConnectorConfig(connectorId, settings.public_config),
      });
      const prepared = await prepareFubonCaptcha(
        env.BROWSER,
        config,
        createFubonEgressFetcher(env.FUBON_EGRESS),
      );
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
          "台北富邦設定在驗證期間已變更，請重新取得驗證碼。",
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

export async function syncFubon(
  env: Env,
  trigger: SyncTrigger,
  overrides: FubonSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "fubon";
  const scope = SYNC_SCOPE_ALL;
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  // 排程同步不得接續任何人工驗證狀態，也不會寄送雙重驗證碼。
  const config: FubonConfig = parseFubonConfig({
    ...(trigger === "manual" ? stored : withoutChallenge(stored)),
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...(trigger === "manual" ? overrides : {}),
  });
  if (!overrides.otp) {
    // 新一輪同步（非接續 OTP）時不沿用上一輪等待中的 OTP 工作階段。
    delete config.otpBrowserSessionId;
    delete config.otpExpiresAt;
  }
  if (!overrides.captcha) {
    delete config.captcha;
    if (!overrides.otp) {
      delete config.browserSessionId;
      delete config.browserSessionExpiresAt;
    }
  }

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  const reusableStored = withoutChallenge(stored);
  let result: Awaited<
    ReturnType<ReturnType<typeof createFubonConnector>["sync"]>
  >;
  try {
    result = await createFubonConnector(
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
      // 只有使用者在場的手動同步才請銀行寄送雙重驗證碼。
      {
        allowOtpRequest: trigger === "manual",
        egress: createFubonEgressFetcher(env.FUBON_EGRESS),
      },
    ).sync(config, settings.sync_cursor ?? undefined);
  } catch (error) {
    const awaitingOtp =
      error instanceof FubonOtpRequiredError ||
      error instanceof FubonOtpInvalidError;
    const saved = await updateConnectorEncryptedConfigIfCurrent(
      env.DB,
      connectorId,
      settings.encrypted_config,
      await encryptJson(
        awaitingOtp
          ? {
              ...reusableStored,
              otpBrowserSessionId: error.otpBrowserSessionId,
              otpExpiresAt: error.otpExpiresAt,
            }
          : reusableStored,
        configEncryptionKey(env),
      ),
    );
    if (!saved) {
      throw new NeedsUserActionError(
        "台北富邦設定在同步期間已變更，請重新同步。",
      );
    }
    if (awaitingOtp) throw error;
    if (error instanceof FubonVerificationRequiredError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
  }

  if (result.syncWarning) {
    // 同步結果目前沒有 partial 狀態；與永豐等來源相同，以摘要 log 呈現略過的資料。
    console.warn(
      `[sync] ${connectorId}/${scope}: partial ${result.syncWarning}`,
    );
  }
  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  const bankTransactions = result.bankTransactions ?? [];
  const creditCardBills = result.creditCardBills ?? [];
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
    ...creditCardBills.map((bill) =>
      creditCardBillRecord(connectorId, bill, now),
    ),
  ];

  const cursorState = splitConnectorCursorState(
    connectorId,
    result.cursor ?? "{}",
  );
  const persistedCursor = cursorState.safeCursor;
  const reusableConfig = parseFubonConfig(withoutChallenge(config));
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

  const prepared = await prepareCardAuthorizationWrite(
    env.DB,
    connectorId,
    records,
    {
      sourcePattern: "fubon:card:tx:v1:%",
      encryptedConfig: settings.encrypted_config,
      cardId: (row) => row.source_id.match(/^fubon:card:tx:v1:(\d{4}):/)?.[1],
    },
  );
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records: prepared.records,
    settingsGuard,
    afterPromoteStatements: [
      ...prepared.afterPromoteStatements,
      ...(bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB, settingsGuard)]
        : []),
    ],
    finalizeStatements,
  });

  if (
    bankBalanceSnapshots.some((snapshot) =>
      bankAccounts.some(
        (account) =>
          account.sourceId === snapshot.accountId &&
          account.accountType !== "credit",
      ),
    )
  ) {
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
