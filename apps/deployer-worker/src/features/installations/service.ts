import { randomToken } from "../../platform/crypto";
import type { Env, PublicSession } from "../../platform/env";
import {
  canUpgradeFrom,
  hasReleaseSource,
  loadRelease,
  localUpgradeRelease,
  LOCAL_FIXTURE_NEXT_VERSION,
  readCurrentRelease,
} from "../../platform/release";
import {
  listAuthorizedAccounts,
  plannedD1Name,
  plannedQueueName,
} from "../../platform/cloudflare";
import { readAccessToken } from "../auth/service";
import { AccountNotAuthorizedError } from "../precheck/service";
import { enqueueDeployJob } from "../deployments/queue";
import {
  findActiveJob,
  getJobById,
  insertJob,
  listJobsForInstallation,
  updateJob,
} from "../deployments/repository";
import {
  getInstallationByAccountWorker,
  getInstallationById,
  insertInstallation,
  listInstallationsForOwnerAccount,
  updateInstallation,
  type InstallationRow,
} from "./repository";

export class InstallationConflictError extends Error {
  constructor() {
    super("INSTALLATION_CONFLICT");
    this.name = "InstallationConflictError";
  }
}

export class InstallationNotFoundError extends Error {
  constructor() {
    super("INSTALLATION_NOT_FOUND");
    this.name = "InstallationNotFoundError";
  }
}

export class InstallationNotReadyError extends Error {
  constructor(public readonly code = "INSTALL_NOT_READY") {
    super(code);
    this.name = "InstallationNotReadyError";
  }
}

export class UpgradeNotAllowedError extends Error {
  constructor(public readonly code = "UPGRADE_NOT_ALLOWED") {
    super(code);
    this.name = "UpgradeNotAllowedError";
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VERSION_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

export function assertInstallInput(input: {
  workerName: string;
  allowedEmail: string;
  targetVersion: string;
  targetDigest: string;
}) {
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(input.workerName)) {
    throw new Error("INVALID_REQUEST");
  }
  if (
    !EMAIL_PATTERN.test(input.allowedEmail) ||
    input.allowedEmail.length > 254
  ) {
    throw new Error("INVALID_REQUEST");
  }
  if (!VERSION_PATTERN.test(input.targetVersion)) {
    throw new Error("INVALID_REQUEST");
  }
  if (!DIGEST_PATTERN.test(input.targetDigest)) {
    throw new Error("INVALID_REQUEST");
  }
}

export async function createOrReuseInstallation(
  env: Env,
  session: PublicSession,
  input: {
    accountId: string;
    workerName: string;
    allowedEmail: string;
    targetVersion: string;
    targetDigest: string;
  },
) {
  assertInstallInput(input);
  if (session.selectedAccountId !== input.accountId) {
    throw new AccountNotAuthorizedError();
  }
  const { accessToken } = await readAccessToken(env, session.id);
  const accounts = await listAuthorizedAccounts(accessToken);
  if (!accounts.some((account) => account.id === input.accountId)) {
    throw new AccountNotAuthorizedError();
  }

  const now = new Date().toISOString();
  const candidate: InstallationRow = {
    id: `inst_${randomToken(16)}`,
    ownerSub: session.oauthSub,
    accountId: input.accountId,
    workerName: input.workerName,
    allowedEmail: input.allowedEmail,
    status: "draft",
    targetVersion: input.targetVersion,
    targetDigest: input.targetDigest,
    workerScriptId: null,
    d1DatabaseId: null,
    queueId: null,
    accessAppId: null,
    createdAt: now,
    updatedAt: now,
  };
  await insertInstallation(env.DB, candidate);
  const installation = await getInstallationByAccountWorker(
    env.DB,
    input.accountId,
    input.workerName,
  );
  if (!installation) throw new Error("Failed to persist installation.");
  if (installation.ownerSub !== session.oauthSub) {
    throw new InstallationConflictError();
  }

  const reused = installation.id !== candidate.id;
  if (
    reused &&
    (installation.status === "ready" || installation.status === "update_failed")
  ) {
    const jobs = await listJobsForInstallation(env.DB, installation.id);
    const job = jobs[0];
    if (!job) throw new Error("Failed to persist deploy job.");
    return { installation, job, reused: true };
  }

  let currentInstallation = installation;
  if (reused) {
    const active = await findActiveJob(env.DB, currentInstallation.id);
    if (
      !active &&
      (currentInstallation.targetVersion !== input.targetVersion ||
        currentInstallation.targetDigest !== input.targetDigest ||
        currentInstallation.allowedEmail !== input.allowedEmail)
    ) {
      const updatedAt = new Date().toISOString();
      await updateInstallation(env.DB, currentInstallation.id, {
        allowedEmail: input.allowedEmail,
        targetVersion: input.targetVersion,
        targetDigest: input.targetDigest,
        updatedAt,
      });
      currentInstallation = {
        ...currentInstallation,
        allowedEmail: input.allowedEmail,
        targetVersion: input.targetVersion,
        targetDigest: input.targetDigest,
        updatedAt,
      };
    }
  }

  const job = await createOrReuseJob(env, currentInstallation.id, {
    kind: "install",
    targetVersion: input.targetVersion,
    targetDigest: input.targetDigest,
  });
  return { installation: currentInstallation, job, reused };
}

export async function createOrReuseJob(
  env: Env,
  installationId: string,
  input: {
    kind: "install" | "update";
    targetVersion: string;
    targetDigest: string;
    step?: string;
    createdResources?: string;
  },
) {
  const existing = await findActiveJob(env.DB, installationId);
  if (existing) {
    if (
      existing.status === "queued" ||
      existing.status === "awaiting_reauth" ||
      existing.status === "awaiting_release"
    ) {
      if (existing.status !== "queued") {
        await updateJob(env.DB, existing.id, {
          status: "queued",
          errorCode: null,
          updatedAt: new Date().toISOString(),
        });
      }
      await enqueueDeployJob(env, existing.id);
    }
    const current = await getJobById(env.DB, existing.id);
    if (!current) throw new Error("Failed to persist deploy job.");
    return current;
  }
  const now = new Date().toISOString();
  const job = {
    id: `job_${randomToken(16)}`,
    installationId,
    kind: input.kind,
    status: "queued",
    step:
      input.step ?? (input.kind === "update" ? "precheck_update" : "precheck"),
    targetVersion: input.targetVersion,
    targetDigest: input.targetDigest,
    attemptCount: 0,
    createdResources: input.createdResources ?? "{}",
    createdAt: now,
    updatedAt: now,
  };
  await insertJob(env.DB, job);
  await enqueueDeployJob(env, job.id);
  const stored = await getJobById(env.DB, job.id);
  if (!stored) throw new Error("Failed to persist deploy job.");
  return stored;
}

export function installerWritesEnabled(env: Env) {
  return hasReleaseSource(env);
}

export async function listOwnedInstallations(env: Env, session: PublicSession) {
  if (!session.selectedAccountId) throw new AccountNotAuthorizedError();
  const { accessToken } = await readAccessToken(env, session.id);
  const accounts = await listAuthorizedAccounts(accessToken);
  if (!accounts.some((account) => account.id === session.selectedAccountId)) {
    throw new AccountNotAuthorizedError();
  }
  return listInstallationsForOwnerAccount(
    env.DB,
    session.oauthSub,
    session.selectedAccountId,
  );
}

export async function getOwnedInstallation(
  env: Env,
  session: PublicSession,
  installationId: string,
) {
  const installation = await getInstallationById(env.DB, installationId);
  if (
    !installation ||
    installation.ownerSub !== session.oauthSub ||
    installation.accountId !== session.selectedAccountId
  ) {
    throw new InstallationNotFoundError();
  }
  const { accessToken } = await readAccessToken(env, session.id);
  const accounts = await listAuthorizedAccounts(accessToken);
  if (!accounts.some((account) => account.id === installation.accountId)) {
    throw new InstallationNotFoundError();
  }
  return installation;
}

export async function getOwnedInstallationDetail(
  env: Env,
  session: PublicSession,
  installationId: string,
) {
  const installation = await getOwnedInstallation(env, session, installationId);
  const jobs = await listJobsForInstallation(env.DB, installation.id);
  return { installation, job: jobs[0] ?? null };
}

export async function getOwnedInstallationJob(
  env: Env,
  session: PublicSession,
  installationId: string,
  jobId: string,
) {
  const installation = await getOwnedInstallation(env, session, installationId);
  const jobs = await listJobsForInstallation(env.DB, installation.id);
  const job = jobs.find((row) => row.id === jobId);
  if (!job) throw new InstallationNotFoundError();
  return { installation, job };
}

export async function resumeOwnedInstallation(
  env: Env,
  session: PublicSession,
  installationId: string,
) {
  const installation = await getOwnedInstallation(env, session, installationId);
  const jobs = await listJobsForInstallation(env.DB, installation.id);
  const latest = jobs[0];
  if (latest?.status === "failed") {
    await updateJob(env.DB, latest.id, {
      status: "queued",
      errorCode: null,
      updatedAt: new Date().toISOString(),
    });
    await enqueueDeployJob(env, latest.id);
    const job = await getJobById(env.DB, latest.id);
    if (!job) throw new Error("Failed to persist deploy job.");
    return { installation, job };
  }
  if (!installation.targetVersion || !installation.targetDigest) {
    throw new Error("INVALID_REQUEST");
  }
  const job = await createOrReuseJob(env, installation.id, {
    kind: (latest?.kind as "install" | "update") ?? "install",
    targetVersion: latest?.targetVersion ?? installation.targetVersion,
    targetDigest: latest?.targetDigest ?? installation.targetDigest,
  });
  return { installation, job };
}

export async function getOwnedUpdatePlan(
  env: Env,
  session: PublicSession,
  installationId: string,
) {
  const installation = await getOwnedInstallation(env, session, installationId);
  const currentVersion = installation.targetVersion;
  const currentDigest = installation.targetDigest;
  if (
    (installation.status !== "ready" &&
      installation.status !== "update_failed") ||
    !currentVersion ||
    !currentDigest
  ) {
    return {
      available: false,
      reason: "INSTALL_NOT_READY" as const,
      currentVersion,
      currentDigest,
      targetVersion: null,
      targetDigest: null,
      pendingMigrations: [] as string[],
      interruption: { pauseSync: false, hasMigrations: false },
    };
  }

  let target: {
    version: string;
    digest: string;
    source: "r2" | "local_fixture";
  };
  try {
    const latest = await readCurrentRelease(env);
    const upgrade = localUpgradeRelease(currentVersion);
    if (latest.source === "local_fixture" && upgrade) {
      target = upgrade;
    } else if (
      latest.source === "local_fixture" &&
      currentVersion === LOCAL_FIXTURE_NEXT_VERSION
    ) {
      target = {
        version: currentVersion,
        digest: currentDigest,
        source: "local_fixture",
      };
    } else {
      target = latest;
    }
  } catch {
    return {
      available: false,
      reason: "RELEASE_UNAVAILABLE" as const,
      currentVersion,
      currentDigest,
      targetVersion: null,
      targetDigest: null,
      pendingMigrations: [] as string[],
      interruption: { pauseSync: false, hasMigrations: false },
    };
  }

  if (target.version === currentVersion) {
    return {
      available: false,
      reason: "UP_TO_DATE" as const,
      currentVersion,
      currentDigest,
      targetVersion: target.version,
      targetDigest: target.digest,
      pendingMigrations: [] as string[],
      interruption: { pauseSync: false, hasMigrations: false },
    };
  }

  const currentReleaseArtifact = await loadRelease(
    env,
    currentVersion,
    currentDigest,
  );
  const targetRelease = await loadRelease(env, target.version, target.digest);
  if (!canUpgradeFrom(currentVersion, targetRelease)) {
    return {
      available: false,
      reason: "UPGRADE_NOT_ALLOWED" as const,
      currentVersion,
      currentDigest,
      targetVersion: target.version,
      targetDigest: target.digest,
      pendingMigrations: [] as string[],
      interruption: { pauseSync: true, hasMigrations: true },
    };
  }
  const applied = new Set(
    currentReleaseArtifact.migrations.map((file) => file.name),
  );
  const pendingMigrations = targetRelease.migrations
    .map((file) => file.name)
    .filter((name) => !applied.has(name));
  return {
    available: true,
    reason: null,
    currentVersion,
    currentDigest,
    targetVersion: target.version,
    targetDigest: target.digest,
    pendingMigrations,
    interruption: {
      pauseSync: pendingMigrations.length > 0,
      hasMigrations: pendingMigrations.length > 0,
    },
  };
}

export async function startOwnedUpdate(
  env: Env,
  session: PublicSession,
  installationId: string,
  input: { targetVersion: string; targetDigest: string },
) {
  if (
    !VERSION_PATTERN.test(input.targetVersion) ||
    !DIGEST_PATTERN.test(input.targetDigest)
  ) {
    throw new Error("INVALID_REQUEST");
  }
  const installation = await getOwnedInstallation(env, session, installationId);
  if (
    installation.status !== "ready" &&
    installation.status !== "update_failed"
  ) {
    throw new InstallationNotReadyError();
  }
  if (!installation.targetVersion || !installation.targetDigest) {
    throw new InstallationNotReadyError();
  }
  if (installation.targetVersion === input.targetVersion) {
    throw new InstallationNotReadyError("UP_TO_DATE");
  }
  const release = await loadRelease(
    env,
    input.targetVersion,
    input.targetDigest,
  );
  if (!canUpgradeFrom(installation.targetVersion, release)) {
    throw new UpgradeNotAllowedError();
  }
  const job = await createOrReuseJob(env, installation.id, {
    kind: "update",
    targetVersion: input.targetVersion,
    targetDigest: input.targetDigest,
    createdResources: JSON.stringify({
      d1DatabaseId: installation.d1DatabaseId,
      queueId: installation.queueId,
      workerScriptId: installation.workerScriptId,
      accessAppId: installation.accessAppId,
      d1DatabaseName: plannedD1Name(installation.workerName),
      queueName: plannedQueueName(installation.workerName),
      installedVersion: installation.targetVersion,
      installedDigest: installation.targetDigest,
    }),
  });
  return { installation, job };
}

export function toInstallationDto(row: InstallationRow) {
  return {
    id: row.id,
    accountId: row.accountId,
    workerName: row.workerName,
    allowedEmail: row.allowedEmail,
    status: row.status,
    targetVersion: row.targetVersion,
    targetDigest: row.targetDigest,
  };
}

export function toJobDto(row: {
  id: string;
  installationId: string;
  kind: string;
  status: string;
  step: string;
  targetVersion: string;
  targetDigest: string;
  attemptCount: number;
  createdResources: string;
  errorCode: string | null;
  migrationName: string | null;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    id: row.id,
    installationId: row.installationId,
    kind: row.kind,
    status: row.status,
    step: row.step,
    targetVersion: row.targetVersion,
    targetDigest: row.targetDigest,
    attemptCount: row.attemptCount,
    createdResources: JSON.parse(row.createdResources) as Record<
      string,
      unknown
    >,
    errorCode: row.errorCode,
    migrationName: row.migrationName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
