import type { Env } from "../../platform/env";
import type { SyncTrigger } from "../../db";
import type { SyncOutcome } from "../../features/sync/types";
import {
  requireConnectorSettings,
  encryptConnectorConfig,
  serializePublicConfig,
} from "../../features/sync/config";
import { decryptJson } from "../../platform/crypto";
import { configEncryptionKey } from "../../platform/config";
import { parseCtbcConfig, type CtbcPendingSession } from "./protocol";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../features/sync/connector-state";
import {
  createCtbcConnector,
  CtbcTwoStageRequiredError,
  CtbcVerificationExpiredError,
  CtbcVerificationRequiredError,
  type CtbcSyncOverrides,
} from "./mobile-api";
import { createCtbcFetch } from "./connector";
import { NeedsUserActionError } from "../../features/sync/errors";
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
  connectorStateStatement,
  connectorSettingsGuardStatement,
  updateConnectorEncryptedConfigIfCurrent,
  linkCanonicalBankAccountsStatement,
} from "../../features/sync/connector-repository";
import { prepareCtbcAuthorizationWrite } from "./authorizations";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../features/net-worth/service";

export async function syncCtbc(
  env: Env,
  trigger: SyncTrigger,
  overrides: CtbcSyncOverrides = {},
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
  let encryptedConfig = settings.encrypted_config;
  const savePendingSession = async (
    pendingSession: CtbcPendingSession | undefined,
  ) => {
    if (config.pendingSession === undefined && pendingSession === undefined)
      return;
    config.pendingSession = pendingSession;
    await saveConfig();
  };
  const saveConfig = async () => {
    const next = await encryptConnectorConfig(env, connectorId, config);
    if (
      !(await updateConnectorEncryptedConfigIfCurrent(
        env.DB,
        connectorId,
        encryptedConfig,
        next,
      ))
    ) {
      throw new CtbcVerificationRequiredError(
        "中國信託設定在登入期間已變更，請重新同步。",
      );
    }
    encryptedConfig = next;
  };

  // Persist before any bank request, including failures and MFA challenges.
  // Changing a password keeps this identity; changing customer/account resets it.
  if (!config.deviceCode) {
    config.deviceCode = crypto.randomUUID();
    await saveConfig();
  }
  // Older pending logins already carry the seed used for the App approval.
  if (!config.deviceSeed && config.pendingSession?.seed) {
    config.deviceSeed = config.pendingSession.seed;
    await saveConfig();
  }

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<
    ReturnType<ReturnType<typeof createCtbcConnector>["sync"]>
  >;
  try {
    const fetcher = createCtbcFetch(env);
    const connector = createCtbcConnector(fetcher, {
      allowInteractiveVerification: trigger === "manual",
      onDeviceSeed: async (seed) => {
        config.deviceSeed = seed;
        await saveConfig();
      },
      onPendingSession: savePendingSession,
    });
    result = await connector.sync(
      config,
      settings.sync_cursor ?? undefined,
      overrides,
    );
  } catch (error) {
    if (error instanceof CtbcTwoStageRequiredError) throw error;
    await savePendingSession(undefined);
    if (error instanceof CtbcVerificationExpiredError) throw error;
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
        encryptedConfig,
      ),
    );
  }

  const authorizationWrite = await prepareCtbcAuthorizationWrite(
    env.DB,
    records,
  );
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records: authorizationWrite.records,
    beforePromoteStatements: [
      connectorSettingsGuardStatement(
        env.DB,
        connectorId,
        encryptedConfig,
        settings.updated_at,
      ),
    ],
    afterPromoteStatements: [
      ...authorizationWrite.afterPromoteStatements,
      ...(bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB)]
        : []),
    ],
    finalizeStatements,
  }).catch(async (error) => {
    const current = await requireConnectorSettings(env.DB, connectorId);
    if (
      current.encrypted_config !== encryptedConfig ||
      current.updated_at !== settings.updated_at
    ) {
      throw new NeedsUserActionError(
        "中國信託設定在同步期間已變更，請重新同步。",
      );
    }
    throw error;
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
