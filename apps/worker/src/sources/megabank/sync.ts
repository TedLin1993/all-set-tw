import { createSyncExecution } from "../../features/sync/execution";
import { prepareCardAuthorizationWrite } from "../../features/sync/card-authorization-write";
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
import { createMegabankEgressFetcher } from "../../platform/megabank-egress";
import { configEncryptionKey } from "../../platform/config";
import { parseMegabankConfig, type MegabankConfig } from "./protocol";
import { appVersion, detailVersion } from "./app-settings";
import { reconcileMegabankDeposits } from "./transaction-reconcile";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../features/sync/connector-state";
import {
  prepareMegabankCaptcha,
  createMegabankConnector,
  MegabankVerificationRequiredError,
  MegabankOtpRequiredError,
  MegabankOtpInvalidError,
  MegabankProtocolError,
  type MegabankDevice,
  type MegabankDiagnostic,
} from "./mobile-api";
import {
  updateConnectorEncryptedConfigIfCurrent,
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
} from "../../features/sync/connector-repository";
import {
  recognizeNumericCaptcha,
  ValidateNumberOcrError,
} from "../../features/ocr/service";
import { CaptchaUnreadableError } from "../captcha-retry";
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

export type MegabankSyncOverrides = {
  captcha?: string;
  otp?: string;
};

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
      const config = parseMegabankConfig({
        ...stored,
        ...parsePublicConnectorConfig(connectorId, settings.public_config),
      });
      const tracking = trackMegabankState(
        env,
        stored,
        config,
        settings.encrypted_config,
        "manual",
        "captcha",
      );
      const prepared = await prepareMegabankCaptcha(
        config,
        createMegabankEgressFetcher(env.MEGABANK_EGRESS),
        tracking,
      );
      const saved = await updateConnectorEncryptedConfigIfCurrent(
        env.DB,
        connectorId,
        tracking.encryptedConfig,
        await encryptJson(
          {
            ...stored,
            // 裝置已在向銀行請求前保存；這裡只追加短暫的驗證工作階段。
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
    });
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

function megabankStoredConfigAfterSync(stored: Record<string, unknown>) {
  const cleaned = { ...stored };
  delete cleaned.pendingSession;
  delete cleaned.pendingSessionExpiresAt;
  delete cleaned.captcha;
  delete cleaned.otp;
  return cleaned;
}

/** 在任何銀行請求前加密保存實際裝置；指紋僅供跨次診斷，無法恢復登入。 */
function trackMegabankState(
  env: Env,
  stored: Record<string, unknown>,
  config: MegabankConfig,
  encryptedConfig: string,
  trigger: SyncTrigger,
  flow: "captcha" | "sync",
) {
  const context = {
    attemptId: crypto.randomUUID(),
    trigger,
    flow,
    appVersion,
    detailVersion,
  };
  const log = (diagnostic: object) => {
    console.log(JSON.stringify({ ...context, ...diagnostic }));
  };
  const tracking = {
    encryptedConfig,
    onDiagnostic: (diagnostic: MegabankDiagnostic) => log(diagnostic),
    async onDevice(
      device: MegabankDevice,
      source: "stored" | "generated" | "pending_session",
    ) {
      const changed =
        stored.deviceCode !== device.deviceCode ||
        stored.deviceUKey !== device.deviceUKey ||
        stored.deviceSeed !== device.deviceSeed;
      if (changed) {
        const next = await encryptJson(
          { ...stored, ...device },
          configEncryptionKey(env),
        );
        const saved = await updateConnectorEncryptedConfigIfCurrent(
          env.DB,
          "megabank",
          tracking.encryptedConfig,
          next,
        );
        if (!saved) {
          log({
            event: "megabank_device_state",
            source,
            outcome: "settings_changed",
          });
          throw new NeedsUserActionError(
            "兆豐銀行設定在同步期間已變更，請重新同步。",
          );
        }
        tracking.encryptedConfig = next;
        Object.assign(stored, device);
      }
      Object.assign(config, device);
      const digest = await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(
          JSON.stringify([
            device.deviceCode,
            device.deviceUKey,
            device.deviceSeed,
          ]),
        ),
      );
      const fingerprint = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("")
        .slice(0, 16);
      log({
        event: "megabank_device_state",
        source,
        fingerprint,
        outcome: changed ? "saved" : "reused",
      });
    },
  };
  return tracking;
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
  const tracking = trackMegabankState(
    env,
    stored,
    config,
    settings.encrypted_config,
    trigger,
    "sync",
  );
  let result: Awaited<
    ReturnType<ReturnType<typeof createMegabankConnector>["sync"]>
  >;
  try {
    const connector = createMegabankConnector(
      createMegabankEgressFetcher(env.MEGABANK_EGRESS),
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
            } catch (error) {
              // 辨識結果不符格式時尚未送出登入，可換新驗證碼重試；服務不可用則停止。
              if (error instanceof ValidateNumberOcrError) {
                throw new CaptchaUnreadableError();
              }
              throw new MegabankVerificationRequiredError(
                "兆豐銀行驗證碼無法自動辨識，請改用人工輸入。",
              );
            }
          },
      // 只有使用者在場的手動同步才請銀行寄簡訊驗證碼，排程不觸發。
      { ...tracking, allowOtpRequest: trigger === "manual" },
    );
    result = await connector.sync(config, settings.sync_cursor ?? undefined);
  } catch (error) {
    const awaitingOtp =
      error instanceof MegabankOtpRequiredError ||
      error instanceof MegabankOtpInvalidError;
    const cleaned = megabankStoredConfigAfterSync(stored);
    const saved = await updateConnectorEncryptedConfigIfCurrent(
      env.DB,
      connectorId,
      tracking.encryptedConfig,
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
    if (!saved) {
      throw new NeedsUserActionError(
        "兆豐銀行設定在同步期間已變更，請重新同步。",
      );
    }
    if (awaitingOtp) throw error;
    if (error instanceof MegabankVerificationRequiredError) {
      throw new NeedsUserActionError(error.message);
    }
    if (error instanceof MegabankProtocolError) throw error;
    throw error;
  }

  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  // 舊 sourceId 含會隨當天交易變動的順序欄位；寫入前先對回既有列，避免重複寫入。
  const bankTransactions = await reconcileMegabankDeposits(
    env.DB,
    result.bankTransactions ?? [],
  );
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
    tracking.encryptedConfig
  ) {
    throw new NeedsUserActionError(
      "兆豐銀行設定在同步期間已變更，請重新同步。",
    );
  }
  const settingsGuard = {
    connectorId,
    encryptedConfig: tracking.encryptedConfig,
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
        tracking.encryptedConfig,
      ),
    );
  }
  const prepared = await prepareCardAuthorizationWrite(
    env.DB,
    connectorId,
    records,
    {
      sourcePattern: "megabank:card:tx:%",
      encryptedConfig: tracking.encryptedConfig,
      cardId: (row) => {
        if (!row.source_id.startsWith("megabank:card:tx:")) return undefined;
        const metadata = JSON.parse(row.raw_payload || "{}") as {
          cardLast4?: string;
        };
        return typeof metadata.cardLast4 === "string" &&
          /^\d{4}$/.test(metadata.cardLast4)
          ? metadata.cardLast4
          : undefined;
      },
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
