import assert from "node:assert/strict";
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
      for (const name of ["prebuild", "deploy"]) {
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
          name === "prebuild"
            ? [
                {
                  command: "node",
                  args: ["scripts/prepare-cloudflare-build.mjs"],
                },
              ]
            : [
                { command: "npm", args: ["run", "db:migrate:remote"] },
                { command: "node", args: ["scripts/deploy-with-vapid.mjs"] },
              ],
        );
        assert.ok(!`${stdout}${stderr}`.includes(newToken));
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
