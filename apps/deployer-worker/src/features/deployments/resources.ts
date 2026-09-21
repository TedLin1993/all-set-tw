export type CreatedResources = {
  workersSubdomain?: string;
  teamDomain?: string;
  d1DatabaseName?: string;
  d1CreateAttempted?: boolean;
  d1DatabaseId?: string;
  queueName?: string;
  queueCreateAttempted?: boolean;
  queueId?: string;
  bootstrapDeployed?: boolean;
  workersDevEnabled?: boolean;
  otpIdpId?: string;
  accessAppId?: string;
  accessPolicyId?: string;
  policyAud?: string;
  workerScriptId?: string;
  keysGenerated?: boolean;
  accessSecretsWritten?: boolean;
  appSecretsWritten?: boolean;
  migrations?: string[];
  ledgerReady?: boolean;
  workerDeployed?: boolean;
  queueConsumerId?: string;
  cronAttached?: boolean;
  verified?: boolean;
  releaseVersion?: string;
  releaseDigest?: string;
  restoreBookmark?: string;
  maintenanceEntered?: boolean;
  cronDisabled?: boolean;
  inflightClear?: boolean;
  secretsVerified?: boolean;
  installedVersion?: string;
  installedDigest?: string;
  assetUploadBuckets?: string[][];
  assetUploadIndex?: number;
  assetUploadComplete?: boolean;
  pendingMigrations?: string[];
};

export type JobSecrets = {
  configEncryptionKey?: string;
  vapidPublicKey?: string;
  vapidPrivateKey?: string;
  assetJwt?: string;
};

export function parseCreatedResources(value: string): CreatedResources {
  try {
    const parsed = JSON.parse(value) as CreatedResources;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
