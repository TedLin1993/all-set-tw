import { taipeiDateKey } from "@taiwan-fin-hub/shared";
import type { SyncTrigger } from "../../db";
import type { SyncOutcome } from "../../features/sync/types";
import type { SyncEnv } from "../../features/sync/execution";
import { requireConnectorSettings } from "../../features/sync/config";
import { parsePublicConnectorConfig } from "../../features/sync/connector-state";
import { persistCryptoHoldings } from "../../features/sync/crypto-holdings-write";
import { NeedsUserActionError } from "../../features/sync/errors";
import { decryptJson } from "../../platform/crypto";
import { configEncryptionKey } from "../../platform/config";
import {
  runWithCryptoEgressFallback,
  withCryptoBrowserFetcher,
} from "../../platform/crypto-browser-egress";
import { MaxPublicAccessBlockedError } from "../crypto-prices";
import { MAX_EGRESS_ORIGINS, fetchMaxSnapshot } from "./client";
import {
  MaxAccessBlockedError,
  MaxCredentialError,
  normalizeMaxHoldings,
  parseMaxConfig,
} from "./protocol";

export async function syncMax(
  env: SyncEnv,
  trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const connectorId = "max";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseMaxConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
  });
  if (!config.accessKey || !config.secretKey) {
    throw new NeedsUserActionError("請先填入 MAX Access Key 與 Secret Key。");
  }
  const { accessKey, secretKey } = config;

  console.log(`[sync] ${connectorId}/${scope}: starting trigger=${trigger}`);

  const now = new Date();
  let snapshot: Awaited<ReturnType<typeof fetchMaxSnapshot>>;
  try {
    // Worker fetch 會被交易所拒絕，改由固定區域的 Durable Object 開 Browser Run 代發。
    snapshot = await runWithCryptoEgressFallback(
      (location) =>
        withCryptoBrowserFetcher(
          env.CRYPTO_BROWSER_EGRESS,
          connectorId,
          location,
          MAX_EGRESS_ORIGINS,
          (fetcher) =>
            fetchMaxSnapshot({
              accessKey,
              secretKey,
              fetcher,
              signal: env.syncSignal,
            }),
        ),
      (error) =>
        error instanceof MaxAccessBlockedError ||
        error instanceof MaxPublicAccessBlockedError,
      { signal: env.syncSignal },
    );
  } catch (error) {
    if (error instanceof MaxCredentialError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
  }

  const holdings = normalizeMaxHoldings(snapshot, taipeiDateKey(now));
  if (holdings.unpricedAssets.length > 0) {
    console.warn(
      `[sync] ${connectorId}/${scope}: unpriced assets=${holdings.unpricedAssets.join(",")}`,
    );
  }
  console.log(
    `[sync] ${connectorId}/${scope}: positions=${holdings.positions.length}`,
  );

  const newRecords = await persistCryptoHoldings(env.DB, {
    connectorId,
    title: "MAX",
    encryptedConfig: settings.encrypted_config,
    settingsUpdatedAt: settings.updated_at,
    holdings,
    now: now.toISOString(),
  });

  return {
    success: true,
    connectorId,
    scope,
    records: holdings.positions.length,
    newRecords,
    cursorUpdated: false,
  };
}
