import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { ensureRequiredQueues } from "./deploy-with-vapid.mjs";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryDirectory = resolve(dirname(scriptPath), "..");

export function isWorkersBuild(environment = process.env) {
  return environment.WORKERS_CI === "1";
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === scriptPath &&
  isWorkersBuild()
) {
  console.log("[build] Preparing Cloudflare resources.");
  await ensureRequiredQueues([
    "--config",
    resolve(repositoryDirectory, "wrangler.toml"),
  ]);
}
