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
import { parseObankConfig } from "./protocol";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../features/sync/connector-state";
import {
  prepareObankCaptcha,
  createObankConnector,
  ObankVerificationRequiredError,
  ObankProtocolError,
} from "./mobile-api";
import {
  updateConnectorEncryptedConfig,
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
} from "../../features/sync/connector-repository";
import { recognizeAlphanumericCaptcha } from "../../features/ocr/service";
import { prepareObankTimeDepositWrite } from "./time-deposits";
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

export type ObankSyncOverrides = {
  captcha?: string;
};

export async function prepareObankCaptchaSession(env: Env) {
  const connectorId = "obank";
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
      const config = parseObankConfig({
        ...stored,
        ...parsePublicConnectorConfig(connectorId, settings.public_config),
      });
      const prepared = await prepareObankCaptcha(config);
      await updateConnectorEncryptedConfig(
        env.DB,
        connectorId,
        await encryptJson(
          {
            ...stored,
            pendingSession: prepared.pendingSession,
            pendingSessionExpiresAt: prepared.pendingSessionExpiresAt,
          },
          configEncryptionKey(env),
        ),
      );
      return {
        captchaImage: prepared.captchaImage,
        expiresAt: prepared.pendingSessionExpiresAt,
        captchaLength: 4,
        captchaKind: "alphanumeric" as const,
      };
    });
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

export async function syncObank(
  env: Env,
  trigger: SyncTrigger,
  overrides: ObankSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "obank";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseObankConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...overrides,
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<
    ReturnType<ReturnType<typeof createObankConnector>["sync"]>
  >;
  try {
    const connector = createObankConnector(
      globalThis.fetch.bind(globalThis),
      overrides.captcha
        ? undefined
        : async (imageBytes, contentType) => {
            try {
              return (
                await recognizeAlphanumericCaptcha(
                  env.AI,
                  imageBytes,
                  contentType,
                  4,
                )
              ).code;
            } catch {
              throw new ObankVerificationRequiredError(
                "王道銀行驗證碼無法自動辨識，請改用人工輸入。",
              );
            }
          },
    );
    result = await connector.sync(config, settings.sync_cursor ?? undefined, {
      forceLogin: true,
    });
  } catch (error) {
    const cleaned = obankStoredConfigAfterSync(stored);
    await updateConnectorEncryptedConfig(
      env.DB,
      connectorId,
      await encryptJson(cleaned, configEncryptionKey(env)),
    );
    if (error instanceof ObankVerificationRequiredError) {
      throw new NeedsUserActionError(error.message);
    }
    if (error instanceof ObankProtocolError) throw error;
    throw error;
  }

  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  const bankTransactions = result.bankTransactions ?? [];
  console.log(
    `[sync] ${connectorId}/${scope}: accounts=${bankAccounts.length} snapshots=${bankBalanceSnapshots.length} transactions=${bankTransactions.length}`,
  );

  const now = new Date().toISOString();
  const timeDepositWrite = await prepareObankTimeDepositWrite(
    env.DB,
    result,
    now,
  );
  const records: SyncWriteRecord[] = [
    ...timeDepositWrite.records,
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
  const cleanedConfig = parseObankConfig({
    ...config,
    pendingSession: undefined,
    pendingSessionExpiresAt: undefined,
    captcha: undefined,
  });
  let persistedCursor: string | undefined;
  const finalizeStatements: D1PreparedStatement[] = [];
  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, cleanedConfig),
        serializePublicConfig(connectorId, cleanedConfig),
        persistedCursor,
        now,
      ),
    );
  }

  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    afterPromoteStatements: [
      ...timeDepositWrite.afterPromoteStatements,
      ...(bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB)]
        : []),
    ],
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
      timeDepositWrite.records.length +
      bankAccounts.length +
      bankBalanceSnapshots.length +
      bankTransactions.length,
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}

export function obankStoredConfigAfterSync(stored: Record<string, unknown>) {
  const cleaned = { ...stored };
  delete cleaned.pendingSession;
  delete cleaned.pendingSessionExpiresAt;
  delete cleaned.captcha;
  return cleaned;
}
