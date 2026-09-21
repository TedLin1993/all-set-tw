import { runUpdatePrecheck } from "../../platform/cloudflare";
import {
  createD1Bookmark,
  deleteWorkerSecret,
  listWorkerSecretNames,
  pauseQueueDelivery,
  putWorkerSecret,
  putWorkerSchedules,
  readQueueInflight,
  resumeQueueDelivery,
} from "../../platform/cloudflare-provision";
import type { Env } from "../../platform/env";
import { canUpgradeFrom, loadRelease } from "../../platform/release";
import type { InstallationRow } from "../installations/repository";
import type { DeployJobRow } from "./repository";
import {
  ProvisionError,
  stepApplyMigrations,
  stepAttachCron,
  stepAttachQueueConsumer,
  stepDeployWorker,
  stepLoadRelease,
  stepUploadAssets,
  stepVerifyInstall,
} from "./provision";
import type { CreatedResources, JobSecrets } from "./resources";

export const UPDATE_STEPS = [
  "precheck_update",
  "load_release",
  "compare_versions",
  "enter_maintenance",
  "wait_inflight",
  "create_restore_point",
  "apply_migrations",
  "verify_secrets",
  "upload_assets",
  "deploy_worker",
  "attach_queue_consumer",
  "exit_maintenance",
  "verify_install",
  "finalize",
] as const;

export type UpdateStep = (typeof UPDATE_STEPS)[number];

const REQUIRED_SECRETS = [
  "CONFIG_ENCRYPTION_KEY",
  "VAPID_PUBLIC_KEY",
  "VAPID_PRIVATE_KEY",
  "TEAM_DOMAIN",
  "POLICY_AUD",
];

export function normalizeUpdateStep(step: string): UpdateStep {
  if ((UPDATE_STEPS as readonly string[]).includes(step)) {
    return step as UpdateStep;
  }
  return "precheck_update";
}

export function nextUpdateStep(step: UpdateStep): UpdateStep | null {
  const index = UPDATE_STEPS.indexOf(step);
  if (index < 0 || index === UPDATE_STEPS.length - 1) return null;
  return UPDATE_STEPS[index + 1]!;
}

export async function runUpdateStep(input: {
  env: Env;
  accessToken: string;
  installation: InstallationRow;
  job: DeployJobRow;
  step: UpdateStep;
  resources: CreatedResources;
  secrets: JobSecrets;
}): Promise<{
  resources: CreatedResources;
  secrets: JobSecrets;
  stayOnStep?: boolean;
  migrationName?: string | null;
}> {
  const ctx = {
    accessToken: input.accessToken,
    accountId: input.installation.accountId,
    workerName: input.installation.workerName,
  };
  switch (input.step) {
    case "precheck_update":
      return stepPrecheckUpdate(ctx, input.installation, input.resources);
    case "load_release":
      return stepLoadRelease(input.env, input.job, input.resources);
    case "compare_versions":
      return stepCompareVersions(
        input.env,
        input.job,
        input.installation,
        input.resources,
      );
    case "enter_maintenance":
      return stepEnterMaintenance(ctx, input.resources);
    case "wait_inflight":
      return stepWaitInflight(ctx, input.resources);
    case "create_restore_point":
      return stepCreateRestorePoint(ctx, input.resources);
    case "apply_migrations":
      return stepApplyMigrations(input.env, input.job, ctx, input.resources);
    case "verify_secrets":
      return stepVerifySecrets(ctx, input.resources);
    case "upload_assets":
      return stepUploadAssets(
        input.env,
        input.job,
        ctx,
        input.resources,
        input.secrets,
      );
    case "deploy_worker":
      return stepDeployWorker(
        input.env,
        input.job,
        ctx,
        input.resources,
        input.secrets,
      );
    case "attach_queue_consumer":
      return stepAttachQueueConsumer(ctx, input.resources);
    case "exit_maintenance":
      return stepExitMaintenance(input.env, input.job, ctx, input.resources);
    case "verify_install":
      return stepVerifyInstall(ctx, input.resources);
    case "finalize":
      return { resources: input.resources, secrets: {} };
    default: {
      const exhaustive: never = input.step;
      throw new ProvisionError("UNKNOWN_STEP", exhaustive);
    }
  }
}

async function stepPrecheckUpdate(
  ctx: { accessToken: string; accountId: string; workerName: string },
  installation: InstallationRow,
  resources: CreatedResources,
) {
  const precheck = await runUpdatePrecheck({
    accessToken: ctx.accessToken,
    accountId: ctx.accountId,
    workerName: ctx.workerName,
    d1DatabaseId: installation.d1DatabaseId ?? resources.d1DatabaseId ?? null,
    queueId: installation.queueId ?? resources.queueId ?? null,
  });
  if (!precheck.ready) {
    throw new ProvisionError("PRECHECK_INCOMPLETE");
  }
  return {
    resources: {
      ...resources,
      workersSubdomain: precheck.workersSubdomain ?? undefined,
      teamDomain: precheck.teamDomain ?? undefined,
      d1DatabaseId: precheck.d1DatabaseId ?? resources.d1DatabaseId,
      queueId: precheck.queueId ?? resources.queueId,
      workerScriptId: installation.workerScriptId ?? resources.workerScriptId,
      accessAppId: installation.accessAppId ?? resources.accessAppId,
      installedVersion:
        installation.targetVersion ?? resources.installedVersion,
      installedDigest: installation.targetDigest ?? resources.installedDigest,
    },
    secrets: {},
  };
}

async function stepCompareVersions(
  env: Env,
  job: DeployJobRow,
  installation: InstallationRow,
  resources: CreatedResources,
) {
  const currentVersion =
    resources.installedVersion ?? installation.targetVersion;
  if (!currentVersion) throw new ProvisionError("INSTALL_NOT_READY");
  if (currentVersion === job.targetVersion) {
    throw new ProvisionError("UP_TO_DATE");
  }
  const currentDigest = resources.installedDigest ?? installation.targetDigest;
  if (!currentDigest) throw new ProvisionError("INSTALL_NOT_READY");
  const currentRelease = await loadRelease(env, currentVersion, currentDigest);
  const release = await loadRelease(env, job.targetVersion, job.targetDigest);
  if (!canUpgradeFrom(currentVersion, release)) {
    throw new ProvisionError("UPGRADE_NOT_ALLOWED");
  }
  const applied = new Set(currentRelease.migrations.map((file) => file.name));
  const pending = release.migrations
    .map((file) => file.name)
    .filter((name) => !applied.has(name));
  return {
    resources: {
      ...resources,
      pendingMigrations: pending,
      releaseVersion: release.version,
      releaseDigest: release.digest,
    },
    secrets: {},
  };
}

async function stepEnterMaintenance(
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  if (resources.maintenanceEntered) return { resources, secrets: {} };
  if (!resources.queueId) throw new ProvisionError("QUEUE_MISSING");
  await pauseQueueDelivery(ctx.accessToken, ctx.accountId, resources.queueId);
  await putWorkerSchedules({
    accessToken: ctx.accessToken,
    accountId: ctx.accountId,
    workerName: ctx.workerName,
    crons: [],
  });
  await putWorkerSecret({
    accessToken: ctx.accessToken,
    accountId: ctx.accountId,
    workerName: ctx.workerName,
    name: "DEPLOY_MAINTENANCE",
    value: "1",
  });
  return {
    resources: {
      ...resources,
      maintenanceEntered: true,
      cronDisabled: true,
    },
    secrets: {},
  };
}

async function stepWaitInflight(
  ctx: { accessToken: string; accountId: string },
  resources: CreatedResources,
) {
  if (resources.inflightClear) return { resources, secrets: {} };
  if (!resources.queueId) throw new ProvisionError("QUEUE_MISSING");
  const inflight = await readQueueInflight(
    ctx.accessToken,
    ctx.accountId,
    resources.queueId,
  );
  if (inflight.pending > 0) {
    return { resources, secrets: {}, stayOnStep: true };
  }
  return {
    resources: { ...resources, inflightClear: true },
    secrets: {},
  };
}

async function stepCreateRestorePoint(
  ctx: { accessToken: string; accountId: string },
  resources: CreatedResources,
) {
  if (resources.restoreBookmark) return { resources, secrets: {} };
  if (!resources.d1DatabaseId) throw new ProvisionError("D1_MISSING");
  const bookmark = await createD1Bookmark(
    ctx.accessToken,
    ctx.accountId,
    resources.d1DatabaseId,
  );
  return {
    resources: { ...resources, restoreBookmark: bookmark },
    secrets: {},
  };
}

async function stepVerifySecrets(
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  if (resources.secretsVerified) return { resources, secrets: {} };
  const names = await listWorkerSecretNames(
    ctx.accessToken,
    ctx.accountId,
    ctx.workerName,
  );
  const missing = REQUIRED_SECRETS.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    throw new ProvisionError("SECRETS_MISSING");
  }
  return {
    resources: { ...resources, secretsVerified: true },
    secrets: {},
  };
}

async function stepExitMaintenance(
  env: Env,
  job: DeployJobRow,
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  const release = await loadRelease(env, job.targetVersion, job.targetDigest);
  await stepAttachCron(env, job, ctx, resources);
  if (resources.queueId) {
    await resumeQueueDelivery(
      ctx.accessToken,
      ctx.accountId,
      resources.queueId,
    );
  }
  try {
    await deleteWorkerSecret({
      accessToken: ctx.accessToken,
      accountId: ctx.accountId,
      workerName: ctx.workerName,
      name: "DEPLOY_MAINTENANCE",
    });
  } catch {
    // Secret may already be absent after a retry.
  }
  return {
    resources: {
      ...resources,
      maintenanceEntered: false,
      cronDisabled: false,
      cronAttached: true,
      releaseVersion: release.version,
    },
    secrets: {},
  };
}
