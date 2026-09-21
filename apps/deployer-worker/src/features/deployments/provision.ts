import {
  base64ToBytes,
  decryptJson,
  encryptJson,
  generateInstallKeys,
} from "../../platform/crypto";
import {
  CloudflareApiError,
  findD1DatabaseByName,
  findQueueByName,
  plannedD1Name,
  plannedQueueName,
  runAccountPrecheck,
} from "../../platform/cloudflare";
import {
  applyMigrationFile,
  BOOTSTRAP_WORKER_MODULE,
  createAccessApplication,
  createAccessPolicy,
  createAssetUploadSession,
  createD1Database,
  createOtpIdentityProvider,
  createQueue,
  enableWorkersDev,
  ensureMigrationLedger,
  hasCloudflareAccessChallenge,
  listAppliedMigrations,
  listIdentityProviders,
  patchAccessApplication,
  putQueueConsumer,
  putWorkerSchedules,
  putWorkerScript,
  putWorkerSecret,
  readAnonymousUrl,
  uploadWorkerAssetBucket,
} from "../../platform/cloudflare-provision";
import type { Env } from "../../platform/env";
import { loadRelease, type ReleaseArtifact } from "../../platform/release";
import type { InstallationRow } from "../installations/repository";
import type { DeployJobRow } from "./repository";
import type { CreatedResources, JobSecrets } from "./resources";

export const INSTALL_STEPS = [
  "precheck",
  "load_release",
  "generate_keys",
  "create_d1",
  "create_queue",
  "deploy_bootstrap",
  "enable_workers_dev",
  "ensure_otp_idp",
  "create_access_app",
  "write_access_secrets",
  "apply_migrations",
  "write_app_secrets",
  "upload_assets",
  "deploy_worker",
  "attach_queue_consumer",
  "attach_cron",
  "verify_install",
  "finalize",
] as const;

export type InstallStep = (typeof INSTALL_STEPS)[number];

export class ProvisionError extends Error {
  constructor(
    public readonly code: string,
    message = code,
  ) {
    super(message);
    this.name = "ProvisionError";
  }
}

export function normalizeInstallStep(step: string): InstallStep {
  if ((INSTALL_STEPS as readonly string[]).includes(step)) {
    return step as InstallStep;
  }
  if (step === "validate_authorization" || step === "provision_resources") {
    return "precheck";
  }
  return "precheck";
}

export function nextInstallStep(step: InstallStep): InstallStep | null {
  const index = INSTALL_STEPS.indexOf(step);
  if (index < 0 || index === INSTALL_STEPS.length - 1) return null;
  return INSTALL_STEPS[index + 1]!;
}

export async function runInstallStep(input: {
  env: Env;
  accessToken: string;
  installation: InstallationRow;
  job: DeployJobRow;
  step: InstallStep;
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
    allowedEmail: input.installation.allowedEmail,
  };
  switch (input.step) {
    case "precheck":
      return stepPrecheck(ctx, input.resources);
    case "load_release":
      return stepLoadRelease(input.env, input.job, input.resources);
    case "generate_keys":
      return stepGenerateKeys(input.resources, input.secrets);
    case "create_d1":
      return stepCreateD1(ctx, input.resources);
    case "create_queue":
      return stepCreateQueue(ctx, input.resources);
    case "deploy_bootstrap":
      return stepDeployBootstrap(ctx, input.resources);
    case "enable_workers_dev":
      return stepEnableWorkersDev(ctx, input.resources);
    case "ensure_otp_idp":
      return stepEnsureOtpIdp(ctx, input.resources);
    case "create_access_app":
      return stepCreateAccessApp(ctx, input.resources);
    case "write_access_secrets":
      return stepWriteAccessSecrets(ctx, input.resources);
    case "apply_migrations":
      return stepApplyMigrations(input.env, input.job, ctx, input.resources);
    case "write_app_secrets":
      return stepWriteAppSecrets(ctx, input.resources, input.secrets);
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
    case "attach_cron":
      return stepAttachCron(input.env, input.job, ctx, input.resources);
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

async function readJobRelease(
  env: Env,
  job: DeployJobRow,
): Promise<ReleaseArtifact> {
  return loadRelease(env, job.targetVersion, job.targetDigest);
}

async function stepPrecheck(
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  const precheck = await runAccountPrecheck(ctx);
  if (!precheck.ready) {
    throw new ProvisionError("PRECHECK_INCOMPLETE");
  }
  return {
    resources: {
      ...resources,
      workersSubdomain: precheck.workersSubdomain ?? undefined,
      teamDomain: precheck.teamDomain ?? undefined,
      d1DatabaseName: plannedD1Name(ctx.workerName),
      queueName: plannedQueueName(ctx.workerName),
    },
    secrets: {},
  };
}

export async function stepLoadRelease(
  env: Env,
  job: DeployJobRow,
  resources: CreatedResources,
) {
  const release = await loadRelease(env, job.targetVersion, job.targetDigest);
  return {
    resources: {
      ...resources,
      releaseVersion: release.version,
      releaseDigest: release.digest,
    },
    secrets: {},
  };
}

async function stepGenerateKeys(
  resources: CreatedResources,
  secrets: JobSecrets,
) {
  if (
    secrets.configEncryptionKey &&
    secrets.vapidPublicKey &&
    secrets.vapidPrivateKey
  ) {
    return {
      resources: { ...resources, keysGenerated: true },
      secrets,
    };
  }
  const generated = await generateInstallKeys();
  return {
    resources: { ...resources, keysGenerated: true },
    secrets: {
      ...secrets,
      configEncryptionKey: generated.configEncryptionKey,
      vapidPublicKey: generated.vapidPublicKey,
      vapidPrivateKey: generated.vapidPrivateKey,
    },
  };
}

async function stepCreateD1(
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  const name = resources.d1DatabaseName ?? plannedD1Name(ctx.workerName);
  if (resources.d1DatabaseId) {
    return { resources: { ...resources, d1DatabaseName: name }, secrets: {} };
  }
  if (!resources.d1CreateAttempted) {
    const existing = await findD1DatabaseByName(
      ctx.accessToken,
      ctx.accountId,
      name,
    );
    if (existing) throw new ProvisionError("RESOURCE_CONFLICT");
    return {
      resources: {
        ...resources,
        d1DatabaseName: name,
        d1CreateAttempted: true,
      },
      secrets: {},
      stayOnStep: true,
    };
  }
  const existing = await findD1DatabaseByName(
    ctx.accessToken,
    ctx.accountId,
    name,
  );
  if (existing) {
    return {
      resources: {
        ...resources,
        d1DatabaseName: name,
        d1DatabaseId: existing.id,
      },
      secrets: {},
    };
  }
  try {
    const created = await createD1Database(
      ctx.accessToken,
      ctx.accountId,
      name,
    );
    return {
      resources: {
        ...resources,
        d1DatabaseName: name,
        d1DatabaseId: created.id,
      },
      secrets: {},
    };
  } catch (error) {
    if (error instanceof CloudflareApiError && error.code === "CONFLICT") {
      const retry = await findD1DatabaseByName(
        ctx.accessToken,
        ctx.accountId,
        name,
      );
      if (retry) {
        return {
          resources: {
            ...resources,
            d1DatabaseName: name,
            d1DatabaseId: retry.id,
          },
          secrets: {},
        };
      }
      throw new ProvisionError("RESOURCE_CONFLICT");
    }
    throw error;
  }
}

async function stepCreateQueue(
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  const name = resources.queueName ?? plannedQueueName(ctx.workerName);
  if (resources.queueId) {
    return { resources: { ...resources, queueName: name }, secrets: {} };
  }
  if (!resources.queueCreateAttempted) {
    const existing = await findQueueByName(
      ctx.accessToken,
      ctx.accountId,
      name,
    );
    if (existing) throw new ProvisionError("RESOURCE_CONFLICT");
    return {
      resources: {
        ...resources,
        queueName: name,
        queueCreateAttempted: true,
      },
      secrets: {},
      stayOnStep: true,
    };
  }
  const existing = await findQueueByName(ctx.accessToken, ctx.accountId, name);
  if (existing) {
    return {
      resources: { ...resources, queueName: name, queueId: existing.id },
      secrets: {},
    };
  }
  try {
    const created = await createQueue(ctx.accessToken, ctx.accountId, name);
    return {
      resources: { ...resources, queueName: name, queueId: created.id },
      secrets: {},
    };
  } catch (error) {
    if (error instanceof CloudflareApiError && error.code === "CONFLICT") {
      const retry = await findQueueByName(ctx.accessToken, ctx.accountId, name);
      if (retry) {
        return {
          resources: { ...resources, queueName: name, queueId: retry.id },
          secrets: {},
        };
      }
      throw new ProvisionError("RESOURCE_CONFLICT");
    }
    throw error;
  }
}

async function stepDeployBootstrap(
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  if (resources.bootstrapDeployed && resources.workerScriptId) {
    return { resources, secrets: {} };
  }
  const uploaded = await putWorkerScript({
    accessToken: ctx.accessToken,
    accountId: ctx.accountId,
    workerName: ctx.workerName,
    mainModule: "index.js",
    source: BOOTSTRAP_WORKER_MODULE,
    metadata: {
      main_module: "index.js",
      compatibility_date: "2026-06-01",
      compatibility_flags: ["nodejs_compat"],
      bindings: [],
    },
  });
  return {
    resources: {
      ...resources,
      bootstrapDeployed: true,
      workerScriptId: uploaded.tag,
    },
    secrets: {},
  };
}

async function stepEnableWorkersDev(
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  if (resources.workersDevEnabled) return { resources, secrets: {} };
  await enableWorkersDev(ctx.accessToken, ctx.accountId, ctx.workerName);
  return {
    resources: { ...resources, workersDevEnabled: true },
    secrets: {},
  };
}

async function stepEnsureOtpIdp(
  ctx: { accessToken: string; accountId: string },
  resources: CreatedResources,
) {
  if (resources.otpIdpId) return { resources, secrets: {} };
  const providers = await listIdentityProviders(ctx.accessToken, ctx.accountId);
  const existing = providers.find(
    (provider) => provider.type === "onetimepin" && provider.id,
  );
  const id =
    existing?.id ??
    (await createOtpIdentityProvider(ctx.accessToken, ctx.accountId));
  return { resources: { ...resources, otpIdpId: id }, secrets: {} };
}

async function stepCreateAccessApp(
  ctx: {
    accessToken: string;
    accountId: string;
    workerName: string;
    allowedEmail: string;
  },
  resources: CreatedResources,
) {
  if (!resources.workerScriptId) {
    throw new ProvisionError("WORKER_TAG_MISSING");
  }
  if (
    resources.accessAppId &&
    resources.accessPolicyId &&
    resources.policyAud
  ) {
    return { resources, secrets: {} };
  }
  if (!resources.accessAppId) {
    const created = await createAccessApplication({
      accessToken: ctx.accessToken,
      accountId: ctx.accountId,
      name: ctx.workerName,
      workerId: resources.workerScriptId,
      allowedIdpId: resources.otpIdpId,
    });
    return {
      resources: {
        ...resources,
        accessAppId: created.id,
        policyAud: created.aud,
      },
      secrets: {},
      stayOnStep: true,
    };
  }
  if (!resources.accessPolicyId) {
    const policyId = await createAccessPolicy({
      accessToken: ctx.accessToken,
      accountId: ctx.accountId,
      appId: resources.accessAppId,
      email: ctx.allowedEmail,
    });
    return {
      resources: {
        ...resources,
        accessPolicyId: policyId,
      },
      secrets: {},
    };
  }
  return { resources, secrets: {} };
}

async function stepWriteAccessSecrets(
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  if (resources.accessSecretsWritten) return { resources, secrets: {} };
  if (!resources.teamDomain || !resources.policyAud) {
    throw new ProvisionError("ACCESS_CONFIG_MISSING");
  }
  await putWorkerSecret({
    accessToken: ctx.accessToken,
    accountId: ctx.accountId,
    workerName: ctx.workerName,
    name: "TEAM_DOMAIN",
    value: resources.teamDomain.startsWith("https://")
      ? resources.teamDomain
      : `https://${resources.teamDomain}`,
  });
  await putWorkerSecret({
    accessToken: ctx.accessToken,
    accountId: ctx.accountId,
    workerName: ctx.workerName,
    name: "POLICY_AUD",
    value: resources.policyAud,
  });
  return {
    resources: { ...resources, accessSecretsWritten: true },
    secrets: {},
  };
}

export async function stepApplyMigrations(
  env: Env,
  job: DeployJobRow,
  ctx: { accessToken: string; accountId: string },
  resources: CreatedResources,
) {
  if (!resources.d1DatabaseId) throw new ProvisionError("D1_MISSING");
  if (!resources.ledgerReady) {
    await ensureMigrationLedger(
      ctx.accessToken,
      ctx.accountId,
      resources.d1DatabaseId,
    );
    return {
      resources: { ...resources, ledgerReady: true, migrations: [] },
      secrets: {},
      stayOnStep: true,
    };
  }
  const release = await readJobRelease(env, job);
  const applied = new Set([
    ...(resources.migrations ?? []),
    ...(await listAppliedMigrations(
      ctx.accessToken,
      ctx.accountId,
      resources.d1DatabaseId,
    )),
  ]);
  const pending = release.migrations.find((file) => !applied.has(file.name));
  if (!pending) {
    return {
      resources: {
        ...resources,
        migrations: release.migrations.map((file) => file.name),
      },
      secrets: {},
      migrationName: null,
    };
  }
  await applyMigrationFile({
    accessToken: ctx.accessToken,
    accountId: ctx.accountId,
    databaseId: resources.d1DatabaseId,
    name: pending.name,
    sql: pending.sql,
  });
  const migrations = [...applied, pending.name];
  const done = release.migrations.every((file) =>
    migrations.includes(file.name),
  );
  return {
    resources: { ...resources, migrations },
    secrets: {},
    stayOnStep: !done,
    migrationName: pending.name,
  };
}

async function stepWriteAppSecrets(
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
  secrets: JobSecrets,
) {
  if (resources.appSecretsWritten) return { resources, secrets };
  if (
    !secrets.configEncryptionKey ||
    !secrets.vapidPublicKey ||
    !secrets.vapidPrivateKey
  ) {
    throw new ProvisionError("KEYS_MISSING");
  }
  for (const [name, value] of [
    ["CONFIG_ENCRYPTION_KEY", secrets.configEncryptionKey],
    ["VAPID_PUBLIC_KEY", secrets.vapidPublicKey],
    ["VAPID_PRIVATE_KEY", secrets.vapidPrivateKey],
  ] as const) {
    await putWorkerSecret({
      accessToken: ctx.accessToken,
      accountId: ctx.accountId,
      workerName: ctx.workerName,
      name,
      value,
    });
  }
  return {
    resources: { ...resources, appSecretsWritten: true },
    secrets,
  };
}

export async function stepUploadAssets(
  env: Env,
  job: DeployJobRow,
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
  secrets: JobSecrets,
) {
  if (resources.assetUploadComplete && secrets.assetJwt) {
    return { resources, secrets };
  }
  const release = await readJobRelease(env, job);
  if (!secrets.assetJwt) {
    const manifest = Object.fromEntries(
      release.assets.map((asset) => [
        asset.path,
        { hash: asset.hash, size: asset.size },
      ]),
    );
    const session = await createAssetUploadSession({
      accessToken: ctx.accessToken,
      accountId: ctx.accountId,
      workerName: ctx.workerName,
      manifest,
    });
    const buckets = session.buckets;
    return {
      resources: {
        ...resources,
        assetUploadBuckets: buckets,
        assetUploadIndex: 0,
        assetUploadComplete: buckets.length === 0,
      },
      secrets: { ...secrets, assetJwt: session.jwt },
      stayOnStep: buckets.length > 0,
    };
  }
  const buckets = resources.assetUploadBuckets ?? [];
  const index = resources.assetUploadIndex ?? 0;
  if (index >= buckets.length) {
    return {
      resources: { ...resources, assetUploadComplete: true },
      secrets,
    };
  }
  const byHash = new Map(
    release.assets.map((asset) => [asset.hash, asset] as const),
  );
  const files = (buckets[index] ?? []).map((hash) => {
    const asset = byHash.get(hash);
    if (!asset) throw new ProvisionError("ASSET_MISSING");
    return { hash, base64: asset.contentBase64 };
  });
  const uploaded = await uploadWorkerAssetBucket({
    jwt: secrets.assetJwt,
    accountId: ctx.accountId,
    files,
  });
  const nextIndex = index + 1;
  return {
    resources: {
      ...resources,
      assetUploadIndex: nextIndex,
      assetUploadComplete: nextIndex >= buckets.length,
    },
    secrets: { ...secrets, assetJwt: uploaded.jwt },
    stayOnStep: nextIndex < buckets.length,
  };
}

export async function stepDeployWorker(
  env: Env,
  job: DeployJobRow,
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
  secrets: JobSecrets,
) {
  if (resources.workerDeployed) return { resources, secrets };
  if (!resources.d1DatabaseId || !resources.queueName) {
    throw new ProvisionError("BINDINGS_MISSING");
  }
  const release = await readJobRelease(env, job);
  const bindings: Array<Record<string, unknown>> = [
    { type: "d1", name: "DB", id: resources.d1DatabaseId },
    { type: "queue", name: "SYNC_QUEUE", queue_name: resources.queueName },
    { type: "browser", name: "BROWSER" },
    { type: "ai", name: "AI" },
    { type: "assets", name: "ASSETS" },
  ];
  const metadata: Record<string, unknown> = {
    main_module: release.workerMain,
    compatibility_date: release.compatibilityDate,
    compatibility_flags: release.compatibilityFlags,
    bindings,
  };
  if (secrets.assetJwt) {
    metadata.assets = { jwt: secrets.assetJwt };
  }
  const uploaded = await putWorkerScript({
    accessToken: ctx.accessToken,
    accountId: ctx.accountId,
    workerName: ctx.workerName,
    mainModule: release.workerMain,
    source: release.workerSource,
    modules: release.workerModules.map((module) => ({
      name: module.name,
      contentType: module.contentType,
      bytes: base64ToBytes(module.contentBase64),
    })),
    metadata,
  });
  if (resources.accessAppId && uploaded.tag !== resources.workerScriptId) {
    await patchAccessApplication({
      accessToken: ctx.accessToken,
      accountId: ctx.accountId,
      appId: resources.accessAppId,
      workerId: uploaded.tag,
    });
  }
  return {
    resources: {
      ...resources,
      workerDeployed: true,
      workerScriptId: uploaded.tag,
    },
    secrets,
  };
}

export async function stepAttachQueueConsumer(
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  if (resources.queueConsumerId) return { resources, secrets: {} };
  if (!resources.queueId) throw new ProvisionError("QUEUE_MISSING");
  const consumer = await putQueueConsumer({
    accessToken: ctx.accessToken,
    accountId: ctx.accountId,
    queueId: resources.queueId,
    workerName: ctx.workerName,
  });
  return {
    resources: { ...resources, queueConsumerId: consumer.id },
    secrets: {},
  };
}

export async function stepAttachCron(
  env: Env,
  job: DeployJobRow,
  ctx: { accessToken: string; accountId: string; workerName: string },
  resources: CreatedResources,
) {
  if (resources.cronAttached) return { resources, secrets: {} };
  const release = await readJobRelease(env, job);
  await putWorkerSchedules({
    accessToken: ctx.accessToken,
    accountId: ctx.accountId,
    workerName: ctx.workerName,
    crons: release.crons,
  });
  return { resources: { ...resources, cronAttached: true }, secrets: {} };
}

export async function stepVerifyInstall(
  ctx: { workerName: string },
  resources: CreatedResources,
) {
  if (resources.verified) return { resources, secrets: {} };
  if (!resources.workersSubdomain) {
    throw new ProvisionError("SUBDOMAIN_MISSING");
  }
  const url = `https://${ctx.workerName}.${resources.workersSubdomain}.workers.dev/`;
  const probe = await readAnonymousUrl(url);
  if (probe.status === 200) {
    throw new ProvisionError("ACCESS_NOT_ENFORCED");
  }
  if (!hasCloudflareAccessChallenge(probe)) {
    throw new ProvisionError("VERIFY_FAILED");
  }
  return { resources: { ...resources, verified: true }, secrets: {} };
}

export async function readJobSecrets(
  row: DeployJobRow,
  encryptionKey: string | undefined,
): Promise<JobSecrets> {
  if (!row.encryptedSecrets) return {};
  if (!encryptionKey) throw new ProvisionError("MISSING_ENCRYPTION_KEY");
  return decryptJson<JobSecrets>(row.encryptedSecrets, encryptionKey);
}

export async function writeJobSecrets(
  secrets: JobSecrets,
  encryptionKey: string | undefined,
) {
  const keys = Object.values(secrets).filter(Boolean);
  if (keys.length === 0) return null;
  if (!encryptionKey) throw new ProvisionError("MISSING_ENCRYPTION_KEY");
  return encryptJson(secrets, encryptionKey);
}
