import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../src/index";
import { processDeployJob } from "../../src/features/deployments/service";
import { getInstallationByAccountWorker } from "../../src/features/installations/repository";
import {
  findActiveJob,
  getJobById,
} from "../../src/features/deployments/repository";
import {
  TARGET_DIGEST,
  authHeaders,
  createDeployerEnv,
  login,
  oauthStateCookieHeader,
  queuedMessages,
} from "../helpers";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function dispose(env: Awaited<ReturnType<typeof createDeployerEnv>>) {
  await env.harness.mf.dispose();
}

describe("deployer auth, precheck, and jobs", () => {
  it("reports OAuth as unconfigured without claiming live consent", async () => {
    const { env, harness } = await createDeployerEnv();
    try {
      const response = await app.request(
        "http://localhost/api/auth/status",
        {},
        { ...env, OAUTH_CLIENT_ID: undefined },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        oauthConfigured: false,
        stage: { oauthLiveVerified: false, writesEnabled: true },
      });
    } finally {
      await harness.mf.dispose();
    }
  });

  it("rejects an unknown OAuth state and a missing CSRF token", async () => {
    const ctx = await createDeployerEnv();
    try {
      const invalid = await app.request(
        "http://localhost/api/auth/callback?code=ok&state=unknown",
        {},
        ctx.env,
      );
      expect(invalid.status).toBe(400);
      const session = await login(ctx.env);
      const csrfMissing = await app.request(
        "http://localhost/api/auth/select-account",
        {
          method: "POST",
          headers: {
            Cookie: session.cookie,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ accountId: "acct-1" }),
        },
        ctx.env,
      );
      expect(csrfMissing.status).toBe(403);
    } finally {
      await dispose(ctx);
    }
  });

  it("lists only authorized accounts and rejects a cross-account precheck", async () => {
    const ctx = await createDeployerEnv();
    try {
      const session = await login(ctx.env);
      const listed = await app.request(
        "http://localhost/api/auth/accounts",
        { headers: { Cookie: session.cookie } },
        ctx.env,
      );
      expect(listed.status).toBe(200);
      await expect(listed.json()).resolves.toEqual({
        accounts: [
          { id: "acct-1", name: "Primary" },
          { id: "acct-2", name: "Other" },
        ],
      });
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
            accountId: "acct-2",
            workerName: "taiwan-fin-hub",
          }),
        },
        ctx.env,
      );
      expect(precheck.status).toBe(403);
    } finally {
      await dispose(ctx);
    }
  });

  it("returns dashboard links when a precheck item is missing", async () => {
    const ctx = await createDeployerEnv({ organization: false });
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
      const response = await app.request(
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
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        ready: boolean;
        checks: Array<{ id: string; ok: boolean; dashboardUrl?: string }>;
      };
      expect(body.ready).toBe(false);
      expect(
        body.checks.find((check) => check.id === "access_organization"),
      ).toMatchObject({
        ok: false,
        dashboardUrl: "https://one.dash.cloudflare.com/",
      });
    } finally {
      await dispose(ctx);
    }
  });

  it("reuses one installation on resend and hides another user's record", async () => {
    const ctx = await createDeployerEnv();
    try {
      const first = await login(ctx.env, "ok");
      await app.request(
        "http://localhost/api/auth/select-account",
        {
          method: "POST",
          headers: authHeaders(first),
          body: JSON.stringify({ accountId: "acct-1" }),
        },
        ctx.env,
      );
      const payload = {
        accountId: "acct-1",
        workerName: "taiwan-fin-hub",
        allowedEmail: "owner@example.com",
        targetVersion: "v0.1.0",
        targetDigest: TARGET_DIGEST,
      };
      const created = await app.request(
        "http://localhost/api/installations",
        {
          method: "POST",
          headers: authHeaders(first),
          body: JSON.stringify(payload),
        },
        ctx.env,
      );
      const firstBody = (await created.json()) as {
        installation: { id: string };
        job: { id: string };
        writesEnabled: boolean;
      };
      expect(created.status).toBe(200);
      expect(firstBody.writesEnabled).toBe(true);
      const again = await app.request(
        "http://localhost/api/installations",
        {
          method: "POST",
          headers: authHeaders(first),
          body: JSON.stringify(payload),
        },
        ctx.env,
      );
      const secondBody = (await again.json()) as {
        installation: { id: string };
        job: { id: string };
        reused: boolean;
      };
      expect(secondBody.installation.id).toBe(firstBody.installation.id);
      expect(secondBody.job.id).toBe(firstBody.job.id);
      expect(secondBody.reused).toBe(true);
      expect(queuedMessages(ctx.send).every((message) => message.jobId)).toBe(
        true,
      );
      expect(JSON.stringify(queuedMessages(ctx.send)).includes("token-")).toBe(
        false,
      );

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
      const conflict = await app.request(
        "http://localhost/api/installations",
        {
          method: "POST",
          headers: authHeaders(other),
          body: JSON.stringify(payload),
        },
        ctx.env,
      );
      expect(conflict.status).toBe(409);
      const hidden = await app.request(
        `http://localhost/api/installations/${firstBody.installation.id}`,
        { headers: { Cookie: other.cookie } },
        ctx.env,
      );
      expect(hidden.status).toBe(404);
    } finally {
      await dispose(ctx);
    }
  });

  it("marks a job awaiting reauth when the token has expired", async () => {
    const ctx = await createDeployerEnv({ tokenExpiresIn: 1 });
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
            targetVersion: "v0.1.0",
            targetDigest: TARGET_DIGEST,
          }),
        },
        ctx.env,
      );
      const body = (await created.json()) as { job: { id: string } };
      await ctx.env.DB.prepare(
        "UPDATE sessions SET token_expires_at = ? WHERE 1=1",
      )
        .bind(new Date(Date.now() - 1000).toISOString())
        .run();
      const outcome = await processDeployJob(ctx.env, body.job.id, "lease-1");
      expect(outcome).toBe("ack");
      const job = await getJobById(ctx.env.DB, body.job.id);
      expect(job?.status).toBe("awaiting_reauth");
      expect(job?.errorCode).toBe("TOKEN_EXPIRED");
    } finally {
      await dispose(ctx);
    }
  });

  it("does not create a second installation when the queue message is replayed", async () => {
    const ctx = await createDeployerEnv();
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
      await app.request(
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
      const installation = await getInstallationByAccountWorker(
        ctx.env.DB,
        "acct-1",
        "taiwan-fin-hub",
      );
      const job = await findActiveJob(ctx.env.DB, installation!.id);
      await processDeployJob(ctx.env, job!.id, "lease-1");
      await processDeployJob(ctx.env, job!.id, "lease-2");
      const rows = await ctx.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM installations",
      ).first<{ n: number }>();
      const jobs = await ctx.env.DB.prepare(
        "SELECT COUNT(*) AS n FROM deploy_jobs",
      ).first<{ n: number }>();
      const current = await getJobById(ctx.env.DB, job!.id);
      expect(rows?.n).toBe(1);
      expect(jobs?.n).toBe(1);
      expect(current?.status).toBe("queued");
      expect(current?.step).toBe("generate_keys");
    } finally {
      await dispose(ctx);
    }
  });

  it("rejects a valid OAuth callback that is missing the initiating browser cookie", async () => {
    const ctx = await createDeployerEnv();
    try {
      const loginResponse = await app.request(
        "http://localhost/api/auth/login",
        {},
        ctx.env,
      );
      const location = loginResponse.headers.get("location");
      if (!location) throw new Error("Missing OAuth redirect");
      const state = new URL(location).searchParams.get("state");
      const stolen = await app.request(
        `http://localhost/api/auth/callback?code=ok&state=${state}`,
        {},
        ctx.env,
      );
      expect(stolen.status).toBe(400);
      const legitimate = await app.request(
        `http://localhost/api/auth/callback?code=ok&state=${state}`,
        { headers: { Cookie: oauthStateCookieHeader(loginResponse) } },
        ctx.env,
      );
      expect(legitimate.status).toBe(302);
    } finally {
      await dispose(ctx);
    }
  });

  it("retries when enqueueing the next step fails after a successful step", async () => {
    const ctx = await createDeployerEnv();
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
            targetVersion: "v0.1.0",
            targetDigest: TARGET_DIGEST,
          }),
        },
        ctx.env,
      );
      const body = (await created.json()) as { job: { id: string } };
      ctx.send.mockReset();
      ctx.send.mockRejectedValueOnce(new Error("queue down"));
      const outcome = await processDeployJob(
        ctx.env,
        body.job.id,
        "lease-enqueue",
      );
      expect(outcome).toBe("retry");
      const job = await getJobById(ctx.env.DB, body.job.id);
      expect(job?.status).toBe("queued");
      expect(job?.errorCode).toBeNull();
      expect(job?.step).toBe("load_release");
    } finally {
      await dispose(ctx);
    }
  });

  it("updates a failed installation to the new target version on reuse", async () => {
    const ctx = await createDeployerEnv();
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
      const first = await app.request(
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
      const firstBody = (await first.json()) as {
        installation: { id: string };
        job: { id: string };
      };
      await ctx.env.DB.prepare(
        "UPDATE deploy_jobs SET status = 'failed' WHERE id = ?",
      )
        .bind(firstBody.job.id)
        .run();
      await ctx.env.DB.prepare(
        "UPDATE installations SET status = 'failed' WHERE id = ?",
      )
        .bind(firstBody.installation.id)
        .run();
      const nextDigest = "c".repeat(64);
      const reused = await app.request(
        "http://localhost/api/installations",
        {
          method: "POST",
          headers: authHeaders(session),
          body: JSON.stringify({
            accountId: "acct-1",
            workerName: "taiwan-fin-hub",
            allowedEmail: "owner@example.com",
            targetVersion: "v0.2.0",
            targetDigest: nextDigest,
          }),
        },
        ctx.env,
      );
      const reusedBody = (await reused.json()) as {
        installation: {
          id: string;
          targetVersion: string;
          targetDigest: string;
        };
        job: { id: string; targetVersion: string; targetDigest: string };
      };
      expect(reusedBody.installation.id).toBe(firstBody.installation.id);
      expect(reusedBody.installation.targetVersion).toBe("v0.2.0");
      expect(reusedBody.installation.targetDigest).toBe(nextDigest);
      expect(reusedBody.job.id).not.toBe(firstBody.job.id);
      expect(reusedBody.job.targetVersion).toBe("v0.2.0");
    } finally {
      await dispose(ctx);
    }
  });
});
