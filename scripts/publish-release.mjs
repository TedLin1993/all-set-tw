import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { formatPublishPlan, publishRelease } from "./release/publish.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerScript = join(root, "node_modules/wrangler/bin/wrangler.js");
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    sha256: { type: "string" },
    bucket: { type: "string" },
    execute: { type: "boolean", default: false },
  },
});
if (positionals.length !== 1) {
  throw new Error(
    "Usage: npm run release:publish -- <directory> [--sha256 <trusted digest>] [--bucket <name>] [--execute]",
  );
}

function runWrangler(args) {
  return new Promise((resolveRun) => {
    const child = spawn(process.execPath, [wranglerScript, ...args], {
      cwd: root,
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (exitCode) => {
      resolveRun({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

function createWranglerR2Store(run = runWrangler) {
  return {
    async exists(bucket, key) {
      const result = await run([
        "r2",
        "object",
        "get",
        `${bucket}/${key}`,
        "--remote",
      ]);
      if (result.exitCode === 0) return true;
      const output = `${result.stdout}\n${result.stderr}`;
      if (/not found|does not exist|404|10007|10092/i.test(output)) {
        return false;
      }
      throw new Error(output.trim() || "R2 get failed");
    },
    async put(bucket, object) {
      const temporary = object.contents
        ? await mkdtemp(join(tmpdir(), "all-set-release-publish-"))
        : null;
      const file = object.file ?? join(temporary, "latest");
      try {
        if (object.contents) await writeFile(file, object.contents);
        const result = await run([
          "r2",
          "object",
          "put",
          `${bucket}/${object.key}`,
          "--file",
          file,
          "--remote",
        ]);
        if (result.exitCode !== 0) {
          throw new Error(
            `${result.stderr || result.stdout}`.trim() || "R2 put failed",
          );
        }
      } finally {
        if (temporary) await rm(temporary, { recursive: true, force: true });
      }
    },
  };
}

const result = await publishRelease({
  directory: resolve(positionals[0]),
  digest: values.sha256,
  execute: values.execute,
  bucket: values.bucket ?? process.env.ALL_SET_RELEASE_BUCKET,
  store: values.execute ? createWranglerR2Store() : undefined,
});
console.log(formatPublishPlan(result));
