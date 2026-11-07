import {
  taipeiDateKey,
  type SinotradeConnectionResponse,
  type SinotradeVerificationInput,
} from "@taiwan-fin-hub/shared";
import {
  acquireSyncJobLock,
  releaseSyncJobLock,
  type SyncTrigger,
} from "../../db";
import type { Env } from "../../platform/env";
import type { SyncEnv } from "../../features/sync/execution";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import { requireConnectorSettings } from "../../features/sync/config";
import { canonicalSyncLockRowId } from "../../features/sync/lock";
import {
  NeedsUserActionError,
  SyncAlreadyRunningError,
} from "../../features/sync/errors";
import {
  compareAndSetConnectorSecret,
  connectorSettingsGuardStatement,
  connectorEncryptedConfigStatement,
} from "../../features/sync/connector-repository";
import { persistStagedSyncWrite } from "../../features/sync/persistence";
import {
  investmentPositionRecord,
  investmentTransactionRecord,
} from "../../features/sync/record-mapper";
import type { SyncOutcome } from "../../features/sync/types";
import type {
  InvestmentPosition,
  InvestmentTransaction,
} from "../financial-types";
import {
  prepareSinotradeLogin,
  completeSinotradeLogin,
  closeSinotradeLogin,
  captureSinotradeIssuedState,
  fetchSinotradeSnapshot,
  readSinotradeLoginChallenge,
  verifySinotradeLogin,
} from "./connector";
import {
  parseSinotradeConfig,
  SinotradeLoginExpiredError,
  type SinotradeConfig,
  type SinotradePlatform,
} from "./session-protocol";

function reusableConfig(config: SinotradeConfig): SinotradeConfig {
  return {
    userId: config.userId,
    password: config.password,
    webState: config.webState,
  };
}

async function withConnectionLock<T>(env: Env, task: () => Promise<T>) {
  const lockRowId = canonicalSyncLockRowId("sinotrade");
  const runId = crypto.randomUUID();
  if (
    !(await acquireSyncJobLock(env.DB, {
      lockRowId,
      scope: "all",
      trigger: "manual",
      runId,
      leaseMs: 3 * 60_000,
    }))
  )
    throw new SyncAlreadyRunningError("sinotrade");
  try {
    return await task();
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

async function loadConfig(env: Env) {
  const settings = await requireConnectorSettings(env.DB, "sinotrade");
  const config = parseSinotradeConfig(
    await decryptJson(settings.encrypted_config, configEncryptionKey(env)),
  );
  return { settings, config };
}

export async function startSinotradeConnection(
  env: Env,
  platform: SinotradePlatform,
) {
  return withConnectionLock(env, async () => {
    const { settings, config } = await loadConfig(env);
    const prepared = await prepareSinotradeLogin(env.BROWSER, config, platform);
    try {
      await compareAndSetConnectorSecret(
        env.DB,
        "sinotrade",
        settings,
        await encryptJson(
          {
            ...config,
            browserSessionId: prepared.browserSessionId,
            browserSessionExpiresAt: prepared.expiresAt,
            loginPlatform: platform,
          },
          configEncryptionKey(env),
        ),
        new Date().toISOString(),
      );
    } catch (error) {
      await closeSinotradeLogin(env.BROWSER, {
        browserSessionId: prepared.browserSessionId,
      });
      throw error;
    }
    return {
      status: "verification_required" as const,
      platform,
      challenge: prepared.challenge,
      expiresAt: prepared.expiresAt,
    };
  });
}

export async function finishSinotradeConnection(
  env: Env,
): Promise<SinotradeConnectionResponse> {
  return withConnectionLock(env, async () => {
    const { settings, config } = await loadConfig(env);
    let completed: Awaited<ReturnType<typeof completeSinotradeLogin>>;
    try {
      completed = await completeSinotradeLogin(env.BROWSER, config);
    } catch (error) {
      if (error instanceof SinotradeLoginExpiredError) {
        await closeSinotradeLogin(env.BROWSER, config);
        await compareAndSetConnectorSecret(
          env.DB,
          "sinotrade",
          settings,
          await encryptJson(reusableConfig(config), configEncryptionKey(env)),
          new Date().toISOString(),
        );
      }
      throw error;
    }
    const pending = completed.pending;
    try {
      await compareAndSetConnectorSecret(
        env.DB,
        "sinotrade",
        settings,
        await encryptJson(
          {
            userId: config.userId,
            password: config.password,
            webState: completed.webState,
            ...(pending
              ? {
                  browserSessionId: pending.browserSessionId,
                  browserSessionExpiresAt: pending.expiresAt,
                  loginPlatform: pending.platform,
                }
              : {}),
          },
          configEncryptionKey(env),
        ),
        new Date().toISOString(),
      );
    } catch (error) {
      if (pending)
        await closeSinotradeLogin(env.BROWSER, {
          browserSessionId: pending.browserSessionId,
        });
      throw error;
    }
    if (pending)
      return {
        status: "verification_required",
        platform: pending.platform,
        challenge: pending.challenge,
        expiresAt: pending.expiresAt,
      };
    return { success: true as const, status: "connected" as const };
  });
}

export async function cancelSinotradeConnection(env: Env) {
  return withConnectionLock(env, async () => {
    const { settings, config } = await loadConfig(env);
    await closeSinotradeLogin(env.BROWSER, config);
    await compareAndSetConnectorSecret(
      env.DB,
      "sinotrade",
      settings,
      await encryptJson(reusableConfig(config), configEncryptionKey(env)),
      new Date().toISOString(),
    );
    return { success: true as const };
  });
}

export async function readSinotradeConnectionStatus(
  env: Env,
): Promise<SinotradeConnectionResponse> {
  const { config } = await loadConfig(env);
  const challenge = await readSinotradeLoginChallenge(env.BROWSER, config);
  return {
    status: "verification_required",
    platform: config.loginPlatform!,
    challenge,
    expiresAt: config.browserSessionExpiresAt!,
  };
}

/**
 * Saves the issued certificate (with the login it enabled) as an unverified platform state, so
 * a failure or a cancel later in the flow does not cost another OTP: the next connection
 * restores it. Only `connect/complete` marks the platform as connected. Remembering is best
 * effort and must never fail or hide the verification result.
 */
async function rememberIssuedCertificate(
  env: Env,
  settings: Awaited<ReturnType<typeof loadConfig>>["settings"],
  config: SinotradeConfig,
) {
  const platform = config.loginPlatform;
  if (!platform) return;
  try {
    const state = await captureSinotradeIssuedState(env.BROWSER, config);
    if (!state) return;
    const previous = config.webState?.[platform];
    await compareAndSetConnectorSecret(
      env.DB,
      "sinotrade",
      settings,
      await encryptJson(
        {
          ...config,
          webState: {
            ...config.webState,
            [platform]: {
              ...state,
              authenticated: previous ? previous.authenticated : false,
            },
          },
        },
        configEncryptionKey(env),
      ),
      new Date().toISOString(),
    );
  } catch {
    // The verification already succeeded; `connect/complete` saves the state again.
  }
}

export async function verifySinotradeConnection(
  env: Env,
  input: SinotradeVerificationInput,
): Promise<SinotradeConnectionResponse> {
  return withConnectionLock(env, async () => {
    const { settings, config } = await loadConfig(env);
    const challenge = await verifySinotradeLogin(env.BROWSER, config, input);
    // Agreeing to the terms issues the certificate; keep it now, whatever happens next.
    if (input.action === "accept_terms" || challenge.step === "ready")
      await rememberIssuedCertificate(env, settings, config);
    return {
      status: "verification_required",
      platform: config.loginPlatform!,
      challenge,
      expiresAt: config.browserSessionExpiresAt!,
    };
  });
}

export async function syncSinotrade(
  env: SyncEnv,
  _trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const { settings, config } = await loadConfig(env);
  const snapshot = await fetchSinotradeSnapshot(env.BROWSER, config);
  const now = new Date().toISOString();
  const asOfDate = taipeiDateKey(new Date(now));
  const positions: Array<Omit<InvestmentPosition, "id" | "connectorId">> = [];
  const trades: Array<Omit<InvestmentTransaction, "id" | "connectorId">> = [];
  for (const {
    account,
    holdings,
    trades: accountTrades,
  } of snapshot.accountHoldings) {
    for (const trade of accountTrades)
      trades.push({
        accountId: `sinotrade:${account.market}:${account.brokerNo}:${account.brokerAccount}`,
        sourceId: trade.key,
        brokerNo: account.brokerNo,
        brokerAccount: account.brokerAccount,
        brokerName: "永豐金證券",
        symbol: trade.symbol,
        name: trade.name,
        assetType:
          trade.market === "TW" && trade.symbol.startsWith("00")
            ? "etf"
            : "stock",
        tradeDate: trade.tradeDate,
        transactionCode: trade.side,
        transactionName: trade.side === "B" ? "買進" : "賣出",
        quantity: trade.quantity,
        price: trade.price,
        amount: trade.amount,
        realizedPnl: trade.realizedPnl,
        currency: trade.currency,
        raw: {
          market: trade.market,
          fee: trade.fee,
          tax: trade.tax,
          orderNo: trade.orderNo,
          inventoryType: trade.inventoryType,
          realizedCost: trade.realizedCost,
        },
      });
    // Keep both asset scopes current even when every security in a scope was sold.
    for (const assetType of ["stock", "etf"] as const)
      positions.push({
        sourceId: `empty:${account.market}:${account.brokerNo}:${account.brokerAccount}:${assetType}`,
        ...account,
        assetType,
        name: "目前沒有持倉",
        quantity: 0,
        marketValue: 0,
        currency: account.market === "TW" ? "TWD" : "USD",
        asOfDate,
        raw: { snapshotMarker: true },
      });
    for (const holding of holdings)
      positions.push({
        sourceId: `${account.market}:${account.brokerNo}:${account.brokerAccount}:${holding.symbol}`,
        ...account,
        assetType:
          holding.market === "TW" && holding.symbol.startsWith("00")
            ? "etf"
            : "stock",
        symbol: holding.symbol,
        name: holding.name,
        quantity: holding.quantity,
        marketValue: holding.marketValue,
        costBasis: holding.costBasis,
        unrealizedPnl: holding.unrealizedPnl,
        currency: holding.currency,
        asOfDate,
        raw: { market: holding.market, positionType: holding.positionType },
      });
  }
  env.syncSignal?.throwIfAborted();
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records: [
      ...positions.map((position) =>
        investmentPositionRecord("sinotrade", position, now),
      ),
      ...trades.map((trade) =>
        investmentTransactionRecord("sinotrade", trade, now),
      ),
    ],
    beforePromoteStatements: [
      connectorSettingsGuardStatement(
        env.DB,
        "sinotrade",
        settings.encrypted_config,
        settings.updated_at,
      ),
      env.DB.prepare(
        "DELETE FROM investment_positions WHERE connector_id = ? AND as_of_date = ?",
      ).bind("sinotrade", asOfDate),
    ],
    finalizeStatements: [
      connectorEncryptedConfigStatement(
        env.DB,
        "sinotrade",
        await encryptJson(
          { ...reusableConfig(config), webState: snapshot.webState },
          configEncryptionKey(env),
        ),
        null,
        now,
      ),
    ],
  }).catch(async (error: unknown) => {
    const current = await requireConnectorSettings(env.DB, "sinotrade");
    if (
      current.encrypted_config !== settings.encrypted_config ||
      current.updated_at !== settings.updated_at
    )
      throw new NeedsUserActionError("證券連線設定已變更，請重新同步。");
    throw error;
  });
  return {
    success: true,
    connectorId: "sinotrade",
    scope: "all",
    records:
      snapshot.accountHoldings.reduce(
        (sum, item) => sum + item.holdings.length,
        0,
      ) + trades.length,
    newRecords,
    cursorUpdated: false,
  };
}
