import {
  connectorIdentityResets,
  describeConnectorSession,
  parseConnectorConfig,
} from "../../sources/config-registry";
import {
  connectorCatalog,
  type ConnectorDataSummaryResponse,
  type ConnectorId,
  type ConnectorUnlinkResponse,
} from "@taiwan-fin-hub/shared";
import { clearConnectorCursor } from "../../db";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import { bankDepositHistoryRebuildStatements } from "../net-worth/service";
import {
  connectorDataDeletionStatements,
  connectorIdleGuardStatement,
  connectorUnlinkStatements,
  countConnectorData,
  findConnectorBalanceStartDate,
  findConnectorSettings,
  isConnectorSyncRunning,
  saveConnectorSettings,
} from "./repository";

export class ConnectorConfigMissingError extends Error {}
export class InvalidConnectorConfigError extends Error {}
export class ConnectorSyncRunningError extends Error {}

export async function getConnectorDataSummary(
  db: D1Database,
  connectorId: ConnectorId,
): Promise<ConnectorDataSummaryResponse> {
  const counts = await countConnectorData(db, connectorId);
  const count = (key: string) => counts[key] ?? 0;
  return {
    connectorId,
    data: {
      accounts: count("accounts"),
      transactions: count("transactions"),
      balanceSnapshots: count("balanceSnapshots"),
      creditCardBills: count("creditCardBills"),
      invoices: count("invoices"),
      investmentPositions: count("investmentPositions"),
      investmentTransactions: count("investmentTransactions"),
    },
    userEdits: {
      categoryOverrides: count("categoryOverrides"),
      transactionPreferences: count("transactionPreferences"),
      invoiceLinks: count("invoiceLinks"),
      paymentAccounts: count("paymentAccounts"),
    },
  };
}

/**
 * 解除連結：刪除憑證、session 與同步狀態；`deleteData` 時一併刪除這個來源同步的資料，
 * 並重算受影響的存款歷史。同步中不處理，檢查與刪除在同一個 batch，避免檢查後才開始的同步寫回資料。
 */
export async function unlinkConnector(
  db: D1Database,
  connectorId: ConnectorId,
  deleteData: boolean,
): Promise<ConnectorUnlinkResponse> {
  const now = new Date().toISOString();
  if (await isConnectorSyncRunning(db, connectorId, now))
    throw new ConnectorSyncRunningError();
  const depositHistoryFrom = deleteData
    ? await findConnectorBalanceStartDate(db, connectorId)
    : null;
  try {
    await db.batch([
      connectorIdleGuardStatement(db, connectorId, now),
      ...(deleteData
        ? connectorDataDeletionStatements(db, connectorId, now)
        : []),
      ...(depositHistoryFrom
        ? bankDepositHistoryRebuildStatements(db, depositHistoryFrom, now)
        : []),
      ...connectorUnlinkStatements(db, connectorId, now),
    ]);
  } catch (error) {
    if (await isConnectorSyncRunning(db, connectorId, new Date().toISOString()))
      throw new ConnectorSyncRunningError();
    throw error;
  }
  return { connectorId, configured: false, dataDeleted: deleteData };
}

export async function getConnectorSettingsView(
  env: Env,
  connectorId: ConnectorId,
) {
  const settings = await findConnectorSettings(env.DB, connectorId);
  let credentialsComplete = false;
  let sessionState = describeConnectorSession(connectorId, {}, false);
  if (settings) {
    const stored = await decryptJson<Record<string, unknown>>(
      settings.encrypted_config,
      configEncryptionKey(env),
    );
    credentialsComplete = connectorCatalog[connectorId].credentialFields
      // select 欄位有預設值（第一個選項），未設定不算憑證不完整。
      .filter(({ type }) => type !== "select")
      .every(
        ({ key }) => typeof stored[key] === "string" && stored[key].length > 0,
      );
    sessionState = describeConnectorSession(
      connectorId,
      stored,
      credentialsComplete,
    );
  }
  return {
    connectorId,
    configured: Boolean(settings),
    updatedAt: settings?.updated_at,
    publicConfig: settings?.public_config
      ? filterPublicConfig(
          connectorId,
          JSON.parse(settings.public_config) as Record<string, unknown>,
        )
      : null,
    credentialsComplete,
    ...sessionState,
  };
}

export async function updateConnectorSettings(
  env: Env,
  connectorId: ConnectorId,
  rawConfig: Record<string, unknown>,
) {
  const definition = connectorCatalog[connectorId];
  const publicKeys: readonly string[] = definition.publicFields;
  const credentialKeys = definition.credentialFields.map(({ key }) => key);
  const hasSensitive = credentialKeys.some(
    (key) => rawConfig[key] !== undefined && rawConfig[key] !== "",
  );
  const now = new Date().toISOString();
  const encryptionKey = configEncryptionKey(env);
  const existing = await findConnectorSettings(env.DB, connectorId);
  if (!hasSensitive && !existing && credentialKeys.length > 0)
    throw new ConnectorConfigMissingError();

  let encryptedConfig: Record<string, unknown>;
  let mergedPublic: Record<string, unknown>;
  let shouldClearCursor = false;
  try {
    const storedConfig = existing
      ? await decryptJson<Record<string, unknown>>(
          existing.encrypted_config,
          encryptionKey,
        )
      : {};
    const storedPublic = existing?.public_config
      ? filterPublicConfig(
          connectorId,
          JSON.parse(existing.public_config) as Record<string, unknown>,
        )
      : {};
    const mergedConfig: Record<string, unknown> = {
      ...storedConfig,
      ...storedPublic,
      ...rawConfig,
    };
    shouldClearCursor =
      Boolean(existing) &&
      fieldsChanged(credentialKeys, storedConfig, rawConfig);
    if (shouldClearCursor) {
      for (const key of definition.resetOnCredentialChangeFields) {
        delete mergedConfig[key];
      }
      const identityReset = connectorIdentityResets[connectorId];
      if (
        identityReset &&
        fieldsChanged(identityReset.fields, storedConfig, rawConfig)
      ) {
        for (const key of identityReset.reset) delete mergedConfig[key];
      }
    }

    const parsedConfig = parseConnectorConfig(
      connectorId,
      mergedConfig,
    ) as Record<string, unknown>;
    mergedPublic = {};
    encryptedConfig = { ...parsedConfig };
    for (const key of publicKeys) {
      if (parsedConfig[key] !== undefined)
        mergedPublic[key] = parsedConfig[key];
      delete encryptedConfig[key];
    }
  } catch {
    throw new InvalidConnectorConfigError();
  }

  await saveConnectorSettings(env.DB, {
    id: existing?.id ?? crypto.randomUUID(),
    connectorId,
    encryptedConfig: await encryptJson(encryptedConfig, encryptionKey),
    publicConfig:
      Object.keys(mergedPublic).length > 0
        ? JSON.stringify(mergedPublic)
        : null,
    now,
  });
  if (shouldClearCursor) {
    await clearConnectorCursor(env.DB, connectorId, now);
  }
  return { connectorId, configured: true, updatedAt: now };
}

function filterPublicConfig(
  connectorId: ConnectorId,
  config: Record<string, unknown>,
) {
  const publicKeys = connectorCatalog[connectorId].publicFields;
  return Object.fromEntries(
    publicKeys
      .filter((key) => config[key] !== undefined)
      .map((key) => [key, config[key]]),
  );
}

function fieldsChanged(
  fields: readonly string[],
  stored: Record<string, unknown>,
  incoming: Record<string, unknown>,
) {
  return fields.some(
    (key) =>
      key in incoming &&
      incoming[key] !== undefined &&
      incoming[key] !== "" &&
      incoming[key] !== stored[key],
  );
}
