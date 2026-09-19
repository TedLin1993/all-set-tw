import { createApiClient, setCsrfToken } from "@/shared/api/client";
import type {
  AuthSession,
  AuthStatus,
  CloudflareAccount,
  CurrentRelease,
  DeployJob,
  Installation,
  PrecheckResult,
  UpdatePlan,
} from "./types";

const api = createApiClient();

export function fetchAuthStatus() {
  return api.get<AuthStatus>("/api/auth/status");
}

export async function fetchSession() {
  const session = await api.get<AuthSession>("/api/auth/me");
  setCsrfToken(session.csrfToken);
  return session;
}

export function fetchAccounts() {
  return api.get<{ accounts: CloudflareAccount[] }>("/api/auth/accounts");
}

export function selectAccount(accountId: string) {
  return api.post<{ selectedAccountId: string }>("/api/auth/select-account", {
    accountId,
  });
}

export function runPrecheck(input: { accountId: string; workerName: string }) {
  return api.post<PrecheckResult>("/api/precheck", input);
}

export function fetchCurrentRelease() {
  return api.get<CurrentRelease>("/api/releases/current");
}

export function fetchInstallations() {
  return api.get<{ installations: Installation[] }>("/api/installations");
}

export function fetchInstallation(installationId: string) {
  return api.get<{ installation: Installation; job: DeployJob | null }>(
    `/api/installations/${installationId}`,
  );
}

export function createInstallation(input: {
  accountId: string;
  workerName: string;
  allowedEmail: string;
  targetVersion: string;
  targetDigest: string;
}) {
  return api.post<{
    installation: Installation;
    job: DeployJob;
    reused: boolean;
    writesEnabled: boolean;
  }>("/api/installations", input);
}

export function fetchInstallationJob(installationId: string, jobId: string) {
  return api.get<{ installation: Installation; job: DeployJob }>(
    `/api/installations/${installationId}/jobs/${jobId}`,
  );
}

export function resumeInstallation(installationId: string) {
  return api.post<{ installation: Installation; job: DeployJob }>(
    `/api/installations/${installationId}/jobs`,
  );
}

export function fetchUpdatePlan(installationId: string) {
  return api.get<UpdatePlan>(
    `/api/installations/${installationId}/update-plan`,
  );
}

export function startUpdate(
  installationId: string,
  input: { targetVersion: string; targetDigest: string },
) {
  return api.post<{
    installation: Installation;
    job: DeployJob;
    writesEnabled: boolean;
  }>(`/api/installations/${installationId}/updates`, input);
}
