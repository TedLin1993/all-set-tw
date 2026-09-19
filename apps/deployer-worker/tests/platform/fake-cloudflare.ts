import { CLOUDFLARE_API_BASE } from "../../src/platform/cloudflare";

export type FakeCloudflareState = {
  subdomain: string | null;
  organization: string | null;
  workers: Set<string>;
  workerTags: Map<string, string>;
  d1: Array<{ id: string; name: string }>;
  queues: Array<{ id: string; name: string }>;
  idps: Array<{ id: string; type: string; name: string }>;
  accessApps: Array<{
    id: string;
    name: string;
    workerId: string;
    aud: string;
  }>;
  policies: Array<{ id: string; appId: string; email: string }>;
  secrets: Map<string, string>;
  appliedMigrations: Map<string, string[]>;
  consumers: Array<{ id: string; queueId: string; scriptName: string }>;
  crons: Map<string, string[]>;
  workersDev: Set<string>;
  writes: Array<{ method: string; path: string }>;
  expireOnWrite?: boolean;
  conflictD1?: boolean;
  deliveryPaused: Set<string>;
  pendingMessages: Map<string, number>;
  bookmarks: Map<string, string>;
  uploadedAssetHashes: string[];
  uploadedWorkerModules: string[][];
};

export function createFakeCloudflare(options?: {
  subdomain?: boolean;
  organization?: boolean;
  existingWorkers?: string[];
  existingD1?: string[];
  existingQueues?: string[];
  expireOnWrite?: boolean;
}): FakeCloudflareState {
  return {
    subdomain: options?.subdomain === false ? null : "example",
    organization:
      options?.organization === false ? null : "example.cloudflareaccess.com",
    workers: new Set(options?.existingWorkers ?? []),
    workerTags: new Map(),
    d1: (options?.existingD1 ?? []).map((name) => ({
      id: `d1-${name}`,
      name,
    })),
    queues: (options?.existingQueues ?? []).map((name) => ({
      id: `q-${name}`,
      name,
    })),
    idps: [{ id: "idp-otp", type: "onetimepin", name: "One-time PIN" }],
    accessApps: [],
    policies: [],
    secrets: new Map(),
    appliedMigrations: new Map(),
    consumers: [],
    crons: new Map(),
    workersDev: new Set(),
    writes: [],
    expireOnWrite: options?.expireOnWrite,
    deliveryPaused: new Set(),
    pendingMessages: new Map(),
    bookmarks: new Map(),
    uploadedAssetHashes: [],
    uploadedWorkerModules: [],
  };
}

export async function handleCloudflareApi(
  state: FakeCloudflareState,
  url: string,
  init?: RequestInit,
) {
  if (!url.startsWith(CLOUDFLARE_API_BASE)) return null;
  const parsed = new URL(url);
  const path = parsed.pathname.startsWith("/client/v4")
    ? parsed.pathname.slice("/client/v4".length)
    : parsed.pathname;
  const query = parsed.searchParams;
  const method = (init?.method ?? "GET").toUpperCase();
  const isWrite = method !== "GET";
  if (isWrite) {
    state.writes.push({ method, path });
    if (state.expireOnWrite) return new Response(null, { status: 401 });
  }

  if (path === "/memberships") return null;

  const subdomain = path.match(/^\/accounts\/[^/]+\/workers\/subdomain$/);
  if (subdomain && method === "GET") {
    if (!state.subdomain) return new Response(null, { status: 404 });
    return Response.json({ result: { subdomain: state.subdomain } });
  }

  const org = path.match(/^\/accounts\/[^/]+\/access\/organizations$/);
  if (org && method === "GET") {
    if (!state.organization) return new Response(null, { status: 404 });
    return Response.json({ result: { auth_domain: state.organization } });
  }

  const listD1 = path.match(/^\/accounts\/[^/]+\/d1\/database$/);
  if (listD1 && method === "GET") {
    const name = query.get("name");
    const items = name
      ? state.d1.filter((item) => item.name === name)
      : state.d1;
    return Response.json({
      result: items.map((item) => ({ uuid: item.id, name: item.name })),
    });
  }
  if (listD1 && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as { name?: string };
    if (state.d1.some((item) => item.name === body.name)) {
      return new Response(null, { status: 409 });
    }
    const created = {
      id: `d1-${crypto.randomUUID()}`,
      name: body.name ?? "db",
    };
    state.d1.push(created);
    return Response.json({ result: { uuid: created.id, name: created.name } });
  }

  const queryD1 = path.match(
    /^\/accounts\/[^/]+\/d1\/database\/([^/]+)\/query$/,
  );
  if (queryD1 && method === "POST") {
    const databaseId = queryD1[1]!;
    const sql = String(
      (JSON.parse(String(init?.body ?? "{}")) as { sql?: string }).sql ?? "",
    );
    const applied = state.appliedMigrations.get(databaseId) ?? [];
    if (/SELECT name FROM "d1_migrations"/.test(sql)) {
      return Response.json({
        result: [{ results: applied.map((name) => ({ name })), success: true }],
      });
    }
    const inserted = sql.match(
      /INSERT INTO "d1_migrations" \(name\) values \('([^']+)'\)/i,
    );
    if (inserted) {
      applied.push(inserted[1]!);
      state.appliedMigrations.set(databaseId, applied);
    }
    if (/CREATE TABLE IF NOT EXISTS "d1_migrations"/.test(sql)) {
      state.appliedMigrations.set(databaseId, applied);
    }
    return Response.json({ result: [{ results: [], success: true }] });
  }

  const bookmark = path.match(
    /^\/accounts\/[^/]+\/d1\/database\/([^/]+)\/bookmark$/,
  );
  if (bookmark && method === "POST") {
    const id = `bm-${crypto.randomUUID()}`;
    state.bookmarks.set(bookmark[1]!, id);
    return Response.json({ result: { bookmark: id } });
  }

  const restore = path.match(
    /^\/accounts\/[^/]+\/d1\/database\/([^/]+)\/time_travel\/restore$/,
  );
  if (restore && method === "POST") {
    return Response.json({ result: { success: true } });
  }

  const listQueues = path.match(/^\/accounts\/[^/]+\/queues$/);
  if (listQueues && method === "GET") {
    return Response.json({
      result: state.queues.map((item) => ({
        queue_id: item.id,
        queue_name: item.name,
      })),
    });
  }
  if (listQueues && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      queue_name?: string;
    };
    const name = body.queue_name ?? "queue";
    if (state.queues.some((item) => item.name === name)) {
      return new Response(null, { status: 409 });
    }
    const created = { id: `q-${crypto.randomUUID()}`, name };
    state.queues.push(created);
    return Response.json({
      result: { queue_id: created.id, queue_name: created.name },
    });
  }

  const consumer = path.match(
    /^\/accounts\/[^/]+\/queues\/([^/]+)\/consumers$/,
  );
  if (consumer && method === "POST") {
    const queueId = consumer[1]!;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      script_name?: string;
    };
    const created = {
      id: `c-${crypto.randomUUID()}`,
      queueId,
      scriptName: body.script_name ?? "",
    };
    state.consumers.push(created);
    return Response.json({ result: { id: created.id } });
  }

  const pauseQueue = path.match(
    /^\/accounts\/[^/]+\/queues\/([^/]+)\/pause_delivery$/,
  );
  if (pauseQueue && method === "POST") {
    state.deliveryPaused.add(pauseQueue[1]!);
    return Response.json({ result: { delivery_paused: true } });
  }

  const resumeQueue = path.match(
    /^\/accounts\/[^/]+\/queues\/([^/]+)\/resume_delivery$/,
  );
  if (resumeQueue && method === "POST") {
    state.deliveryPaused.delete(resumeQueue[1]!);
    return Response.json({ result: { delivery_paused: false } });
  }

  const queueById = path.match(/^\/accounts\/[^/]+\/queues\/([^/]+)$/);
  if (queueById && method === "GET") {
    const queueId = queueById[1]!;
    return Response.json({
      result: {
        delivery_paused: state.deliveryPaused.has(queueId),
        pending_messages: state.pendingMessages.get(queueId) ?? 0,
      },
    });
  }

  const idps = path.match(/^\/accounts\/[^/]+\/access\/identity_providers$/);
  if (idps && method === "GET") {
    return Response.json({ result: state.idps });
  }
  if (idps && method === "POST") {
    const created = {
      id: `idp-${crypto.randomUUID()}`,
      type: "onetimepin",
      name: "One-time PIN",
    };
    state.idps.push(created);
    return Response.json({ result: created });
  }

  const policy = path.match(
    /^\/accounts\/[^/]+\/access\/apps\/([^/]+)\/policies$/,
  );
  if (policy && method === "POST") {
    const appId = policy[1]!;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      include?: Array<{ email?: { email?: string } }>;
    };
    const created = {
      id: `pol-${crypto.randomUUID()}`,
      appId,
      email: body.include?.[0]?.email?.email ?? "",
    };
    state.policies.push(created);
    return Response.json({ result: { id: created.id } });
  }

  const accessApp = path.match(/^\/accounts\/[^/]+\/access\/apps$/);
  if (accessApp && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      name?: string;
      destinations?: Array<{ worker_id?: string }>;
    };
    const created = {
      id: `app-${crypto.randomUUID()}`,
      name: body.name ?? "app",
      workerId: body.destinations?.[0]?.worker_id ?? "",
      aud: `aud-${crypto.randomUUID()}`,
    };
    state.accessApps.push(created);
    return Response.json({ result: { id: created.id, aud: created.aud } });
  }

  const accessAppId = path.match(/^\/accounts\/[^/]+\/access\/apps\/([^/]+)$/);
  if (accessAppId && method === "PUT") {
    const app = state.accessApps.find((item) => item.id === accessAppId[1]);
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      destinations?: Array<{ worker_id?: string }>;
    };
    if (app && body.destinations?.[0]?.worker_id) {
      app.workerId = body.destinations[0].worker_id;
    }
    return Response.json({
      result: { id: app?.id ?? accessAppId[1], aud: app?.aud },
    });
  }

  const secrets = path.match(
    /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/secrets$/,
  );
  if (secrets && method === "GET") {
    const workerName = secrets[1]!;
    const names = [...state.secrets.keys()]
      .filter((key) => key.startsWith(`${workerName}:`))
      .map((key) => ({
        name: key.slice(workerName.length + 1),
        type: "secret_text",
      }));
    return Response.json({ result: names });
  }
  if (secrets && method === "PUT") {
    const workerName = secrets[1]!;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      name?: string;
      text?: string;
    };
    state.secrets.set(`${workerName}:${body.name}`, body.text ?? "");
    return Response.json({ result: { name: body.name, type: "secret_text" } });
  }

  const deleteSecret = path.match(
    /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/secrets\/([^/]+)$/,
  );
  if (deleteSecret && method === "DELETE") {
    state.secrets.delete(`${deleteSecret[1]}:${deleteSecret[2]}`);
    return new Response(null, { status: 204 });
  }

  const assets = path.match(
    /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/assets-upload-session$/,
  );
  if (assets && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      manifest?: Record<string, { hash?: string }>;
    };
    const hashes = Object.values(body.manifest ?? {})
      .map((item) => item.hash)
      .filter((hash): hash is string => Boolean(hash));
    return Response.json({
      result: {
        jwt: "asset-jwt",
        buckets: hashes.length ? [hashes] : [],
      },
    });
  }

  const assetUpload = path.match(
    /^\/accounts\/[^/]+\/workers\/assets\/upload$/,
  );
  if (assetUpload && method === "POST") {
    const form = init?.body as FormData | undefined;
    if (form && typeof form.keys === "function") {
      for (const key of form.keys()) {
        state.uploadedAssetHashes.push(key);
      }
    }
    return Response.json({ result: { jwt: "asset-jwt-complete" } });
  }

  const schedules = path.match(
    /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/schedules$/,
  );
  if (schedules && method === "PUT") {
    const workerName = schedules[1]!;
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      schedules?: Array<{ cron?: string }>;
    };
    state.crons.set(
      workerName,
      (body.schedules ?? []).map((item) => item.cron ?? ""),
    );
    return Response.json({ result: body.schedules ?? [] });
  }

  const subdomainEnable = path.match(
    /^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)\/subdomain$/,
  );
  if (subdomainEnable && method === "POST") {
    state.workersDev.add(subdomainEnable[1]!);
    return Response.json({
      result: { enabled: true, previews_enabled: false },
    });
  }

  const script = path.match(/^\/accounts\/[^/]+\/workers\/scripts\/([^/]+)$/);
  if (script && method === "GET") {
    const name = script[1]!;
    if (!state.workers.has(name)) return new Response(null, { status: 404 });
    return Response.json({
      result: { id: name, tag: state.workerTags.get(name) },
    });
  }
  if (script && method === "PUT") {
    const name = script[1]!;
    const tag = `tag-${name}-${state.writes.length}`;
    state.workers.add(name);
    state.workerTags.set(name, tag);
    const form = init?.body as FormData | undefined;
    if (form && typeof form.keys === "function") {
      state.uploadedWorkerModules.push(
        [...form.keys()].filter((key) => key !== "metadata"),
      );
    }
    return Response.json({ result: { id: name, tag } });
  }

  return new Response("unhandled " + method + " " + path, { status: 500 });
}
