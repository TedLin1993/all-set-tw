import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const workerDirectory = path.join(projectRoot, "apps", "worker");
const relayToken = randomBytes(32).toString("hex");

const relay = createServer(async (request, response) => {
  try {
    if (
      request.method !== "POST" ||
      request.url !== "/ctbc" ||
      request.headers["x-ctbc-relay-token"] !== relayToken
    ) {
      response.writeHead(404).end();
      return;
    }

    const requestBody = await readRequest(request, MAX_REQUEST_BYTES);
    const payload = JSON.parse(requestBody);
    const target = new URL(payload.url);
    if (
      target.origin !== "https://eb.ctbcbank.com" ||
      !target.pathname.startsWith("/IMP/") ||
      payload.method !== "POST" ||
      typeof payload.body !== "string" ||
      !isStringRecord(payload.headers)
    ) {
      response.writeHead(400).end();
      return;
    }

    const upstream = await fetch(target, {
      method: "POST",
      headers: payload.headers,
      body: payload.body,
      redirect: "manual",
    });
    const bytes = new Uint8Array(await upstream.arrayBuffer());
    if (bytes.byteLength > MAX_RESPONSE_BYTES) {
      response.writeHead(502).end();
      return;
    }
    const responseHeaders = {};
    for (const name of ["content-type", "x-auth-token"]) {
      const value = upstream.headers.get(name);
      if (value) responseHeaders[name] = value;
    }
    response.writeHead(upstream.status, responseHeaders).end(bytes);
  } catch (error) {
    const status = error?.code === "REQUEST_TOO_LARGE" ? 413 : 502;
    response.writeHead(status).end();
  }
});

await new Promise((resolve, reject) => {
  relay.once("error", reject);
  relay.listen(0, "127.0.0.1", resolve);
});
const address = relay.address();
if (!address || typeof address === "string") {
  throw new Error("Unable to resolve the CTBC local relay address.");
}

console.log(`CTBC local relay ready on 127.0.0.1:${address.port}`);
const wrangler = spawn(
  "npx",
  [
    "wrangler",
    "dev",
    "-c",
    "wrangler.local.toml",
    "--port",
    "8787",
    "--var",
    `CTBC_API_RELAY_URL:http://127.0.0.1:${address.port}/ctbc`,
    "--var",
    `CTBC_API_RELAY_TOKEN:${relayToken}`,
  ],
  {
    cwd: workerDirectory,
    env: {
      ...process.env,
      X_BROWSER_HEADFUL: process.env.X_BROWSER_HEADFUL ?? "true",
      XDG_CONFIG_HOME: path.join(projectRoot, ".wrangler-config"),
    },
    stdio: "inherit",
  },
);

let stopping = false;
const stop = (signal) => {
  if (stopping) return;
  stopping = true;
  wrangler.kill(signal);
  relay.close();
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
wrangler.once("exit", (code, signal) => {
  relay.close(() => process.exit(signal ? 1 : (code ?? 1)));
});

async function readRequest(request, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) {
      const error = new Error("Request too large.");
      error.code = "REQUEST_TOO_LARGE";
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function isStringRecord(value) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string")
  );
}
