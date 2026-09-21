import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assembleRelease,
  assetHash,
  releaseSettings,
  sha256,
  unpackWorker,
  verifyRelease,
} from "./artifact.mjs";

const config = {
  compatibility_date: "2026-06-01",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  preview_urls: false,
  assets: { binding: "ASSETS" },
  browser: { binding: "BROWSER" },
  ai: { binding: "AI" },
  d1_databases: [{ binding: "DB" }],
  queues: {
    producers: [{ binding: "SYNC_QUEUE", queue: "sync" }],
    consumers: [{ queue: "sync", max_batch_size: 1 }],
  },
};
const settings = releaseSettings(config);
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "all-set-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetDirectory = join(root, "web");
  const migrationDirectory = join(root, "sql");
  await mkdir(assetDirectory);
  await mkdir(migrationDirectory);
  await writeFile(join(assetDirectory, "index.html"), "<h1>私人財務</h1>");
  await writeFile(
    join(migrationDirectory, "0001_initial.sql"),
    "-- keep CRLF and SQL semicolons\r\nSELECT 'a;b';\r\n",
  );
  const directory = join(root, "release");
  await mkdir(directory);
  const options = {
    directory,
    assetDirectory,
    migrationDirectory,
    version: "v0.1.0",
    commit: "a".repeat(40),
    sourceDirty: false,
    settings,
    worker: {
      mainModule: "index.js",
      modules: [
        {
          name: "index.js",
          contentType: "application/javascript+module",
          bytes: Buffer.from("export default {};"),
        },
      ],
    },
  };
  return { root, options, result: await assembleRelease(options) };
}

test("release preserves migrations, is deterministic, and verifies against a trusted digest", async (t) => {
  const { root, options, result } = await fixture(t);
  const verified = await verifyRelease(options.directory, result.digest);
  assert.equal(verified.manifest.migrations.length, 1);
  assert.deepEqual(
    await readFile(join(options.directory, "migrations/0001_initial.sql")),
    await readFile(join(options.migrationDirectory, "0001_initial.sql")),
  );
  const second = join(root, "second");
  await mkdir(second);
  assert.equal(
    (await assembleRelease({ ...options, directory: second })).digest,
    result.digest,
  );
  await assert.rejects(assembleRelease(options), /EEXIST/);
  assert.deepEqual(verified.manifest.allowedUpgradeFrom, []);
});

test("rejects modified, missing, and extra files", async (t) => {
  const { options, result } = await fixture(t);
  const path = join(options.directory, "worker/index.js");
  const original = await readFile(path);
  await writeFile(path, "tampered");
  await assert.rejects(
    verifyRelease(options.directory, result.digest),
    /integrity mismatch/,
  );
  await writeFile(path, original);
  await writeFile(join(options.directory, "unexpected.txt"), "extra");
  await assert.rejects(
    verifyRelease(options.directory),
    /Unexpected release files/,
  );
  await rm(join(options.directory, "unexpected.txt"));
  await rm(path);
  await assert.rejects(verifyRelease(options.directory), /ENOENT/);
});

test("trusted manifest digest detects a rewritten checksum file", async (t) => {
  const { options, result } = await fixture(t);
  const manifest = { ...result.manifest, version: "forged" };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(options.directory, "release.json"), bytes);
  await writeFile(join(options.directory, "release.sha256"), sha256(bytes));
  await assert.rejects(
    verifyRelease(options.directory, result.digest),
    /digest mismatch/,
  );
});

test("rejects traversal and symlinks before reading release files", async (t) => {
  const { options, result } = await fixture(t);
  await symlink(options.assetDirectory, join(options.directory, "outside"));
  await assert.rejects(verifyRelease(options.directory), /Symlink/);
  await rm(join(options.directory, "outside"));
  result.manifest.files[0].path = "../secret";
  const bytes = JSON.stringify(result.manifest);
  await writeFile(join(options.directory, "release.json"), bytes);
  await writeFile(join(options.directory, "release.sha256"), sha256(bytes));
  await assert.rejects(
    verifyRelease(options.directory),
    /Invalid release path/,
  );
});

test("asset hashing is extension-sensitive and asset manifest is checked", async (t) => {
  assert.notEqual(
    assetHash(Buffer.from("same"), "a.js"),
    assetHash(Buffer.from("same"), "a.txt"),
  );
  const { options, result } = await fixture(t);
  const bytes = JSON.stringify({
    "/index.html": { hash: "0".repeat(32), size: 1 },
  });
  await writeFile(join(options.directory, "assets-manifest.json"), bytes);
  Object.assign(
    result.manifest.files.find((file) => file.path === "assets-manifest.json"),
    { size: Buffer.byteLength(bytes), sha256: sha256(bytes) },
  );
  const manifest = JSON.stringify(result.manifest);
  await writeFile(join(options.directory, "release.json"), manifest);
  await writeFile(join(options.directory, "release.sha256"), sha256(manifest));
  await assert.rejects(
    verifyRelease(options.directory),
    /Asset manifest mismatch/,
  );
});

test("release config rejects private IDs and unhandled bindings", () => {
  assert.throws(
    () =>
      releaseSettings({
        ...config,
        vars: { CONFIG_ENCRYPTION_KEY: "never-publish" },
      }),
    /Unsupported release config/,
  );
  assert.throws(
    () =>
      releaseSettings({
        ...config,
        d1_databases: [{ binding: "DB", database_id: "private-id" }],
      }),
    /unprovisioned/,
  );
  assert.throws(
    () => releaseSettings({ ...config, preview_urls: true }),
    /preview/,
  );
});

test("extracts multipart module types and rejects a secret from the Wrangler output", async () => {
  const metadata = {
    main_module: "index.js",
    compatibility_date: settings.compatibilityDate,
    compatibility_flags: settings.compatibilityFlags,
    bindings: settings.bindings.map((binding) => ({
      name: binding.name,
      type: binding.type === "d1" ? "inherit" : binding.type,
    })),
  };
  async function multipart() {
    const form = new FormData();
    form.set("metadata", JSON.stringify(metadata));
    form.set(
      "index.js",
      new Blob(["export default {};"], {
        type: "application/javascript+module",
      }),
      "index.js",
    );
    return Buffer.from(await new Response(form).arrayBuffer());
  }
  const worker = await unpackWorker(await multipart(), settings);
  assert.equal(worker.mainModule, "index.js");
  assert.equal(worker.modules[0].contentType, "application/javascript+module");
  metadata.bindings.push({
    name: "PRIVATE_KEY",
    type: "secret_text",
    text: "must-not-leak",
  });
  await assert.rejects(
    unpackWorker(await multipart(), settings),
    /sensitive binding/,
  );
});

test("public wrangler.toml is a valid unprovisioned release config", async () => {
  const { experimental_readRawConfig } = await import("wrangler");
  const { rawConfig } = experimental_readRawConfig({
    config: new URL("../../wrangler.toml", import.meta.url).pathname,
  });
  const actual = releaseSettings(rawConfig);
  assert.equal(actual.workersDev, true);
  assert.equal(actual.previewUrls, false);
  assert.deepEqual(
    actual.bindings.map((binding) => binding.name).sort(),
    ["AI", "ASSETS", "BROWSER", "DB", "SYNC_QUEUE"].sort(),
  );
});
