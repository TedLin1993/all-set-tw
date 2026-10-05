import { createSyncExecution } from "../../features/sync/execution";
import type { Env } from "../../platform/env";
import { canonicalSyncLockRowId } from "../../features/sync/lock";
import {
  acquireSyncJobLock,
  releaseSyncJobLock,
  type SyncTrigger,
} from "../../db";
import { SYNC_SCOPE_ALL, type SyncOutcome } from "../../features/sync/types";
import {
  SyncAlreadyRunningError,
  NeedsUserActionError,
  NextbankCaptchaRequiredError,
} from "../../features/sync/errors";
import { requireConnectorSettings } from "../../features/sync/config";
import { decryptJson, encryptJson } from "../../platform/crypto";
import { configEncryptionKey } from "../../platform/config";
import { nextbankConfigSchema, parseNextbankDeposits } from "./protocol";
import {
  compareAndSetConnectorSecret,
  connectorSettingsGuardStatement,
  linkCanonicalBankAccountsStatement,
  connectorCursorStatement,
} from "../../features/sync/connector-repository";
import {
  NextbankApiClient,
  NextbankApiError,
  collectNextbankDepositPayloads,
} from "./api";
import { z } from "zod";
import { recognizeAlphanumericCaptcha } from "../../features/ocr/service";
import {
  type SyncWriteRecord,
  persistStagedSyncWrite,
} from "../../features/sync/persistence";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
} from "../../features/sync/record-mapper";
import { prepareNextbankDepositWrite } from "./deposits";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../features/net-worth/service";

function nextbankCleanConfig(stored: Record<string, unknown>) {
  const cleaned = { ...stored };
  delete cleaned.captchaUuid;
  delete cleaned.captchaExpiresAt;
  return cleaned;
}

export async function prepareNextbankCaptchaSession(env: Env) {
  const connectorId = "nextbank";
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId(connectorId);
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope: SYNC_SCOPE_ALL,
    trigger: "manual",
    runId,
    leaseMs: 180_000,
  });
  if (!locked) throw new SyncAlreadyRunningError(connectorId);
  const execution = createSyncExecution(
    env,
    { lockRowId, runId },
    { deadline: Date.now() + 3 * 60 * 1000 },
  );
  try {
    return await execution.run(async (env) => {
      const settings = await requireConnectorSettings(env.DB, connectorId);
      const stored = await decryptJson<Record<string, unknown>>(
        settings.encrypted_config,
        configEncryptionKey(env),
      );
      const config = nextbankConfigSchema.parse(stored);
      if (!config.userId || !config.account || !config.password)
        throw new NeedsUserActionError("請先儲存將來銀行帳密。");
      const cleared = await encryptJson(
        nextbankCleanConfig(stored),
        configEncryptionKey(env),
      );
      const clearedAt = new Date().toISOString();
      await compareAndSetConnectorSecret(
        env.DB,
        connectorId,
        settings,
        cleared,
        clearedAt,
      );
      const prepared = await new NextbankApiClient().prepareCaptcha();
      await compareAndSetConnectorSecret(
        env.DB,
        connectorId,
        { encrypted_config: cleared, updated_at: clearedAt },
        await encryptJson(
          {
            ...nextbankCleanConfig(stored),
            captchaUuid: prepared.uuid,
            captchaExpiresAt: prepared.expiresAt,
          },
          configEncryptionKey(env),
        ),
        new Date().toISOString(),
      );
      return {
        captchaImage: `data:image/png;base64,${prepared.imageBase64}`,
        expiresAt: new Date(prepared.expiresAt).toISOString(),
        captchaLength: 5,
        captchaKind: "alphanumeric" as const,
      };
    });
  } finally {
    execution.stop();
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

export async function syncNextbank(
  env: Env,
  _trigger: SyncTrigger,
  overrides: Record<string, unknown> = {},
): Promise<SyncOutcome> {
  const connectorId = "nextbank";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = nextbankConfigSchema.parse(stored);
  if (!config.userId || !config.account || !config.password)
    throw new NeedsUserActionError("請先儲存將來銀行帳密。");
  // Consume persisted challenge before contacting the bank, including failures.
  const cleaned = await encryptJson(
    nextbankCleanConfig(stored),
    configEncryptionKey(env),
  );
  const version = new Date().toISOString();
  await compareAndSetConnectorSecret(
    env.DB,
    connectorId,
    settings,
    cleaned,
    version,
  );
  const client = new NextbankApiClient();
  let token: string | undefined;
  let result: ReturnType<typeof parseNextbankDeposits>;
  try {
    const submitted = z
      .string()
      .regex(/^[A-Za-z0-9]{1,5}$/)
      .optional()
      .safeParse(overrides.captcha);
    if (!submitted.success) throw new NextbankApiError("captcha");
    let answer = submitted.data;
    if (answer) {
      if (!config.captchaUuid || !config.captchaExpiresAt)
        throw new NextbankApiError("captcha");
      client.restoreCaptcha({
        uuid: config.captchaUuid,
        expiresAt: config.captchaExpiresAt,
      });
    } else {
      const challenge = await client.prepareCaptcha();
      const bytes = Uint8Array.from(atob(challenge.imageBase64), (char) =>
        char.charCodeAt(0),
      );
      try {
        answer = (
          await recognizeAlphanumericCaptcha(
            env.AI,
            bytes.buffer,
            "image/png",
            5,
          )
        ).code;
      } catch {
        throw new NextbankCaptchaRequiredError(
          "將來銀行驗證碼無法自動辨識，請改用人工輸入。",
        );
      }
    }
    ({ accessToken: token } = await client.login({
      identity: config.userId,
      userId: config.account,
      password: config.password,
      captchaResult: answer,
    }));
    result = parseNextbankDeposits(
      await collectNextbankDepositPayloads(client, token),
    );
  } catch (error) {
    if (error instanceof NextbankApiError && error.kind === "captcha") {
      throw new NextbankCaptchaRequiredError("將來銀行需要重新驗證：captcha。");
    }
    if (
      error instanceof NextbankApiError &&
      [
        "credentials",
        "session_conflict",
        "session_expired",
        "account_unavailable",
      ].includes(error.kind)
    ) {
      throw new NeedsUserActionError(`將來銀行需要重新驗證：${error.kind}。`);
    }
    throw error;
  } finally {
    if (token) {
      try {
        await client.logout(token);
      } catch {
        console.warn("[sync] nextbank: logout unconfirmed");
      }
      token = undefined;
    }
  }
  const now = new Date().toISOString();
  const records: SyncWriteRecord[] = [
    ...result.bankAccounts.map((account) =>
      bankAccountRecord(connectorId, account, now),
    ),
    ...result.bankBalanceSnapshots.map((snapshot) =>
      bankBalanceSnapshotRecord(connectorId, snapshot, now),
    ),
    ...result.bankTransactions.map((transaction) =>
      bankTransactionRecord(connectorId, transaction, now),
    ),
  ];
  const depositWrite = await prepareNextbankDepositWrite(env.DB, result, now);
  records.push(...depositWrite.records);
  const cursor = JSON.stringify({ syncedAt: now });
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    beforePromoteStatements: [
      connectorSettingsGuardStatement(env.DB, connectorId, cleaned, version),
    ],
    afterPromoteStatements: [
      ...depositWrite.afterPromoteStatements,
      linkCanonicalBankAccountsStatement(env.DB),
    ],
    finalizeStatements: [
      connectorCursorStatement(env.DB, connectorId, cursor, now),
    ],
  });
  await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  return {
    success: true,
    connectorId,
    scope: "all",
    records: records.length,
    newRecords,
    cursorUpdated: true,
  };
}
