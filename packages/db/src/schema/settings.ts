import { sqliteTable, text, primaryKey, unique } from "drizzle-orm/sqlite-core";

// SQL migrations remain authoritative for schema shape and constraints.

export const connectorSettings = sqliteTable(
  "connector_settings",
  {
    id: text("id").notNull(),
    connectorId: text("connector_id").notNull(),
    encryptedConfig: text("encrypted_config").notNull(),
    syncCursor: text("sync_cursor"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    publicConfig: text("public_config"),
  },
  (table) => [
    primaryKey({ columns: [table.id] }),
    unique().on(table.connectorId),
  ],
);
