import {
  cfRequest,
  CloudflareApiError,
  CLOUDFLARE_API_BASE,
} from "./cloudflare";
import { bytesToArrayBuffer } from "./crypto";

export const BOOTSTRAP_WORKER_MODULE = `export default {
  async fetch() {
    return new Response("Installation is not ready.", {
      status: 403,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },
};
`;

export async function createD1Database(
  accessToken: string,
  accountId: string,
  name: string,
) {
  const body = await cfRequest(
    accessToken,
    `/accounts/${accountId}/d1/database`,
    { method: "POST", body: JSON.stringify({ name }) },
  );
  const result = body.result as { uuid?: string; id?: string; name?: string };
  const id = result?.uuid ?? result?.id;
  if (!id) throw new Error("D1 create response missing id.");
  return { id, name: result.name ?? name };
}

export async function createQueue(
  accessToken: string,
  accountId: string,
  name: string,
) {
  const body = await cfRequest(accessToken, `/accounts/${accountId}/queues`, {
    method: "POST",
    body: JSON.stringify({ queue_name: name }),
  });
  const result = body.result as {
    queue_id?: string;
    id?: string;
    queue_name?: string;
  };
  const id = result?.queue_id ?? result?.id;
  if (!id) throw new Error("Queue create response missing id.");
  return { id, name: result.queue_name ?? name };
}

export async function putWorkerScript(input: {
  accessToken: string;
  accountId: string;
  workerName: string;
  mainModule: string;
  source: string;
  modules?: Array<{
    name: string;
    contentType: string;
    bytes: Uint8Array | string;
  }>;
  metadata: Record<string, unknown>;
}) {
  const form = new FormData();
  form.set("metadata", JSON.stringify(input.metadata));
  const modules = input.modules?.length
    ? input.modules
    : [
        {
          name: input.mainModule,
          contentType: "application/javascript+module",
          bytes: input.source,
        },
      ];
  for (const module of modules) {
    const bytes =
      typeof module.bytes === "string"
        ? new TextEncoder().encode(module.bytes)
        : module.bytes;
    form.set(
      module.name,
      new Blob([bytesToArrayBuffer(bytes)], { type: module.contentType }),
      module.name,
    );
  }
  const body = await cfRequest(
    input.accessToken,
    `/accounts/${input.accountId}/workers/scripts/${input.workerName}`,
    { method: "PUT", body: form },
  );
  const result = body.result as { id?: string; tag?: string; etag?: string };
  const tag = result?.tag ?? result?.etag ?? result?.id;
  if (!tag) throw new Error("Worker upload response missing tag.");
  return { tag };
}

export async function enableWorkersDev(
  accessToken: string,
  accountId: string,
  workerName: string,
) {
  await cfRequest(
    accessToken,
    `/accounts/${accountId}/workers/scripts/${workerName}/subdomain`,
    {
      method: "POST",
      body: JSON.stringify({ enabled: true, previews_enabled: false }),
    },
  );
}

export async function listIdentityProviders(
  accessToken: string,
  accountId: string,
) {
  const body = await cfRequest(
    accessToken,
    `/accounts/${accountId}/access/identity_providers`,
  );
  const rows = Array.isArray(body.result) ? body.result : [];
  return rows as Array<{ id?: string; type?: string; name?: string }>;
}

export async function createOtpIdentityProvider(
  accessToken: string,
  accountId: string,
) {
  const body = await cfRequest(
    accessToken,
    `/accounts/${accountId}/access/identity_providers`,
    {
      method: "POST",
      body: JSON.stringify({ type: "onetimepin", name: "One-time PIN" }),
    },
  );
  const result = body.result as { id?: string };
  if (!result?.id) throw new Error("OTP IdP create response missing id.");
  return result.id;
}

export async function createAccessApplication(input: {
  accessToken: string;
  accountId: string;
  name: string;
  workerId: string;
  allowedIdpId?: string;
}) {
  const payload: Record<string, unknown> = {
    name: input.name,
    type: "self_hosted",
    destinations: [{ type: "worker", worker_id: input.workerId }],
    session_duration: "24h",
  };
  if (input.allowedIdpId) payload.allowed_idps = [input.allowedIdpId];
  const body = await cfRequest(
    input.accessToken,
    `/accounts/${input.accountId}/access/apps`,
    { method: "POST", body: JSON.stringify(payload) },
  );
  const result = body.result as { id?: string; aud?: string };
  if (!result?.id) throw new Error("Access app create response missing id.");
  return { id: result.id, aud: result.aud ?? result.id };
}

export async function patchAccessApplication(input: {
  accessToken: string;
  accountId: string;
  appId: string;
  workerId: string;
}) {
  const body = await cfRequest(
    input.accessToken,
    `/accounts/${input.accountId}/access/apps/${input.appId}`,
    {
      method: "PUT",
      body: JSON.stringify({
        destinations: [{ type: "worker", worker_id: input.workerId }],
      }),
    },
  );
  const result = body.result as { id?: string; aud?: string };
  return { id: result?.id ?? input.appId, aud: result?.aud };
}

export async function createAccessPolicy(input: {
  accessToken: string;
  accountId: string;
  appId: string;
  email: string;
}) {
  const body = await cfRequest(
    input.accessToken,
    `/accounts/${input.accountId}/access/apps/${input.appId}/policies`,
    {
      method: "POST",
      body: JSON.stringify({
        name: "allow-owner",
        decision: "allow",
        precedence: 1,
        include: [{ email: { email: input.email } }],
      }),
    },
  );
  const result = body.result as { id?: string };
  if (!result?.id) throw new Error("Access policy create response missing id.");
  return result.id;
}

export async function putWorkerSecret(input: {
  accessToken: string;
  accountId: string;
  workerName: string;
  name: string;
  value: string;
}) {
  await cfRequest(
    input.accessToken,
    `/accounts/${input.accountId}/workers/scripts/${input.workerName}/secrets`,
    {
      method: "PUT",
      body: JSON.stringify({
        name: input.name,
        text: input.value,
        type: "secret_text",
      }),
    },
  );
}

export async function ensureMigrationLedger(
  accessToken: string,
  accountId: string,
  databaseId: string,
) {
  await queryD1(
    accessToken,
    accountId,
    databaseId,
    `CREATE TABLE IF NOT EXISTS "d1_migrations"(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);`,
  );
}

export async function listAppliedMigrations(
  accessToken: string,
  accountId: string,
  databaseId: string,
) {
  const body = await queryD1(
    accessToken,
    accountId,
    databaseId,
    `SELECT name FROM "d1_migrations" ORDER BY id`,
  );
  const rows = Array.isArray(body.result)
    ? (
        body.result as Array<{
          results?: Array<{ name?: string }>;
        }>
      ).flatMap((item) => item.results ?? [])
    : [];
  return rows
    .map((row) => row.name)
    .filter((name): name is string => Boolean(name));
}

export async function applyMigrationFile(input: {
  accessToken: string;
  accountId: string;
  databaseId: string;
  name: string;
  sql: string;
}) {
  const normalized = input.sql.replace(/\r\n/g, "\n").trimEnd();
  await queryD1(
    input.accessToken,
    input.accountId,
    input.databaseId,
    `${normalized}\nINSERT INTO "d1_migrations" (name) values ('${input.name.replaceAll("'", "''")}');`,
  );
}

export async function queryD1(
  accessToken: string,
  accountId: string,
  databaseId: string,
  sql: string,
) {
  return cfRequest(
    accessToken,
    `/accounts/${accountId}/d1/database/${databaseId}/query`,
    { method: "POST", body: JSON.stringify({ sql }) },
  );
}

export async function createAssetUploadSession(input: {
  accessToken: string;
  accountId: string;
  workerName: string;
  manifest: Record<string, { hash: string; size: number }>;
}) {
  const body = await cfRequest(
    input.accessToken,
    `/accounts/${input.accountId}/workers/scripts/${input.workerName}/assets-upload-session`,
    { method: "POST", body: JSON.stringify({ manifest: input.manifest }) },
  );
  const result = body.result as { jwt?: string; buckets?: unknown[] };
  if (!result?.jwt) throw new Error("Asset upload session missing jwt.");
  return { jwt: result.jwt, buckets: normalizeAssetBuckets(result.buckets) };
}

function normalizeAssetBuckets(value: unknown): string[][] {
  if (!Array.isArray(value)) return [];
  return value
    .map((bucket) =>
      Array.isArray(bucket)
        ? bucket.filter((item): item is string => typeof item === "string")
        : [],
    )
    .filter((bucket) => bucket.length > 0);
}

export async function uploadWorkerAssetBucket(input: {
  jwt: string;
  accountId: string;
  files: Array<{ hash: string; base64: string }>;
}) {
  const form = new FormData();
  for (const file of input.files) {
    form.set(file.hash, file.base64);
  }
  const response = await fetch(
    `${CLOUDFLARE_API_BASE}/accounts/${input.accountId}/workers/assets/upload?base64=true`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${input.jwt}` },
      body: form,
    },
  );
  if (!response.ok) {
    throw new CloudflareApiError(
      response.status,
      response.status === 429 ? "RATE_LIMITED" : "UPSTREAM",
    );
  }
  const text = await response.text();
  if (!text) return { jwt: input.jwt };
  const body = JSON.parse(text) as { result?: { jwt?: string } };
  return { jwt: body.result?.jwt ?? input.jwt };
}

export async function putQueueConsumer(input: {
  accessToken: string;
  accountId: string;
  queueId: string;
  workerName: string;
}) {
  const body = await cfRequest(
    input.accessToken,
    `/accounts/${input.accountId}/queues/${input.queueId}/consumers`,
    {
      method: "POST",
      body: JSON.stringify({
        script_name: input.workerName,
        type: "worker",
        environment: "production",
        settings: {
          batch_size: 1,
          max_retries: 3,
          max_wait_time_ms: 1000,
          max_concurrency: 1,
        },
      }),
    },
  );
  const result = body.result as { id?: string; consumer_id?: string };
  return { id: result?.id ?? result?.consumer_id ?? input.queueId };
}

export async function putWorkerSchedules(input: {
  accessToken: string;
  accountId: string;
  workerName: string;
  crons: string[];
}) {
  await cfRequest(
    input.accessToken,
    `/accounts/${input.accountId}/workers/scripts/${input.workerName}/schedules`,
    {
      method: "PUT",
      body: JSON.stringify({
        schedules: input.crons.map((cron) => ({ cron })),
      }),
    },
  );
}

export async function readAnonymousUrl(url: string) {
  const response = await fetch(url, { redirect: "manual" });
  return {
    status: response.status,
    location: response.headers.get("Location"),
    wwwAuthenticate: response.headers.get("WWW-Authenticate"),
  };
}

export function hasCloudflareAccessChallenge(probe: {
  status: number;
  location: string | null;
  wwwAuthenticate?: string | null;
}) {
  const location = probe.location ?? "";
  const authenticate = probe.wwwAuthenticate ?? "";
  const accessLocation =
    /https:\/\/[^/\s]+\.cloudflareaccess\.com(?:\/|$)/i.test(location) ||
    /\/cdn-cgi\/access\//i.test(location);
  const accessAuth =
    /cloudflareaccess/i.test(authenticate) ||
    /resource_metadata=/i.test(authenticate);
  if (probe.status === 302 && accessLocation) return true;
  if (
    (probe.status === 401 || probe.status === 403) &&
    (accessLocation || accessAuth)
  ) {
    return true;
  }
  return false;
}

export function isRetryableCloudflareError(error: unknown) {
  return (
    error instanceof CloudflareApiError &&
    (error.code === "RATE_LIMITED" ||
      (error.code === "UPSTREAM" && error.status >= 500))
  );
}

export async function pauseQueueDelivery(
  accessToken: string,
  accountId: string,
  queueId: string,
) {
  await cfRequest(
    accessToken,
    `/accounts/${accountId}/queues/${queueId}/pause_delivery`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function resumeQueueDelivery(
  accessToken: string,
  accountId: string,
  queueId: string,
) {
  await cfRequest(
    accessToken,
    `/accounts/${accountId}/queues/${queueId}/resume_delivery`,
    { method: "POST", body: JSON.stringify({}) },
  );
}

export async function readQueueInflight(
  accessToken: string,
  accountId: string,
  queueId: string,
) {
  const body = await cfRequest(
    accessToken,
    `/accounts/${accountId}/queues/${queueId}`,
  );
  const result = body.result as {
    delivery_paused?: boolean;
    pending_messages?: number;
    messages?: { unacked?: number };
  };
  return {
    paused: Boolean(result?.delivery_paused),
    pending: result?.pending_messages ?? result?.messages?.unacked ?? 0,
  };
}

export async function createD1Bookmark(
  accessToken: string,
  accountId: string,
  databaseId: string,
) {
  const body = await cfRequest(
    accessToken,
    `/accounts/${accountId}/d1/database/${databaseId}/bookmark`,
    { method: "POST", body: JSON.stringify({}) },
  );
  const result = body.result as { bookmark?: string; id?: string };
  const bookmark = result?.bookmark ?? result?.id;
  if (!bookmark) throw new Error("D1 bookmark response missing id.");
  return bookmark;
}

export async function restoreD1Bookmark(input: {
  accessToken: string;
  accountId: string;
  databaseId: string;
  bookmark: string;
}) {
  await cfRequest(
    input.accessToken,
    `/accounts/${input.accountId}/d1/database/${input.databaseId}/time_travel/restore`,
    {
      method: "POST",
      body: JSON.stringify({ bookmark: input.bookmark }),
    },
  );
}

export async function listWorkerSecretNames(
  accessToken: string,
  accountId: string,
  workerName: string,
) {
  const body = await cfRequest(
    accessToken,
    `/accounts/${accountId}/workers/scripts/${workerName}/secrets`,
  );
  const rows = Array.isArray(body.result) ? body.result : [];
  return rows
    .map((row) => (row as { name?: string }).name)
    .filter((name): name is string => Boolean(name));
}

export async function deleteWorkerSecret(input: {
  accessToken: string;
  accountId: string;
  workerName: string;
  name: string;
}) {
  await cfRequest(
    input.accessToken,
    `/accounts/${input.accountId}/workers/scripts/${input.workerName}/secrets/${input.name}`,
    { method: "DELETE" },
  );
}
