export const CLOUDFLARE_API_BASE = "https://api.cloudflare.com/client/v4";

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

export class CloudflareApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code:
      | "TOKEN_EXPIRED"
      | "FORBIDDEN"
      | "NOT_FOUND"
      | "CONFLICT"
      | "RATE_LIMITED"
      | "UPSTREAM",
  ) {
    super("Cloudflare API request failed.");
    this.name = "CloudflareApiError";
  }
}

function mapStatus(status: number): CloudflareApiError["code"] {
  if (status === 401) return "TOKEN_EXPIRED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  if (status === 429) return "RATE_LIMITED";
  return "UPSTREAM";
}

export async function cfRequest(
  accessToken: string,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  if (
    init.body !== undefined &&
    typeof init.body === "string" &&
    !headers.has("Content-Type")
  ) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`${CLOUDFLARE_API_BASE}${path}`, {
    ...init,
    headers,
  });
  if (!response.ok)
    throw new CloudflareApiError(response.status, mapStatus(response.status));
  if (response.status === 204) return { success: true, result: undefined };
  const text = await response.text();
  if (!text) return { success: true, result: undefined };
  return JSON.parse(text) as {
    success?: boolean;
    result?: unknown;
    result_info?: {
      page?: number;
      per_page?: number;
      count?: number;
      total_count?: number;
      total_pages?: number;
    };
  };
}

async function cfFetch(accessToken: string, path: string) {
  return cfRequest(accessToken, path);
}

async function cfFetchAllPages(accessToken: string, path: string) {
  const items: unknown[] = [];
  let page = 1;
  const perPage = 50;
  const maxPages = 100;
  for (;;) {
    const separator = path.includes("?") ? "&" : "?";
    const body = await cfRequest(
      accessToken,
      `${path}${separator}page=${page}&per_page=${perPage}`,
    );
    const rows = Array.isArray(body.result) ? body.result : [];
    items.push(...rows);
    const info = body.result_info;
    const pageSize = info?.per_page ?? perPage;
    const totalPages =
      info?.total_pages ??
      (info?.total_count != null
        ? Math.ceil(info.total_count / pageSize)
        : undefined);
    if (totalPages != null) {
      if (page >= totalPages) break;
    } else if (rows.length < pageSize) {
      break;
    }
    page += 1;
    if (page > maxPages) break;
  }
  return items;
}

export async function listAuthorizedAccounts(
  accessToken: string,
): Promise<CloudflareAccount[]> {
  const rows = await cfFetchAllPages(accessToken, "/memberships");
  const accounts: CloudflareAccount[] = [];
  for (const row of rows) {
    const account = (row as { account?: { id?: string; name?: string } })
      .account;
    if (account?.id) {
      accounts.push({ id: account.id, name: account.name ?? account.id });
    }
  }
  return accounts;
}

export function workersDashboardUrl(accountId: string) {
  return `https://dash.cloudflare.com/${accountId}/workers-and-pages`;
}

export function d1DashboardUrl(accountId: string) {
  return `https://dash.cloudflare.com/${accountId}/workers/d1`;
}

export function queuesDashboardUrl(accountId: string) {
  return `https://dash.cloudflare.com/${accountId}/workers/queues`;
}

export function zeroTrustDashboardUrl() {
  return "https://one.dash.cloudflare.com/";
}

export function plannedD1Name(workerName: string) {
  return workerName;
}

export function plannedQueueName(workerName: string) {
  return `${workerName}-sync`;
}

export async function readWorkersSubdomain(
  accessToken: string,
  accountId: string,
) {
  try {
    const body = await cfFetch(
      accessToken,
      `/accounts/${accountId}/workers/subdomain`,
    );
    const result = body.result as { subdomain?: string } | undefined;
    return result?.subdomain ?? null;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.code === "NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

export async function readAccessOrganization(
  accessToken: string,
  accountId: string,
) {
  try {
    const body = await cfFetch(
      accessToken,
      `/accounts/${accountId}/access/organizations`,
    );
    const result = body.result as { auth_domain?: string } | undefined;
    return result?.auth_domain ?? null;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.code === "NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

export async function workerScriptExists(
  accessToken: string,
  accountId: string,
  workerName: string,
) {
  try {
    await cfFetch(
      accessToken,
      `/accounts/${accountId}/workers/scripts/${workerName}`,
    );
    return true;
  } catch (error) {
    if (error instanceof CloudflareApiError && error.code === "NOT_FOUND") {
      return false;
    }
    throw error;
  }
}

export async function findD1DatabaseByName(
  accessToken: string,
  accountId: string,
  name: string,
) {
  const rows = await cfFetchAllPages(
    accessToken,
    `/accounts/${accountId}/d1/database?name=${encodeURIComponent(name)}`,
  );
  for (const row of rows) {
    const item = row as { uuid?: string; id?: string; name?: string };
    if (item.name === name && (item.uuid || item.id)) {
      return { id: item.uuid ?? item.id!, name: item.name };
    }
  }
  return null;
}

export async function findQueueByName(
  accessToken: string,
  accountId: string,
  name: string,
) {
  const rows = await cfFetchAllPages(
    accessToken,
    `/accounts/${accountId}/queues`,
  );
  for (const row of rows) {
    const item = row as {
      queue_id?: string;
      queue_name?: string;
      id?: string;
      name?: string;
    };
    const queueName = item.queue_name ?? item.name;
    const queueId = item.queue_id ?? item.id;
    if (queueName === name && queueId) {
      return { id: queueId, name: queueName };
    }
  }
  return null;
}

export async function runAccountPrecheck(input: {
  accessToken: string;
  accountId: string;
  workerName: string;
}): Promise<{
  ready: boolean;
  checks: PrecheckItem[];
  workersSubdomain: string | null;
  teamDomain: string | null;
}> {
  const d1Name = plannedD1Name(input.workerName);
  const queueName = plannedQueueName(input.workerName);
  const [subdomain, organization, workerExists, existingD1, existingQueue] =
    await Promise.all([
      readWorkersSubdomain(input.accessToken, input.accountId),
      readAccessOrganization(input.accessToken, input.accountId),
      workerScriptExists(input.accessToken, input.accountId, input.workerName),
      findD1DatabaseByName(input.accessToken, input.accountId, d1Name),
      findQueueByName(input.accessToken, input.accountId, queueName),
    ]);
  const checks: PrecheckItem[] = [
    {
      id: "workers_subdomain",
      ok: Boolean(subdomain),
      blocking: true,
      dashboardUrl: workersDashboardUrl(input.accountId),
    },
    {
      id: "access_organization",
      ok: Boolean(organization),
      blocking: true,
      dashboardUrl: zeroTrustDashboardUrl(),
    },
    {
      id: "worker_name",
      ok: !workerExists,
      blocking: true,
      dashboardUrl: workersDashboardUrl(input.accountId),
    },
    {
      id: "d1_name",
      ok: existingD1 === null,
      blocking: true,
      dashboardUrl: d1DashboardUrl(input.accountId),
    },
    {
      id: "queue_name",
      ok: existingQueue === null,
      blocking: true,
      dashboardUrl: queuesDashboardUrl(input.accountId),
    },
  ];
  return {
    ready: checks.every((check) => check.ok),
    checks,
    workersSubdomain: subdomain,
    teamDomain: organization,
  };
}

export async function runUpdatePrecheck(input: {
  accessToken: string;
  accountId: string;
  workerName: string;
  d1DatabaseId: string | null;
  queueId: string | null;
}): Promise<{
  ready: boolean;
  checks: PrecheckItem[];
  workersSubdomain: string | null;
  teamDomain: string | null;
  d1DatabaseId: string | null;
  queueId: string | null;
}> {
  const d1Name = plannedD1Name(input.workerName);
  const queueName = plannedQueueName(input.workerName);
  const [subdomain, organization, workerExists, existingD1, existingQueue] =
    await Promise.all([
      readWorkersSubdomain(input.accessToken, input.accountId),
      readAccessOrganization(input.accessToken, input.accountId),
      workerScriptExists(input.accessToken, input.accountId, input.workerName),
      findD1DatabaseByName(input.accessToken, input.accountId, d1Name),
      findQueueByName(input.accessToken, input.accountId, queueName),
    ]);
  const d1Matches =
    existingD1 !== null &&
    (input.d1DatabaseId === null || existingD1.id === input.d1DatabaseId);
  const queueMatches =
    existingQueue !== null &&
    (input.queueId === null || existingQueue.id === input.queueId);
  const checks: PrecheckItem[] = [
    {
      id: "workers_subdomain",
      ok: Boolean(subdomain),
      blocking: true,
      dashboardUrl: workersDashboardUrl(input.accountId),
    },
    {
      id: "access_organization",
      ok: Boolean(organization),
      blocking: true,
      dashboardUrl: zeroTrustDashboardUrl(),
    },
    {
      id: "worker_name",
      ok: workerExists,
      blocking: true,
      dashboardUrl: workersDashboardUrl(input.accountId),
    },
    {
      id: "d1_name",
      ok: d1Matches,
      blocking: true,
      dashboardUrl: d1DashboardUrl(input.accountId),
    },
    {
      id: "queue_name",
      ok: queueMatches,
      blocking: true,
      dashboardUrl: queuesDashboardUrl(input.accountId),
    },
  ];
  return {
    ready: checks.every((check) => check.ok),
    checks,
    workersSubdomain: subdomain,
    teamDomain: organization,
    d1DatabaseId: existingD1?.id ?? null,
    queueId: existingQueue?.id ?? null,
  };
}
