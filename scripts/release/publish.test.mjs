import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assembleRelease, releaseSettings } from "./artifact.mjs";
import {
  createMemoryObjectStore,
  formatPublishPlan,
  plannedPublishObjects,
  publishRelease,
} from "./publish.mjs";

const settings = releaseSettings({
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
});

async function fixture(t, sourceDirty = false) {
  const root = await mkdtemp(join(tmpdir(), "all-set-publish-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const assetDirectory = join(root, "web");
  const migrationDirectory = join(root, "sql");
  await mkdir(assetDirectory);
  await mkdir(migrationDirectory);
  await writeFile(join(assetDirectory, "index.html"), "<h1>私人財務</h1>");
  await writeFile(
    join(migrationDirectory, "0001_initial.sql"),
    "CREATE TABLE probe(id INTEGER PRIMARY KEY);\n",
  );
  const directory = join(root, "release");
  await mkdir(directory);
  const result = await assembleRelease({
    directory,
    assetDirectory,
    migrationDirectory,
    version: "v0.1.0",
    commit: "a".repeat(40),
    sourceDirty,
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
  });
  return { directory, result };
}

test("dry-run lists immutable version keys and latest last without uploading", async (t) => {
  const { directory, result } = await fixture(t);
  const published = await publishRelease({ directory, digest: result.digest });
  assert.equal(published.mode, "dry-run");
  assert.equal(published.uploaded.length, 0);
  assert.equal(published.objects.at(-1)?.key, "releases/latest");
  assert.deepEqual(
    plannedPublishObjects(directory, result.manifest)
      .filter((object) => !object.mutable)
      .map((object) => object.key)
      .sort(),
    [
      "releases/v0.1.0/assets-manifest.json",
      "releases/v0.1.0/assets/index.html",
      "releases/v0.1.0/migrations/0001_initial.sql",
      "releases/v0.1.0/release.json",
      "releases/v0.1.0/release.sha256",
      "releases/v0.1.0/worker/index.js",
    ].sort(),
  );
  const output = formatPublishPlan(published);
  assert.match(output, /Dry-run v0.1.0/);
  assert.match(output, /Not uploaded/);
  assert.doesNotMatch(output, /Published /);
});

test("execute writes version objects then latest and refuses overwrites", async (t) => {
  const { directory, result } = await fixture(t);
  const store = createMemoryObjectStore();
  const published = await publishRelease({
    directory,
    digest: result.digest,
    execute: true,
    bucket: "all-set-deployer-releases",
    store,
  });
  assert.equal(published.mode, "execute");
  assert.equal(store.puts.at(-1), "releases/latest");
  assert.equal(store.existing.get("releases/latest").toString(), "v0.1.0\n");
  await assert.rejects(
    publishRelease({
      directory,
      digest: result.digest,
      execute: true,
      bucket: "all-set-deployer-releases",
      store,
    }),
    /Refusing to overwrite/,
  );
});

test("rejects dirty releases and execute without a bucket", async (t) => {
  const { directory } = await fixture(t, true);
  await assert.rejects(publishRelease({ directory }), /not publishable/);
  const clean = await fixture(t);
  await assert.rejects(
    publishRelease({
      directory: clean.directory,
      digest: clean.result.digest,
      execute: true,
      store: createMemoryObjectStore(),
    }),
    /requires --bucket/,
  );
});
