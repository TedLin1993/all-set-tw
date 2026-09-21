import {
  index,
  integer,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";

export const oauthStates = sqliteTable("oauth_states", {
  state: text("state").primaryKey(),
  codeVerifier: text("code_verifier").notNull(),
  redirectPath: text("redirect_path").notNull(),
  createdAt: text("created_at").notNull(),
  expiresAt: text("expires_at").notNull(),
});

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    oauthSub: text("oauth_sub").notNull(),
    selectedAccountId: text("selected_account_id"),
    encryptedAccessToken: text("encrypted_access_token").notNull(),
    tokenExpiresAt: text("token_expires_at").notNull(),
    csrfToken: text("csrf_token").notNull(),
    createdAt: text("created_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    revokedAt: text("revoked_at"),
  },
  (table) => [
    index("sessions_oauth_sub_idx").on(table.oauthSub),
    index("sessions_expires_at_idx").on(table.expiresAt),
  ],
);

export const installations = sqliteTable(
  "installations",
  {
    id: text("id").primaryKey(),
    ownerSub: text("owner_sub").notNull(),
    accountId: text("account_id").notNull(),
    workerName: text("worker_name").notNull(),
    allowedEmail: text("allowed_email").notNull(),
    status: text("status").notNull(),
    targetVersion: text("target_version"),
    targetDigest: text("target_digest"),
    workerScriptId: text("worker_script_id"),
    d1DatabaseId: text("d1_database_id"),
    queueId: text("queue_id"),
    accessAppId: text("access_app_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    unique().on(table.accountId, table.workerName),
    index("installations_owner_account_idx").on(
      table.ownerSub,
      table.accountId,
    ),
  ],
);

export const deployJobs = sqliteTable(
  "deploy_jobs",
  {
    id: text("id").primaryKey(),
    installationId: text("installation_id").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    step: text("step").notNull(),
    targetVersion: text("target_version").notNull(),
    targetDigest: text("target_digest").notNull(),
    leaseOwner: text("lease_owner"),
    leaseUntil: text("lease_until"),
    attemptCount: integer("attempt_count").notNull(),
    createdResources: text("created_resources").notNull(),
    encryptedSecrets: text("encrypted_secrets"),
    errorCode: text("error_code"),
    migrationName: text("migration_name"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (table) => [
    index("deploy_jobs_installation_idx").on(table.installationId),
    index("deploy_jobs_status_idx").on(table.status),
  ],
);
