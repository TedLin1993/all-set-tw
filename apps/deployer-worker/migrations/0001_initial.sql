CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY NOT NULL,
  code_verifier TEXT NOT NULL,
  redirect_path TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY NOT NULL,
  oauth_sub TEXT NOT NULL,
  selected_account_id TEXT,
  encrypted_access_token TEXT NOT NULL,
  token_expires_at TEXT NOT NULL,
  csrf_token TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

CREATE INDEX sessions_oauth_sub_idx ON sessions (oauth_sub);
CREATE INDEX sessions_expires_at_idx ON sessions (expires_at);

CREATE TABLE installations (
  id TEXT PRIMARY KEY NOT NULL,
  owner_sub TEXT NOT NULL,
  account_id TEXT NOT NULL,
  worker_name TEXT NOT NULL,
  allowed_email TEXT NOT NULL,
  status TEXT NOT NULL,
  target_version TEXT,
  target_digest TEXT,
  worker_script_id TEXT,
  d1_database_id TEXT,
  queue_id TEXT,
  access_app_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, worker_name)
);

CREATE INDEX installations_owner_account_idx ON installations (owner_sub, account_id);

CREATE TABLE deploy_jobs (
  id TEXT PRIMARY KEY NOT NULL,
  installation_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  step TEXT NOT NULL,
  target_version TEXT NOT NULL,
  target_digest TEXT NOT NULL,
  lease_owner TEXT,
  lease_until TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  created_resources TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  migration_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (installation_id) REFERENCES installations (id)
);

CREATE INDEX deploy_jobs_installation_idx ON deploy_jobs (installation_id);
CREATE INDEX deploy_jobs_status_idx ON deploy_jobs (status);
