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
import { parseFirstbankConfig } from "./protocol";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../features/sync/connector-state";
import {
  prepareFirstbankCaptcha,
  createFirstbankConnector,
  FirstbankVerificationRequiredError,
  FirstbankConnectionError,
} from "./connector";
import {
  updateConnectorEncryptedConfig,
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
} from "../../features/sync/connector-repository";
import { recognizeAlphanumericCaptcha } from "../../features/ocr/service";
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

export type FirstbankSyncOverrides = {
  captcha?: string;
};

export async function prepareFirstbankCaptchaSession(env: Env) {
  const connectorId = "firstbank";
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
      const config = parseFirstbankConfig({
        ...stored,
        ...parsePublicConnectorConfig(connectorId, settings.public_config),
      });
      const prepared = await prepareFirstbankCaptcha(env.BROWSER, config);
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
        captchaLength: prepared.captchaDigitCount,
        captchaKind: "alphanumeric" as const,
      };
    });
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

export async function syncFirstbank(
  env: Env,
  trigger: SyncTrigger,
  overrides: FirstbankSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "firstbank";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseFirstbankConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...overrides,
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<
    ReturnType<ReturnType<typeof createFirstbankConnector>["sync"]>
  >;
  try {
    const connector = createFirstbankConnector(
      env.BROWSER,
      overrides.captcha
        ? undefined
        : async (imageBytes: ArrayBuffer, digitCount: number) => {
            try {
              return (
                await recognizeAlphanumericCaptcha(
                  env.AI,
                  imageBytes,
                  "image/jpeg",
                  digitCount,
                )
              ).code;
            } catch {
              throw new FirstbankVerificationRequiredError(
                "第一銀行圖形驗證碼無法自動辨識，請改用人工輸入。",
              );
            }
          },
    );
    result = await connector.sync(config, settings.sync_cursor ?? undefined);
  } catch (error) {
    const cleaned = firstbankStoredConfigAfterSync(stored);
    if (error instanceof FirstbankConnectionError && error.sessionCookies) {
      cleaned.sessionCookies = error.sessionCookies;
      cleaned.sessionCreatedAt =
        error.sessionCreatedAt ?? new Date().toISOString();
    }
    if (error instanceof FirstbankVerificationRequiredError) {
      delete cleaned.sessionCookies;
      delete cleaned.sessionCreatedAt;
    }
    await updateConnectorEncryptedConfig(
      env.DB,
      connectorId,
      await encryptJson(cleaned, configEncryptionKey(env)),
    );
    if (error instanceof FirstbankVerificationRequiredError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
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
  const cleanedConfig = firstbankStoredConfigAfterSync(config);
  let persistedCursor: string | undefined;
  const finalizeStatements: D1PreparedStatement[] = [];
  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, {
          ...cleanedConfig,
          ...cursorState.secretState,
        }),
        serializePublicConfig(connectorId, cleanedConfig),
        persistedCursor,
        now,
      ),
    );
  }
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
      bankTransactions.length +
      creditCardBills.length,
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}

export function firstbankStoredConfigAfterSync(
  stored: Record<string, unknown>,
) {
  const cleaned = { ...stored };
  delete cleaned.browserSessionId;
  delete cleaned.browserSessionExpiresAt;
  delete cleaned.captchaDigitCount;
  delete cleaned.captcha;
  return cleaned;
}
