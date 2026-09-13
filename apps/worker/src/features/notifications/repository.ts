import {
  createDrizzle,
  notificationPreferences,
  pushSubscriptions,
} from "@taiwan-fin-hub/db";
import type {
  NotificationPreferences,
  PushSubscriptionInput,
} from "@taiwan-fin-hub/core";
import { asc, count, eq, sql } from "drizzle-orm";

export type PushSubscriptionRow = {
  id: string;
  encrypted_subscription: string;
  created_at: string;
  updated_at: string;
  last_success_at: string | null;
  consecutive_failures: number;
};

const DEFAULT_PREFERENCES: NotificationPreferences = {
  success: false,
  failed: true,
  needsUserAction: true,
};

export async function listPushSubscriptions(db: D1Database) {
  const rows = await createDrizzle(db)
    .select({
      id: pushSubscriptions.id,
      encryptedSubscription: pushSubscriptions.encryptedSubscription,
      createdAt: pushSubscriptions.createdAt,
      updatedAt: pushSubscriptions.updatedAt,
      lastSuccessAt: pushSubscriptions.lastSuccessAt,
      consecutiveFailures: pushSubscriptions.consecutiveFailures,
    })
    .from(pushSubscriptions)
    .orderBy(asc(pushSubscriptions.createdAt), asc(pushSubscriptions.id))
    .all();
  return rows.map(
    (row) =>
      ({
        id: row.id,
        encrypted_subscription: row.encryptedSubscription,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
        last_success_at: row.lastSuccessAt,
        consecutive_failures: row.consecutiveFailures,
      }) satisfies PushSubscriptionRow,
  );
}

export async function upsertPushSubscription(
  db: D1Database,
  input: {
    id: string;
    encryptedSubscription: string;
    now: string;
  },
) {
  await createDrizzle(db)
    .insert(pushSubscriptions)
    .values({
      id: input.id,
      encryptedSubscription: input.encryptedSubscription,
      createdAt: input.now,
      updatedAt: input.now,
      lastSuccessAt: null,
      consecutiveFailures: 0,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.id,
      set: {
        encryptedSubscription: input.encryptedSubscription,
        updatedAt: input.now,
        consecutiveFailures: 0,
      },
    });
}

export async function removePushSubscription(db: D1Database, id: string) {
  await createDrizzle(db)
    .delete(pushSubscriptions)
    .where(eq(pushSubscriptions.id, id));
}

export async function markPushSuccess(db: D1Database, id: string, now: string) {
  await createDrizzle(db)
    .update(pushSubscriptions)
    .set({
      lastSuccessAt: now,
      consecutiveFailures: 0,
      updatedAt: now,
    })
    .where(eq(pushSubscriptions.id, id));
}

export async function markPushFailure(db: D1Database, id: string, now: string) {
  await createDrizzle(db)
    .update(pushSubscriptions)
    .set({
      consecutiveFailures: sql`${pushSubscriptions.consecutiveFailures} + 1`,
      updatedAt: now,
    })
    .where(eq(pushSubscriptions.id, id));
}

export async function getNotificationPreferences(db: D1Database) {
  const row = await createDrizzle(db)
    .select({
      success: notificationPreferences.notifySuccess,
      failed: notificationPreferences.notifyFailed,
      needsUserAction: notificationPreferences.notifyNeedsUserAction,
    })
    .from(notificationPreferences)
    .where(eq(notificationPreferences.id, "default"))
    .get();

  if (!row) return DEFAULT_PREFERENCES;
  return {
    success: Boolean(row.success),
    failed: Boolean(row.failed),
    needsUserAction: Boolean(row.needsUserAction),
  } satisfies NotificationPreferences;
}

export async function saveNotificationPreferences(
  db: D1Database,
  preferences: NotificationPreferences,
  now: string,
) {
  await createDrizzle(db)
    .insert(notificationPreferences)
    .values({
      id: "default",
      notifySuccess: preferences.success ? 1 : 0,
      notifyFailed: preferences.failed ? 1 : 0,
      notifyNeedsUserAction: preferences.needsUserAction ? 1 : 0,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: notificationPreferences.id,
      set: {
        notifySuccess: preferences.success ? 1 : 0,
        notifyFailed: preferences.failed ? 1 : 0,
        notifyNeedsUserAction: preferences.needsUserAction ? 1 : 0,
        updatedAt: now,
      },
    });
}

export async function countPushSubscriptions(db: D1Database) {
  const row = await createDrizzle(db)
    .select({ count: count() })
    .from(pushSubscriptions)
    .get();
  return row?.count ?? 0;
}

export function normalizePushSubscription(input: PushSubscriptionInput) {
  return {
    endpoint: input.endpoint,
    expirationTime: input.expirationTime ?? null,
    keys: {
      p256dh: input.keys.p256dh,
      auth: input.keys.auth,
    },
  } satisfies PushSubscriptionInput;
}
