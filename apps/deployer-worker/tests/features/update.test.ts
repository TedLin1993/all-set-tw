import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";
import { processDeployJob } from "../../src/features/deployments/service";
import { getJobById } from "../../src/features/deployments/repository";
import { getInstallationById } from "../../src/features/installations/repository";
import {
  LOCAL_FIXTURE_DIGEST,
  LOCAL_FIXTURE_NEXT_DIGEST,
  LOCAL_FIXTURE_NEXT_VERSION,
  LOCAL_FIXTURE_VERSION,
} from "../../src/platform/release";
import {
  TARGET_DIGEST,
  authHeaders,
  createDeployerEnv,
  login,
} from "../helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function dispose(env: Awaited<ReturnType<typeof createDeployerEnv>>) {
  await env.harness.mf.dispose();
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

async function installReady(
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
  };
  const finished = await runJob(env, body.job.id);
  expect(finished.status).toBe("succeeded");
  return { session, installationId: body.installation.id, job: finished };
}

describe("web update provisioner", { timeout: 30_000 }, () => {
  it("upgrades a ready install without rotating keys or duplicating D1", async () => {
    const ctx = await createDeployerEnv();
    try {
      const {
        session,
        installationId,
        job: installed,
      } = await installReady(ctx.env);
      const encryptionKey = ctx.cloudflare.secrets.get(
        "taiwan-fin-hub:CONFIG_ENCRYPTION_KEY",
      );
      expect(encryptionKey).toHaveLength(64);
      expect(ctx.cloudflare.d1).toHaveLength(1);
      const installedResources = JSON.parse(installed.createdResources) as {
        d1DatabaseId?: string;
        queueId?: string;
      };

      const planResponse = await app.request(
        `http://localhost/api/installations/${installationId}/update-plan`,
        { headers: { Cookie: session.cookie } },
        ctx.env,
      );
      expect(planResponse.status).toBe(200);
      const plan = (await planResponse.json()) as {
        available: boolean;
        targetVersion: string;
        targetDigest: string;
        pendingMigrations: string[];
      };
      expect(plan).toMatchObject({
        available: true,
        targetVersion: LOCAL_FIXTURE_NEXT_VERSION,
        targetDigest: LOCAL_FIXTURE_NEXT_DIGEST,
      });
      expect(plan.pendingMigrations).toContain("0002_probe_note.sql");

      const started = await app.request(
        `http://localhost/api/installations/${installationId}/updates`,
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({
            targetVersion: plan.targetVersion,
            targetDigest: plan.targetDigest,
          }),
        },
        ctx.env,
      );
      expect(started.status).toBe(200);
      const startedBody = (await started.json()) as { job: { id: string } };
      const finished = await runJob(ctx.env, startedBody.job.id);
      expect(finished.status).toBe("succeeded");
      expect(finished.kind).toBe("update");
      expect(finished.encryptedSecrets).toBeNull();

      const resources = JSON.parse(finished.createdResources) as {
        restoreBookmark?: string;
        pendingMigrations?: string[];
        d1DatabaseId?: string;
        queueId?: string;
      };
      expect(resources.restoreBookmark).toMatch(/^bm-/);
      expect(resources.d1DatabaseId).toBe(installedResources.d1DatabaseId);
      expect(resources.queueId).toBe(installedResources.queueId);
      expect(ctx.cloudflare.d1).toHaveLength(1);
      expect(
        ctx.cloudflare.secrets.get("taiwan-fin-hub:CONFIG_ENCRYPTION_KEY"),
      ).toBe(encryptionKey);
      expect(
        ctx.cloudflare.secrets.has("taiwan-fin-hub:DEPLOY_MAINTENANCE"),
      ).toBe(false);
      expect(ctx.cloudflare.deliveryPaused.size).toBe(0);
      expect(ctx.cloudflare.crons.get("taiwan-fin-hub")).toEqual([
        "*/10 * * * *",
      ]);
      expect(
        ctx.cloudflare.appliedMigrations.get(resources.d1DatabaseId ?? ""),
      ).toEqual(
        expect.arrayContaining(["0001_initial.sql", "0002_probe_note.sql"]),
      );

      const installation = await getInstallationById(
        ctx.env.DB,
        installationId,
      );
      expect(installation?.status).toBe("ready");
      expect(installation?.targetVersion).toBe(LOCAL_FIXTURE_NEXT_VERSION);
      expect(installation?.targetDigest).toBe(LOCAL_FIXTURE_NEXT_DIGEST);

      const latestPlan = await app.request(
        `http://localhost/api/installations/${installationId}/update-plan`,
        { headers: { Cookie: session.cookie } },
        ctx.env,
      );
      await expect(latestPlan.json()).resolves.toMatchObject({
        available: false,
        reason: "UP_TO_DATE",
        currentVersion: LOCAL_FIXTURE_NEXT_VERSION,
      });
    } finally {
      await dispose(ctx);
    }
  });

  it("rejects an up-to-date or disallowed target before writing", async () => {
    const ctx = await createDeployerEnv();
    try {
      const { session, installationId } = await installReady(ctx.env);
      const writesBefore = ctx.cloudflare.writes.length;

      const upToDate = await app.request(
        `http://localhost/api/installations/${installationId}/updates`,
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({
            targetVersion: "v0.1.0",
            targetDigest: TARGET_DIGEST,
          }),
        },
        ctx.env,
      );
      expect(upToDate.status).toBe(409);
      await expect(upToDate.json()).resolves.toMatchObject({
        error: { code: "UP_TO_DATE" },
      });

      const blocked = await app.request(
        `http://localhost/api/installations/${installationId}/updates`,
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({
            targetVersion: LOCAL_FIXTURE_VERSION,
            targetDigest: LOCAL_FIXTURE_DIGEST,
          }),
        },
        ctx.env,
      );
      expect(blocked.status).toBe(409);
      await expect(blocked.json()).resolves.toMatchObject({
        error: { code: "UPGRADE_NOT_ALLOWED" },
      });
      expect(ctx.cloudflare.writes.length).toBe(writesBefore);
      expect(ctx.cloudflare.d1).toHaveLength(1);
    } finally {
      await dispose(ctx);
    }
  });

  it("pauses queue delivery then waits for inflight messages", async () => {
    const ctx = await createDeployerEnv();
    try {
      const {
        session,
        installationId,
        job: installed,
      } = await installReady(ctx.env);
      const resources = JSON.parse(installed.createdResources) as {
        queueId?: string;
      };
      expect(resources.queueId).toBeTruthy();
      ctx.cloudflare.pendingMessages.set(resources.queueId!, 2);

      const started = await app.request(
        `http://localhost/api/installations/${installationId}/updates`,
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({
            targetVersion: LOCAL_FIXTURE_NEXT_VERSION,
            targetDigest: LOCAL_FIXTURE_NEXT_DIGEST,
          }),
        },
        ctx.env,
      );
      const startedBody = (await started.json()) as { job: { id: string } };

      let waited = false;
      for (let index = 0; index < 40; index += 1) {
        const current = await getJobById(ctx.env.DB, startedBody.job.id);
        if (current?.step === "wait_inflight") {
          await processDeployJob(
            ctx.env,
            startedBody.job.id,
            `lease-wait-${index}`,
          );
          const stayed = await getJobById(ctx.env.DB, startedBody.job.id);
          expect(stayed?.step).toBe("wait_inflight");
          expect(stayed?.status).toBe("queued");
          expect(ctx.cloudflare.deliveryPaused.has(resources.queueId!)).toBe(
            true,
          );
          waited = true;
          break;
        }
        if (
          current?.status === "succeeded" ||
          current?.status === "failed" ||
          current?.status === "awaiting_reauth"
        ) {
          break;
        }
        await processDeployJob(ctx.env, startedBody.job.id, `lease-${index}`);
      }
      expect(waited).toBe(true);

      ctx.cloudflare.pendingMessages.set(resources.queueId!, 0);
      const finished = await runJob(ctx.env, startedBody.job.id);
      expect(finished.status).toBe("succeeded");
      expect(ctx.cloudflare.deliveryPaused.size).toBe(0);
    } finally {
      await dispose(ctx);
    }
  });

  it("keeps a restore bookmark when secrets are missing and resumes after they return", async () => {
    const ctx = await createDeployerEnv();
    try {
      const { session, installationId } = await installReady(ctx.env);
      ctx.cloudflare.secrets.delete("taiwan-fin-hub:TEAM_DOMAIN");

      const started = await app.request(
        `http://localhost/api/installations/${installationId}/updates`,
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({
            targetVersion: LOCAL_FIXTURE_NEXT_VERSION,
            targetDigest: LOCAL_FIXTURE_NEXT_DIGEST,
          }),
        },
        ctx.env,
      );
      const startedBody = (await started.json()) as { job: { id: string } };
      const failed = await runJob(ctx.env, startedBody.job.id);
      expect(failed.status).toBe("failed");
      expect(failed.errorCode).toBe("SECRETS_MISSING");
      const failedResources = JSON.parse(failed.createdResources) as {
        restoreBookmark?: string;
      };
      expect(failedResources.restoreBookmark).toMatch(/^bm-/);

      const installation = await getInstallationById(
        ctx.env.DB,
        installationId,
      );
      expect(installation?.status).toBe("update_failed");

      ctx.cloudflare.secrets.set(
        "taiwan-fin-hub:TEAM_DOMAIN",
        "https://example.cloudflareaccess.com",
      );
      const resumed = await app.request(
        `http://localhost/api/installations/${installationId}/jobs`,
        { method: "POST", headers: authHeaders(session) },
        ctx.env,
      );
      expect(resumed.status).toBe(200);
      const resumedBody = (await resumed.json()) as { job: { id: string } };
      expect(resumedBody.job.id).toBe(startedBody.job.id);
      const finished = await runJob(ctx.env, resumedBody.job.id);
      expect(finished.status).toBe("succeeded");
      expect(JSON.parse(finished.createdResources).restoreBookmark).toBe(
        failedResources.restoreBookmark,
      );
    } finally {
      await dispose(ctx);
    }
  });

  it("hides another account's update plan", async () => {
    const ctx = await createDeployerEnv();
    try {
      const { installationId } = await installReady(ctx.env);
      const other = await login(ctx.env, "user-b");
      await app.request(
        "http://localhost/api/auth/select-account",
        {
          method: "POST",
          headers: authHeaders(other),
          body: JSON.stringify({ accountId: "acct-1" }),
        },
        ctx.env,
      );
      const hidden = await app.request(
        `http://localhost/api/installations/${installationId}/update-plan`,
        { headers: { Cookie: other.cookie } },
        ctx.env,
      );
      expect(hidden.status).toBe(404);
    } finally {
      await dispose(ctx);
    }
  });
});
