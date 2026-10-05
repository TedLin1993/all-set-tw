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
import { parseTaishinConfig } from "./protocol";
import {
  prepareTaishinCaptcha,
  createTaishinConnector,
  TaishinConnectionError,
  TaishinVerificationRequiredError,
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
import {
  recognizeNumericCaptcha,
  ValidateNumberOcrError,
} from "../../features/ocr/service";
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

export type TaishinSyncOverrides = {
  captcha?: string;
};

export async function prepareTaishinCaptchaSession(env: Env) {
  const connectorId = "taishin";
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
      const config = parseTaishinConfig({ ...stored, ...publicStored });
      const prepared = await prepareTaishinCaptcha(env.BROWSER, config);
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
      };
    });
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

export async function syncTaishin(
  env: Env,
  trigger: SyncTrigger,
  overrides: TaishinSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "taishin";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseTaishinConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...overrides,
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );
  let result: Awaited<
    ReturnType<ReturnType<typeof createTaishinConnector>["sync"]>
  >;
  try {
    result = await createTaishinConnector(
      env.BROWSER,
      async (imageBytes, digitCount) => {
        try {
          return (
            await recognizeNumericCaptcha(
              env.AI,
              imageBytes,
              "image/jpeg",
              digitCount,
            )
          ).number;
        } catch (error) {
          if (error instanceof ValidateNumberOcrError) return null;
          throw error;
        }
      },
    ).sync(config, settings.sync_cursor ?? undefined);
  } catch (error) {
    const cleaned = { ...stored };
    delete cleaned.captcha;
    delete cleaned.browserSessionId;
    delete cleaned.browserSessionExpiresAt;
    delete cleaned.captchaDigitCount;
    if (error instanceof TaishinConnectionError && error.sessionCookies) {
      cleaned.sessionCookies = error.sessionCookies;
      cleaned.sessionCreatedAt =
        error.sessionCreatedAt ?? new Date().toISOString();
    }
    if (error instanceof TaishinVerificationRequiredError) {
      delete cleaned.sessionCookies;
      delete cleaned.sessionCreatedAt;
    }
    await updateConnectorEncryptedConfig(
      env.DB,
      connectorId,
      await encryptJson(cleaned, configEncryptionKey(env)),
    );
    if (error instanceof TaishinVerificationRequiredError) {
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

  let persistedCursor: string | undefined;
  const finalizeStatements: D1PreparedStatement[] = [];
  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    const {
      browserSessionId: _browserSessionId,
      browserSessionExpiresAt: _browserSessionExpiresAt,
      captchaDigitCount: _captchaDigitCount,
      captcha: _captcha,
      ...reusableConfig
    } = config;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, {
          ...reusableConfig,
          ...cursorState.secretState,
        }),
        serializePublicConfig(connectorId, config),
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
