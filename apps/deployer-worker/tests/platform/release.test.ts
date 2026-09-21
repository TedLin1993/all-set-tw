import { describe, expect, it } from "vitest";
import {
  loadRelease,
  readCurrentRelease,
  ReleaseUnavailableError,
} from "../../src/platform/release";
import type { Env } from "../../src/platform/env";
import { MemoryR2Bucket, seedPublishedRelease } from "./memory-r2";

function envWithBucket(bucket: MemoryR2Bucket): Env {
  return {
    RELEASE_BUCKET: bucket as unknown as R2Bucket,
  } as Env;
}

describe("R2 release loading", () => {
  it("loads worker modules, migrations, and assets after verifying SHA-256", async () => {
    const bucket = new MemoryR2Bucket();
    const published = await seedPublishedRelease(bucket, {
      extraModule: {
        name: "chunk.js",
        path: "worker/chunk.js",
        source: "export const chunk = 1;",
      },
    });
    const current = await readCurrentRelease(envWithBucket(bucket));
    expect(current).toEqual({
      version: "v0.1.0",
      digest: published.digest,
      source: "r2",
    });

    const release = await loadRelease(
      envWithBucket(bucket),
      published.version,
      published.digest,
    );
    expect(release.source).toBe("r2");
    expect(release.workerMain).toBe("index.js");
    expect(release.workerModules.map((module) => module.name)).toEqual([
      "index.js",
      "chunk.js",
    ]);
    expect(release.migrations).toEqual([
      {
        name: "0001_initial.sql",
        sql: "CREATE TABLE IF NOT EXISTS probe (\n  id INTEGER PRIMARY KEY\n);\n",
      },
    ]);
    expect(release.assets).toEqual([
      {
        path: "/index.html",
        hash: "r2-index-html",
        size: published.htmlSize,
        contentBase64: published.htmlBase64,
      },
    ]);
  });

  it("rejects a pinned digest that does not match release.json", async () => {
    const bucket = new MemoryR2Bucket();
    const published = await seedPublishedRelease(bucket);
    await expect(
      loadRelease(envWithBucket(bucket), published.version, "a".repeat(64)),
    ).rejects.toMatchObject({
      name: "ReleaseUnavailableError",
      code: "RELEASE_DIGEST_MISMATCH",
    });
  });

  it("rejects a tampered worker module", async () => {
    const bucket = new MemoryR2Bucket();
    const published = await seedPublishedRelease(bucket);
    bucket.putBytes(
      "releases/v0.1.0/worker/index.js",
      "export default { tampered: true };",
    );
    await expect(
      loadRelease(envWithBucket(bucket), published.version, published.digest),
    ).rejects.toBeInstanceOf(ReleaseUnavailableError);
  });

  it("rejects a rewritten checksum file", async () => {
    const bucket = new MemoryR2Bucket();
    await seedPublishedRelease(bucket);
    bucket.putBytes("releases/v0.1.0/release.sha256", `${"b".repeat(64)}\n`);
    await expect(
      readCurrentRelease(envWithBucket(bucket)),
    ).rejects.toMatchObject({
      code: "RELEASE_DIGEST_MISMATCH",
    });
  });

  it("does not fall back to the local fixture when R2 is bound", async () => {
    await expect(
      readCurrentRelease({ LOCAL_DEV_MODE: true } as Env),
    ).resolves.toMatchObject({ source: "local_fixture" });
    await expect(
      readCurrentRelease(envWithBucket(new MemoryR2Bucket())),
    ).rejects.toMatchObject({ code: "RELEASE_UNAVAILABLE" });
  });
});
