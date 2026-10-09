import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getBuildInfo } from "./build-info.mjs";

const scriptPath = fileURLToPath(
  new URL("./sync-upstream.mjs", import.meta.url),
);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: options.env ?? process.env,
  });

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`,
    );
  }

  return result;
}

function git(cwd, ...args) {
  return run("git", args, { cwd }).stdout.trim();
}

function write(repo, relativePath, contents) {
  const target = path.join(repo, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

function configureAuthor(repo) {
  git(repo, "config", "user.name", "sync-upstream-test");
  git(repo, "config", "user.email", "sync-upstream-test@example.com");
}

function commitAll(repo, message) {
  git(repo, "add", "--all");
  git(repo, "commit", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function initializeRepository(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--initial-branch=main");
  configureAuthor(repo);
}

function initializeBareRepository(repo) {
  mkdirSync(repo, { recursive: true });
  git(repo, "init", "--bare", "--initial-branch=main");
}

function pushMain(worktree, bareRepository) {
  git(worktree, "remote", "add", "origin", bareRepository);
  git(worktree, "push", "-u", "origin", "main");
}

function cloneRepository(bareRepository, destination) {
  run("git", ["clone", bareRepository, destination]);
  configureAuthor(destination);
}

function createUpstream(root, { includeSecondCommit = true } = {}) {
  const worktree = path.join(root, "upstream-worktree");
  const bare = path.join(root, "upstream.git");
  initializeRepository(worktree);
  write(worktree, "app.txt", "version 1\n");
  write(worktree, "removed-after-v1.txt", "remove me\n");
  write(worktree, ".github/workflows/sync-upstream.yml", "name: upstream v1\n");
  write(worktree, ".github/workflows/ci.yml", "name: upstream ci\n");
  const firstCommit = commitAll(worktree, "upstream v1");
  initializeBareRepository(bare);
  pushMain(worktree, bare);

  let latestCommit = firstCommit;
  if (includeSecondCommit) {
    write(worktree, "app.txt", "version 2\n");
    write(worktree, "new-in-v2.txt", "new\n");
    rmSync(path.join(worktree, "removed-after-v1.txt"));
    latestCommit = commitAll(worktree, "upstream v2");
    git(worktree, "push", "origin", "main");
  }

  return { bare, firstCommit, latestCommit, worktree };
}

function createImportedDeployment(root, upstream, options = {}) {
  const worktree = path.join(root, "deployment-worktree");
  const bare = path.join(root, "deployment.git");
  initializeRepository(worktree);

  if (options.unknownBaseline) {
    write(worktree, "app.txt", "not an upstream version\n");
  } else {
    write(worktree, "app.txt", "version 1\n");
    write(worktree, "removed-after-v1.txt", "remove me\n");
  }
  const rootCommit = commitAll(worktree, "Cloudflare source repo import");

  write(
    worktree,
    ".github/workflows/sync-upstream.yml",
    "name: manually installed updater\n",
  );
  const beforeSync = commitAll(worktree, "install updater workflow");

  if (options.userChange) {
    write(worktree, "user-change.txt", "keep me\n");
    commitAll(worktree, "user customization");
  }

  initializeBareRepository(bare);
  pushMain(worktree, bare);
  git(worktree, "remote", "add", "test-upstream", upstream.bare);

  return { bare, beforeSync, rootCommit, worktree };
}

function runUpdater(worktree, upstreamBare) {
  return run(process.execPath, [scriptPath], {
    cwd: worktree,
    allowFailure: true,
    env: {
      ...process.env,
      SYNC_UPSTREAM_URL: upstreamBare,
    },
  });
}

function remoteBranch(worktree, branch) {
  return git(
    worktree,
    "ls-remote",
    "--heads",
    "origin",
    `refs/heads/${branch}`,
  ).split("\t")[0];
}

function withTemporaryRepository(testFunction) {
  const root = mkdtempSync(path.join(tmpdir(), "taiwan-fin-hub-sync-test-"));
  try {
    testFunction(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("三方合併發生程式碼衝突時不改 working tree 且不 push", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root, { includeSecondCommit: false });
    const originBare = path.join(root, "deployment.git");
    initializeBareRepository(originBare);
    git(upstream.worktree, "remote", "add", "deployment", originBare);
    git(upstream.worktree, "push", "deployment", "main");

    const runner = path.join(root, "runner");
    cloneRepository(originBare, runner);
    write(runner, "app.txt", "deployment change\n");
    const deploymentCommit = commitAll(runner, "deployment change");
    git(runner, "push", "origin", "main");

    write(upstream.worktree, "app.txt", "upstream change\n");
    commitAll(upstream.worktree, "upstream change");
    git(upstream.worktree, "push", "origin", "main");

    const result = runUpdater(runner, upstream.bare);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /CONFLICT|發生衝突/);
    assert.equal(remoteBranch(runner, "main"), deploymentCommit);
    assert.equal(git(runner, "rev-parse", "HEAD"), deploymentCommit);
    assert.equal(git(runner, "status", "--porcelain"), "");
  });
});

test("先前同步後的非衝突使用者修改會保留，且不引入上游 parent", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    const deployment = createImportedDeployment(root, upstream);
    const firstResult = runUpdater(deployment.worktree, upstream.bare);
    assert.equal(firstResult.status, 0, firstResult.stderr);

    write(deployment.worktree, "user-note.txt", "deployment note\n");
    const userCommit = commitAll(deployment.worktree, "user note");
    git(deployment.worktree, "push", "origin", "main");

    write(upstream.worktree, "upstream-v3.txt", "upstream v3\n");
    const upstreamV3 = commitAll(upstream.worktree, "upstream v3");
    git(upstream.worktree, "push", "origin", "main");

    const result = runUpdater(deployment.worktree, upstream.bare);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      git(deployment.worktree, "show", "HEAD:user-note.txt"),
      "deployment note",
    );
    assert.equal(
      git(deployment.worktree, "show", "HEAD:upstream-v3.txt"),
      "upstream v3",
    );
    assert.deepEqual(
      git(
        deployment.worktree,
        "rev-list",
        "--parents",
        "-n",
        "1",
        "HEAD",
      ).split(" "),
      [git(deployment.worktree, "rev-parse", "HEAD"), userCommit],
    );
    assert.notEqual(
      run("git", ["merge-base", "--is-ancestor", upstreamV3, "HEAD"], {
        cwd: deployment.worktree,
        allowFailure: true,
      }).status,
      0,
    );
    assert.match(
      git(deployment.worktree, "show", "-s", "--format=%B", "HEAD"),
      new RegExp(`Taiwan-Fin-Hub-Upstream: ${upstreamV3}`),
    );
  });
});

test("獨立部署辨識匯入與同步版本，自行新增 commit 後顯示未知", () => {
  withTemporaryRepository((root) => {
    const upstream = createUpstream(root);
    assert.equal(
      getBuildInfo(upstream.worktree, upstream.bare).commit,
      upstream.latestCommit,
    );
    const deployment = createImportedDeployment(root, upstream);
    git(
      deployment.worktree,
      "push",
      "origin",
      `${deployment.rootCommit}:refs/heads/imported-snapshot`,
    );

    const buildCheckout = path.join(root, "cloudflare-build");
    run("git", [
      "clone",
      "--depth=1",
      "--branch=imported-snapshot",
      pathToFileURL(deployment.bare).href,
      buildCheckout,
    ]);
    const imported = getBuildInfo(buildCheckout, upstream.bare);
    assert.equal(imported.repository, "TedLin1993/all-set-tw");
    assert.equal(imported.commit, upstream.firstCommit);
    assert.equal(imported.branch, "main");
    assert.ok(Number.isFinite(Date.parse(imported.builtAt)));
    assert.equal(
      getBuildInfo(deployment.worktree, upstream.bare).commit,
      "未知",
    );
    git(buildCheckout, "fetch", "--depth=1", "origin", "main");
    git(buildCheckout, "checkout", "--detach", "FETCH_HEAD");
    assert.equal(getBuildInfo(buildCheckout, upstream.bare).commit, "未知");

    const result = runUpdater(deployment.worktree, upstream.bare);
    assert.equal(result.status, 0, result.stderr);
    const synced = getBuildInfo(deployment.worktree, upstream.bare);
    assert.equal(synced.commit, upstream.latestCommit);
    assert.equal(synced.branch, "main");

    const syncedCheckout = path.join(root, "synced-build");
    run("git", [
      "clone",
      "--depth=1",
      pathToFileURL(deployment.bare).href,
      syncedCheckout,
    ]);
    assert.equal(
      getBuildInfo(syncedCheckout, upstream.bare).commit,
      upstream.latestCommit,
    );

    write(deployment.worktree, "user-note.txt", "deployment note\n");
    commitAll(deployment.worktree, "user note");
    git(deployment.worktree, "checkout", "-b", "private-deployment");

    const customized = getBuildInfo(deployment.worktree, upstream.bare);
    assert.equal(customized.commit, "未知");
    assert.equal(customized.branch, "main");

    git(deployment.worktree, "push", "origin", "private-deployment");
    const customizedCheckout = path.join(root, "customized-build");
    run("git", [
      "clone",
      "--depth=1",
      "--branch=private-deployment",
      pathToFileURL(deployment.bare).href,
      customizedCheckout,
    ]);
    assert.equal(
      getBuildInfo(customizedCheckout, upstream.bare).commit,
      "未知",
    );
  });
});
