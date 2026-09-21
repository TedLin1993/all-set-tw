import { bytesToBase64, sha256Hex } from "../../src/platform/crypto";

const encoder = new TextEncoder();

export class MemoryR2Bucket {
  readonly objects = new Map<string, Uint8Array>();

  async get(key: string) {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    const copy = new Uint8Array(bytes);
    return {
      arrayBuffer: async () =>
        copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
      text: async () => new TextDecoder().decode(copy),
    };
  }

  putBytes(key: string, bytes: Uint8Array | string) {
    this.objects.set(
      key,
      typeof bytes === "string" ? encoder.encode(bytes) : bytes.slice(),
    );
  }
}

export async function seedPublishedRelease(
  bucket: MemoryR2Bucket,
  options?: {
    version?: string;
    worker?: string;
    html?: string;
    extraModule?: { name: string; path: string; source: string };
    allowedUpgradeFrom?: string[];
  },
) {
  const version = options?.version ?? "v0.1.0";
  const worker =
    options?.worker ??
    "export default { fetch() { return new Response('ok'); } };";
  const html = options?.html ?? "<!doctype html><title>不用記帳</title>";
  const files: Array<{ path: string; size: number; sha256: string }> = [];

  const putFile = async (path: string, contents: string) => {
    const bytes = encoder.encode(contents);
    files.push({
      path,
      size: bytes.byteLength,
      sha256: await sha256Hex(bytes),
    });
    bucket.putBytes(`releases/${version}/${path}`, bytes);
    return bytes;
  };

  await putFile("worker/index.js", worker);
  const extra = options?.extraModule;
  if (extra) {
    await putFile(extra.path, extra.source);
  }
  const htmlBytes = await putFile("assets/index.html", html);
  const assetsManifest = {
    "/index.html": {
      hash: "r2-index-html",
      size: htmlBytes.byteLength,
    },
  };
  await putFile(
    "assets-manifest.json",
    `${JSON.stringify(assetsManifest, null, 2)}\n`,
  );
  await putFile(
    "migrations/0001_initial.sql",
    "CREATE TABLE IF NOT EXISTS probe (\n  id INTEGER PRIMARY KEY\n);\n",
  );

  const modules = [
    {
      name: "index.js",
      path: "worker/index.js",
      contentType: "application/javascript+module",
    },
  ];
  if (extra) {
    modules.push({
      name: extra.name,
      path: extra.path,
      contentType: "application/javascript+module",
    });
  }

  const manifest = {
    schemaVersion: 1,
    version,
    allowedUpgradeFrom: options?.allowedUpgradeFrom ?? [],
    deployment: {
      compatibilityDate: "2026-06-01",
      compatibilityFlags: ["nodejs_compat"],
      crons: ["*/10 * * * *"],
    },
    worker: { mainModule: "index.js", modules },
    assetsManifest: "assets-manifest.json",
    migrations: [
      { name: "0001_initial.sql", path: "migrations/0001_initial.sql" },
    ],
    files: files.sort((a, b) => (a.path < b.path ? -1 : 1)),
  };
  const jsonBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const digest = await sha256Hex(jsonBytes);
  bucket.putBytes(`releases/${version}/release.json`, jsonBytes);
  bucket.putBytes(`releases/${version}/release.sha256`, `${digest}\n`);
  bucket.putBytes("releases/latest", `${version}\n`);
  return {
    version,
    digest,
    htmlSize: htmlBytes.byteLength,
    htmlBase64: bytesToBase64(htmlBytes),
    bucket: bucket as unknown as R2Bucket,
  };
}
