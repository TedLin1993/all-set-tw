import { createHash } from "node:crypto";

// An upload may be newer than the version receiving production traffic.
export async function readActiveResources(
  deployment,
  readVersion,
  workerName,
  migrationOnly = false,
) {
  const versions = deployment.versions?.filter(
    (version) => version.percentage > 0,
  );
  if (!versions?.length)
    throw new Error("No active Worker version to inspect.");
  let resources;
  for (const { version_id } of versions) {
    const version = await readVersion(version_id);
    const bindings = version.resources?.bindings ?? [];
    const databaseId = bindings.find(
      (binding) => binding.type === "d1" && binding.name === "DB",
    )?.id;
    const queueName = migrationOnly
      ? undefined
      : bindings.find(
          (binding) =>
            binding.type === "queue" && binding.name === "SYNC_QUEUE",
        )?.queue_name;
    if (!databaseId || (!migrationOnly && !queueName))
      throw new Error(
        `Worker '${workerName}' is missing a required live binding.`,
      );
    if (
      resources &&
      (databaseId !== resources.databaseId || queueName !== resources.queueName)
    ) {
      throw new Error(
        `Active versions of Worker '${workerName}' have different resource bindings.`,
      );
    }
    resources = { databaseId, queueName };
  }
  return resources;
}

// Workers Builds creates the Worker before running the deploy command. Its
// immutable script tag also distinguishes a deleted and recreated Worker.
export async function resolveWorkerResources(
  environment,
  workerName,
  fetchApi = fetch,
) {
  const account = environment.CLOUDFLARE_ACCOUNT_ID;
  const token = environment.CLOUDFLARE_API_TOKEN;
  if (!account || !token || !workerName) {
    throw new Error("Missing Cloudflare account, build token or Worker name.");
  }
  async function request(path, body, method = body ? "POST" : "GET") {
    const response = await fetchApi(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        ...(body && { body: JSON.stringify(body) }),
      },
    );
    const data = await response.json();
    if (!response.ok || data.success !== true) {
      throw new Error(
        `Cloudflare resource setup failed (HTTP ${response.status}, codes ${(data.errors ?? []).map((error) => error.code).join(", ")}).`,
      );
    }
    return data.result;
  }

  const name = encodeURIComponent(workerName);
  const servicePath = `/workers/services/${name}`;
  const service = await request(servicePath);
  const tag = service.default_environment?.script?.tag;
  if (
    typeof tag !== "string" ||
    !tag ||
    (environment.WRANGLER_CI_MATCH_TAG &&
      environment.WRANGLER_CI_MATCH_TAG !== tag)
  ) {
    throw new Error("Cannot verify the deployment Worker identity.");
  }
  const scriptPath = `/workers/scripts/${name}`;
  const { deployments } = await request(`${scriptPath}/deployments`);
  if (!Array.isArray(deployments))
    throw new Error("Cannot read Worker deployment history.");
  // The deployments API returns the newest deployment first, including rollbacks.
  if (deployments.length) {
    return readActiveResources(
      deployments[0],
      (id) => request(`${scriptPath}/versions/${encodeURIComponent(id)}`),
      workerName,
    );
  }

  // No deployments yet. Preserve bindings provisioned by the install template.
  const { bindings } = await request(`${scriptPath}/settings`);
  if (!Array.isArray(bindings))
    throw new Error("Cannot read deployed Worker bindings.");
  const db = bindings.find((binding) => binding.name === "DB");
  const queue = bindings.find((binding) => binding.name === "SYNC_QUEUE");
  if (
    (db && (db.type !== "d1" || !db.id)) ||
    (queue && (queue.type !== "queue" || !queue.queue_name))
  ) {
    throw new Error(
      "Unexpected DB or SYNC_QUEUE binding on the deployed Worker.",
    );
  }

  if (db && queue) return { databaseId: db.id, queueName: queue.queue_name };

  // Reserve unused names on this Worker before creating either resource. A
  // retry can then finish an interrupted allocation without claiming an orphan.
  const installId = createHash("sha256").update(tag).digest("hex").slice(0, 32);
  const marker = `all-set-resources-${installId}-`;
  const reservation = (tags) => tags.find((value) => value.startsWith(marker));
  const tagsOf = (service) => service.default_environment.script.tags ?? [];
  let allocation = reservation(tagsOf(service));
  async function find(path, field, resourceName) {
    const matches = await request(
      `${path}?name=${encodeURIComponent(resourceName)}`,
    );
    return matches.find((item) => item[field] === resourceName);
  }
  if (!allocation) {
    let suffix = 1;
    while (true) {
      allocation = `${marker}${suffix}`;
      if (
        (!db && (await find("/d1/database", "name", `${allocation}-db`))) ||
        (!queue && (await find("/queues", "queue_name", `${allocation}-sync`)))
      ) {
        suffix++;
        continue;
      }
      break;
    }
    // Another build for this Worker may have reserved the names meanwhile.
    const current = await request(servicePath);
    if (current.default_environment?.script?.tag !== tag)
      throw new Error("Deployment Worker changed during allocation.");
    const tags = tagsOf(current);
    const concurrent = reservation(tags);
    if (concurrent) {
      allocation = concurrent;
    } else {
      await request(
        `/workers/scripts/${name}/script-settings`,
        { tags: [...tags, allocation] },
        "PATCH",
      );
    }
  }
  async function provision(path, field, resourceName) {
    const existing = await find(path, field, resourceName);
    if (existing) return existing;
    try {
      return await request(path, { [field]: resourceName });
    } catch (error) {
      // A simultaneous retry for the same allocation may have won the create.
      const created = await find(path, field, resourceName);
      if (created) return created;
      throw error;
    }
  }
  const databaseId =
    db?.id ??
    (await provision("/d1/database", "name", `${allocation}-db`)).uuid;
  const queueName =
    queue?.queue_name ??
    (await provision("/queues", "queue_name", `${allocation}-sync`)).queue_name;
  if (!databaseId || !queueName)
    throw new Error("Incomplete Cloudflare resource allocation.");
  return { databaseId, queueName };
}
