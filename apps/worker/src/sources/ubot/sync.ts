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
import { parseUbotConfig } from "./protocol";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../../features/sync/connector-state";
import {
  createUbotConnector,
  UbotVerificationRequiredError,
} from "./mobile-api";
import { NeedsUserActionError } from "../../features/sync/errors";
import { prepareCardAuthorizationWrite } from "../../features/sync/card-authorization-write";
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
  linkCanonicalBankAccountsStatement,
} from "../../features/sync/connector-repository";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../features/net-worth/service";

export async function syncUbot(
  env: Env,
  trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const connectorId = "ubot";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseUbotConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<
    ReturnType<ReturnType<typeof createUbotConnector>["sync"]>
  >;
  try {
    result = await createUbotConnector().sync(
      config,
      settings.sync_cursor ?? undefined,
    );
  } catch (error) {
    if (error instanceof UbotVerificationRequiredError) {
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
    const persistedConfig = { ...config, ...cursorState.secretState };
    persistedEncryptedConfig = await encryptConnectorConfig(
      env,
      connectorId,
      persistedConfig,
    );
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        persistedEncryptedConfig,
        serializePublicConfig(connectorId, persistedConfig),
        persistedCursor,
        now,
        settings.encrypted_config,
      ),
    );
  }

  const prepared = await prepareCardAuthorizationWrite(
    env.DB,
    connectorId,
    records,
    {
      sourcePattern: "ubot:card:tx:%",
      encryptedConfig: settings.encrypted_config,
      cardId: (row) => {
        if (!row.source_id.startsWith("ubot:card:tx:")) return undefined;
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
      "聯邦 New New Bank 設定在同步期間已變更，請重新同步。",
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
