export type AuthStatus = {
  oauthConfigured: boolean;
  stage: {
    oauthLiveVerified: boolean;
    writesEnabled: boolean;
  };
};

export type AuthSession = {
  sub: string;
  selectedAccountId: string | null;
  tokenExpiresAt: string;
  csrfToken: string;
  expiresAt: string;
};

export type CloudflareAccount = {
  id: string;
  name: string;
};

export type PrecheckItem = {
  id:
    | "workers_subdomain"
    | "access_organization"
    | "worker_name"
    | "d1_name"
    | "queue_name";
  ok: boolean;
  blocking: boolean;
  dashboardUrl?: string;
};

export type PrecheckResult = {
  accountId: string;
  workerName: string;
  ready: boolean;
  checks: PrecheckItem[];
};

export type CurrentRelease = {
  version: string;
  digest: string;
  source: "r2" | "local_fixture";
};

export type Installation = {
  id: string;
  accountId: string;
  workerName: string;
  allowedEmail: string;
  status: string;
  targetVersion: string | null;
  targetDigest: string | null;
};

export type DeployJob = {
  id: string;
  installationId: string;
  kind: string;
  status: string;
  step: string;
  targetVersion: string;
  targetDigest: string;
  errorCode: string | null;
  createdResources: Record<string, unknown>;
};

export type UpdatePlan = {
  available: boolean;
  reason:
    | "INSTALL_NOT_READY"
    | "RELEASE_UNAVAILABLE"
    | "UP_TO_DATE"
    | "UPGRADE_NOT_ALLOWED"
    | null;
  currentVersion: string | null;
  currentDigest: string | null;
  targetVersion: string | null;
  targetDigest: string | null;
  pendingMigrations: string[];
  interruption: { pauseSync: boolean; hasMigrations: boolean };
};
