import {
  FirstradeApiClient,
  FirstradeApiError,
  parseFirstradeConfig,
  parseFirstradePortfolio,
} from "@taiwan-fin-hub/connectors";
import {
  acquireSyncJobLock,
  getConnectorSettings,
  releaseSyncJobLock,
  type SyncTrigger,
} from "@taiwan-fin-hub/db";
import { configEncryptionKey } from "../../platform/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import type { Env } from "../../platform/env";
import {
  NeedsUserActionError,
  SyncAlreadyRunningError,
  type SyncOutcome,
} from "./service";
import {
  compareAndSetConnectorSecret,
  connectorSettingsGuardStatement,
  connectorCursorStatement,
} from "./repository";
import { investmentPositionRecord } from "./record-mapper";
import { persistStagedSyncWrite } from "./persistence";

const connectorId = "firstrade";
async function consumeState(env: Env) {
  const settings = await getConnectorSettings(env.DB, connectorId);
  if (!settings) throw new NeedsUserActionError("請先儲存 Firstrade 帳密。");
  const config = parseFirstradeConfig(
    await decryptJson(settings.encrypted_config, configEncryptionKey(env)),
  );
  if (!config.username || !config.password)
    throw new NeedsUserActionError("請先儲存 Firstrade 帳密。");
  const clean = { username: config.username, password: config.password };
  const encrypted = await encryptJson(clean, configEncryptionKey(env));
  const version = new Date().toISOString();
  // Claim the challenge before network I/O so replay and concurrent requests
  // cannot send OTP twice or overwrite a newer credential configuration.
  await compareAndSetConnectorSecret(
    env.DB,
    connectorId,
    settings,
    encrypted,
    version,
  );
  return { config, clean, encrypted, version };
}
function userError(error: unknown): never {
  if (error instanceof FirstradeApiError)
    throw new NeedsUserActionError(
      `Firstrade 驗證未完成（${error.step}: ${error.kind}${error.status ? ` / HTTP ${error.status}` : ""}）。請重新開始；未自動重試帳密。`,
    );
  throw error;
}
export async function prepareFirstradeSession(
  env: Env,
  recipientIndex?: number,
) {
  const runId = crypto.randomUUID();
  const lockRowId = "firstrade:all";
  if (
    !(await acquireSyncJobLock(env.DB, {
      lockRowId,
      scope: "all",
      trigger: "manual",
      runId,
      leaseMs: 180_000,
    }))
  )
    throw new SyncAlreadyRunningError(connectorId);
  const client = new FirstradeApiClient();
  try {
    const state = await consumeState(env);
    let challenge;
    if (recipientIndex === undefined)
      challenge = await client.login(
        state.clean.username,
        state.clean.password,
      );
    else {
      if (!state.config.pendingSession)
        throw new NeedsUserActionError("Firstrade 驗證已失效，請重新開始。");
      client.restoreSession(state.config.pendingSession);
      challenge = await client.sendCode(recipientIndex);
    }
    const session = client.exportSession();
    await compareAndSetConnectorSecret(
      env.DB,
      connectorId,
      { encrypted_config: state.encrypted, updated_at: state.version },
      await encryptJson(
        { ...state.clean, pendingSession: session },
        configEncryptionKey(env),
      ),
      new Date().toISOString(),
    );
    return {
      ...challenge,
      expiresAt: new Date(session.deadline).toISOString(),
    };
  } catch (error) {
    userError(error);
  } finally {
    client.clear();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}
export async function syncFirstrade(
  env: Env,
  trigger: SyncTrigger,
  overrides: Record<string, unknown> = {},
): Promise<SyncOutcome> {
  // There is no verified reusable trusted-device lifecycle. Scheduled work must
  // never initiate login or deliver OTP, even if manually enabled in settings.
  if (trigger !== "manual")
    throw new NeedsUserActionError(
      "Firstrade 需要在設定頁完成一次性驗證，請手動同步。",
    );
  const state = await consumeState(env);
  const client = new FirstradeApiClient();
  try {
    const session = state.config.pendingSession;
    if (!session) throw new NeedsUserActionError("請先開始 Firstrade 驗證。");
    client.restoreSession(session);
    if (session.state !== "ready") {
      if (typeof overrides.otp !== "string" || !/^\d{6}$/.test(overrides.otp))
        throw new NeedsUserActionError(
          "請輸入收到的六位驗證碼，並重新開始驗證。",
        );
      await client.verify(overrides.otp);
    }
    const now = new Date().toISOString();
    const date = now.slice(0, 10);
    let positions: Awaited<ReturnType<typeof parseFirstradePortfolio>> = [];
    await client.readPortfolio(async (accounts) => {
      positions = await parseFirstradePortfolio(accounts, date);
    });
    const records = positions.map((p) =>
      investmentPositionRecord(connectorId, p, now),
    );
    const cursor = JSON.stringify({ syncedAt: now });
    const newRecords = await persistStagedSyncWrite(env.DB, {
      records,
      beforePromoteStatements: [
        connectorSettingsGuardStatement(
          env.DB,
          connectorId,
          state.encrypted,
          state.version,
        ),
        // Replace only today's complete snapshot. Retain previous days, remove
        // sold positions on same-day sync, and roll back deletion on any failure.
        env.DB.prepare(
          "DELETE FROM investment_positions WHERE connector_id = ? AND as_of_date = ?",
        ).bind(connectorId, date),
      ],
      finalizeStatements: [
        connectorCursorStatement(env.DB, connectorId, cursor, now),
      ],
    });
    return {
      success: true,
      connectorId,
      scope: "all",
      records: records.length,
      warnings: [
        ...new Set(
          positions.flatMap((p) => {
            const raw = p.raw as { valuationNote?: string } | undefined;
            return raw?.valuationNote ? [raw.valuationNote] : [];
          }),
        ),
      ],
      newRecords,
      cursorUpdated: true,
    };
  } catch (error) {
    userError(error);
  } finally {
    client.clear();
  }
}
