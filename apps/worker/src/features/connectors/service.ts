import { parseConnectorConfig } from "@taiwan-fin-hub/connectors";
import { connectorCatalog, type ConnectorId } from "@taiwan-fin-hub/core";
import { clearConnectorCursor } from "@taiwan-fin-hub/db";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import { findConnectorSettings, saveConnectorSettings } from "./repository";

export class ConnectorConfigMissingError extends Error {}
export class InvalidConnectorConfigError extends Error {}

export async function getConnectorSettingsView(
  env: Env,
  connectorId: ConnectorId,
) {
  const settings = await findConnectorSettings(env.DB, connectorId);
  let sessionAvailable = false;
  let credentialsComplete = false;
  if (settings) {
    const stored = await decryptJson<Record<string, unknown>>(
      settings.encrypted_config,
      configEncryptionKey(env),
    );
    credentialsComplete = connectorCatalog[connectorId].credentialFields.every(
      (key) => typeof stored[key] === "string" && stored[key].length > 0,
    );
    if (connectorId === "tdcc") {
      const session = stored.session;
      sessionAvailable =
        credentialsComplete &&
        Boolean(
          session &&
          typeof session === "object" &&
          typeof (session as Record<string, unknown>).tokenId === "string",
        );
    } else if (
      connectorId === "esun" ||
      connectorId === "sinopac" ||
      connectorId === "taishin" ||
      connectorId === "hncb"
    ) {
      sessionAvailable =
        typeof stored.sessionCookies === "string" &&
        stored.sessionCookies.length > 0 &&
        (connectorId !== "sinopac" ||
          stored.protocol === "sinopac-mobile-app-json-v1");
    }
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
    sessionAvailable,
  };
}

export async function updateConnectorSettings(
  env: Env,
  connectorId: ConnectorId,
  rawConfig: Record<string, unknown>,
) {
  const definition = connectorCatalog[connectorId];
  const publicKeys: readonly string[] = definition.publicFields;
  const hasSensitive = definition.credentialFields.some(
    (key) => rawConfig[key] !== undefined && rawConfig[key] !== "",
  );
  const now = new Date().toISOString();
  const encryptionKey = configEncryptionKey(env);
  const existing = await findConnectorSettings(env.DB, connectorId);
  if (!hasSensitive && !existing) throw new ConnectorConfigMissingError();

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
      fieldsChanged(definition.credentialFields, storedConfig, rawConfig);
    if (shouldClearCursor) {
      for (const key of definition.resetOnCredentialChangeFields) {
        delete mergedConfig[key];
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
