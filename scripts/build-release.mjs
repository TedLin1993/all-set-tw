import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { experimental_readRawConfig } from "wrangler";
import {
  assembleRelease,
  releaseSettings,
  unpackWorker,
  verifyRelease,
} from "./release/artifact.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { values } = parseArgs({
  options: {
    version: { type: "string" },
    "allow-dirty": { type: "boolean", default: false },
  },
});
const git = (...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const commit = git("rev-parse", "HEAD");
const dirty = git("status", "--porcelain").length > 0;
if (dirty && !values["allow-dirty"])
  throw new Error(
    "Release source is dirty; commit changes or use --allow-dirty for local verification only.",
  );
const version = values.version ?? `dev-${commit.slice(0, 12)}`;
if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(version))
  throw new Error("Invalid release version");
const output = join(root, "dist", "releases", version);
try {
  await access(output);
  throw new Error(`Release already exists: ${version}`);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const { rawConfig: config } = experimental_readRawConfig({
  config: join(root, "wrangler.toml"),
});
const settings = releaseSettings(config);
await mkdir(dirname(output), { recursive: true });
const temporary = await mkdtemp(join(dirname(output), ".build-"));
// Build offline from the public config, never run prepare-cloudflare-build hooks.
const env = {
  ...process.env,
  WORKERS_CI: "0",
  WRANGLER_SEND_METRICS: "false",
  CI: "true",
};
const node = (args, cwd = root) =>
  execFileSync(process.execPath, args, { cwd, env, stdio: "inherit" });
try {
  const assets = join(temporary, "web");
  node(
    [
      join(root, "node_modules/vite/bin/vite.js"),
      "build",
      "--outDir",
      assets,
      "--emptyOutDir",
    ],
    join(root, "apps/web"),
  );
  const multipart = join(temporary, "worker.multipart");
  node([
    join(root, "node_modules/wrangler/bin/wrangler.js"),
    "deploy",
    "--dry-run",
    "--config",
    join(root, "wrangler.toml"),
    "--assets",
    assets,
    "--outfile",
    multipart,
  ]);
  const worker = await unpackWorker(await readFile(multipart), settings);
  const directory = join(temporary, "release");
  await mkdir(directory);
  const result = await assembleRelease({
    directory,
    version,
    commit,
    sourceDirty: dirty,
    settings,
    worker,
    assetDirectory: assets,
    migrationDirectory: resolve(root, config.d1_databases[0].migrations_dir),
  });
  await verifyRelease(directory, result.digest);
  // mkdir without recursive reserves this version against concurrent writers.
  await mkdir(output);
  try {
    for (const path of [
      "worker",
      "assets",
      "migrations",
      "assets-manifest.json",
      "release.json",
      "release.sha256",
    ]) {
      await rename(join(directory, path), join(output, path));
    }
  } catch (error) {
    await rm(output, { recursive: true, force: true });
    throw error;
  }
  console.log(`Release ${version}: ${result.digest}\n${output}`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}
