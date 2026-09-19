import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, join, posix } from "node:path";
import { hash } from "blake3-wasm";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

export function safePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Invalid release path");
  return value;
}

export async function filesIn(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = safePath(posix.join(prefix, entry.name));
    if (entry.isSymbolicLink())
      throw new Error(`Symlink is not allowed: ${path}`);
    if (entry.isDirectory())
      paths.push(...(await filesIn(join(directory, entry.name), path)));
    else if (entry.isFile()) paths.push(path);
    else throw new Error(`Unsupported release entry: ${path}`);
  }
  return paths;
}

export function assetHash(bytes, path) {
  // Match the pinned Wrangler's Direct Upload hash (base64 content + extension).
  return hash(bytes.toString("base64") + extname(path).slice(1))
    .toString("hex")
    .slice(0, 32);
}

export function releaseSettings(config) {
  // Do not silently omit a new binding or ship account-specific settings/secrets.
  const allowed = new Set([
    "name",
    "main",
    "compatibility_date",
    "compatibility_flags",
    "workers_dev",
    "preview_urls",
    "assets",
    "browser",
    "ai",
    "triggers",
    "queues",
    "d1_databases",
    "observability",
  ]);
  for (const key of Object.keys(config)) {
    if (!allowed.has(key))
      throw new Error(`Unsupported release config: ${key}`);
  }
  if (config.workers_dev !== true || config.preview_urls !== false)
    throw new Error("Release requires workers.dev with preview URLs disabled");
  if (config.d1_databases?.length !== 1 || config.d1_databases[0].database_id)
    throw new Error("Release requires one unprovisioned D1 binding");
  if (
    config.queues?.producers?.length !== 1 ||
    config.queues?.consumers?.length !== 1 ||
    config.queues.producers[0].queue !== config.queues.consumers[0].queue
  )
    throw new Error(
      "Release requires one matching Queue producer and consumer",
    );
  for (const key of ["assets", "browser", "ai"]) {
    if (!config[key]?.binding) throw new Error(`Missing ${key} binding`);
  }
  const db = config.d1_databases[0];
  const queue = config.queues.producers[0];
  return {
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags ?? [],
    workersDev: true,
    previewUrls: false,
    bindings: [
      { name: db.binding, type: "d1", resource: "database" },
      { name: queue.binding, type: "queue", resource: "syncQueue" },
      { name: config.browser.binding, type: "browser" },
      { name: config.ai.binding, type: "ai" },
      { name: config.assets.binding, type: "assets" },
    ],
    queueConsumer: Object.fromEntries(
      Object.entries(config.queues.consumers[0]).filter(
        ([key]) => key !== "queue",
      ),
    ),
    crons: config.triggers?.crons ?? [],
    observability: config.observability,
    requiredSecrets: [
      "CONFIG_ENCRYPTION_KEY",
      "VAPID_PUBLIC_KEY",
      "VAPID_PRIVATE_KEY",
      "TEAM_DOMAIN",
      "POLICY_AUD",
    ],
    migrationTable: db.migrations_table ?? "d1_migrations",
  };
}

export async function unpackWorker(bytes, settings) {
  const boundary = bytes.subarray(2, bytes.indexOf("\r\n")).toString();
  if (
    !bytes.subarray(0, 2).equals(Buffer.from("--")) ||
    !/^[\w-]+$/.test(boundary)
  )
    throw new Error("Invalid Wrangler multipart output");
  const form = await new Response(bytes, {
    headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
  }).formData();
  const metadataPart = form.get("metadata");
  const metadata = JSON.parse(
    typeof metadataPart === "string" ? metadataPart : await metadataPart.text(),
  );
  const expected = new Map(
    settings.bindings.map((binding) => [binding.name, binding]),
  );
  const seen = new Set();
  for (const binding of metadata.bindings ?? []) {
    const wanted = expected.get(binding.name);
    if (
      !wanted ||
      seen.has(binding.name) ||
      !(
        binding.type === wanted.type ||
        (wanted.type === "d1" && binding.type === "inherit")
      )
    )
      throw new Error("Unexpected or sensitive binding in Worker bundle");
    seen.add(binding.name);
  }
  if (seen.size !== expected.size)
    throw new Error("Worker bindings differ from release configuration");
  if (
    metadata.compatibility_date !== settings.compatibilityDate ||
    JSON.stringify(metadata.compatibility_flags ?? []) !==
      JSON.stringify(settings.compatibilityFlags)
  )
    throw new Error("Worker compatibility configuration mismatch");
  const modules = [];
  for (const [name, part] of form) {
    if (name === "metadata") continue;
    safePath(name);
    if (
      typeof part === "string" ||
      modules.some((module) => module.name === name)
    )
      throw new Error("Invalid Worker module");
    modules.push({
      name,
      contentType: part.type,
      bytes: Buffer.from(await part.arrayBuffer()),
    });
  }
  modules.sort((a, b) => (a.name < b.name ? -1 : 1));
  if (!modules.some((module) => module.name === metadata.main_module))
    throw new Error("Worker entry module missing");
  return { mainModule: metadata.main_module, modules };
}

export async function assembleRelease({
  directory,
  version,
  commit,
  sourceDirty,
  settings,
  worker,
  assetDirectory,
  migrationDirectory,
}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(version))
    throw new Error("Invalid release version");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid source commit");
  const files = [];
  async function put(path, bytes) {
    safePath(path);
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), bytes, { flag: "wx" });
    files.push({ path, size: bytes.length, sha256: sha256(bytes) });
  }
  const modules = [];
  for (const module of worker.modules) {
    const path = `worker/${safePath(module.name)}`;
    await put(path, module.bytes);
    modules.push({ name: module.name, path, contentType: module.contentType });
  }
  const assets = {};
  for (const name of await filesIn(assetDirectory)) {
    if (
      name.split("/").some((part) => part.startsWith(".")) ||
      /(^|\/)(_worker\.js|_headers|_redirects)$/.test(name) ||
      name.endsWith(".map")
    )
      throw new Error(`Unsupported public asset: ${name}`);
    const bytes = await readFile(join(assetDirectory, name));
    await put(`assets/${name}`, bytes);
    assets[`/${name}`] = { hash: assetHash(bytes, name), size: bytes.length };
  }
  if (!assets["/index.html"]) throw new Error("Web entry index.html missing");
  await put(
    "assets-manifest.json",
    Buffer.from(JSON.stringify(assets, null, 2) + "\n"),
  );
  const migrations = [];
  for (const name of await filesIn(migrationDirectory)) {
    if (!/^\d{4}_[\w-]+\.sql$/.test(name))
      throw new Error(`Unsupported migration: ${name}`);
    const path = `migrations/${name}`;
    await put(path, await readFile(join(migrationDirectory, name)));
    migrations.push({ name, path });
  }
  if (!migrations.length) throw new Error("No migrations found");
  const manifest = {
    schemaVersion: 1,
    version,
    commit,
    sourceDirty,
    // No upgrade path is certified until the stage-4 migration tests pass.
    allowedUpgradeFrom: [],
    deployment: settings,
    worker: { mainModule: worker.mainModule, modules },
    assetsManifest: "assets-manifest.json",
    migrations,
    files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n");
  await writeFile(join(directory, "release.json"), bytes, { flag: "wx" });
  const digest = sha256(bytes);
  await writeFile(join(directory, "release.sha256"), `${digest}\n`, {
    flag: "wx",
  });
  return { manifest, digest };
}

export async function verifyRelease(directory, expectedDigest) {
  const actualFiles = await filesIn(directory);
  const bytes = await readFile(join(directory, "release.json"));
  const digest = sha256(bytes);
  const recorded = (
    await readFile(join(directory, "release.sha256"), "utf8")
  ).trim();
  if (digest !== recorded || (expectedDigest && digest !== expectedDigest))
    throw new Error("Release manifest digest mismatch");
  const manifest = JSON.parse(bytes);
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files))
    throw new Error("Unsupported release manifest");
  const expectedFiles = new Set(["release.json", "release.sha256"]);
  for (const file of manifest.files) {
    safePath(file.path);
    if (expectedFiles.has(file.path)) throw new Error("Duplicate release file");
    expectedFiles.add(file.path);
    const bytes = await readFile(join(directory, file.path));
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256)
      throw new Error(`Release file integrity mismatch: ${file.path}`);
  }
  if (
    actualFiles.length !== expectedFiles.size ||
    actualFiles.some((path) => !expectedFiles.has(path))
  )
    throw new Error("Unexpected release files");
  const requireFile = (path) => {
    safePath(path);
    if (!manifest.files.some((file) => file.path === path))
      throw new Error(`Missing referenced file: ${path}`);
  };
  for (const module of manifest.worker.modules) requireFile(module.path);
  if (
    !manifest.worker.modules.some(
      (module) => module.name === manifest.worker.mainModule,
    )
  )
    throw new Error("Worker entry module missing");
  for (const migration of manifest.migrations) requireFile(migration.path);
  requireFile(manifest.assetsManifest);
  const assets = JSON.parse(
    await readFile(join(directory, manifest.assetsManifest), "utf8"),
  );
  for (const [url, asset] of Object.entries(assets)) {
    if (!url.startsWith("/")) throw new Error("Invalid asset URL");
    const name = safePath(url.slice(1));
    requireFile(`assets/${name}`);
    const content = await readFile(join(directory, "assets", name));
    if (
      asset.hash !== assetHash(content, name) ||
      asset.size !== content.length
    )
      throw new Error(`Asset manifest mismatch: ${name}`);
  }
  return { manifest, digest };
}
