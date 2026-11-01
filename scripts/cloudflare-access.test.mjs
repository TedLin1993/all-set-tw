import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";
import { parseEnv } from "node:util";
import { deploy } from "./deploy-with-vapid.mjs";

const accountId = "test-account";
const workerName = "taiwan-fin-hub";
const config = { name: workerName, vars: {} };
const environment = {
  WORKERS_CI: "1",
  CLOUDFLARE_ACCOUNT_ID: accountId,
  CLOUDFLARE_API_TOKEN: "test-build-token",
};
const accessSecrets = {
  TEAM_DOMAIN: "https://test-team.cloudflareaccess.com",
  POLICY_AUD: "worker-application-audience",
};
const vapidSecrets = {
  VAPID_PUBLIC_KEY: "existing-public",
  VAPID_PRIVATE_KEY: "existing-private",
};
const workerUrl = `https://${workerName}.test-subdomain.workers.dev/`;
const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
});
const publicJwk = {
  ...publicKey.export({ format: "jwk" }),
  kid: "metadata-key",
  alg: "RS256",
};

function signedMetadata(extra = {}) {
  const header = Buffer.from(
    JSON.stringify({ alg: "RS256", kid: publicJwk.kid }),
  ).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      type: "match",
      hostname: new URL(workerUrl).hostname,
      auth_domain: new URL(accessSecrets.TEAM_DOMAIN).hostname,
      aud: accessSecrets.POLICY_AUD,
      iat: Math.floor(Date.now() / 1000),
      ...extra,
    }),
  ).toString("base64url");
  const data = `${header}.${payload}`;
  return `${data}.${sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url")}`;
}

function publicAccess({
  metadata = signedMetadata(),
  missingResponses = 0,
  url: applicationUrl = workerUrl,
} = {}) {
  const calls = [];
  let heads = 0;
  const fetchPublic = async (url, options) => {
    calls.push(url);
    assert.equal(new Headers(options.headers).has("Authorization"), false);
    assert.equal(options.redirect, "manual");
    if (url === applicationUrl) {
      assert.equal(options.method, "HEAD");
      assert.equal(options.headers["cf-access-metadata-request"], "true");
      heads += 1;
      return new Response(null, {
        status: 200,
        headers:
          heads <= missingResponses || !metadata
            ? {}
            : { "cf-access-metadata": metadata },
      });
    }
    assert.equal(url, `${accessSecrets.TEAM_DOMAIN}/cdn-cgi/access/certs`);
    return Response.json({ keys: [publicJwk] });
  };
  return { calls, fetchPublic };
}

function response(result) {
  return Response.json({
    success: true,
    result,
  });
}

function cloudflare({ deniedPath } = {}) {
  const state = { calls: [] };
  const fetchApi = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    state.calls.push({ method: options.method, path, body });
    assert.equal(
      options.headers.Authorization,
      `Bearer ${environment.CLOUDFLARE_API_TOKEN}`,
    );
    if (path.endsWith(deniedPath ?? "never-match")) {
      return Response.json(
        {
          success: false,
          errors: [{ code: 10000, message: "Do not log test-build-token" }],
        },
        { status: 403 },
      );
    }
    if (path.endsWith("/workers/subdomain"))
      return response({ subdomain: "test-subdomain" });
    assert.fail(`Unexpected API call: ${options.method} ${path}`);
  };
  return { state, fetchApi };
}

function deploymentRunner({ initialSecrets = {}, failDeployment = 0 } = {}) {
  const runtimeSecrets = { CONFIG_ENCRYPTION_KEY: "auto", ...initialSecrets };
  const uploads = [];
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "queues")
      return { exitCode: 0, stdout: "Queue exists", stderr: "" };
    if (args[0] === "secret")
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          Object.keys(runtimeSecrets).map((name) => ({ name })),
        ),
        stderr: "",
      };
    if (args[0] === "d1")
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          { success: true, results: [{ has_encrypted_data: 0 }] },
        ]),
        stderr: "",
      };
    assert.equal(args[0], "deploy");
    const file = args[args.indexOf("--secrets-file") + 1];
    let secrets = {};
    if (args.includes("--secrets-file")) {
      const content = await readFile(file, "utf8");
      secrets = file.endsWith(".json")
        ? JSON.parse(content)
        : parseEnv(content);
      if (file.includes("taiwan-fin-hub-deploy-"))
        assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    uploads.push({
      args,
      secrets,
      file: args.includes("--secrets-file") ? file : null,
    });
    if (uploads.length === failDeployment) return { exitCode: 2 };
    Object.assign(runtimeSecrets, secrets);
    return { exitCode: 0 };
  };
  return { run, runtimeSecrets, uploads, calls };
}

function options(api, runner, extra = {}) {
  return {
    run: runner.run,
    environment,
    readConfig: async () => config,
    fetchApi: api.fetchApi,
    fetchPublic: publicAccess().fetchPublic,
    ...extra,
  };
}

test("unverified Access metadata is never deployed as runtime credentials", async (t) => {
  const valid = signedMetadata();
  const [header, payload] = valid.split(".");
  const cases = [
    [
      "invalid signature",
      `${header}.${payload}.${Buffer.alloc(256).toString("base64url")}`,
    ],
    [
      "different hostname",
      signedMetadata({ hostname: "other-worker.test-subdomain.workers.dev" }),
    ],
    [
      "expired metadata",
      signedMetadata({ iat: Math.floor(Date.now() / 1000) - 86401 }),
    ],
    ["no matching application", signedMetadata({ type: "no_match" })],
    [
      "untrusted auth domain",
      signedMetadata({ auth_domain: "attacker.example" }),
    ],
  ];
  for (const [name, metadata] of cases) {
    await t.test(name, async () => {
      const api = cloudflare();
      const publicApi = publicAccess({ metadata });
      const runner = deploymentRunner({ initialSecrets: vapidSecrets });
      await assert.rejects(
        deploy(
          [],
          options(api, runner, {
            fetchPublic: publicApi.fetchPublic,
          }),
        ),
        /metadata could not be verified/,
      );
      assert.equal(runner.uploads.length, 1);
      assert.equal(runner.runtimeSecrets.TEAM_DOMAIN, undefined);
      assert.equal(runner.runtimeSecrets.POLICY_AUD, undefined);
      if (name === "untrusted auth domain")
        assert.deepEqual(publicApi.calls, [workerUrl]);
    });
  }
});

test("subdomain permission errors do not expose response bodies or write verification secrets", async () => {
  const api = cloudflare({ deniedPath: "/workers/subdomain" });
  const runner = deploymentRunner({ initialSecrets: vapidSecrets });
  await assert.rejects(deploy([], options(api, runner)), (error) => {
    assert.match(error.message, /HTTP 403, codes 10000/);
    assert.doesNotMatch(error.message, /test-build-token/);
    return true;
  });
  assert.equal(runner.uploads.length, 1);
  assert.equal(runner.runtimeSecrets.TEAM_DOMAIN, undefined);
  assert.equal(runner.runtimeSecrets.POLICY_AUD, undefined);
  assert.ok(api.state.calls.every((call) => call.method === "GET"));
});

test("dry-run performs no Access queries, Queue provisioning, or secret writes", async () => {
  const calls = [];
  assert.equal(
    await deploy(["--dry-run"], {
      environment,
      run: async (args) => {
        calls.push(args);
        return { exitCode: 0 };
      },
      readConfig: async () => assert.fail("Dry-run must not read credentials"),
      fetchApi: async () => assert.fail("Dry-run must not call Cloudflare"),
    }),
    0,
  );
  assert.deepEqual(calls, [["deploy", "--dry-run"]]);
});

test("Access setup and later deployments preserve the generated encryption key and VAPID pair", async () => {
  const api = cloudflare();
  const runner = deploymentRunner();
  assert.equal(await deploy([], options(api, runner)), 0);
  assert.equal(runner.uploads.length, 2);
  const encryptionKey = runner.runtimeSecrets.GENERATED_CONFIG_ENCRYPTION_KEY;
  assert.match(encryptionKey, /^[0-9a-f]{64}$/);
  const initialSecrets = { ...runner.runtimeSecrets };
  assert.deepEqual(runner.uploads[1].secrets, accessSecrets);
  assert.equal(await deploy([], options(api, runner)), 0);
  assert.deepEqual(runner.runtimeSecrets, initialSecrets);
  assert.deepEqual(runner.uploads[2].secrets, {});
  assert.equal(runner.calls.filter((args) => args[0] === "d1").length, 1);
  for (const upload of runner.uploads) {
    if (upload.file)
      await assert.rejects(readFile(upload.file), { code: "ENOENT" });
    assert.equal(upload.args.includes(encryptionKey), false);
  }
});
