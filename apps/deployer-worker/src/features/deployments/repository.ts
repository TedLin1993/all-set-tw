import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { createDrizzle } from "../../db/client";
import { deployJobs } from "../../db/schema";

export const ACTIVE_JOB_STATUSES = [
  "queued",
  "running",
  "awaiting_reauth",
  "awaiting_release",
] as const;

export type DeployJobRow = {
  id: string;
  installationId: string;
  kind: string;
  status: string;
  step: string;
  targetVersion: string;
  targetDigest: string;
  leaseOwner: string | null;
  leaseUntil: string | null;
  attemptCount: number;
  createdResources: string;
  encryptedSecrets: string | null;
  errorCode: string | null;
  migrationName: string | null;
  createdAt: string;
  updatedAt: string;
};

const jobColumns = {
  id: deployJobs.id,
  installationId: deployJobs.installationId,
  kind: deployJobs.kind,
  status: deployJobs.status,
  step: deployJobs.step,
  targetVersion: deployJobs.targetVersion,
  targetDigest: deployJobs.targetDigest,
  leaseOwner: deployJobs.leaseOwner,
  leaseUntil: deployJobs.leaseUntil,
  attemptCount: deployJobs.attemptCount,
  createdResources: deployJobs.createdResources,
  encryptedSecrets: deployJobs.encryptedSecrets,
  errorCode: deployJobs.errorCode,
  migrationName: deployJobs.migrationName,
  createdAt: deployJobs.createdAt,
  updatedAt: deployJobs.updatedAt,
};

export async function findActiveJob(db: D1Database, installationId: string) {
  const rows = await createDrizzle(db)
    .select(jobColumns)
    .from(deployJobs)
    .where(eq(deployJobs.installationId, installationId))
    .all();
  return (
    rows.find((row) =>
      (ACTIVE_JOB_STATUSES as readonly string[]).includes(row.status),
    ) ?? null
  );
}

export async function getJobById(db: D1Database, id: string) {
  return (
    (await createDrizzle(db)
      .select(jobColumns)
      .from(deployJobs)
      .where(eq(deployJobs.id, id))
      .get()) ?? null
  );
}

export async function insertJob(
  db: D1Database,
  row: {
    id: string;
    installationId: string;
    kind: string;
    status: string;
    step: string;
    targetVersion: string;
    targetDigest: string;
    attemptCount: number;
    createdResources: string;
    createdAt: string;
    updatedAt: string;
  },
) {
  await createDrizzle(db).insert(deployJobs).values(row).run();
}

export async function listJobsForInstallation(
  db: D1Database,
  installationId: string,
) {
  return createDrizzle(db)
    .select(jobColumns)
    .from(deployJobs)
    .where(eq(deployJobs.installationId, installationId))
    .orderBy(desc(deployJobs.updatedAt))
    .all();
}

export const LEASE_MS = 60_000;
// 完整首次安裝約 18 步 + Access 拆步 + ledger + 每個 migration 一次
// invocation，再保留暫時性失敗重試額度。
export const MAX_JOB_ATTEMPTS = 200;

export async function acquireJobLease(
  db: D1Database,
  jobId: string,
  leaseOwner: string,
  now: Date,
) {
  const leaseUntil = new Date(now.getTime() + LEASE_MS).toISOString();
  const nowIso = now.toISOString();
  const result = await createDrizzle(db)
    .update(deployJobs)
    .set({
      leaseOwner,
      leaseUntil,
      status: "running",
      attemptCount: sql`${deployJobs.attemptCount} + 1`,
      updatedAt: nowIso,
    })
    .where(
      and(
        eq(deployJobs.id, jobId),
        or(
          eq(deployJobs.status, "queued"),
          and(
            eq(deployJobs.status, "running"),
            or(
              isNull(deployJobs.leaseUntil),
              lt(deployJobs.leaseUntil, nowIso),
            ),
          ),
        ),
      ),
    )
    .run();
  return (result.meta.changes ?? 0) > 0;
}

export async function updateJob(
  db: D1Database,
  jobId: string,
  patch: {
    status?: string;
    step?: string;
    errorCode?: string | null;
    createdResources?: string;
    encryptedSecrets?: string | null;
    migrationName?: string | null;
    leaseOwner?: string | null;
    leaseUntil?: string | null;
    updatedAt: string;
  },
) {
  await createDrizzle(db)
    .update(deployJobs)
    .set(patch)
    .where(eq(deployJobs.id, jobId))
    .run();
}

export async function updateLeasedJob(
  db: D1Database,
  jobId: string,
  leaseOwner: string,
  patch: {
    status?: string;
    step?: string;
    errorCode?: string | null;
    createdResources?: string;
    encryptedSecrets?: string | null;
    migrationName?: string | null;
    leaseOwner?: string | null;
    leaseUntil?: string | null;
    updatedAt: string;
  },
) {
  const result = await createDrizzle(db)
    .update(deployJobs)
    .set(patch)
    .where(and(eq(deployJobs.id, jobId), eq(deployJobs.leaseOwner, leaseOwner)))
    .run();
  return (result.meta.changes ?? 0) > 0;
}
