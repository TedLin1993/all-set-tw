import { parseConnectorConfig } from "@taiwan-fin-hub/connectors";
import { connectorCatalog, type ConnectorId } from "@taiwan-fin-hub/core";
import { clearConnectorCursor } from "@taiwan-fin-hub/db";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import { findConnectorSettings, saveConnectorSettings } from "./repository";

export class ConnectorConfigMissingError extends Error {}
export class InvalidConnectorConfigError extends Error {}

function hasValidCathayTrustedDevice(value: unknown) {
  if (typeof value !== "string") return false;
  try {
    const cookies = JSON.parse(value) as unknown;
    return (
      Array.isArray(cookies) &&
      cookies.some((cookie) => {
        if (!cookie || typeof cookie !== "object") return false;
        const candidate = cookie as Record<string, unknown>;
        const domain = String(candidate.domain ?? "")
          .replace(/^\./, "")
          .toLowerCase();
        return (
          candidate.name === "CUB.eBank.DeviceId" &&
          typeof candidate.value === "string" &&
          candidate.value.length > 0 &&
          typeof candidate.expires === "number" &&
          candidate.expires > Date.now() / 1000 &&
          (domain === "cathaybk.com.tw" || domain.endsWith(".cathaybk.com.tw"))
        );
      })
    );
  } catch {
    return false;
  }
}

export async function getConnectorSettingsView(
  env: Env,
  connectorId: ConnectorId,
) {
  const settings = await findConnectorSettings(env.DB, connectorId);
  let sessionAvailable = false;
  let credentialsComplete = false;
  let verificationPending = false;
  let verificationChannel: "email" | "sms" | null = null;
  let verificationExpiresAt: string | null = null;
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
      connectorId === "firstbank" ||
      connectorId === "hncb"
    ) {
      sessionAvailable =
        typeof stored.sessionCookies === "string" &&
        stored.sessionCookies.length > 0 &&
        (connectorId !== "sinopac" ||
          stored.protocol === "sinopac-mobile-app-json-v1");
    } else if (connectorId === "cathaybk") {
      sessionAvailable = hasValidCathayTrustedDevice(stored.sessionCookies);
      verificationExpiresAt =
        typeof stored.browserSessionExpiresAt === "string"
          ? stored.browserSessionExpiresAt
          : null;
      verificationPending =
        credentialsComplete &&
        typeof stored.browserSessionId === "string" &&
        stored.browserSessionId.length > 0 &&
        verificationExpiresAt !== null &&
        new Date(verificationExpiresAt) > new Date();
      verificationChannel =
        verificationPending &&
        (stored.otpChannel === "email" || stored.otpChannel === "sms")
          ? stored.otpChannel
          : null;
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
    verificationPending,
    verificationChannel,
    verificationExpiresAt,
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
