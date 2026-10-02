import { beginActivityRun } from "./activity-detail-repository";
import {
  NextbankApiClient,
  NextbankApiError,
  nextbankConfigSchema,
  collectNextbankDepositPayloads,
  parseNextbankDeposits,
} from "@taiwan-fin-hub/connectors";
import { z } from "zod";
import { prepareCtbcAuthorizationWrite } from "./ctbc-authorizations";
import { prepareEsunAuthorizationWrite } from "./esun-authorizations";
import { prepareSinopacAuthorizationWrite } from "./sinopac-authorizations";
import { prepareObankTimeDepositWrite } from "./obank-time-deposits";
import { prepareNextbankDepositWrite } from "./nextbank-deposits";
import {
  EInvoiceProtocolUnavailableError,
  createCtbcConnector,
  CtbcVerificationRequiredError,
  createSkbankConnector,
  SkbankVerificationRequiredError,
  createObankConnector,
  ObankProtocolError,
  ObankVerificationRequiredError,
  createMegabankConnector,
  MegabankOtpInvalidError,
  MegabankOtpRequiredError,
  MegabankProtocolError,
  MegabankVerificationRequiredError,
  parseCathaybkConfig,
  parseCtbcConfig,
  parseSkbankConfig,
  parseEsunConfig,
  parseObankConfig,
  parseMegabankConfig,
  parseSinopacConfig,
  parseHncbConfig,
  parseKgibankConfig,
  parseRakutenConfig,
  parseTaishinConfig,
  parseTdccConfig,
  syncTdccTradeHistory,
  tdccConnector,
  TdccOtpExpiredError,
  TdccVerificationRequiredError,
  prepareObankCaptcha,
  prepareMegabankCaptcha,
  parseFirstbankConfig,
} from "@taiwan-fin-hub/connectors";
import { BrowserRunCapacityError } from "../../connectors/browser";
import {
  CathayOtpChannelRequiredError,
  CathayOtpInvalidError,
  CathayOtpRequiredError,
  CathayOtpSessionExpiredError,
  CathayVerificationRequiredError,
  createCathaybkConnector,
} from "../../connectors/cathaybk";
import { createCtbcFetch } from "../../connectors/ctbc";
import { createEsunConnector } from "../../connectors/esun";
import {
  createFirstbankConnector,
  prepareFirstbankCaptcha,
  FirstbankConnectionError,
  FirstbankVerificationRequiredError,
} from "../../connectors/firstbank";
import {
  createHncbConnector,
  prepareHncbCaptcha,
  HncbConnectionError,
  HncbVerificationRequiredError,
} from "../../connectors/hncb";
import {
  createKgibankConnector,
  prepareKgibankCaptcha,
  KgibankVerificationRequiredError,
} from "../../connectors/kgibank";
import {
  createRakutenConnector,
  prepareRakutenCaptcha,
  RakutenAutoCaptchaFailedError,
  RakutenVerificationRequiredError,
} from "../../connectors/rakuten";
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
  ValidateNumberOcrError,
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
  findLatestRecoverableScheduledBatchId,
  recoverLatestScheduledSyncSource,
} from "./report-repository";
import {
  emptySyncNewRecordCounts,
  persistStagedSyncWrite,
  type SyncWriteRecord,
} from "./persistence";
import {
  connectorCursorStatement,
  connectorSettingsGuardStatement,
  compareAndSetConnectorSecret,
  connectorEncryptedConfigStatement,
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
  reconcileEsunLifecycleShadowStatements,
  reconcileEsunSingleCardSummaryAccountStatements,
  reconcileHncbLegacyTransactionStatements,
  reconcileHncbSingleCardSummaryAccountStatements,
  reconcileSinopacLegacyTransactionStatements,
  updateConnectorEncryptedConfig,
  updateConnectorEncryptedConfigIfCurrent,
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
// Single-invocation syncs renew their lease while running, so an interrupted
// invocation that never reaches `finally` blocks retries for at most one lease.
export const SYNC_LOCK_LEASE_MS = 10 * 60 * 1000;
const SYNC_LOCK_HEARTBEAT_MS = 2 * 60 * 1000;
// Durable runs hold the connector lock across Queue invocations without a
// heartbeat, so they keep the longer lease between chunks.
export const DURABLE_SYNC_LOCK_LEASE_MS = 30 * 60 * 1000;

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

/** 自動辨識驗證碼失敗，前端應直接改走人工驗證碼流程。 */
export class ManualCaptchaRequiredError extends NeedsUserActionError {}
export class NextbankCaptchaRequiredError extends NeedsUserActionError {}

export type SinopacSyncOverrides = {
  captcha?: string;
};

export type HncbSyncOverrides = {
  captcha?: string;
};

export type RakutenSyncOverrides = {
  captcha?: string;
};

export type KgibankSyncOverrides = {
  captcha?: string;
};

export type TaishinSyncOverrides = {
  captcha?: string;
};

export type ObankSyncOverrides = {
  captcha?: string;
};

export type MegabankSyncOverrides = {
  captcha?: string;
  otp?: string;
};

export type FirstbankSyncOverrides = {
  captcha?: string;
};

export type CathaySyncOverrides = {
  otp?: string;
  otpChannel?: "email" | "sms";
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

export async function prepareHncbCaptchaSession(env: Env) {
  const connectorId = "hncb";
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
    const config = parseHncbConfig({ ...stored, ...publicStored });
    const prepared = await prepareHncbCaptcha(env.BROWSER, config);
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
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

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

  try {
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
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

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

  try {
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

export async function prepareMegabankCaptchaSession(env: Env) {
  const connectorId = "megabank";
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
    const config = parseMegabankConfig({
      ...stored,
      ...parsePublicConnectorConfig(connectorId, settings.public_config),
    });
    const prepared = await prepareMegabankCaptcha(config);
    const saved = await updateConnectorEncryptedConfigIfCurrent(
      env.DB,
      connectorId,
      settings.encrypted_config,
      await encryptJson(
        {
          ...stored,
          // 首次取得驗證碼時固定虛擬裝置，之後登入都沿用，簡訊驗證才可能只需一次。
          ...prepared.device,
          pendingSession: prepared.pendingSession,
          pendingSessionExpiresAt: prepared.pendingSessionExpiresAt,
        },
        configEncryptionKey(env),
      ),
    );
    if (!saved) {
      throw new NeedsUserActionError(
        "兆豐銀行設定在驗證期間已變更，請重新取得驗證碼。",
      );
    }
    return {
      captchaImage: prepared.captchaImage,
      expiresAt: prepared.pendingSessionExpiresAt,
      captchaLength: 5,
      captchaKind: "numeric" as const,
    };
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

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

  try {
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

  const authorizationStatements = await prepareEsunAuthorizationWrite(
    env.DB,
    records,
  );
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    afterPromoteStatements: [
      ...(bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB)]
        : []),
      ...reconcileEsunLifecycleShadowStatements(env.DB),
      ...reconcileEsunSingleCardSummaryAccountStatements(env.DB),
      ...authorizationStatements,
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
  overrides: CathaySyncOverrides = {},
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
    ...(trigger === "manual" ? overrides : {}),
  });

  if (trigger !== "manual" && config.browserSessionId) {
    throw new NeedsUserActionError(
      "國泰世華正在等待一次性驗證碼，排程同步不會在背景寄送驗證碼。",
    );
  }

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );
  let result: Awaited<
    ReturnType<ReturnType<typeof createCathaybkConnector>["sync"]>
  >;
  try {
    result = await createCathaybkConnector(env.BROWSER).sync(
      config,
      settings.sync_cursor ?? undefined,
    );
  } catch (error) {
    const cleaned = { ...stored };

    if (error instanceof CathayOtpChannelRequiredError) {
      delete cleaned.sessionCookies;
      delete cleaned.sessionExpiresAt;
      cleaned.browserSessionId = error.browserSessionId;
      cleaned.browserSessionExpiresAt = error.browserSessionExpiresAt;
      delete cleaned.otp;
      delete cleaned.otpChannel;
      await updateConnectorEncryptedConfig(
        env.DB,
        connectorId,
        await encryptJson(cleaned, configEncryptionKey(env)),
      );
      throw error;
    }

    if (error instanceof CathayOtpRequiredError) {
      cleaned.otpChannel = error.channel;
      delete cleaned.otp;
      await updateConnectorEncryptedConfig(
        env.DB,
        connectorId,
        await encryptJson(cleaned, configEncryptionKey(env)),
      );
      throw error;
    }

    if (error instanceof CathayOtpInvalidError) {
      delete cleaned.otp;
      await updateConnectorEncryptedConfig(
        env.DB,
        connectorId,
        await encryptJson(cleaned, configEncryptionKey(env)),
      );
      throw error;
    }

    // OTP submission, session expiry, and all other failures invalidate the
    // transient Browser session. A subsequent manual sync starts a new login.
    delete cleaned.browserSessionId;
    delete cleaned.browserSessionExpiresAt;
    delete cleaned.otp;
    delete cleaned.otpChannel;
    if (error instanceof CathayVerificationRequiredError) {
      delete cleaned.sessionCookies;
      delete cleaned.sessionExpiresAt;
    }
    await updateConnectorEncryptedConfig(
      env.DB,
      connectorId,
      await encryptJson(cleaned, configEncryptionKey(env)),
    );

    if (error instanceof CathayOtpSessionExpiredError) {
      throw error;
    }
    if (error instanceof CathayVerificationRequiredError) {
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
      otp: _otp,
      otpChannel: _otpChannel,
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

  const authorizationWrite = await prepareCtbcAuthorizationWrite(
    env.DB,
    records,
  );
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records: authorizationWrite.records,
    afterPromoteStatements: [
      ...authorizationWrite.afterPromoteStatements,
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

export async function syncSkbank(
  env: Env,
  trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const connectorId = "skbank";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseSkbankConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<
    ReturnType<ReturnType<typeof createSkbankConnector>["sync"]>
  >;
  try {
    result = await createSkbankConnector().sync(
      config,
      settings.sync_cursor ?? undefined,
    );
  } catch (error) {
    if (error instanceof SkbankVerificationRequiredError) {
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
    const persistedConfig = { ...config, ...cursorState.secretState };
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, persistedConfig),
        serializePublicConfig(connectorId, persistedConfig),
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

function nextbankCleanConfig(stored: Record<string, unknown>) {
  const cleaned = { ...stored };
  delete cleaned.captchaUuid;
  delete cleaned.captchaExpiresAt;
  return cleaned;
}

export async function prepareNextbankCaptchaSession(env: Env) {
  const connectorId = "nextbank";
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId(connectorId);
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope: SYNC_SCOPE_ALL,
    trigger: "manual",
    runId,
    leaseMs: 180_000,
  });
  if (!locked) throw new SyncAlreadyRunningError(connectorId);
  try {
    const settings = await requireConnectorSettings(env.DB, connectorId);
    const stored = await decryptJson<Record<string, unknown>>(
      settings.encrypted_config,
      configEncryptionKey(env),
    );
    const config = nextbankConfigSchema.parse(stored);
    if (!config.userId || !config.account || !config.password)
      throw new NeedsUserActionError("請先儲存將來銀行帳密。");
    const cleared = await encryptJson(
      nextbankCleanConfig(stored),
      configEncryptionKey(env),
    );
    const clearedAt = new Date().toISOString();
    await compareAndSetConnectorSecret(
      env.DB,
      connectorId,
      settings,
      cleared,
      clearedAt,
    );
    const prepared = await new NextbankApiClient().prepareCaptcha();
    await compareAndSetConnectorSecret(
      env.DB,
      connectorId,
      { encrypted_config: cleared, updated_at: clearedAt },
      await encryptJson(
        {
          ...nextbankCleanConfig(stored),
          captchaUuid: prepared.uuid,
          captchaExpiresAt: prepared.expiresAt,
        },
        configEncryptionKey(env),
      ),
      new Date().toISOString(),
    );
    return {
      captchaImage: `data:image/png;base64,${prepared.imageBase64}`,
      expiresAt: new Date(prepared.expiresAt).toISOString(),
      captchaLength: 5,
      captchaKind: "alphanumeric" as const,
    };
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

export async function syncNextbank(
  env: Env,
  _trigger: SyncTrigger,
  overrides: Record<string, unknown> = {},
): Promise<SyncOutcome> {
  const connectorId = "nextbank";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = nextbankConfigSchema.parse(stored);
  if (!config.userId || !config.account || !config.password)
    throw new NeedsUserActionError("請先儲存將來銀行帳密。");
  // Consume persisted challenge before contacting the bank, including failures.
  const cleaned = await encryptJson(
    nextbankCleanConfig(stored),
    configEncryptionKey(env),
  );
  const version = new Date().toISOString();
  await compareAndSetConnectorSecret(
    env.DB,
    connectorId,
    settings,
    cleaned,
    version,
  );
  const client = new NextbankApiClient();
  let token: string | undefined;
  let result: ReturnType<typeof parseNextbankDeposits>;
  try {
    const submitted = z
      .string()
      .regex(/^[A-Za-z0-9]{1,5}$/)
      .optional()
      .safeParse(overrides.captcha);
    if (!submitted.success) throw new NextbankApiError("captcha");
    let answer = submitted.data;
    if (answer) {
      if (!config.captchaUuid || !config.captchaExpiresAt)
        throw new NextbankApiError("captcha");
      client.restoreCaptcha({
        uuid: config.captchaUuid,
        expiresAt: config.captchaExpiresAt,
      });
    } else {
      const challenge = await client.prepareCaptcha();
      const bytes = Uint8Array.from(atob(challenge.imageBase64), (char) =>
        char.charCodeAt(0),
      );
      try {
        answer = (
          await recognizeAlphanumericCaptcha(
            env.AI,
            bytes.buffer,
            "image/png",
            5,
          )
        ).code;
      } catch {
        throw new NextbankCaptchaRequiredError(
          "將來銀行驗證碼無法自動辨識，請改用人工輸入。",
        );
      }
    }
    ({ accessToken: token } = await client.login({
      identity: config.userId,
      userId: config.account,
      password: config.password,
      captchaResult: answer,
    }));
    result = parseNextbankDeposits(
      await collectNextbankDepositPayloads(client, token),
    );
  } catch (error) {
    if (error instanceof NextbankApiError && error.kind === "captcha") {
      throw new NextbankCaptchaRequiredError("將來銀行需要重新驗證：captcha。");
    }
    if (
      error instanceof NextbankApiError &&
      [
        "credentials",
        "session_conflict",
        "session_expired",
        "account_unavailable",
      ].includes(error.kind)
    ) {
      throw new NeedsUserActionError(`將來銀行需要重新驗證：${error.kind}。`);
    }
    throw error;
  } finally {
    if (token) {
      try {
        await client.logout(token);
      } catch {
        console.warn("[sync] nextbank: logout unconfirmed");
      }
      token = undefined;
    }
  }
  const now = new Date().toISOString();
  const records: SyncWriteRecord[] = [
    ...result.bankAccounts.map((account) =>
      bankAccountRecord(connectorId, account, now),
    ),
    ...result.bankBalanceSnapshots.map((snapshot) =>
      bankBalanceSnapshotRecord(connectorId, snapshot, now),
    ),
    ...result.bankTransactions.map((transaction) =>
      bankTransactionRecord(connectorId, transaction, now),
    ),
  ];
  const depositWrite = await prepareNextbankDepositWrite(env.DB, result, now);
  records.push(...depositWrite.records);
  const cursor = JSON.stringify({ syncedAt: now });
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    beforePromoteStatements: [
      connectorSettingsGuardStatement(env.DB, connectorId, cleaned, version),
    ],
    afterPromoteStatements: [
      ...depositWrite.afterPromoteStatements,
      linkCanonicalBankAccountsStatement(env.DB),
    ],
    finalizeStatements: [
      connectorCursorStatement(env.DB, connectorId, cursor, now),
    ],
  });
  await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  return {
    success: true,
    connectorId,
    scope: "all",
    records: records.length,
    newRecords,
    cursorUpdated: true,
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

function megabankStoredConfigAfterSync(stored: Record<string, unknown>) {
  const cleaned = obankStoredConfigAfterSync(stored);
  delete cleaned.otp;
  return cleaned;
}

export async function syncMegabank(
  env: Env,
  trigger: SyncTrigger,
  overrides: MegabankSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "megabank";
  const scope = SYNC_SCOPE_ALL;
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseMegabankConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...overrides,
  });
  let result: Awaited<
    ReturnType<ReturnType<typeof createMegabankConnector>["sync"]>
  >;
  try {
    const connector = createMegabankConnector(
      globalThis.fetch.bind(globalThis),
      overrides.captcha || overrides.otp
        ? undefined
        : async (imageBytes, contentType) => {
            try {
              return (
                await recognizeNumericCaptcha(
                  env.AI,
                  imageBytes,
                  contentType,
                  5,
                )
              ).number;
            } catch {
              throw new MegabankVerificationRequiredError(
                "兆豐銀行驗證碼無法自動辨識，請改用人工輸入。",
              );
            }
          },
      // 只有使用者在場的手動同步才請銀行寄簡訊驗證碼，排程不觸發。
      { allowOtpRequest: trigger === "manual" },
    );
    result = await connector.sync(config, settings.sync_cursor ?? undefined);
  } catch (error) {
    const awaitingOtp =
      error instanceof MegabankOtpRequiredError ||
      error instanceof MegabankOtpInvalidError;
    const cleaned = megabankStoredConfigAfterSync(stored);
    await updateConnectorEncryptedConfigIfCurrent(
      env.DB,
      connectorId,
      settings.encrypted_config,
      await encryptJson(
        awaitingOtp
          ? {
              ...cleaned,
              ...error.device,
              pendingSession: error.pendingSession,
              pendingSessionExpiresAt: error.pendingSessionExpiresAt,
            }
          : cleaned,
        configEncryptionKey(env),
      ),
    );
    if (awaitingOtp) throw error;
    if (error instanceof MegabankVerificationRequiredError) {
      throw new NeedsUserActionError(error.message);
    }
    if (error instanceof MegabankProtocolError) throw error;
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
  const cleanedConfig = parseMegabankConfig(
    megabankStoredConfigAfterSync(config),
  );
  if (
    (await requireConnectorSettings(env.DB, connectorId)).encrypted_config !==
    settings.encrypted_config
  ) {
    throw new NeedsUserActionError(
      "兆豐銀行設定在同步期間已變更，請重新同步。",
    );
  }
  const settingsGuard = {
    connectorId,
    encryptedConfig: settings.encrypted_config,
  } as const;
  let persistedCursor: string | undefined;
  let persistedEncryptedConfig: string | undefined;
  const finalizeStatements: D1PreparedStatement[] = [];
  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    persistedEncryptedConfig = await encryptConnectorConfig(
      env,
      connectorId,
      cleanedConfig,
    );
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        persistedEncryptedConfig,
        serializePublicConfig(connectorId, cleanedConfig),
        persistedCursor,
        now,
        settings.encrypted_config,
      ),
    );
  }
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    settingsGuard,
    afterPromoteStatements:
      bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB, settingsGuard)]
        : [],
    finalizeStatements,
  });
  if (
    persistedEncryptedConfig &&
    (await requireConnectorSettings(env.DB, connectorId)).encrypted_config !==
      persistedEncryptedConfig
  ) {
    throw new NeedsUserActionError(
      "兆豐銀行設定在同步期間已變更，請重新同步。",
    );
  }
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
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
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

export async function syncHncb(
  env: Env,
  trigger: SyncTrigger,
  overrides: HncbSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "hncb";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseHncbConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...overrides,
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<
    ReturnType<ReturnType<typeof createHncbConnector>["sync"]>
  >;
  try {
    result = await createHncbConnector(
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
    if (error instanceof HncbConnectionError && error.sessionCookies) {
      cleaned.sessionCookies = error.sessionCookies;
      cleaned.sessionCreatedAt =
        error.sessionCreatedAt ?? new Date().toISOString();
    }
    if (error instanceof HncbVerificationRequiredError) {
      delete cleaned.sessionCookies;
      delete cleaned.sessionCreatedAt;
    }
    await updateConnectorEncryptedConfig(
      env.DB,
      connectorId,
      await encryptJson(cleaned, configEncryptionKey(env)),
    );
    if (error instanceof HncbVerificationRequiredError) {
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
    afterPromoteStatements: [
      ...(bankTransactions.some((transaction) =>
        transaction.sourceId.startsWith("hncb:card:tx:v2:"),
      )
        ? reconcileHncbLegacyTransactionStatements(env.DB)
        : []),
      ...reconcileHncbSingleCardSummaryAccountStatements(env.DB),
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
  let recoveryBatchId: string | null = null;
  try {
    recoveryBatchId =
      connectorId !== "tdcc" || scope === SYNC_SCOPE_ALL
        ? await findLatestRecoverableScheduledBatchId(env.DB, connectorId)
        : null;
    await beginActivityRun(env.DB, runId, recoveryBatchId, connectorId);
    const outcome = await task();
    await markManualSyncSuccess(env.DB, connectorId, scope);
    if (connectorId !== "tdcc" || scope === SYNC_SCOPE_ALL) {
      await recoverLatestScheduledSyncSource(env.DB, {
        connectorId,
        newRecords: outcome.newRecords,
        batchId: recoveryBatchId,
        runId,
      }).catch((error) => {
        // A report repair must never turn an otherwise successful manual sync
        // into a failed sync response.
        console.error(
          "[sync] failed to recover latest scheduled report",
          error,
        );
      });
    }
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
  if (error instanceof BrowserRunCapacityError) return false;
  if (
    error instanceof NeedsUserActionError ||
    error instanceof CathayOtpChannelRequiredError ||
    error instanceof CathayOtpRequiredError ||
    error instanceof CathayOtpSessionExpiredError ||
    error instanceof CathayVerificationRequiredError ||
    error instanceof TdccOtpExpiredError ||
    error instanceof TdccVerificationRequiredError ||
    error instanceof EInvoiceProtocolUnavailableError ||
    error instanceof SinopacVerificationRequiredError ||
    error instanceof TaishinVerificationRequiredError ||
    error instanceof HncbVerificationRequiredError ||
    error instanceof RakutenVerificationRequiredError ||
    error instanceof KgibankVerificationRequiredError ||
    error instanceof MegabankVerificationRequiredError
  )
    return true;
  const message = error instanceof Error ? error.message : String(error);
  return /OTP|verification|requires.*login|requires.*session|requires.*user action/i.test(
    message,
  );
}

export function safeErrorMessage(error: unknown) {
  const message = normalizeErrorText(
    redactSensitiveText(
      error instanceof Error
        ? error.message
        : error === null || error === undefined
          ? ""
          : String(error),
    ),
    300,
  );
  return message || "同步失敗，但未取得錯誤原因。";
}

export function safeErrorLogDetails(error: unknown) {
  const errorName = normalizeErrorText(
    error instanceof Error ? error.name : typeof error,
    80,
  );
  const stack =
    error instanceof Error
      ? sanitizeErrorDiagnostic(
          (error.stack ?? "").split("\n").slice(1).join("\n"),
          1_500,
        )
      : "";
  const cause = error instanceof Error ? error.cause : undefined;
  const causeName =
    cause instanceof Error
      ? normalizeErrorText(cause.name, 80) || "UnknownError"
      : "";
  const causeStack =
    cause instanceof Error
      ? sanitizeErrorDiagnostic(
          (cause.stack ?? "").split("\n").slice(1).join("\n"),
          500,
        )
      : "";
  const stage =
    error instanceof Error &&
    "stage" in error &&
    typeof error.stage === "string"
      ? normalizeErrorText(error.stage, 80)
      : "";

  return {
    errorName: errorName || "UnknownError",
    ...(stage ? { stage } : {}),
    ...(stack ? { stack } : {}),
    ...(causeName ? { causeName } : {}),
    ...(causeStack ? { causeStack } : {}),
  };
}

function normalizeErrorText(value: string, maxLength: number) {
  return value.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function sanitizeErrorDiagnostic(value: string, maxLength: number) {
  return redactSensitiveText(value).trim().slice(0, maxLength);
}

// Upstream error text can echo account identifiers or tokens; redact before it
// reaches sync records, API responses, or logs.
function redactSensitiveText(value: string) {
  return value
    .replace(/https?:\/\/\S+/gi, "[URL]")
    .replace(
      /\b(authorization|cookie|password|passwd|token|secret|session(?:cookies?)?)\s*[:=]\s*([^\s,;]+)/gi,
      "$1=[redacted]",
    )
    .replace(/\b(?:Bearer\s+)?[A-Za-z0-9+/_=-]{24,}\b/g, "[redacted]")
    .replace(/\b[A-Z][1289]\d{8}\b/g, "[redacted]")
    .replace(/\b\d{10,}\b/g, "[redacted]");
}
