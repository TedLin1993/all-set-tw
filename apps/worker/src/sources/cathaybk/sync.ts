import type { Env } from "../../platform/env";
import type { SyncTrigger } from "../../db";
import type { SyncOutcome } from "../../features/sync/types";
import {
  requireConnectorSettings,
  encryptConnectorConfig,
  serializePublicConfig,
} from "../../features/sync/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import { configEncryptionKey } from "../../platform/config";
import { parseCathaybkConfig } from "./protocol";
import { logCathayLoanStage } from "./loan-overview";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../features/sync/connector-state";
import { NeedsUserActionError } from "../../features/sync/errors";
import {
  createCathaybkConnector,
  CathayOtpChannelRequiredError,
  CathayOtpRequiredError,
  CathayOtpInvalidError,
  CathayVerificationRequiredError,
  CathayOtpSessionExpiredError,
} from "./connector";
import {
  updateConnectorEncryptedConfig,
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
  deactivateMissingCathayLoanAccountsStatement,
} from "../../features/sync/connector-repository";
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

export type CathaySyncOverrides = {
  otp?: string;
  otpChannel?: "email" | "sms";
};

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
  const loanAccounts = bankAccounts.filter(
    (account) =>
      account.accountType === "loan" &&
      account.sourceId.startsWith("loan:cathaybk:"),
  );
  const loanSourceIds = new Set(
    loanAccounts.map((account) => account.sourceId),
  );
  const loanSnapshots = bankBalanceSnapshots.filter((snapshot) =>
    loanSourceIds.has(snapshot.accountId),
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

  const loanPersistenceCounts = {
    returnedLoanAccountCount: loanAccounts.length,
    submittedLoanAccountCount: loanAccounts.length,
    submittedLoanSnapshotCount: loanSnapshots.length,
  };
  logCathayLoanStage("persistence", "started", loanPersistenceCounts);
  let newRecords: SyncOutcome["newRecords"];
  try {
    newRecords = await persistStagedSyncWrite(env.DB, {
      records,
      afterPromoteStatements: [
        ...(bankAccounts.length > 0
          ? [linkCanonicalBankAccountsStatement(env.DB)]
          : []),
        ...(result.loanOverviewComplete
          ? [
              deactivateMissingCathayLoanAccountsStatement(
                env.DB,
                bankAccounts
                  .filter(
                    (account) =>
                      account.accountType === "loan" &&
                      account.sourceId.startsWith("loan:cathaybk:"),
                  )
                  .map((account) => account.sourceId),
                now,
              ),
            ]
          : []),
      ],
      finalizeStatements,
    });
  } catch (error) {
    logCathayLoanStage("persistence", "failed", loanPersistenceCounts);
    throw error;
  }

  logCathayLoanStage("persistence", "success", loanPersistenceCounts);

  if (bankBalanceSnapshots.length > 0) {
    logCathayLoanStage("history_rebuild", "started", {
      snapshotCount: bankBalanceSnapshots.length,
    });
    try {
      await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
    } catch (error) {
      logCathayLoanStage("history_rebuild", "failed", {
        snapshotCount: bankBalanceSnapshots.length,
      });
      throw error;
    }
    logCathayLoanStage("history_rebuild", "complete", {
      snapshotCount: bankBalanceSnapshots.length,
    });
  }

  console.log(
    `[sync] ${connectorId}/${scope}: accounts=${bankAccounts.length} loans=${loanAccounts.length} snapshots=${bankBalanceSnapshots.length} loan_snapshots=${loanSnapshots.length} transactions=${bankTransactions.length} bills=${creditCardBills.length} loan_overview=${result.loanOverviewComplete ? "complete" : "incomplete"}`,
  );

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
