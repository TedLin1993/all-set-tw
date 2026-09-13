import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  check,
} from "drizzle-orm/sqlite-core";

// SQL migrations remain authoritative for schema shape and constraints.

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: text("id").notNull(),
    encryptedSubscription: text("encrypted_subscription").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    lastSuccessAt: text("last_success_at"),
    consecutiveFailures: integer("consecutive_failures")
      .notNull()
      .default(sql`0`),
  },
  (table) => [primaryKey({ columns: [table.id] })],
);

export const notificationPreferences = sqliteTable(
  "notification_preferences",
  {
    id: text("id").notNull(),
    notifySuccess: integer("notify_success")
      .notNull()
      .default(sql`0`),
    notifyFailed: integer("notify_failed")
      .notNull()
      .default(sql`1`),
    notifyNeedsUserAction: integer("notify_needs_user_action")
      .notNull()
      .default(sql`1`),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    check("notification_preferences_check_1", sql`id = 'default'`),
  ],
);
