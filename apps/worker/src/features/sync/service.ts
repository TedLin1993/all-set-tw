import {
  EInvoiceProtocolUnavailableError,
  createCtbcConnector,
  CtbcVerificationRequiredError,
  createObankConnector,
  ObankProtocolError,
  ObankVerificationRequiredError,
  parseCathaybkConfig,
  parseCtbcConfig,
  parseEsunConfig,
  parseObankConfig,
  parseSinopacConfig,
  parseTaishinConfig,
  parseTdccConfig,
  syncTdccTradeHistory,
  tdccConnector,
  TdccOtpExpiredError,
  TdccVerificationRequiredError,
  prepareObankCaptcha,
} from "@taiwan-fin-hub/connectors";
import { createCathaybkConnector } from "../../connectors/cathaybk";
import { createCtbcFetch } from "../../connectors/ctbc";
import { createEsunConnector } from "../../connectors/esun";
import {
  createTaishinConnector,
  prepareTaishinCaptcha,
  TaishinConnectionError,
  TaishinVerificationRequiredError,
} from "../../connectors/taishin";
import {
  createSinopacConnector,
  loginSinopacWithOcr,
  prepareSinopacCaptcha,
  SinopacBrowserCapacityError,
  SinopacVerificationRequiredError,
} from "../../connectors/sinopac";
import {
  recognizeAlphanumericCaptcha,
  recognizeNumericCaptcha,
  recognizeValidateNumber,
} from "../ocr/service";
import type { ConnectorId, SyncNewRecordCounts } from "@taiwan-fin-hub/core";
import {
  acquireSyncJobLock,
  getConnectorSettings,
  markManualSyncFailure,
  markManualSyncSuccess,
  releaseSyncJobLock,
  renewSyncJobLock,
  type SyncStatus,
  type SyncTrigger,
  upsertConnectorSettings,
} from "@taiwan-fin-hub/db";
import { configEncryptionKey } from "../../platform/config";
import { encryptJson, decryptJson } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import { dateFromIso, rebuildBankDepositHistory } from "../net-worth/service";
import {
  emptySyncNewRecordCounts,
  persistStagedSyncWrite,
  type SyncWriteRecord,
} from "./persistence";
import {
  connectorCursorStatement,
  connectorEncryptedConfigStatement,
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
  reconcileEsunLifecycleShadowStatements,
  reconcileEsunSingleCardSummaryAccountStatements,
  reconcileSinopacLegacyTransactionStatements,
  updateConnectorEncryptedConfig,
} from "./repository";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
  creditCardBillRecord,
  investmentPositionRecord,
  investmentTransactionRecord,
  invoiceLineItemRecord,
  invoiceRecord,
  netWorthHistoryRecord,
} from "./record-mapper";
import {
  parsePublicConnectorConfig,
  restoreConfiguredPublicFields,
  serializePublicConnectorConfig,
  sensitiveConnectorConfig,
  splitConnectorCursorState,
} from "./connector-state";

export type SyncScope =
  | "all"
  | "investments"
  | "bank"
  | "trades"
  | "investments+bank"
  | "investments+trades"
  | "bank+trades";

export const SYNC_SCOPE_ALL = "all";
export const TDCC_SCOPE_INVESTMENTS = "investments";
export const TDCC_SCOPE_BANK = "bank";
export const TDCC_SCOPE_TRADES = "trades";
export const SYNC_LOCK_LEASE_MS = 30 * 60 * 1000;
const SYNC_LOCK_HEARTBEAT_MS = 5 * 60 * 1000;

export type SyncOutcome = {
  success: true;
  connectorId: ConnectorId;
  scope: SyncScope;
  records: number;
  newRecords: SyncNewRecordCounts;
  cursorUpdated: boolean;
  detailRecords?: number;
};

export class SyncAlreadyRunningError extends Error {
  constructor(readonly connectorId: ConnectorId) {
    super(`${connectorId} sync is already running.`);
  }
}

export class NeedsUserActionError extends Error {
  constructor(message: string) {
    super(message);
  }
}

export type SinopacSyncOverrides = {
  captcha?: string;
};

export type TaishinSyncOverrides = {
  captcha?: string;
};

export type ObankSyncOverrides = {
  captcha?: string;
};

export type TdccSyncOverrides = {
  otp?: string;
  otpChannel?: "email" | "sms";
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

  try {
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
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

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

  try {
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
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

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

  try {
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
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

export async function syncEsun(
  env: Env,
  trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const connectorId = "esun";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseEsunConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );
  const result = await createEsunConnector(env.BROWSER).sync(
    config,
    settings.sync_cursor ?? undefined,
  );

  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  const bankTransactions = result.bankTransactions ?? [];
  const creditCardBills = result.creditCardBills ?? [];
  console.log(
    `[sync] ${connectorId}/${scope}: accounts=${bankAccounts.length} snapshots=${bankBalanceSnapshots.length} transactions=${bankTransactions.length} bills=${creditCardBills.length}`,
  );

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
  const finalizeStatements: D1PreparedStatement[] = [];
  let persistedCursor: string | undefined;

  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, {
          ...config,
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
        ? [
            linkCanonicalBankAccountsStatement(env.DB),
            ...reconcileEsunLifecycleShadowStatements(env.DB),
            ...reconcileEsunSingleCardSummaryAccountStatements(env.DB),
          ]
        : [
            ...reconcileEsunLifecycleShadowStatements(env.DB),
            ...reconcileEsunSingleCardSummaryAccountStatements(env.DB),
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
      bankAccounts.length +
      bankBalanceSnapshots.length +
      bankTransactions.length,
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}

export async function syncCathaybk(
  env: Env,
  trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const connectorId = "cathaybk";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseCathaybkConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );
  const result = await createCathaybkConnector(env.BROWSER).sync(
    config,
    settings.sync_cursor ?? undefined,
  );

  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  const bankTransactions = result.bankTransactions ?? [];
  const creditCardBills = result.creditCardBills ?? [];
  console.log(
    `[sync] ${connectorId}/${scope}: accounts=${bankAccounts.length} snapshots=${bankBalanceSnapshots.length} transactions=${bankTransactions.length} bills=${creditCardBills.length}`,
  );

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
  const finalizeStatements: D1PreparedStatement[] = [];
  let persistedCursor: string | undefined;

  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, {
          ...config,
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
      bankTransactions.length,
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}

export async function syncCtbc(
  env: Env,
  trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const connectorId = "ctbc";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseCtbcConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<
    ReturnType<ReturnType<typeof createCtbcConnector>["sync"]>
  >;
  try {
    const fetcher = createCtbcFetch(env);
    const connector = fetcher
      ? createCtbcConnector(fetcher)
      : createCtbcConnector();
    result = await connector.sync(config, settings.sync_cursor ?? undefined);
  } catch (error) {
    if (error instanceof CtbcVerificationRequiredError) {
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
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, config),
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
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    afterPromoteStatements: [
      ...reconcileSinopacLegacyTransactionStatements(env.DB),
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

export function obankStoredConfigAfterSync(stored: Record<string, unknown>) {
  const cleaned = { ...stored };
  delete cleaned.pendingSession;
  delete cleaned.pendingSessionExpiresAt;
  delete cleaned.captcha;
  return cleaned;
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
      async (imageBytes, digitCount) =>
        (
          await recognizeNumericCaptcha(
            env.AI,
            imageBytes,
            "image/jpeg",
            digitCount,
          )
        ).number,
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

export async function syncTdcc(
  env: Env,
  trigger: SyncTrigger,
  overrides: TdccSyncOverrides,
  scopes: string[],
): Promise<SyncOutcome> {
  const selected = new Set(
    scopes.includes(SYNC_SCOPE_ALL)
      ? [TDCC_SCOPE_INVESTMENTS, TDCC_SCOPE_BANK, TDCC_SCOPE_TRADES]
      : scopes,
  );
  const scope = tdccOutcomeScope(selected);
  let records = 0;
  const newRecords = emptySyncNewRecordCounts();
  let cursorUpdated = false;

  if (selected.has(TDCC_SCOPE_INVESTMENTS) || selected.has(TDCC_SCOPE_BANK)) {
    const result = await syncTdccPositionsAndBank(env, trigger, overrides, {
      writeInvestments: selected.has(TDCC_SCOPE_INVESTMENTS),
      writeBank: selected.has(TDCC_SCOPE_BANK),
      scope,
    });
    records += result.records;
    mergeSyncNewRecordCounts(newRecords, result.newRecords);
    cursorUpdated = cursorUpdated || result.cursorUpdated;
  }

  if (selected.has(TDCC_SCOPE_TRADES)) {
    const result = await syncTdccTrades(env, trigger, overrides, scope);
    records += result.records;
    mergeSyncNewRecordCounts(newRecords, result.newRecords);
    cursorUpdated = cursorUpdated || result.cursorUpdated;
  }

  return {
    success: true,
    connectorId: "tdcc",
    scope,
    records,
    newRecords,
    cursorUpdated,
  };
}

async function syncTdccPositionsAndBank(
  env: Env,
  trigger: SyncTrigger,
  overrides: TdccSyncOverrides,
  options: {
    writeInvestments: boolean;
    writeBank: boolean;
    scope: SyncScope;
  },
): Promise<{
  records: number;
  newRecords: SyncNewRecordCounts;
  cursorUpdated: boolean;
}> {
  const connectorId = "tdcc";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const config = await decryptJson<unknown>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const mergedConfig = { ...(config as Record<string, unknown>), ...overrides };
  const parsedConfig = parseTdccConfig({
    ...mergedConfig,
    requestOtp: trigger === "manual",
  });
  requireTdccCredentials(parsedConfig);
  const syncScope = options.scope;
  console.log(
    `[sync] ${connectorId}/${syncScope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<ReturnType<typeof tdccConnector.sync>>;
  try {
    result = await tdccConnector.sync(
      parsedConfig,
      settings.sync_cursor ?? undefined,
    );
  } catch (error) {
    await handleTdccSyncError(
      env,
      settings.id,
      connectorId,
      mergedConfig,
      syncScope,
      trigger,
      error,
    );
    throw error;
  }

  console.log(
    `[sync] ${connectorId}/${syncScope}: fetched ${result.records.length} investment records`,
  );
  const now = new Date().toISOString();

  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  const bankTransactions = result.bankTransactions ?? [];
  const netWorthHistory = result.netWorthHistory ?? [];
  console.log(
    `[sync] ${connectorId}/${syncScope}: bank accounts=${bankAccounts.length} snapshots=${bankBalanceSnapshots.length} transactions=${bankTransactions.length} history=${netWorthHistory.length}`,
  );
  const records: SyncWriteRecord[] = [
    ...(options.writeBank
      ? bankAccounts.map((account) =>
          bankAccountRecord(connectorId, account, now),
        )
      : []),
    ...(options.writeBank
      ? bankBalanceSnapshots.map((snapshot) =>
          bankBalanceSnapshotRecord(connectorId, snapshot, now),
        )
      : []),
    ...(options.writeBank
      ? bankTransactions.map((transaction) =>
          bankTransactionRecord(connectorId, transaction, now),
        )
      : []),
    ...(options.writeInvestments
      ? result.records.map((position) =>
          investmentPositionRecord(connectorId, position, now),
        )
      : []),
    ...netWorthHistory.map((point) =>
      netWorthHistoryRecord(connectorId, point, now),
    ),
  ];
  const finalizeStatements: D1PreparedStatement[] = [];
  let persistedCursor: string | undefined;

  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    const {
      otp: _otp,
      otpChannel: _otpChannel,
      requestOtp: _requestOtp,
      ...reusableConfig
    } = parsedConfig;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, {
          ...reusableConfig,
          ...cursorState.secretState,
        }),
        serializePublicConfig(connectorId, parsedConfig),
        persistedCursor,
        now,
      ),
    );
  }

  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    afterPromoteStatements:
      options.writeBank && bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB)]
        : [],
    finalizeStatements,
  });

  if (options.writeBank && bankBalanceSnapshots.length > 0) {
    await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  }

  return {
    records:
      (options.writeInvestments ? result.records.length : 0) +
      (options.writeBank
        ? bankAccounts.length +
          bankBalanceSnapshots.length +
          bankTransactions.length
        : 0),
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}

async function syncTdccTrades(
  env: Env,
  trigger: SyncTrigger,
  overrides: TdccSyncOverrides,
  scope: SyncScope,
): Promise<{
  records: number;
  newRecords: SyncNewRecordCounts;
  cursorUpdated: boolean;
}> {
  const connectorId = "tdcc";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const config = await decryptJson<unknown>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const mergedConfig = { ...(config as Record<string, unknown>), ...overrides };
  const parsedConfig = parseTdccConfig({
    ...mergedConfig,
    requestOtp: trigger === "manual",
  });
  requireTdccCredentials(parsedConfig);
  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<ReturnType<typeof syncTdccTradeHistory>>;
  try {
    result = await syncTdccTradeHistory(
      parsedConfig,
      settings.sync_cursor ?? undefined,
    );
  } catch (error) {
    await handleTdccSyncError(
      env,
      settings.id,
      connectorId,
      mergedConfig,
      scope,
      trigger,
      error,
    );
    throw error;
  }

  const now = new Date().toISOString();
  const investmentTransactions = result.investmentTransactions ?? [];
  console.log(
    `[sync] ${connectorId}/${scope}: fetched ${investmentTransactions.length} investment transactions`,
  );
  const records = investmentTransactions.map((transaction) =>
    investmentTransactionRecord(connectorId, transaction, now),
  );
  const finalizeStatements: D1PreparedStatement[] = [];
  let persistedCursor: string | undefined;

  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    const {
      otp: _otp,
      otpChannel: _otpChannel,
      requestOtp: _requestOtp,
      ...reusableConfig
    } = parsedConfig;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, {
          ...reusableConfig,
          ...cursorState.secretState,
        }),
        serializePublicConfig(connectorId, parsedConfig),
        persistedCursor,
        now,
      ),
    );
  }

  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    finalizeStatements,
  });

  return {
    records: investmentTransactions.length,
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}

function mergeSyncNewRecordCounts(
  target: SyncNewRecordCounts,
  source: SyncNewRecordCounts,
) {
  target.invoices += source.invoices;
  target.bankTransactions += source.bankTransactions;
  target.investmentTransactions += source.investmentTransactions;
}

function tdccOutcomeScope(scopes: Set<string>): SyncScope {
  const allScopes = [
    TDCC_SCOPE_INVESTMENTS,
    TDCC_SCOPE_BANK,
    TDCC_SCOPE_TRADES,
  ];
  if (allScopes.every((scope) => scopes.has(scope))) return SYNC_SCOPE_ALL;
  return (allScopes.filter((scope) => scopes.has(scope)).join("+") ||
    SYNC_SCOPE_ALL) as SyncScope;
}

function requireTdccCredentials(config: {
  userId?: string;
  password?: string;
}) {
  if (!config.userId || !config.password) {
    throw new NeedsUserActionError(
      "請重新輸入身分證字號與集保 App 密碼，再開始連線。",
    );
  }
}

async function requireConnectorSettings(
  env: Env["DB"],
  connectorId: ConnectorId,
) {
  const settings = await getConnectorSettings(env, connectorId);
  if (!settings) {
    throw new NeedsUserActionError(
      "Connector settings are required before sync.",
    );
  }
  return settings;
}

async function handleTdccSyncError(
  env: Env,
  settingsId: string,
  connectorId: "tdcc",
  mergedConfig: Record<string, unknown>,
  scope: SyncScope,
  trigger: SyncTrigger,
  error: unknown,
): Promise<never> {
  if (error instanceof TdccOtpExpiredError) {
    const { otp, ...configWithoutOtp } = mergedConfig;
    await upsertConnectorSettings(env.DB, {
      id: settingsId,
      connectorId,
      encryptedConfig: await encryptJson(
        configWithoutOtp,
        configEncryptionKey(env),
      ),
      publicConfig: null,
      now: new Date().toISOString(),
    });
    console.log(
      `[sync] ${connectorId}/${scope}: cleared expired otp from config`,
    );
  }

  if (trigger === "scheduled" && isUserActionError(error)) {
    throw new NeedsUserActionError(
      error instanceof Error ? error.message : "Sync requires user action.",
    );
  }

  throw error;
}

export async function withManualSyncLock(
  env: Env,
  connectorId: ConnectorId,
  scope: SyncScope,
  task: () => Promise<SyncOutcome>,
) {
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId(connectorId);
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope,
    trigger: "manual",
    runId,
    leaseMs: SYNC_LOCK_LEASE_MS,
  });

  if (!locked) {
    throw new SyncAlreadyRunningError(connectorId);
  }

  const stopHeartbeat = startSyncLockHeartbeat(env.DB, lockRowId, runId);
  try {
    const outcome = await task();
    await markManualSyncSuccess(env.DB, connectorId, scope);
    return outcome;
  } catch (error) {
    const status: SyncStatus = isUserActionError(error)
      ? "needs_user_action"
      : "failed";
    await markManualSyncFailure(env.DB, connectorId, scope, {
      status,
      errorMessage: safeErrorMessage(error),
    });
    throw error;
  } finally {
    stopHeartbeat();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

export function startSyncLockHeartbeat(
  db: D1Database,
  lockRowId: string,
  runId: string,
) {
  const timer = setInterval(() => {
    void renewSyncJobLock(db, { lockRowId, runId, leaseMs: SYNC_LOCK_LEASE_MS })
      .then((renewed) => {
        if (!renewed)
          console.error(`[sync] lock heartbeat lost for ${lockRowId}`);
      })
      .catch((error) =>
        console.error(`[sync] lock heartbeat failed for ${lockRowId}`, error),
      );
  }, SYNC_LOCK_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

export function canonicalSyncLockRowId(connectorId: ConnectorId) {
  return `${connectorId}:all`;
}

async function encryptConnectorConfig(
  env: Env,
  connectorId: ConnectorId,
  config: object,
) {
  return encryptJson(
    sensitiveConnectorConfig(connectorId, config as Record<string, unknown>),
    configEncryptionKey(env),
  );
}

function serializePublicConfig(connectorId: ConnectorId, config: object) {
  return serializePublicConnectorConfig(
    connectorId,
    config as Record<string, unknown>,
  );
}

export function isUserActionError(error: unknown) {
  if (
    error instanceof NeedsUserActionError ||
    error instanceof TdccOtpExpiredError ||
    error instanceof TdccVerificationRequiredError ||
    error instanceof EInvoiceProtocolUnavailableError ||
    error instanceof SinopacVerificationRequiredError ||
    error instanceof TaishinVerificationRequiredError
  )
    return true;
  const message = error instanceof Error ? error.message : String(error);
  return /OTP|verification|requires.*login|requires.*session|requires.*user action/i.test(
    message,
  );
}

export function safeErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}
