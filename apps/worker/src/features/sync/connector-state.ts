import { connectorCatalog, type ConnectorId } from "@taiwan-fin-hub/core";

export function parsePublicConnectorConfig(
  connectorId: ConnectorId,
  value: string | null,
) {
  if (!value) return {};
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Connector public config must be a JSON object.");
  }
  const config = parsed as Record<string, unknown>;
  return Object.fromEntries(
    connectorCatalog[connectorId].publicFields
      .filter((key) => config[key] !== undefined)
      .map((key) => [key, config[key]]),
  );
}

export function sensitiveConnectorConfig(
  connectorId: ConnectorId,
  config: Record<string, unknown>,
) {
  const sensitive = { ...config };
  // Retired public preferences must not migrate into encrypted connector state.
  if (connectorId === "einvoice") delete sensitive.fetchDetails;
  for (const key of connectorCatalog[connectorId].publicFields) {
    delete sensitive[key];
  }
  return sensitive;
}

export function serializePublicConnectorConfig(
  connectorId: ConnectorId,
  config: Record<string, unknown>,
) {
  const publicConfig: Record<string, unknown> = {};
  for (const key of connectorCatalog[connectorId].publicFields) {
    if (config[key] !== undefined) publicConfig[key] = config[key];
  }
  return Object.keys(publicConfig).length > 0
    ? JSON.stringify(publicConfig)
    : null;
}

export function restoreConfiguredPublicFields(
  connectorId: ConnectorId,
  effectiveConfig: Record<string, unknown>,
  configuredConfig: Record<string, unknown>,
) {
  const persistedConfig = { ...effectiveConfig };
  for (const key of connectorCatalog[connectorId].publicFields) {
    if (configuredConfig[key] === undefined) delete persistedConfig[key];
    else persistedConfig[key] = configuredConfig[key];
  }
  return persistedConfig;
}

export function splitConnectorCursorState(
  connectorId: ConnectorId,
  cursor: string,
) {
  const parsed = JSON.parse(cursor) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${connectorId} connector cursor must be a JSON object.`);
  }

  const safeState = { ...(parsed as Record<string, unknown>) };
  const secretState: Record<string, unknown> = {};
  for (const key of connectorCatalog[connectorId].secretStateFields) {
    if (safeState[key] !== undefined) secretState[key] = safeState[key];
    delete safeState[key];
  }

  return {
    safeCursor: JSON.stringify(safeState),
    secretState,
  };
}
