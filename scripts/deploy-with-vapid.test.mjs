import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseEnv, promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { deploy } from "./deploy-with-vapid.mjs";

const vapidSecrets = {
  VAPID_PUBLIC_KEY: "synthetic-existing-public",
  VAPID_PRIVATE_KEY: "synthetic-existing-private",
};

function deploymentRunner({
  initialSecrets = { CONFIG_ENCRYPTION_KEY: "auto" },
  inspectData = () => 0,
  databaseResult,
  failDeployment = false,
} = {}) {
  const runtimeSecrets = { ...initialSecrets };
  const calls = [];
  const uploads = [];
  const run = async (args) => {
    calls.push(args);
    if (args[0] === "secret") {
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          Object.keys(runtimeSecrets).map((name) => ({ name })),
        ),
        stderr: "",
      };
    }
    if (args[0] === "d1") {
      const query = args[args.indexOf("--command") + 1];
      return (
        databaseResult ?? {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              success: true,
              results: [{ has_encrypted_data: inspectData(query) }],
            },
          ]),
          stderr: "",
        }
      );
    }
    assert.equal(args[0], "deploy");
    const file = args.includes("--secrets-file")
      ? args[args.indexOf("--secrets-file") + 1]
      : null;
    const content = file ? await readFile(file, "utf8") : null;
    const secrets = content
      ? file.endsWith(".json")
        ? JSON.parse(content)
        : parseEnv(content)
      : {};
    if (file) assert.equal((await stat(file)).mode & 0o777, 0o600);
    uploads.push({ file, secrets });
    if (failDeployment) return { exitCode: 2 };
    Object.assign(runtimeSecrets, secrets);
    return { exitCode: 0 };
  };
  return {
    run,
    calls,
    uploads,
    runtimeSecrets,
    options: {
      run,
      environment: {},
      readConfig: async () => ({ name: "all-set-tw", vars: {} }),
    },
  };
}

test("first auto deployment creates a private random key and later updates preserve it", async (t) => {
  const logs = [];
  t.mock.method(console, "log", (...args) => logs.push(args.join(" ")));
  const runner = deploymentRunner({
    initialSecrets: { CONFIG_ENCRYPTION_KEY: "auto", ...vapidSecrets },
  });
  const args = ["--config", "wrangler.private.toml", "--env", "production"];
  assert.equal(await deploy(args, runner.options), 0);
  const key = runner.runtimeSecrets.GENERATED_CONFIG_ENCRYPTION_KEY;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepEqual(runner.uploads[0].secrets, {
    GENERATED_CONFIG_ENCRYPTION_KEY: key,
  });
  assert.equal(runner.runtimeSecrets.CONFIG_ENCRYPTION_KEY, "auto");
  assert.equal(
    runner.runtimeSecrets.VAPID_PRIVATE_KEY,
    vapidSecrets.VAPID_PRIVATE_KEY,
  );
  const d1Call = runner.calls.find((call) => call[0] === "d1");
  assert.deepEqual(d1Call.slice(0, 6), [
    "d1",
    "execute",
    "DB",
    "--remote",
    "--json",
    "--command",
  ]);
  assert.deepEqual(d1Call.slice(7), args);
  assert.equal(await deploy(args, runner.options), 0);
  assert.equal(runner.runtimeSecrets.GENERATED_CONFIG_ENCRYPTION_KEY, key);
  assert.deepEqual(runner.uploads[1].secrets, {});
  assert.equal(runner.calls.filter((call) => call[0] === "d1").length, 1);
  assert.ok(logs.every((line) => !line.includes(key)));
  assert.ok(runner.calls.every((call) => !call.includes(key)));
  await assert.rejects(readFile(runner.uploads[0].file), { code: "ENOENT" });

  const otherWorker = deploymentRunner();
  assert.equal(await deploy([], otherWorker.options), 0);
  assert.notEqual(
    otherWorker.runtimeSecrets.GENERATED_CONFIG_ENCRYPTION_KEY,
    key,
  );
});

test("Worker 缺少 CONFIG_ENCRYPTION_KEY 且 D1 沒有加密資料時補上 auto", async (t) => {
  t.mock.method(console, "log", () => {});
  const missingBoth = deploymentRunner({ initialSecrets: vapidSecrets });
  assert.equal(await deploy([], missingBoth.options), 0);
  const key = missingBoth.runtimeSecrets.GENERATED_CONFIG_ENCRYPTION_KEY;
  assert.match(key, /^[0-9a-f]{64}$/);
  assert.deepEqual(missingBoth.uploads[0].secrets, {
    GENERATED_CONFIG_ENCRYPTION_KEY: key,
    CONFIG_ENCRYPTION_KEY: "auto",
  });
  assert.equal(await deploy([], missingBoth.options), 0);
  assert.deepEqual(missingBoth.uploads[1].secrets, {});

  const missingPrimary = deploymentRunner({
    initialSecrets: {
      GENERATED_CONFIG_ENCRYPTION_KEY: "synthetic-generated-key",
      ...vapidSecrets,
    },
  });
  assert.equal(await deploy([], missingPrimary.options), 0);
  assert.deepEqual(missingPrimary.uploads[0].secrets, {
    CONFIG_ENCRYPTION_KEY: "auto",
  });
  assert.equal(
    missingPrimary.runtimeSecrets.GENERATED_CONFIG_ENCRYPTION_KEY,
    "synthetic-generated-key",
  );
});

test("initialization preserves manual and auto secrets supplied as JSON or dotenv", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "encryption-secret-test-"));
  try {
    for (const format of ["json", "env"]) {
      for (const mode of ["auto", "manual"]) {
        await t.test(`${format}: ${mode}`, async () => {
          const values = {
            CONFIG_ENCRYPTION_KEY:
              mode === "auto" ? "auto" : "synthetic manual key $() `literal`",
            EXTRA_SECRET: "synthetic extra value",
          };
          const content =
            format === "json"
              ? JSON.stringify(values)
              : `# Private user settings\nCONFIG_ENCRYPTION_KEY='${values.CONFIG_ENCRYPTION_KEY}'\nEXTRA_SECRET='${values.EXTRA_SECRET}'\n`;
          const file = join(directory, `supplied-${mode}.${format}`);
          await writeFile(file, content, { mode: 0o600 });
          const runner = deploymentRunner();
          assert.equal(
            await deploy(["--secrets-file", file], runner.options),
            0,
          );
          for (const [name, value] of Object.entries(values)) {
            assert.equal(runner.runtimeSecrets[name], value);
          }
          assert.equal(await readFile(file, "utf8"), content);
          if (mode === "auto") {
            assert.match(
              runner.runtimeSecrets.GENERATED_CONFIG_ENCRYPTION_KEY,
              /^[0-9a-f]{64}$/,
            );
          } else {
            assert.equal(
              runner.runtimeSecrets.GENERATED_CONFIG_ENCRYPTION_KEY,
              undefined,
            );
            assert.equal(
              runner.calls.some((call) => call[0] === "d1"),
              false,
            );
          }
          await assert.rejects(readFile(runner.uploads[0].file), {
            code: "ENOENT",
          });
        });
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("existing encrypted D1 data blocks key replacement while legacy manual updates remain usable", async (t) => {
  t.mock.method(console, "warn", () => {});
  const db = new DatabaseSync(":memory:");
  const directory = await mkdtemp(join(tmpdir(), "existing-encryption-test-"));
  const migrationsDirectory = new URL(
    "../apps/worker/migrations/",
    import.meta.url,
  );
  const autoFile = join(directory, "auto.json");
  try {
    for (const name of (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort()) {
      db.exec(await readFile(new URL(name, migrationsDirectory), "utf8"));
    }
    await writeFile(
      autoFile,
      JSON.stringify({ CONFIG_ENCRYPTION_KEY: "auto" }),
      { mode: 0o600 },
    );
    const cases = [
      [
        "connector settings",
        "INSERT INTO connector_settings (id, connector_id, encrypted_config, created_at, updated_at) VALUES ('test', 'sinopac', 'encrypted', 't', 't')",
      ],
      [
        "push subscription",
        "INSERT INTO push_subscriptions (id, encrypted_subscription, created_at, updated_at) VALUES ('test', 'encrypted', 't', 't')",
      ],
      [
        "TDCC config",
        "INSERT INTO tdcc_sync_runs (id, trigger, encrypted_config, created_at, updated_at) VALUES ('test', 'manual', 'encrypted', 't', 't')",
      ],
      [
        "TDCC session",
        "INSERT INTO tdcc_sync_runs (id, trigger, encrypted_session, created_at, updated_at) VALUES ('test', 'manual', 'encrypted', 't', 't')",
      ],
    ];
    for (const [name, insert] of cases) {
      await t.test(name, async () => {
        db.exec(
          "DELETE FROM connector_settings; DELETE FROM push_subscriptions; DELETE FROM tdcc_sync_runs;",
        );
        db.exec(insert);
        const options = {
          initialSecrets: {
            CONFIG_ENCRYPTION_KEY: "synthetic-legacy-key",
            ...vapidSecrets,
          },
          inspectData: (query) => db.prepare(query).get().has_encrypted_data,
        };
        const runner = deploymentRunner(options);
        assert.equal(await deploy([], runner.options), 0);
        assert.deepEqual(runner.runtimeSecrets, options.initialSecrets);
        assert.deepEqual(runner.uploads[0].secrets, {});

        const explicitAuto = deploymentRunner(options);
        await assert.rejects(
          deploy(["--secrets-file", autoFile], explicitAuto.options),
          /Refusing to generate a replacement/,
        );
        assert.equal(explicitAuto.uploads.length, 0);

        const missingPrimary = deploymentRunner({
          ...options,
          initialSecrets: vapidSecrets,
        });
        await assert.rejects(
          deploy([], missingPrimary.options),
          /Refusing to generate a replacement/,
        );
        assert.equal(missingPrimary.uploads.length, 0);

        const missingPrimaryWithGeneratedKey = deploymentRunner({
          ...options,
          initialSecrets: {
            GENERATED_CONFIG_ENCRYPTION_KEY: "synthetic-generated-key",
            ...vapidSecrets,
          },
        });
        await assert.rejects(
          deploy([], missingPrimaryWithGeneratedKey.options),
          /CONFIG_ENCRYPTION_KEY is missing/,
        );
        assert.equal(missingPrimaryWithGeneratedKey.uploads.length, 0);
      });
    }
    db.exec(
      "DELETE FROM connector_settings; DELETE FROM push_subscriptions; DELETE FROM tdcc_sync_runs;",
    );
    db.exec(
      `INSERT INTO tdcc_sync_runs (id, trigger, session_json, created_at, updated_at) VALUES ('test', 'manual', '{"legacy":true}', 't', 't')`,
    );
    const fresh = deploymentRunner({
      inspectData: (query) => db.prepare(query).get().has_encrypted_data,
    });
    assert.equal(await deploy([], fresh.options), 0);
    assert.match(
      fresh.runtimeSecrets.GENERATED_CONFIG_ENCRYPTION_KEY,
      /^[0-9a-f]{64}$/,
    );
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed D1 inspection refuses initialization without exposing CLI output", async () => {
  const runner = deploymentRunner({
    databaseResult: {
      exitCode: 1,
      stdout: "synthetic-sensitive-response",
      stderr: "synthetic-sensitive-token",
    },
  });
  await assert.rejects(deploy([], runner.options), (error) => {
    assert.match(error.message, /Unable to inspect encrypted D1 data/);
    assert.doesNotMatch(error.message, /synthetic-sensitive/);
    return true;
  });
  assert.equal(runner.uploads.length, 0);
});

test("failed upload removes the temporary generated secrets file", async () => {
  const runner = deploymentRunner({ failDeployment: true });
  assert.equal(await deploy([], runner.options), 2);
  await assert.rejects(readFile(runner.uploads[0].file), { code: "ENOENT" });
  assert.equal(
    runner.runtimeSecrets.GENERATED_CONFIG_ENCRYPTION_KEY,
    undefined,
  );
});

test("Workers Builds counts only the first successful deployment", async (t) => {
  t.mock.method(console, "log", () => {});
  const requests = [];
  const fetchPublic = async (url) => {
    requests.push(url);
    return new Response("ok");
  };
  const environment = { WORKERS_CI: "1", ACCESS_AUTO_SETUP: "false" };
  const counterUrl =
    "https://github.com/TedLin1993/all-set-tw/releases/download/deploy-counter/first-deploy.txt";

  const failed = deploymentRunner({ failDeployment: true });
  failed.options.environment = environment;
  failed.options.fetchPublic = fetchPublic;
  assert.equal(await deploy([], failed.options), 2);
  assert.deepEqual(requests, []);

  const runner = deploymentRunner();
  runner.options.environment = environment;
  runner.options.fetchPublic = fetchPublic;
  assert.equal(await deploy([], runner.options), 0);
  assert.equal(await deploy([], runner.options), 0);
  assert.deepEqual(requests, [counterUrl]);

  for (const options of [
    { environment: {} },
    { environment: { ...environment, DEPLOY_COUNTER: "false" } },
  ]) {
    const skipped = deploymentRunner();
    Object.assign(skipped.options, options, { fetchPublic });
    assert.equal(await deploy([], skipped.options), 0);
  }
  assert.deepEqual(requests, [counterUrl]);

  const offline = deploymentRunner();
  offline.options.environment = environment;
  offline.options.fetchPublic = async () => {
    throw new Error("network unavailable");
  };
  assert.equal(await deploy([], offline.options), 0);
  assert.ok(offline.runtimeSecrets.VAPID_PUBLIC_KEY);
});

test("Cloudflare build token reaches resource preparation, migrations and deployment without printing the token", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cloudflare-build-auth-"));
  const { scripts } = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const execute = promisify(execFile);
  const newToken = "synthetic token with spaces $() `quotes`";
  const cases = [
    {
      existing: newToken,
      expected: newToken,
    },
    { existing: "original-build-token", expected: "original-build-token" },
    {},
  ];
  const fixture = `#!${process.execPath}
import { basename } from "node:path";
console.log(JSON.stringify({
  command: basename(process.argv[1]),
  args: process.argv.slice(2),
  authorized: process.env.CLOUDFLARE_API_TOKEN === process.env.EXPECTED_TOKEN
}));
`;
  try {
    await writeFile(join(directory, "package.json"), '{"type":"module"}\n');
    for (const name of ["node", "npm"]) {
      await writeFile(join(directory, name), fixture, { mode: 0o700 });
    }
    for (const tokenCase of cases) {
      for (const name of ["build:app", "deploy"]) {
        const { stdout, stderr } = await execute(
          "/bin/sh",
          ["-c", scripts[name]],
          {
            env: {
              ...process.env,
              PATH: `${directory}:${process.env.PATH}`,
              CLOUDFLARE_API_TOKEN: tokenCase.existing,
              EXPECTED_TOKEN: tokenCase.expected,
            },
          },
        );
        const calls = stdout.trim().split("\n").map(JSON.parse);
        assert.ok(
          calls.every((call) => call.authorized),
          `${name}: wrong token`,
        );
        assert.deepEqual(
          calls.map(({ command, args }) => ({ command, args })),
          name === "build:app"
            ? [{ command: "npm", args: ["run", "build", "--workspaces"] }]
            : [
                {
                  command: "node",
                  args: ["scripts/deploy-with-vapid.mjs", "--migrate"],
                },
              ],
        );
        assert.ok(!`${stdout}${stderr}`.includes(newToken));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("新站避開既有資源，失敗重試與舊站更新都用同一組 bindings 執行 migration 與部署", async () => {
  const tag = "1".repeat(32);
  const installId = createHash("sha256").update(tag).digest("hex").slice(0, 32);
  const occupied = `all-set-resources-${installId}-1`;
  const reserved = `all-set-resources-${installId}-2`;
  const databases = new Map([
    ["taiwan-fin-hub", "legacy-db"],
    [`${occupied}-db`, "unrelated-db"],
  ]);
  const queues = new Set(["taiwan-fin-hub-sync", `${occupied}-sync`]);
  let tags = ["unrelated"];
  // Deploy to Cloudflare 先部署沒有 D1 與 Queue 的按鈕範本。
  let deployments = [{ versions: [{ version_id: "active", percentage: 100 }] }];
  const templateBindings = [{ name: "AI", type: "ai" }];
  let activeBindings = templateBindings;
  let secretNames = ["CONFIG_ENCRYPTION_KEY"];
  let writes = 0;
  const events = [];
  const options = {
    environment: {
      WORKERS_CI: "1",
      CLOUDFLARE_ACCOUNT_ID: "example",
      CLOUDFLARE_API_TOKEN: "example",
      WRANGLER_CI_OVERRIDE_NAME: "second-site",
      WRANGLER_CI_MATCH_TAG: tag,
      ACCESS_AUTO_SETUP: "false",
    },
    async fetchApi(url, options) {
      const { pathname, searchParams } = new URL(url);
      const body = options.body && JSON.parse(options.body);
      const filter = searchParams.get("name");
      if (options.method !== "GET") writes++;
      let result;
      if (pathname.endsWith("/services/second-site")) {
        result = { default_environment: { script: { tag, tags } } };
      } else if (pathname.endsWith("/second-site/deployments")) {
        result = { deployments };
      } else if (pathname.endsWith("/versions/active")) {
        result = { resources: { bindings: activeBindings } };
      } else if (pathname.endsWith("/versions/other")) {
        result = {
          resources: {
            bindings: activeBindings.map((binding) =>
              binding.name === "DB" ? { ...binding, id: "other-db" } : binding,
            ),
          },
        };
      } else if (pathname.endsWith("/second-site/settings")) {
        // The latest upload has no stateful bindings.
        result = { bindings: [] };
      } else if (pathname.endsWith("/second-site/secrets")) {
        result = secretNames.map((name) => ({ name, type: "secret_text" }));
      } else if (pathname.endsWith("/second-site/script-settings")) {
        assert.equal(options.method, "PATCH");
        tags = body.tags;
      } else if (pathname.endsWith("/d1/database")) {
        if (body) {
          assert.equal(body.name, `${reserved}-db`);
          assert.ok(!databases.has(body.name));
          databases.set(body.name, "new-db");
          result = { uuid: "new-db" };
        } else {
          result = databases.has(filter)
            ? [{ name: filter, uuid: databases.get(filter) }]
            : [];
        }
      } else if (pathname.endsWith("/queues")) {
        if (body) {
          assert.equal(body.queue_name, `${reserved}-sync`);
          assert.ok(!queues.has(body.queue_name));
          queues.add(body.queue_name);
          result = body;
        } else {
          result = queues.has(filter) ? [{ queue_name: filter }] : [];
        }
      } else assert.fail(pathname);
      return Response.json({ success: true, result });
    },
    async run(args) {
      if (args[0] === "secret")
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            [
              ...Object.keys(vapidSecrets),
              "CONFIG_ENCRYPTION_KEY",
              "GENERATED_CONFIG_ENCRYPTION_KEY",
            ].map((name) => ({ name })),
          ),
        };
      const config = JSON.parse(
        await readFile(args[args.indexOf("--config") + 1], "utf8"),
      );
      events.push({
        command: args[0],
        db: config.d1_databases[0].database_id,
        producer: config.queues.producers[0].queue,
        consumer: config.queues.consumers[0].queue,
        worker: config.name,
      });
      return { exitCode: events.length === 1 ? 1 : 0 };
    },
  };
  assert.equal(await deploy(["--migrate"], options), 1);
  assert.equal(await deploy(["--migrate"], options), 0);
  assert.deepEqual(tags, ["unrelated", reserved]);
  deployments = [{ versions: [{ version_id: "active", percentage: 100 }] }];
  secretNames = [...secretNames, ...Object.keys(vapidSecrets)];
  const installWrites = writes;
  activeBindings = [
    { name: "DB", type: "d1", id: "legacy-db" },
    { name: "SYNC_QUEUE", type: "queue", queue_name: "taiwan-fin-hub-sync" },
  ];
  assert.equal(await deploy(["--migrate"], options), 0);
  assert.deepEqual(
    events,
    ["d1", "d1", "deploy", "d1", "deploy"].map((command, index) => ({
      command,
      db: index < 3 ? "new-db" : "legacy-db",
      worker: "second-site",
      producer: index < 3 ? `${reserved}-sync` : "taiwan-fin-hub-sync",
      consumer: index < 3 ? `${reserved}-sync` : "taiwan-fin-hub-sync",
    })),
  );
  const completedEvents = events.length;
  deployments[0].versions = [
    { version_id: "active", percentage: 50 },
    { version_id: "other", percentage: 50 },
  ];
  await assert.rejects(
    deploy(["--migrate"], options),
    /different resource bindings/,
  );
  activeBindings = activeBindings.slice(0, 1);
  await assert.rejects(
    deploy(["--migrate"], options),
    /missing a required live binding/,
  );
  // 已安裝過的站台即使正式版本沒有 D1 與 Queue，也不得改用新資源。
  deployments[0].versions = [{ version_id: "active", percentage: 100 }];
  activeBindings = templateBindings;
  await assert.rejects(
    deploy(["--migrate"], options),
    /missing a required live binding/,
  );
  assert.equal(writes, installWrites);
  assert.equal(events.length, completedEvents);
  assert.equal(databases.size, 3);
  assert.equal(queues.size, 3);
});

test("本機部署與單獨 migration 依指定 Worker 的正式版本選擇資源", async () => {
  const args = ["--name", "second-site"];
  const runner = deploymentRunner({
    initialSecrets: {
      ...vapidSecrets,
      CONFIG_ENCRYPTION_KEY: "auto",
      GENERATED_CONFIG_ENCRYPTION_KEY: "example",
    },
  });
  const writes = [];
  let versions = [{ version_id: "active", percentage: 100 }];
  let liveBindings = [
    { name: "DB", type: "d1", id: "dedicated-db" },
    { name: "SYNC_QUEUE", type: "queue", queue_name: "dedicated-queue" },
  ];
  const options = {
    environment: {},
    async run(command) {
      if (["deployments", "versions"].includes(command[0])) {
        assert.equal(command[command.indexOf("--name") + 1], "second-site");
        return {
          exitCode: 0,
          stdout: JSON.stringify(
            command[0] === "deployments"
              ? { versions }
              : {
                  resources: {
                    bindings:
                      command[2] === "other"
                        ? [{ type: "d1", name: "DB", id: "other-db" }]
                        : liveBindings,
                  },
                },
          ),
        };
      }
      if (command[0] !== "secret") {
        const config = JSON.parse(
          await readFile(command[command.indexOf("--config") + 1], "utf8"),
        );
        assert.equal(config.name, "second-site");
        assert.equal(config.d1_databases[0].database_id, "dedicated-db");
        if (command[0] === "deploy") {
          assert.equal(config.queues.producers[0].queue, "dedicated-queue");
          assert.equal(config.queues.consumers[0].queue, "dedicated-queue");
        }
        writes.push(command[0]);
      }
      return runner.run(command);
    },
  };
  assert.equal(await deploy([...args, "--migrate"], options), 0);
  liveBindings = liveBindings.slice(0, 1);
  assert.equal(await deploy([...args, "--migrate-only"], options), 0);
  await assert.rejects(
    deploy([...args, "--migrate"], options),
    /missing a required live binding/,
  );
  versions = [
    { version_id: "active", percentage: 50 },
    { version_id: "other", percentage: 50 },
  ];
  await assert.rejects(
    deploy([...args, "--migrate-only"], options),
    /different resource bindings/,
  );
  liveBindings = [];
  await assert.rejects(
    deploy([...args, "--migrate-only"], options),
    /missing a required live binding/,
  );
  assert.deepEqual(writes, ["d1", "deploy", "d1"]);
});

test("私人設定的單獨 migration 需要明確的 DB ID，且只執行 migration", async () => {
  const runner = deploymentRunner();
  const args = ["--migrate-only", "--config", "private.toml"];
  await assert.rejects(deploy(args, runner.options), /requires a database_id/);
  assert.deepEqual(runner.calls, []);
  runner.options.readConfig = async () => ({
    d1_databases: [{ binding: "DB", database_id: "private-db" }],
  });
  assert.equal(await deploy(args, runner.options), 0);
  assert.deepEqual(runner.calls, [
    ["d1", "migrations", "apply", "DB", "--remote", "--config", "private.toml"],
  ]);
});
