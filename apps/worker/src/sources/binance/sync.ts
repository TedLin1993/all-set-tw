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
import { BINANCE_EGRESS_ORIGINS, fetchBinanceSnapshot } from "./client";
import {
  BinanceCredentialError,
  BinanceRegionBlockedError,
  normalizeBinanceHoldings,
  parseBinanceConfig,
} from "./protocol";

export async function syncBinance(
  env: SyncEnv,
  trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const connectorId = "binance";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseBinanceConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
  });
  if (!config.apiKey || !config.apiSecret) {
    throw new NeedsUserActionError("請先填入 Binance API Key 與 Secret Key。");
  }
  const { apiKey, apiSecret } = config;

  console.log(`[sync] ${connectorId}/${scope}: starting trigger=${trigger}`);

  const now = new Date();
  let snapshot: Awaited<ReturnType<typeof fetchBinanceSnapshot>>;
  try {
    // Worker fetch 會被交易所拒絕，改由固定區域的 Durable Object 開 Browser Run 代發。
    snapshot = await runWithCryptoEgressFallback(
      (location) =>
        withCryptoBrowserFetcher(
          env.CRYPTO_BROWSER_EGRESS,
          connectorId,
          location,
          BINANCE_EGRESS_ORIGINS,
          (fetcher) =>
            fetchBinanceSnapshot({
              apiKey,
              apiSecret,
              fetcher,
              signal: env.syncSignal,
            }),
        ),
      (error) =>
        error instanceof BinanceRegionBlockedError ||
        error instanceof MaxPublicAccessBlockedError,
      { signal: env.syncSignal },
    );
  } catch (error) {
    if (error instanceof BinanceCredentialError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
  }

  const holdings = normalizeBinanceHoldings(snapshot, taipeiDateKey(now));
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
    title: "Binance",
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
