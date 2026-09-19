import { bytesToBase64, sha256Hex, utf8ToBase64 } from "./crypto";
import type { Env } from "./env";
import { isLocalDevMode } from "./http";
import { BOOTSTRAP_WORKER_MODULE } from "./cloudflare-provision";

export const LOCAL_FIXTURE_VERSION = "dev-local";
export const LOCAL_FIXTURE_DIGEST = "0".repeat(64);
export const LOCAL_FIXTURE_NEXT_VERSION = "dev-local-2";
export const LOCAL_FIXTURE_NEXT_DIGEST = "b".repeat(64);

export class ReleaseUnavailableError extends Error {
  constructor(
    public readonly code: "RELEASE_UNAVAILABLE" | "RELEASE_DIGEST_MISMATCH",
  ) {
    super(code);
    this.name = "ReleaseUnavailableError";
  }
}

export type ReleaseWorkerModule = {
  name: string;
  contentType: string;
  contentBase64: string;
};

export type ReleaseAsset = {
  path: string;
  hash: string;
  size: number;
  contentBase64: string;
};

export type ReleaseArtifact = {
  version: string;
  digest: string;
  source: "r2" | "local_fixture";
  compatibilityDate: string;
  compatibilityFlags: string[];
  crons: string[];
  workerMain: string;
  workerSource: string;
  workerModules: ReleaseWorkerModule[];
  migrations: Array<{ name: string; sql: string }>;
  assets: ReleaseAsset[];
  allowedUpgradeFrom: string[];
};

type ReleaseManifest = {
  schemaVersion?: number;
  version?: string;
  allowedUpgradeFrom?: string[];
  deployment?: {
    compatibilityDate?: string;
    compatibilityFlags?: string[];
    crons?: string[];
  };
  worker?: {
    mainModule?: string;
    modules?: Array<{ name?: string; path?: string; contentType?: string }>;
  };
  assetsManifest?: string;
  migrations?: Array<{ name?: string; path?: string }>;
  files?: Array<{ path?: string; size?: number; sha256?: string }>;
};

export function hasReleaseSource(env: Env) {
  return Boolean(env.RELEASE_BUCKET) || isLocalDevMode(env);
}

const BASE_MIGRATION = {
  name: "0001_initial.sql",
  sql: "CREATE TABLE IF NOT EXISTS probe (\n  id INTEGER PRIMARY KEY\n);\n",
};

const NEXT_MIGRATION = {
  name: "0002_probe_note.sql",
  sql: "ALTER TABLE probe ADD COLUMN note TEXT;\n",
};

export function localFixtureRelease(
  version = LOCAL_FIXTURE_VERSION,
  digest = LOCAL_FIXTURE_DIGEST,
): ReleaseArtifact {
  const html = "<!doctype html><title>不用記帳</title><p>ok</p>";
  const isNext =
    version === LOCAL_FIXTURE_NEXT_VERSION ||
    digest === LOCAL_FIXTURE_NEXT_DIGEST;
  const workerSource = BOOTSTRAP_WORKER_MODULE.replace(
    "Installation is not ready.",
    isNext ? "ALL SET v2" : "ALL SET",
  );
  return {
    version,
    digest,
    source: "local_fixture",
    compatibilityDate: "2026-06-01",
    compatibilityFlags: ["nodejs_compat"],
    crons: ["*/10 * * * *"],
    workerMain: "index.js",
    workerSource,
    workerModules: [
      {
        name: "index.js",
        contentType: "application/javascript+module",
        contentBase64: utf8ToBase64(workerSource),
      },
    ],
    migrations: isNext ? [BASE_MIGRATION, NEXT_MIGRATION] : [BASE_MIGRATION],
    assets: [
      {
        path: "/index.html",
        hash: isNext ? "local-index-html-v2" : "local-index-html",
        size: html.length,
        contentBase64: utf8ToBase64(html),
      },
    ],
    allowedUpgradeFrom: isNext ? [LOCAL_FIXTURE_VERSION, "v0.1.0"] : [],
  };
}

export function localUpgradeRelease(currentVersion: string | null) {
  if (currentVersion === LOCAL_FIXTURE_VERSION || currentVersion === "v0.1.0") {
    return {
      version: LOCAL_FIXTURE_NEXT_VERSION,
      digest: LOCAL_FIXTURE_NEXT_DIGEST,
      source: "local_fixture" as const,
    };
  }
  return null;
}

export function canUpgradeFrom(
  currentVersion: string,
  release: ReleaseArtifact,
) {
  if (currentVersion === release.version) return false;
  return release.allowedUpgradeFrom.includes(currentVersion);
}

function assertSafeReleasePath(path: string) {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
  }
}

async function readR2Bytes(bucket: R2Bucket, key: string) {
  const object = await bucket.get(key);
  if (!object) throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
  return new Uint8Array(await object.arrayBuffer());
}

function parseManifest(bytes: Uint8Array): ReleaseManifest {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as ReleaseManifest;
  } catch {
    throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
  }
}

async function readPublishedManifest(bucket: R2Bucket, version: string) {
  assertSafeReleasePath(version);
  const jsonBytes = await readR2Bytes(
    bucket,
    `releases/${version}/release.json`,
  );
  const digest = await sha256Hex(jsonBytes);
  const recorded = await bucket.get(`releases/${version}/release.sha256`);
  if (!recorded || (await recorded.text()).trim() !== digest) {
    throw new ReleaseUnavailableError("RELEASE_DIGEST_MISMATCH");
  }
  const manifest = parseManifest(jsonBytes);
  if (manifest.schemaVersion !== 1 || manifest.version !== version) {
    throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
  }
  return { manifest, digest, jsonBytes };
}

export async function readCurrentRelease(env: Env) {
  if (env.RELEASE_BUCKET) {
    const latest = await env.RELEASE_BUCKET.get("releases/latest");
    if (!latest) throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
    const version = (await latest.text()).trim();
    if (!version) throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
    const published = await readPublishedManifest(env.RELEASE_BUCKET, version);
    return {
      version: published.manifest.version!,
      digest: published.digest,
      source: "r2" as const,
    };
  }
  if (isLocalDevMode(env)) {
    return {
      version: LOCAL_FIXTURE_VERSION,
      digest: LOCAL_FIXTURE_DIGEST,
      source: "local_fixture" as const,
    };
  }
  throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
}

export async function loadRelease(
  env: Env,
  version: string,
  digest: string,
): Promise<ReleaseArtifact> {
  if (env.RELEASE_BUCKET) {
    return loadR2Release(env.RELEASE_BUCKET, version, digest);
  }
  if (isLocalDevMode(env)) {
    return localFixtureRelease(version, digest);
  }
  throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
}

async function loadR2Release(
  bucket: R2Bucket,
  version: string,
  digest: string,
): Promise<ReleaseArtifact> {
  const published = await readPublishedManifest(bucket, version);
  if (published.digest !== digest) {
    throw new ReleaseUnavailableError("RELEASE_DIGEST_MISMATCH");
  }
  const manifest = published.manifest;
  const files = new Map<string, Uint8Array>();
  for (const file of manifest.files ?? []) {
    if (
      !file.path ||
      typeof file.size !== "number" ||
      !file.sha256 ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
    }
    assertSafeReleasePath(file.path);
    const bytes = await readR2Bytes(bucket, `releases/${version}/${file.path}`);
    if (
      bytes.byteLength !== file.size ||
      (await sha256Hex(bytes)) !== file.sha256
    ) {
      throw new ReleaseUnavailableError("RELEASE_DIGEST_MISMATCH");
    }
    files.set(file.path, bytes);
  }

  const modules = manifest.worker?.modules ?? [];
  const mainModule = manifest.worker?.mainModule;
  if (!mainModule || modules.length === 0) {
    throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
  }
  const workerModules: ReleaseWorkerModule[] = [];
  for (const module of modules) {
    if (!module.name || !module.path) {
      throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
    }
    const bytes = files.get(module.path);
    if (!bytes) throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
    workerModules.push({
      name: module.name,
      contentType: module.contentType ?? "application/javascript+module",
      contentBase64: bytesToBase64(bytes),
    });
  }
  const main = workerModules.find((module) => module.name === mainModule);
  if (!main) throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");

  const migrations: ReleaseArtifact["migrations"] = [];
  for (const file of manifest.migrations ?? []) {
    if (!file.name || !file.path) {
      throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
    }
    const bytes = files.get(file.path);
    if (!bytes) throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
    migrations.push({
      name: file.name,
      sql: new TextDecoder().decode(bytes),
    });
  }
  if (migrations.length === 0) {
    throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
  }

  const assetsManifestPath = manifest.assetsManifest ?? "assets-manifest.json";
  const assetsManifestBytes = files.get(assetsManifestPath);
  if (!assetsManifestBytes) {
    throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
  }
  const assetsManifest = JSON.parse(
    new TextDecoder().decode(assetsManifestBytes),
  ) as Record<string, { hash?: string; size?: number }>;
  const assets: ReleaseAsset[] = [];
  for (const [path, asset] of Object.entries(assetsManifest)) {
    if (
      !path.startsWith("/") ||
      !asset.hash ||
      typeof asset.size !== "number"
    ) {
      throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
    }
    const name = path.slice(1);
    assertSafeReleasePath(name);
    const filePath = `assets/${name}`;
    const bytes = files.get(filePath);
    if (!bytes || bytes.byteLength !== asset.size) {
      throw new ReleaseUnavailableError("RELEASE_DIGEST_MISMATCH");
    }
    assets.push({
      path,
      hash: asset.hash,
      size: asset.size,
      contentBase64: bytesToBase64(bytes),
    });
  }
  if (!assets.some((asset) => asset.path === "/index.html")) {
    throw new ReleaseUnavailableError("RELEASE_UNAVAILABLE");
  }

  return {
    version: manifest.version ?? version,
    digest,
    source: "r2",
    compatibilityDate: manifest.deployment?.compatibilityDate ?? "2026-06-01",
    compatibilityFlags: manifest.deployment?.compatibilityFlags ?? [
      "nodejs_compat",
    ],
    crons: manifest.deployment?.crons ?? ["*/10 * * * *"],
    workerMain: mainModule,
    workerSource: new TextDecoder().decode(
      files.get(
        modules.find((module) => module.name === mainModule)?.path ?? "",
      ) ?? new Uint8Array(),
    ),
    workerModules,
    migrations,
    assets,
    allowedUpgradeFrom: manifest.allowedUpgradeFrom ?? [],
  };
}
