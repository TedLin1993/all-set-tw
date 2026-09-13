import { sqliteTable, text, primaryKey, unique } from "drizzle-orm/sqlite-core";

// Table-level primary keys preserve SQLite's existing nullable TEXT primary keys.
// SQL migrations remain authoritative; do not add NOT NULL through ORM adoption.

export const connectorSettings = sqliteTable(
  "connector_settings",
  {
    id: text("id"),
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
