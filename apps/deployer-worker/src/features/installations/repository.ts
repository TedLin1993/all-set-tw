import { and, desc, eq } from "drizzle-orm";
import { createDrizzle } from "../../db/client";
import { installations } from "../../db/schema";

export type InstallationRow = {
  id: string;
  ownerSub: string;
  accountId: string;
  workerName: string;
  allowedEmail: string;
  status: string;
  targetVersion: string | null;
  targetDigest: string | null;
  workerScriptId: string | null;
  d1DatabaseId: string | null;
  queueId: string | null;
  accessAppId: string | null;
  createdAt: string;
  updatedAt: string;
};

export const installationColumns = {
  id: installations.id,
  ownerSub: installations.ownerSub,
  accountId: installations.accountId,
  workerName: installations.workerName,
  allowedEmail: installations.allowedEmail,
  status: installations.status,
  targetVersion: installations.targetVersion,
  targetDigest: installations.targetDigest,
  workerScriptId: installations.workerScriptId,
  d1DatabaseId: installations.d1DatabaseId,
  queueId: installations.queueId,
  accessAppId: installations.accessAppId,
  createdAt: installations.createdAt,
  updatedAt: installations.updatedAt,
};

export async function insertInstallation(db: D1Database, row: InstallationRow) {
  await createDrizzle(db)
    .insert(installations)
    .values(row)
    .onConflictDoNothing({
      target: [installations.accountId, installations.workerName],
    })
    .run();
}

export async function getInstallationByAccountWorker(
  db: D1Database,
  accountId: string,
  workerName: string,
) {
  return (
    (await createDrizzle(db)
      .select(installationColumns)
      .from(installations)
      .where(
        and(
          eq(installations.accountId, accountId),
          eq(installations.workerName, workerName),
        ),
      )
      .get()) ?? null
  );
}

export async function getInstallationById(db: D1Database, id: string) {
  return (
    (await createDrizzle(db)
      .select(installationColumns)
      .from(installations)
      .where(eq(installations.id, id))
      .get()) ?? null
  );
}

export async function listInstallationsForOwnerAccount(
  db: D1Database,
  ownerSub: string,
  accountId: string,
) {
  return createDrizzle(db)
    .select(installationColumns)
    .from(installations)
    .where(
      and(
        eq(installations.ownerSub, ownerSub),
        eq(installations.accountId, accountId),
      ),
    )
    .orderBy(desc(installations.updatedAt))
    .all();
}

export async function updateInstallationStatus(
  db: D1Database,
  id: string,
  status: string,
  now: string,
) {
  await updateInstallation(db, id, { status, updatedAt: now });
}

export async function updateInstallation(
  db: D1Database,
  id: string,
  patch: {
    status?: string;
    allowedEmail?: string;
    targetVersion?: string | null;
    targetDigest?: string | null;
    workerScriptId?: string | null;
    d1DatabaseId?: string | null;
    queueId?: string | null;
    accessAppId?: string | null;
    updatedAt: string;
  },
) {
  await createDrizzle(db)
    .update(installations)
    .set(patch)
    .where(eq(installations.id, id))
    .run();
}
