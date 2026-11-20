import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyDeploymentSettings,
  main,
  readDeploymentSettings,
} from "./cloudflare-build.mjs";

const upstreamConfig = `name = "all-set-tw"
main = "apps/worker/src/index.ts"

[[queues.producers]]
binding = "SYNC_QUEUE"
queue = "taiwan-fin-hub-sync"

[[queues.consumers]]
queue = "taiwan-fin-hub-sync"
max_batch_size = 1

[[d1_databases]]
binding = "DB"
database_name = "taiwan-fin-hub"
migrations_dir = "apps/worker/migrations"

[[durable_objects.bindings]]
name = "MEGABANK_EGRESS"
class_name = "MegabankEgress"
`;

const deployedConfig = upstreamConfig
  .replace('name = "all-set-tw"', 'name = "my-finance"')
  .replaceAll('"taiwan-fin-hub-sync"', '"my-sync"')
  .replace(
    'database_name = "taiwan-fin-hub"',
    'database_name = "my-db"\ndatabase_id = "11111111-2222-3333-4444-555555555555"',
  );

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function write(directory, relativePath, contents) {
  const target = path.join(directory, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function commitAll(directory, message) {
  git(directory, "add", "--all");
  git(
    directory,
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "--quiet",
    "-m",
    message,
  );
  return git(directory, "rev-parse", "HEAD");
}

test("換成官方新版時沿用部署的 Worker、D1 與 Queue，避免連到空的資料庫", () => {
  const newerUpstream = upstreamConfig.replace(
    "[[durable_objects.bindings]]",
    '[[d1_databases]]\nbinding = "ARCHIVE"\ndatabase_name = "archive"\n\n[[durable_objects.bindings]]',
  );
  const result = applyDeploymentSettings(
    newerUpstream,
    readDeploymentSettings(deployedConfig),
  );

  const expected = newerUpstream
    .replace('name = "all-set-tw"', 'name = "my-finance"')
    .replaceAll('"taiwan-fin-hub-sync"', '"my-sync"')
    .replace(
      '[[d1_databases]]\nbinding = "DB"\ndatabase_name = "taiwan-fin-hub"',
      '[[d1_databases]]\ndatabase_id = "11111111-2222-3333-4444-555555555555"\nbinding = "DB"\ndatabase_name = "my-db"',
    );
  assert.equal(result, expected);
  // 沒有自訂時維持上游原樣。
  assert.equal(
    applyDeploymentSettings(
      newerUpstream,
      readDeploymentSettings(upstreamConfig),
    ),
    newerUpstream,
  );
});

test("Workers Builds 以官方 main 最新版本建置，不修改部署 repository", () => {
  const root = mkdtempSync(path.join(tmpdir(), "cloudflare-build-"));
  try {
    const upstream = path.join(root, "upstream");
    mkdirSync(upstream);
    git(upstream, "init", "--quiet", "--initial-branch=main");
    write(upstream, "wrangler.toml", upstreamConfig);
    write(upstream, "app.txt", "v1\n");
    write(upstream, "removed.txt", "v1 only\n");
    write(upstream, "package.json", '{"scripts":{"build":"old"}}\n');
    commitAll(upstream, "v1");
    git(upstream, "rm", "--quiet", "removed.txt");
    write(upstream, "app.txt", "v2\n");
    write(upstream, ".github/workflows/ci.yml", "name: ci\n");
    write(
      upstream,
      "package.json",
      '{"scripts":{"build":"node scripts/cloudflare-build.mjs","build:app":"new"}}\n',
    );
    const latest = commitAll(upstream, "v2");

    // Deploy to Cloudflare 建立的 repository：沒有共同歷史，也沒有 workflows。
    const deployment = path.join(root, "deployment");
    mkdirSync(deployment);
    git(deployment, "init", "--quiet", "--initial-branch=main");
    write(deployment, "wrangler.toml", deployedConfig);
    write(deployment, "app.txt", "v1\n");
    write(deployment, "removed.txt", "v1 only\n");
    write(deployment, "package.json", '{"scripts":{"build":"old"}}\n');
    const deployed = commitAll(deployment, "Initial commit");
    const origin = path.join(root, "origin.git");
    git(root, "clone", "--quiet", "--bare", deployment, origin);
    const build = path.join(root, "build");
    git(root, "clone", "--quiet", origin, build);

    const bin = path.join(root, "bin");
    const npmLog = path.join(root, "npm.log");
    write(
      bin,
      "npm",
      `#!/bin/sh\necho "$* $TAIWAN_FIN_HUB_UPDATE_METHOD" >> "${npmLog}"\n`,
    );
    execFileSync("chmod", ["+x", path.join(bin, "npm")]);
    const environment = {
      ...process.env,
      TAIWAN_FIN_HUB_UPDATE_METHOD: "",
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      WORKERS_CI: "1",
    };

    main(build, environment, upstream);

    assert.equal(git(build, "rev-parse", "HEAD"), latest);
    assert.equal(readFileSync(path.join(build, "app.txt"), "utf8"), "v2\n");
    assert.equal(existsSync(path.join(build, "removed.txt")), false);
    assert.equal(
      readFileSync(path.join(build, "wrangler.toml"), "utf8"),
      applyDeploymentSettings(
        upstreamConfig,
        readDeploymentSettings(deployedConfig),
      ),
    );
    assert.deepEqual(readFileSync(npmLog, "utf8").trim().split("\n"), [
      "ci ",
      "run build:app cloudflare",
    ]);
    assert.equal(git(origin, "rev-parse", "main"), deployed);

    // 已有 .github/workflows（例如安裝同步 workflow）時照舊建置目前檔案。
    rmSync(npmLog);
    const synced = path.join(root, "synced");
    git(root, "clone", "--quiet", origin, synced);
    write(synced, ".github/workflows/sync-upstream.yml", "name: sync\n");
    main(synced, environment, upstream);
    assert.equal(git(synced, "rev-parse", "HEAD"), deployed);
    assert.deepEqual(readFileSync(npmLog, "utf8").trim().split("\n"), [
      "run build repository",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
