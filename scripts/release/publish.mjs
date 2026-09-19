import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { verifyRelease } from "./artifact.mjs";

export function plannedPublishObjects(directory, manifest) {
  const prefix = `releases/${manifest.version}`;
  return [
    ...manifest.files.map((file) => ({
      key: `${prefix}/${file.path}`,
      file: join(directory, file.path),
      sha256: file.sha256,
    })),
    {
      key: `${prefix}/release.json`,
      file: join(directory, "release.json"),
    },
    {
      key: `${prefix}/release.sha256`,
      file: join(directory, "release.sha256"),
    },
    {
      key: "releases/latest",
      contents: `${manifest.version}\n`,
      mutable: true,
    },
  ];
}

export function formatPublishPlan(result) {
  const lines = [
    `${result.mode === "execute" ? "Published" : "Dry-run"} ${result.manifest.version}: SHA-256 ${result.digest}`,
    ...result.objects.map((object) =>
      object.key === "releases/latest"
        ? `  ${object.key} -> ${result.manifest.version}`
        : `  ${object.key}`,
    ),
  ];
  if (result.mode === "dry-run") {
    lines.push(
      "Not uploaded. Re-run with --execute --bucket <name> after verifying the plan.",
    );
  }
  return lines.join("\n");
}

export async function publishRelease({
  directory,
  digest,
  execute = false,
  bucket,
  store,
}) {
  const verified = await verifyRelease(directory, digest);
  if (verified.manifest.sourceDirty) {
    throw new Error("Dirty release is not publishable");
  }
  const objects = plannedPublishObjects(directory, verified.manifest);
  if (!execute) {
    return { mode: "dry-run", ...verified, objects, uploaded: [] };
  }
  if (!bucket) throw new Error("Publishing requires --bucket");
  if (!store) throw new Error("Publishing requires an object store");
  for (const object of objects) {
    if (object.mutable) continue;
    if (await store.exists(bucket, object.key)) {
      throw new Error(`Refusing to overwrite ${object.key}`);
    }
  }
  const uploaded = [];
  for (const object of objects) {
    await store.put(bucket, object);
    uploaded.push(object.key);
  }
  return { mode: "execute", ...verified, objects, uploaded };
}

export function createMemoryObjectStore(existing = new Map()) {
  const puts = [];
  return {
    puts,
    existing,
    async exists(_bucket, key) {
      return existing.has(key);
    },
    async put(_bucket, object) {
      const body =
        object.contents ?? (await readFile(object.file ?? object.key));
      existing.set(object.key, body);
      puts.push(object.key);
    },
  };
}
