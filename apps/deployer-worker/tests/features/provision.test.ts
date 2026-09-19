import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";
import { processDeployJob } from "../../src/features/deployments/service";
import {
  getJobById,
  updateJob,
} from "../../src/features/deployments/repository";
import { decryptJson } from "../../src/platform/crypto";
import type { JobSecrets } from "../../src/features/deployments/resources";
import {
  TARGET_DIGEST,
  authHeaders,
  createDeployerEnv,
  login,
  queuedMessages,
} from "../helpers";
import { MemoryR2Bucket, seedPublishedRelease } from "../platform/memory-r2";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function dispose(env: Awaited<ReturnType<typeof createDeployerEnv>>) {
  await env.harness.mf.dispose();
}

async function startInstall(
  env: Awaited<ReturnType<typeof createDeployerEnv>>["env"],
) {
  const session = await login(env);
  await app.request(
    "http://localhost/api/auth/select-account",
    {
      method: "POST",
      headers: authHeaders(session),
      body: JSON.stringify({ accountId: "acct-1" }),
    },
    env,
  );
  const created = await app.request(
    "http://localhost/api/installations",
    {
      method: "POST",
      headers: authHeaders(session),
      body: JSON.stringify({
        accountId: "acct-1",
        workerName: "taiwan-fin-hub",
        allowedEmail: "owner@example.com",
        targetVersion: "v0.1.0",
        targetDigest: TARGET_DIGEST,
      }),
    },
    env,
  );
  const body = (await created.json()) as {
    installation: { id: string };
    job: { id: string };
    writesEnabled: boolean;
  };
  return { session, body };
}

async function runJob(
  env: Awaited<ReturnType<typeof createDeployerEnv>>["env"],
  jobId: string,
  max = 80,
) {
  for (let index = 0; index < max; index += 1) {
    const job = await getJobById(env.DB, jobId);
    if (!job) throw new Error("missing job");
    if (
      job.status === "succeeded" ||
      job.status === "failed" ||
      job.status === "awaiting_reauth" ||
      job.status === "awaiting_release" ||
      job.status === "cancelled"
    ) {
      return job;
    }
    await processDeployJob(env, jobId, `lease-${index}`);
  }
  const leftover = await getJobById(env.DB, jobId);
  if (!leftover) throw new Error("missing job");
  return leftover;
}

describe("first-install provisioner", () => {
  it("installs with mocked Cloudflare writes and does not rotate keys on retry", async () => {
    const ctx = await createDeployerEnv();
    try {
      const { body } = await startInstall(ctx.env);
      const finished = await runJob(ctx.env, body.job.id);
      expect(finished.status).toBe("succeeded");
      expect(finished.encryptedSecrets).toBeNull();
      expect(finished.step).toBe("finalize");
      const resources = JSON.parse(finished.createdResources) as {
        d1DatabaseId?: string;
        queueId?: string;
        accessAppId?: string;
        workerDeployed?: boolean;
        verified?: boolean;
      };
      expect(resources.d1DatabaseId).toBeTruthy();
      expect(resources.queueId).toBeTruthy();
      expect(resources.accessAppId).toBeTruthy();
      expect(resources.workerDeployed).toBe(true);
      expect(resources.verified).toBe(true);
      expect(ctx.cloudflare.uploadedAssetHashes).toEqual(["local-index-html"]);
      expect(ctx.cloudflare.uploadedWorkerModules.at(-1)).toEqual(["index.js"]);
      expect(ctx.cloudflare.d1).toHaveLength(1);
      expect(ctx.cloudflare.queues).toHaveLength(1);
      expect(
        ctx.cloudflare.secrets.get("taiwan-fin-hub:CONFIG_ENCRYPTION_KEY"),
      ).toHaveLength(64);
      expect(queuedMessages(ctx.send).every((message) => message.jobId)).toBe(
        true,
      );
      expect(JSON.stringify(queuedMessages(ctx.send))).not.toContain(
        ctx.cloudflare.secrets.get("taiwan-fin-hub:CONFIG_ENCRYPTION_KEY"),
      );
    } finally {
      await dispose(ctx);
    }
  });

  it("keeps the first generated keys when generate_keys is replayed", async () => {
    const ctx = await createDeployerEnv();
    try {
      const { body } = await startInstall(ctx.env);
      for (let index = 0; index < 20; index += 1) {
        const job = await getJobById(ctx.env.DB, body.job.id);
        if (job?.step === "create_d1") break;
        await processDeployJob(ctx.env, body.job.id, `lease-k-${index}`);
      }
      const generated = await getJobById(ctx.env.DB, body.job.id);
      expect(generated?.step).toBe("create_d1");
      const firstSecrets = await decryptJson<JobSecrets>(
        generated!.encryptedSecrets!,
        "test-session-key",
      );
      await updateJob(ctx.env.DB, body.job.id, {
        status: "queued",
        step: "generate_keys",
        updatedAt: new Date().toISOString(),
      });
      await processDeployJob(ctx.env, body.job.id, "lease-replay-keys");
      const replayed = await getJobById(ctx.env.DB, body.job.id);
      const secondSecrets = await decryptJson<JobSecrets>(
        replayed!.encryptedSecrets!,
        "test-session-key",
      );
      expect(secondSecrets.configEncryptionKey).toBe(
        firstSecrets.configEncryptionKey,
      );
      expect(secondSecrets.vapidPrivateKey).toBe(firstSecrets.vapidPrivateKey);
    } finally {
      await dispose(ctx);
    }
  });

  it("does not create a second D1 when the create step is retried", async () => {
    const ctx = await createDeployerEnv();
    try {
      const { body } = await startInstall(ctx.env);
      for (let index = 0; index < 40; index += 1) {
        const job = await getJobById(ctx.env.DB, body.job.id);
        if (job?.createdResources.includes("d1DatabaseId")) break;
        await processDeployJob(ctx.env, body.job.id, `lease-d1-${index}`);
      }
      expect(ctx.cloudflare.d1).toHaveLength(1);
      const afterCreate = await getJobById(ctx.env.DB, body.job.id);
      await updateJob(ctx.env.DB, body.job.id, {
        status: "queued",
        step: "create_d1",
        updatedAt: new Date().toISOString(),
      });
      await processDeployJob(ctx.env, body.job.id, "lease-d1-retry");
      expect(ctx.cloudflare.d1).toHaveLength(1);
      const retried = await getJobById(ctx.env.DB, body.job.id);
      expect(JSON.parse(retried!.createdResources).d1DatabaseId).toBe(
        JSON.parse(afterCreate!.createdResources).d1DatabaseId,
      );
    } finally {
      await dispose(ctx);
    }
  });

  it("stops at awaiting_release when no version source is bound", async () => {
    const ctx = await createDeployerEnv({ localDevMode: false });
    try {
      const { body } = await startInstall(ctx.env);
      expect(body.writesEnabled).toBe(false);
      const finished = await runJob(ctx.env, body.job.id);
      expect(finished.status).toBe("awaiting_release");
      expect(finished.errorCode).toBe("RELEASE_UNAVAILABLE");
      expect(ctx.cloudflare.d1).toHaveLength(0);
      expect(
        ctx.cloudflare.writes.filter((item) => item.method !== "GET"),
      ).toEqual([]);
    } finally {
      await dispose(ctx);
    }
  });

  it("persists the Access application before creating its policy", async () => {
    const ctx = await createDeployerEnv();
    try {
      const { body } = await startInstall(ctx.env);
      let sawAppWithoutPolicy = false;
      for (let index = 0; index < 40; index += 1) {
        const job = await getJobById(ctx.env.DB, body.job.id);
        const resources = JSON.parse(job?.createdResources ?? "{}") as {
          accessAppId?: string;
          accessPolicyId?: string;
        };
        if (resources.accessAppId && !resources.accessPolicyId) {
          sawAppWithoutPolicy = true;
          expect(ctx.cloudflare.accessApps).toHaveLength(1);
          expect(ctx.cloudflare.policies).toHaveLength(0);
          break;
        }
        await processDeployJob(ctx.env, body.job.id, `lease-access-${index}`);
      }
      expect(sawAppWithoutPolicy).toBe(true);
    } finally {
      await dispose(ctx);
    }
  });

  it("pauses for reauth when a write returns 401", async () => {
    const ctx = await createDeployerEnv({ expireOnWrite: true });
    try {
      const { body } = await startInstall(ctx.env);
      const finished = await runJob(ctx.env, body.job.id);
      expect(finished.status).toBe("awaiting_reauth");
      expect(finished.errorCode).toBe("TOKEN_EXPIRED");
    } finally {
      await dispose(ctx);
    }
  });

  it("treats a pre-existing D1 name as a conflict", async () => {
    const ctx = await createDeployerEnv({ existingD1: ["taiwan-fin-hub"] });
    try {
      const session = await login(ctx.env);
      await app.request(
        "http://localhost/api/auth/select-account",
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({ accountId: "acct-1" }),
        },
        ctx.env,
      );
      const precheck = await app.request(
        "http://localhost/api/precheck",
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({
            accountId: "acct-1",
            workerName: "taiwan-fin-hub",
          }),
        },
        ctx.env,
      );
      const precheckBody = (await precheck.json()) as {
        ready: boolean;
        checks: Array<{ id: string; ok: boolean }>;
      };
      expect(precheckBody.ready).toBe(false);
      expect(
        precheckBody.checks.find((check) => check.id === "d1_name")?.ok,
      ).toBe(false);

      const created = await app.request(
        "http://localhost/api/installations",
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({
            accountId: "acct-1",
            workerName: "taiwan-fin-hub",
            allowedEmail: "owner@example.com",
            targetVersion: "v0.1.0",
            targetDigest: TARGET_DIGEST,
          }),
        },
        ctx.env,
      );
      const body = (await created.json()) as { job: { id: string } };
      const finished = await runJob(ctx.env, body.job.id);
      expect(finished.status).toBe("failed");
      expect(finished.errorCode).toBe("PRECHECK_INCOMPLETE");
    } finally {
      await dispose(ctx);
    }
  });

  it("installs from a published R2 release and uploads asset buckets", async () => {
    const bucket = new MemoryR2Bucket();
    const published = await seedPublishedRelease(bucket, {
      extraModule: {
        name: "chunk.js",
        path: "worker/chunk.js",
        source: "export const chunk = 1;",
      },
    });
    const ctx = await createDeployerEnv({
      localDevMode: false,
      releaseBucket: published.bucket,
    });
    try {
      const session = await login(ctx.env);
      await app.request(
        "http://localhost/api/auth/select-account",
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({ accountId: "acct-1" }),
        },
        ctx.env,
      );
      const created = await app.request(
        "http://localhost/api/installations",
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({
            accountId: "acct-1",
            workerName: "taiwan-fin-hub",
            allowedEmail: "owner@example.com",
            targetVersion: published.version,
            targetDigest: published.digest,
          }),
        },
        ctx.env,
      );
      const body = (await created.json()) as {
        job: { id: string };
        writesEnabled: boolean;
      };
      expect(body.writesEnabled).toBe(true);
      const finished = await runJob(ctx.env, body.job.id);
      expect(finished.status).toBe("succeeded");
      expect(ctx.cloudflare.uploadedAssetHashes).toEqual(["r2-index-html"]);
      expect(ctx.cloudflare.uploadedWorkerModules.at(-1)).toEqual([
        "index.js",
        "chunk.js",
      ]);
    } finally {
      await dispose(ctx);
    }
  });

  it("returns the local fixture as the current release", async () => {
    const ctx = await createDeployerEnv();
    try {
      const session = await login(ctx.env);
      const response = await app.request(
        "http://localhost/api/releases/current",
        { headers: { Cookie: session.cookie } },
        ctx.env,
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        source: "local_fixture",
        version: "dev-local",
      });
    } finally {
      await dispose(ctx);
    }
  });
});
