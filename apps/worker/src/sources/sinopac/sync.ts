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
import { parseSinopacConfig } from "./protocol";
import {
  prepareSinopacCaptcha,
  createSinopacConnector,
  SinopacVerificationRequiredError,
  loginSinopacWithOcr,
} from "./connector";
import {
  updateConnectorEncryptedConfig,
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
} from "../../features/sync/connector-repository";
import { reconcileSinopacLegacyTransactionStatements } from "./repository";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../features/sync/connector-state";
import { recognizeValidateNumber } from "../../features/ocr/service";
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
import { prepareSinopacAuthorizationWrite } from "./authorizations";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../features/net-worth/service";

export type SinopacSyncOverrides = {
  captcha?: string;
};

export async function prepareSinopacCaptchaSession(env: Env) {
  const connectorId = "sinopac";
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
      const config = parseSinopacConfig({ ...stored, ...publicStored });
      const prepared = await prepareSinopacCaptcha(env.BROWSER, config);
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
      };
    });
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

export async function syncSinopac(
  env: Env,
  trigger: SyncTrigger,
  overrides: SinopacSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "sinopac";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseSinopacConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...overrides,
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );
  let result: Awaited<
    ReturnType<ReturnType<typeof createSinopacConnector>["sync"]>
  >;
  let activeConfig = config;
  try {
    const connector = createSinopacConnector(env.BROWSER);
    try {
      result = await connector.sync(
        activeConfig,
        settings.sync_cursor ?? undefined,
      );
    } catch (error) {
      if (!(error instanceof SinopacVerificationRequiredError)) throw error;
      const session = await loginSinopacWithOcr(
        env.BROWSER,
        activeConfig,
        async (imageBytes) =>
          (await recognizeValidateNumber(env.AI, imageBytes, "image/jpeg"))
            .number,
      );
      const {
        browserSessionId: _browserSessionId,
        browserSessionExpiresAt: _browserSessionExpiresAt,
        captcha: _captcha,
        ...reusableConfig
      } = activeConfig;
      activeConfig = { ...reusableConfig, ...session };
      result = await connector.sync(
        activeConfig,
        settings.sync_cursor ?? undefined,
      );
    }
  } catch (error) {
    const cleaned = { ...stored };
    const hadPendingVerification = Boolean(
      config.browserSessionId && overrides.captcha,
    );
    if (hadPendingVerification) {
      delete cleaned.captcha;
      delete cleaned.browserSessionId;
      delete cleaned.browserSessionExpiresAt;
    }
    if (error instanceof SinopacVerificationRequiredError) {
      delete cleaned.sessionCookies;
      delete cleaned.candidateSessionCookies;
      delete cleaned.candidateSessionCreatedAt;
      delete cleaned.sessionExpiresAt;
      delete cleaned.sessionKeepAliveFailures;
      delete cleaned.protocol;
    }
    if (
      hadPendingVerification ||
      error instanceof SinopacVerificationRequiredError
    ) {
      await updateConnectorEncryptedConfig(
        env.DB,
        connectorId,
        await encryptJson(cleaned, configEncryptionKey(env)),
      );
    }
    if (error instanceof SinopacVerificationRequiredError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
  }
  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  const bankTransactions = result.bankTransactions ?? [];
  const creditCardBills = result.creditCardBills ?? [];
  console.log(
    `[sync] ${connectorId}/${scope}: accounts=${bankAccounts.length} snapshots=${bankBalanceSnapshots.length} transactions=${bankTransactions.length} bills=${creditCardBills.length}`,
  );

  const now = new Date().toISOString();
  let records: SyncWriteRecord[] = [
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
  const finalizeStatements: D1PreparedStatement[] = [];
  let persistedCursor: string | undefined;
  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    const {
      browserSessionId: _browserSessionId,
      browserSessionExpiresAt: _browserSessionExpiresAt,
      captcha: _captcha,
      ...reusableConfig
    } = activeConfig;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, {
          ...reusableConfig,
          ...cursorState.secretState,
        }),
        serializePublicConfig(connectorId, activeConfig),
        persistedCursor,
        now,
      ),
    );
  }
  const authorizationWrite = result.pendingSnapshotComplete
    ? await prepareSinopacAuthorizationWrite(
        env.DB,
        records,
        (result.cardAuthorizations ?? []).map((transaction) =>
          bankTransactionRecord(connectorId, transaction, now),
        ),
      )
    : undefined;
  if (authorizationWrite) records = authorizationWrite.records;
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    afterPromoteStatements: [
      ...reconcileSinopacLegacyTransactionStatements(env.DB),
      ...(authorizationWrite?.afterPromoteStatements ?? []),
      ...(bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB)]
        : []),
    ],
    finalizeStatements,
  });
  if (bankBalanceSnapshots.length > 0)
    await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
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
