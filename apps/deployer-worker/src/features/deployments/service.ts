import type { Env } from "../../platform/env";
import { CloudflareApiError } from "../../platform/cloudflare";
import { isRetryableCloudflareError } from "../../platform/cloudflare-provision";
import { ReleaseUnavailableError } from "../../platform/release";
import { findLatestActiveSessionForOwner } from "../auth/repository";
import { AuthServiceError, readAccessToken } from "../auth/service";
import {
  getInstallationById,
  updateInstallation,
  updateInstallationStatus,
} from "../installations/repository";
import { enqueueDeployJob } from "./queue";
import {
  MAX_JOB_ATTEMPTS,
  acquireJobLease,
  getJobById,
  updateLeasedJob,
} from "./repository";
import {
  nextInstallStep,
  normalizeInstallStep,
  ProvisionError,
  readJobSecrets,
  runInstallStep,
  writeJobSecrets,
} from "./provision";
import { nextUpdateStep, normalizeUpdateStep, runUpdateStep } from "./update";
import { parseCreatedResources } from "./resources";

export type QueueOutcome = "ack" | "retry";

const TERMINAL_STATUSES = new Set([
  "succeeded",
  "cancelled",
  "failed",
  "awaiting_reauth",
  "awaiting_release",
]);

export async function processDeployJob(
  env: Env,
  jobId: string,
  leaseOwner: string,
  now = new Date(),
): Promise<QueueOutcome> {
  const job = await getJobById(env.DB, jobId);
  if (!job) return "ack";
  if (TERMINAL_STATUSES.has(job.status)) return "ack";

  const leased = await acquireJobLease(env.DB, jobId, leaseOwner, now);
  if (!leased) return "retry";

  const current = await getJobById(env.DB, jobId);
  if (!current) return "ack";
  if (current.attemptCount > MAX_JOB_ATTEMPTS) {
    await failJob(
      env,
      current.installationId,
      jobId,
      leaseOwner,
      "TOO_MANY_ATTEMPTS",
      now,
    );
    return "ack";
  }

  const installation = await getInstallationById(
    env.DB,
    current.installationId,
  );
  if (!installation) {
    await failJob(
      env,
      current.installationId,
      jobId,
      leaseOwner,
      "INSTALLATION_NOT_FOUND",
      now,
    );
    return "ack";
  }

  let accessToken: string;
  try {
    accessToken = await readOwnerToken(env, installation.ownerSub);
  } catch (error) {
    const code =
      error instanceof AuthServiceError ? error.code : "TOKEN_EXPIRED";
    await pauseForReauth(
      env,
      installation.id,
      jobId,
      leaseOwner,
      code === "SESSION_EXPIRED" ? "TOKEN_EXPIRED" : code,
      now,
    );
    return "ack";
  }

  const isUpdate = current.kind === "update";
  const step = isUpdate
    ? normalizeUpdateStep(current.step)
    : normalizeInstallStep(current.step);
  const resources = parseCreatedResources(current.createdResources);
  let secrets;
  try {
    secrets = await readJobSecrets(current, env.SESSION_ENCRYPTION_KEY);
  } catch {
    await failJob(
      env,
      installation.id,
      jobId,
      leaseOwner,
      "MISSING_ENCRYPTION_KEY",
      now,
    );
    return "ack";
  }

  try {
    const result = isUpdate
      ? await runUpdateStep({
          env,
          accessToken,
          installation,
          job: current,
          step: normalizeUpdateStep(current.step),
          resources,
          secrets,
        })
      : await runInstallStep({
          env,
          accessToken,
          installation,
          job: current,
          step: normalizeInstallStep(current.step),
          resources,
          secrets,
        });
    const mergedSecrets =
      step === "finalize" ? {} : { ...secrets, ...result.secrets };
    const encryptedSecrets = await writeJobSecrets(
      mergedSecrets,
      env.SESSION_ENCRYPTION_KEY,
    );
    const nowIso = now.toISOString();
    if (step === "finalize") {
      const persisted = await updateLeasedJob(env.DB, jobId, leaseOwner, {
        status: "succeeded",
        step,
        errorCode: null,
        createdResources: JSON.stringify(result.resources),
        encryptedSecrets: null,
        migrationName: null,
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: nowIso,
      });
      if (!persisted) return "ack";
      await updateInstallation(env.DB, installation.id, {
        status: "ready",
        workerScriptId: result.resources.workerScriptId ?? null,
        d1DatabaseId: result.resources.d1DatabaseId ?? null,
        queueId: result.resources.queueId ?? null,
        accessAppId: result.resources.accessAppId ?? null,
        targetVersion: current.targetVersion,
        targetDigest: current.targetDigest,
        updatedAt: nowIso,
      });
      return "ack";
    }
    const nextStep = result.stayOnStep
      ? step
      : isUpdate
        ? nextUpdateStep(normalizeUpdateStep(current.step))
        : nextInstallStep(normalizeInstallStep(current.step));
    const persisted = await updateLeasedJob(env.DB, jobId, leaseOwner, {
      status: "queued",
      step: nextStep ?? step,
      errorCode: null,
      createdResources: JSON.stringify(result.resources),
      encryptedSecrets,
      migrationName:
        result.migrationName === undefined
          ? current.migrationName
          : result.migrationName,
      leaseOwner: null,
      leaseUntil: null,
      updatedAt: nowIso,
    });
    if (!persisted) return "ack";
    await updateInstallationStatus(
      env.DB,
      installation.id,
      isUpdate ? "updating" : "installing",
      nowIso,
    );
    try {
      await enqueueDeployJob(env, jobId);
    } catch {
      console.error("[deployer] enqueue failed", jobId);
      return "retry";
    }
    return "ack";
  } catch (error) {
    if (error instanceof ReleaseUnavailableError) {
      await pauseForRelease(
        env,
        installation.id,
        jobId,
        leaseOwner,
        error.code,
        now,
      );
      return "ack";
    }
    if (error instanceof CloudflareApiError && error.code === "TOKEN_EXPIRED") {
      await pauseForReauth(
        env,
        installation.id,
        jobId,
        leaseOwner,
        "TOKEN_EXPIRED",
        now,
      );
      return "ack";
    }
    if (isRetryableCloudflareError(error)) {
      const persisted = await updateLeasedJob(env.DB, jobId, leaseOwner, {
        status: "queued",
        errorCode:
          error instanceof CloudflareApiError ? error.code : "UPSTREAM",
        leaseOwner: null,
        leaseUntil: null,
        updatedAt: now.toISOString(),
      });
      if (!persisted) return "ack";
      return "retry";
    }
    const code =
      error instanceof ProvisionError
        ? error.code
        : error instanceof CloudflareApiError
          ? error.code
          : "UPSTREAM";
    await failJob(
      env,
      installation.id,
      jobId,
      leaseOwner,
      code,
      now,
      step,
      isUpdate ? "update_failed" : "failed",
    );
    return "ack";
  }
}

async function failJob(
  env: Env,
  installationId: string,
  jobId: string,
  leaseOwner: string,
  errorCode: string,
  now: Date,
  step?: string,
  installationStatus = "failed",
) {
  const persisted = await updateLeasedJob(env.DB, jobId, leaseOwner, {
    status: "failed",
    ...(step ? { step } : {}),
    errorCode,
    leaseOwner: null,
    leaseUntil: null,
    updatedAt: now.toISOString(),
  });
  if (!persisted) return;
  await updateInstallationStatus(
    env.DB,
    installationId,
    installationStatus,
    now.toISOString(),
  );
}

async function pauseForReauth(
  env: Env,
  installationId: string,
  jobId: string,
  leaseOwner: string,
  errorCode: string,
  now: Date,
) {
  const persisted = await updateLeasedJob(env.DB, jobId, leaseOwner, {
    status: "awaiting_reauth",
    errorCode,
    leaseOwner: null,
    leaseUntil: null,
    updatedAt: now.toISOString(),
  });
  if (!persisted) return;
  await updateInstallationStatus(
    env.DB,
    installationId,
    "awaiting_reauth",
    now.toISOString(),
  );
}

async function pauseForRelease(
  env: Env,
  installationId: string,
  jobId: string,
  leaseOwner: string,
  errorCode: string,
  now: Date,
) {
  const persisted = await updateLeasedJob(env.DB, jobId, leaseOwner, {
    status: "awaiting_release",
    step: "load_release",
    errorCode,
    leaseOwner: null,
    leaseUntil: null,
    updatedAt: now.toISOString(),
  });
  if (!persisted) return;
  await updateInstallationStatus(
    env.DB,
    installationId,
    "awaiting_release",
    now.toISOString(),
  );
}

async function readOwnerToken(env: Env, ownerSub: string) {
  const row = await findLatestActiveSessionForOwner(
    env.DB,
    ownerSub,
    new Date(),
  );
  if (!row) {
    throw new AuthServiceError(
      "TOKEN_EXPIRED",
      "Cloudflare 授權已過期，請重新授權後續跑。",
    );
  }
  const { accessToken } = await readAccessToken(env, row.id);
  return accessToken;
}

export async function consumeDeployQueue(
  batch: MessageBatch<{ type: string; jobId?: string }>,
  env: Env,
) {
  for (const message of batch.messages) {
    if (message.body.type !== "run-deploy-job" || !message.body.jobId) {
      console.error(
        JSON.stringify({
          event: "deploy_queue_message_rejected",
          messageId: message.id,
        }),
      );
      message.ack();
      continue;
    }
    const outcome = await processDeployJob(env, message.body.jobId, message.id);
    if (outcome === "retry") message.retry();
    else message.ack();
  }
}
