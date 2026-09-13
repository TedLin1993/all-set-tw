export { createDrizzle } from "./client";
export { sanitizeDatabaseError } from "./errors";
export type { AppDatabase } from "./client";
export * from "./schema";

import { eq, sql } from "drizzle-orm";
import { createDrizzle } from "./client";
import { connectorSettings } from "./schema/settings";
import { sanitizeDatabaseError } from "./errors";

export type ConnectorSettingsRow = NonNullable<
  Awaited<ReturnType<typeof getConnectorSettings>>
>;

export async function getConnectorSettings(
  db: D1Database,
  connectorId: string,
) {
  return (
    (await createDrizzle(db)
      .select({
        id: sql<string>`${connectorSettings.id}`,
        connector_id: connectorSettings.connectorId,
        encrypted_config: connectorSettings.encryptedConfig,
        public_config: connectorSettings.publicConfig,
        sync_cursor: connectorSettings.syncCursor,
        created_at: connectorSettings.createdAt,
        updated_at: connectorSettings.updatedAt,
      })
      .from(connectorSettings)
      .where(eq(connectorSettings.connectorId, connectorId))
      .limit(1)
      .get()
      .catch(rethrowSettingsError)) ?? null
  );
}

export async function upsertConnectorSettings(
  db: D1Database,
  input: {
    id: string;
    connectorId: string;
    encryptedConfig: string;
    publicConfig: string | null;
    now: string;
  },
) {
  await createDrizzle(db)
    .insert(connectorSettings)
    .values({
      id: input.id,
      connectorId: input.connectorId,
      encryptedConfig: input.encryptedConfig,
      publicConfig: input.publicConfig,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: connectorSettings.connectorId,
      set: {
        encryptedConfig: input.encryptedConfig,
        publicConfig: input.publicConfig,
        updatedAt: input.now,
      },
    })
    .run()
    .catch(rethrowSettingsError);
}

export async function updateConnectorPublicConfig(
  db: D1Database,
  connectorId: string,
  publicConfig: string,
  now: string,
) {
  await createDrizzle(db)
    .update(connectorSettings)
    .set({ publicConfig, updatedAt: now })
    .where(eq(connectorSettings.connectorId, connectorId))
    .run()
    .catch(rethrowSettingsError);
}

export async function updateConnectorCursor(
  db: D1Database,
  connectorId: string,
  cursor: string,
  now: string,
) {
  await createDrizzle(db)
    .update(connectorSettings)
    .set({ syncCursor: cursor, updatedAt: now })
    .where(eq(connectorSettings.connectorId, connectorId))
    .run()
    .catch(rethrowSettingsError);
}

export async function clearConnectorCursor(
  db: D1Database,
  connectorId: string,
  now: string,
) {
  await createDrizzle(db)
    .update(connectorSettings)
    .set({ syncCursor: null, updatedAt: now })
    .where(eq(connectorSettings.connectorId, connectorId))
    .run()
    .catch(rethrowSettingsError);
}

// Settings are also used by Queue/sync callers that persist error messages.
// Remove ORM-bound configuration/cursor values before an error leaves this boundary.
function rethrowSettingsError(error: unknown): never {
  throw sanitizeDatabaseError(error);
}

export {
  syncJobSelection,
  acquireSyncJobLock,
  completeSyncJob,
  failSyncJob,
  findNextDueSyncJob,
  markManualSyncFailure,
  markManualSyncSuccess,
  nextSyncRunAt,
  releaseSyncJobLock,
  renewSyncJobLock,
} from "./sync-jobs";
export type {
  SyncJobRow,
  SyncScheduleMode,
  SyncStatus,
  SyncTrigger,
} from "./sync-jobs";
